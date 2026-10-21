import { describe, expect, it } from "vitest";

import type { PlacementEntrant, PlacementMatch, TierDraw, TierDrawMatch } from "./data";
import {
  MIN_ENTRANTS_FOR_ROUND_ONE,
  MIN_ENTRANTS_FOR_ROUND_TWO,
  bracketNote,
  bracketRounds,
  buildCategoryView,
  decidedWinners,
  heldEntrantId,
  planSeeds,
  pendingPlacementGenerationKeys,
  scheduleImpactNote,
  scheduleResetNote,
  shuffleSeedFor,
  stageResetBlockedBy,
  stageResetNote,
  tierIsDecided,
  tierLabel,
  toEntrantRefs,
  toGeneratedMatches,
  toTierDrawPayload,
} from "./placement-actions";
import { buildTierBracket } from "./tier-draw";
import { pairPlacementRoundOne } from "./placement";
import { mulberry32 } from "./rng";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe("incremental round-two recovery", () => {
  it("finds missing generations even when every existing match already holds a time", () => {
    const field = Array.from({ length: 8 }, (_, i) => entrant(`e${i + 1}`, i + 1));
    const r1 = pairPlacementRoundOne(toEntrantRefs(field)).matches.map((m) => ({
      ...match(m.key, "round1", m.entrantAId.slice(1), m.entrantBId.slice(1)),
      scheduled_time: "2026-09-17T09:00:00Z",
      ...(m.key === "r1-1" || m.key === "r1-3"
        ? { status: "reported", winner_id: m.entrantAId }
        : {}),
    }));
    expect(pendingPlacementGenerationKeys(field, r1, [])).toEqual(["c1:r2-1", "c1:r2-3"]);
    const opened = [match("r2-1", "round2", "1", "3"), match("r2-3", "round2", "5", "7")];
    expect(pendingPlacementGenerationKeys(field, [...r1, ...opened], [])).toEqual([]);
    const view = buildCategoryView(field, [...r1, ...opened]);
    expect(view.stage).toBe("round1");
    expect(view.roundTwoSlots).toHaveLength(4);
    expect(view.gate.ready).toBe(false);
  });
});

function entrant(
  id: string,
  seed: number | null,
  skill: "advanced" | "intermediate" | "beginner" = "intermediate",
  options: { excluded?: boolean } = {},
): PlacementEntrant {
  return {
    id,
    tournament_id: "t1",
    category_id: "c1",
    team_id: `team-${id}`,
    skill_level: skill,
    seed,
    tier: null,
    excluded: options.excluded ?? false,
    seed_locked_at: seed != null ? "2026-09-17T00:00:00Z" : null,
    created_at: "2026-09-17T00:00:00Z",
  };
}

function match(
  key: string,
  stage: "round1" | "round2",
  a: string,
  b: string,
  options: {
    winner?: string | null;
    status?: string;
    isMakeup?: boolean;
    isCrossover?: boolean;
  } = {},
): PlacementMatch {
  return {
    id: `m-${key}`,
    tournament_id: "t1",
    category_id: "c1",
    stage,
    generation_key: key,
    entrant_a_id: `e${a}`,
    entrant_b_id: `e${b}`,
    winner_id: options.winner ? `e${options.winner}` : null,
    games: [],
    is_makeup: options.isMakeup ?? false,
    is_crossover: options.isCrossover ?? false,
    prerequisite_ids: [],
    court_id: null,
    scheduled_time: null,
    started_at: null,
    ended_at: null,
    reported_time: null,
    status: options.status ?? "scheduled",
    note: null,
    created_at: "2026-09-17T00:00:00Z",
  };
}

function draw(tier: string, overrides: Partial<TierDraw> = {}): TierDraw {
  return {
    id: `d-${tier}`,
    tournament_id: "t1",
    category_id: "c1",
    tier,
    bracket_size: 1,
    entrant_count: 1,
    champion_id: null,
    created_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function tierMatch(
  drawId: string,
  round: number,
  slot: number,
  overrides: Partial<TierDrawMatch> = {},
): TierDrawMatch {
  return {
    id: `${drawId}-r${round}-s${slot}`,
    tournament_id: "t1",
    draw_id: drawId,
    round,
    slot,
    entrant_a_id: null,
    entrant_b_id: null,
    winner_id: null,
    parent_a_id: null,
    parent_b_id: null,
    games: [],
    is_bye: false,
    court_id: null,
    scheduled_time: null,
    started_at: null,
    ended_at: null,
    reported_time: null,
    status: "scheduled",
    note: null,
    created_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

/** Four entrants, seeded, with a decided round one (1 and 3 win). */
function fourEntrants() {
  const entrants = [entrant("e1", 1), entrant("e2", 2), entrant("e3", 3), entrant("e4", 4)];
  const matches = [
    match("r1-1", "round1", "1", "3", { winner: "1", status: "reported" }),
    match("r1-2", "round1", "2", "4", { winner: "4", status: "reported" }),
  ];
  return { entrants, matches };
}

// ---------------------------------------------------------------------------
// Row conversion
// ---------------------------------------------------------------------------

describe("row conversion", () => {
  it("resolves an unseeded entrant's null seed to 0 rather than NaN", () => {
    expect(toEntrantRefs([entrant("e1", 3), entrant("e2", null)])).toEqual([
      { id: "e1", seed: 3 },
      { id: "e2", seed: 0 },
    ]);
  });

  it("carries the generation key and flags through from stored rows", () => {
    const rows = [
      match("r2-makeup-1", "round2", "1", "2", { isMakeup: true }),
      match("r2-5", "round2", "3", "4", { isCrossover: true }),
    ];
    expect(
      toGeneratedMatches(rows).map((m) => [m.key, m.stage, m.isMakeup, m.isCrossover]),
    ).toEqual([
      ["r2-makeup-1", "round2", true, false],
      ["r2-5", "round2", false, true],
    ]);
  });

  it("treats only reported and walkover rows as decided", () => {
    const winners = decidedWinners([
      match("r1-1", "round1", "1", "2", { winner: "1", status: "reported" }),
      match("r1-2", "round1", "3", "4", { winner: "3", status: "walkover" }),
      // An in-progress row can carry a stale winner, which must not count.
      match("r1-3", "round1", "5", "6", { winner: "5", status: "in-progress" }),
      match("r1-4", "round1", "7", "8", { status: "scheduled" }),
    ]);
    expect(winners.get("r1-1")).toBe("e1");
    expect(winners.get("r1-2")).toBe("e3");
    expect(winners.get("r1-3")).toBeNull();
    expect(winners.get("r1-4")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Held entrant
// ---------------------------------------------------------------------------

describe("heldEntrantId", () => {
  it("finds the one entrant with no round-one match", () => {
    const entrants = [entrant("e1", 1), entrant("e2", 2), entrant("e3", 3)];
    const matches = [match("r1-1", "round1", "1", "3", { winner: "1", status: "reported" })];
    expect(heldEntrantId(entrants, matches)).toBe("e2");
  });

  it("is null when round one covers the whole field", () => {
    const { entrants, matches } = fourEntrants();
    expect(heldEntrantId(entrants, matches)).toBeNull();
  });

  it("is null before round one exists, rather than reporting everyone as held", () => {
    // Reporting a held entrant here would make the desk tell a host that nobody
    // has an opponent, when the real answer is that nothing has been generated.
    const entrants = [entrant("e1", 1), entrant("e2", 2), entrant("e3", 3)];
    expect(heldEntrantId(entrants, [])).toBeNull();
  });

  it("ignores a waived entrant, who is also unpaired", () => {
    const entrants = [
      entrant("e1", 1),
      entrant("e2", 2),
      entrant("e3", 3),
      entrant("e4", 4, "intermediate", { excluded: true }),
    ];
    const matches = [match("r1-1", "round1", "1", "3", { winner: "1", status: "reported" })];
    expect(heldEntrantId(entrants, matches)).toBe("e2");
  });
});

// ---------------------------------------------------------------------------
// View builder
// ---------------------------------------------------------------------------

describe("buildCategoryView", () => {
  it("reads the stage as seeding until seeds are locked", () => {
    const view = buildCategoryView([entrant("e1", null), entrant("e2", null)], []);
    expect(view.stage).toBe("seeding");
    expect(view.seedsLocked).toBe(false);
    expect(view.requiredMatches).toBe(1);
  });

  it("reports round one as the work to do once seeds are locked", () => {
    const view = buildCategoryView([entrant("e1", 1), entrant("e2", 2), entrant("e3", 3)], []);
    expect(view.seedsLocked).toBe(true);
    expect(view.stage).toBe("round1");
    expect(view.roundOne).toEqual([]);
  });

  it("moves to round two once every round-one result is in", () => {
    const { entrants, matches } = fourEntrants();
    const view = buildCategoryView(entrants, matches);
    expect(view.stage).toBe("round2");
    expect(view.roundOne).toHaveLength(2);
    expect(view.roundTwo).toEqual([]);
    // Each entrant has one decided match, so the gate is still short.
    expect(view.gate.ready).toBe(false);
    expect(view.gate.short).toHaveLength(4);
  });

  it("reports draws once the gate opens, and groups entrants by tier", () => {
    const entrants = [entrant("e1", 1), entrant("e2", 2), entrant("e3", 3), entrant("e4", 4)];
    const matches = [
      match("r1-1", "round1", "1", "3", { winner: "1", status: "reported" }),
      match("r1-2", "round1", "2", "4", { winner: "4", status: "reported" }),
      match("r2-1", "round2", "1", "4", { winner: "1", status: "reported" }),
      match("r2-2", "round2", "3", "2", { winner: "3", status: "reported" }),
    ];
    const view = buildCategoryView(entrants, matches);

    expect(view.gate.ready).toBe(true);
    expect(view.stage).toBe("draws");

    // e1 won both -> WW -> A. e4 won round one then lost -> WL -> B.
    // e3 lost then won -> LW -> C. e2 lost both -> LL -> D.
    expect(view.byTier.A.map((o) => o.entrantId)).toEqual(["e1"]);
    expect(view.byTier.B.map((o) => o.entrantId)).toEqual(["e4"]);
    expect(view.byTier.C.map((o) => o.entrantId)).toEqual(["e3"]);
    expect(view.byTier.D.map((o) => o.entrantId)).toEqual(["e2"]);
    for (const outcome of view.outcomes) {
      expect(outcome.played).toBe(2);
      expect(tierLabel(outcome)).toBe(outcome.tier);
    }
  });

  it("opens the gate immediately for a field of one, with no matches to play", () => {
    const view = buildCategoryView([entrant("e1", 1)], []);
    expect(view.gate.ready).toBe(true);
    expect(view.requiredMatches).toBe(0);
    expect(view.stage).toBe("draws");
    expect(view.roundOneExpected).toBe(false);
    expect(view.roundTwoExpected).toBe(false);
    // The sole entrant is the champion of Draw A.
    expect(view.byTier.A.map((o) => o.entrantId)).toEqual(["e1"]);
  });

  it("has no round two for a field of two, but does for a field of three", () => {
    const two = buildCategoryView([entrant("e1", 1), entrant("e2", 2)], []);
    expect(two.roundOneExpected).toBe(true);
    expect(two.roundTwoExpected).toBe(false);

    const three = buildCategoryView([entrant("e1", 1), entrant("e2", 2), entrant("e3", 3)], []);
    expect(three.roundOneExpected).toBe(true);
    expect(three.roundTwoExpected).toBe(true);
    expect(MIN_ENTRANTS_FOR_ROUND_ONE).toBe(2);
    expect(MIN_ENTRANTS_FOR_ROUND_TWO).toBe(3);
  });

  it("opens the gate for a field of two after the single match", () => {
    const entrants = [entrant("e1", 1), entrant("e2", 2)];
    const matches = [match("r1-1", "round1", "1", "2", { winner: "1", status: "reported" })];
    const view = buildCategoryView(entrants, matches);
    expect(view.gate.ready).toBe(true);
    expect(view.stage).toBe("draws");
    // Winner to Draw A, loser to Draw D. No crossover, which would be a rematch.
    expect(view.byTier.A.map((o) => o.entrantId)).toEqual(["e1"]);
    expect(view.byTier.D.map((o) => o.entrantId)).toEqual(["e2"]);
  });

  it("keeps a waived entrant out of the gate and out of the tiers", () => {
    const entrants = [
      entrant("e1", 1),
      entrant("e2", 2),
      entrant("e3", 3),
      entrant("e4", 4, "intermediate", { excluded: true }),
    ];
    const matches = [match("r1-1", "round1", "1", "3", { winner: "1", status: "reported" })];
    const view = buildCategoryView(entrants, matches);

    expect(view.excluded.map((e) => e.id)).toEqual(["e4"]);
    expect(view.active).toHaveLength(3);
    // Three active entrants need two matches each, so the gate is still shut.
    expect(view.gate.excluded).toBe(1);
    expect(view.gate.requiredMatches).toBe(2);
    expect(view.gate.short).toHaveLength(3);
  });

  it("does not treat a stale winner on an unfinished match as a result", () => {
    const entrants = [entrant("e1", 1), entrant("e2", 2), entrant("e3", 3), entrant("e4", 4)];
    const matches = [
      // Both carry a winner id but are not finished, so neither counts.
      match("r1-1", "round1", "1", "3", { winner: "1", status: "in-progress" }),
      match("r1-2", "round1", "2", "4", { winner: "4", status: "void" }),
    ];
    const view = buildCategoryView(entrants, matches);
    expect(view.gate.ready).toBe(false);
    expect(view.outcomes.every((outcome) => outcome.played === 0)).toBe(true);
    expect(view.stage).toBe("round1");
  });
});

// ---------------------------------------------------------------------------
// Payload projection
// ---------------------------------------------------------------------------

describe("toTierDrawPayload", () => {
  it("drops an empty tier rather than sending an unbracketable row", () => {
    const entrants = [entrant("e1", 1)];
    const payload = toTierDrawPayload([buildTierBracket("D", [])], entrants);
    expect(payload).toEqual([]);
  });

  it("sends a sole entrant as a champion with no matches", () => {
    const entrants = [entrant("e1", 5)];
    const payload = toTierDrawPayload([buildTierBracket("A", [{ id: "e1", seed: 5 }])], entrants);
    expect(payload).toHaveLength(1);
    expect(payload[0]?.tier).toBe("A");
    expect(payload[0]?.champion_team_id).toBe("team-e1");
    expect(payload[0]?.matches).toEqual([]);
  });

  it("maps entrant ids to team ids, including the bye winner", () => {
    const entrants = [entrant("e1", 1), entrant("e2", 2), entrant("e3", 3)];
    const plan = buildTierBracket("B", [
      { id: "e1", seed: 1 },
      { id: "e2", seed: 2 },
      { id: "e3", seed: 3 },
    ]);
    const payload = toTierDrawPayload([plan], entrants);
    const bye = payload[0]?.matches.find((entry) => entry.is_bye);
    expect(bye?.winner_team_id).toBe("team-e1");
    const real = payload[0]?.matches.find((entry) => !entry.is_bye);
    expect(real?.entrant_a_team_id).toBe("team-e2");
    expect(real?.entrant_b_team_id).toBe("team-e3");
    expect(real?.winner_team_id).toBeNull();
  });

  it("refuses to invent a team for an entrant that is not in the category", () => {
    // Guarding this matters: an unknown entrant would otherwise be silently sent
    // as null and become a bye the host never agreed to.
    const payload = toTierDrawPayload([buildTierBracket("A", [{ id: "ghost", seed: 1 }])], []);
    expect(payload[0]?.champion_team_id).toBeNull();
  });
});

describe("planSeeds", () => {
  it("seeds by skill block and leaves a waived entrant out", () => {
    const entrants = [
      entrant("e1", null, "beginner"),
      entrant("e2", null, "advanced"),
      entrant("e3", null, "intermediate"),
      entrant("e4", null, "advanced", { excluded: true }),
    ];
    const seeds = planSeeds(entrants, mulberry32(7));
    expect(seeds).toHaveLength(3);
    // The strongest block takes the lowest seeds.
    expect(seeds.find((s) => s.id === "e2")?.seed).toBe(1);
    expect(seeds.find((s) => s.id === "e3")?.seed).toBe(2);
    expect(seeds.find((s) => s.id === "e1")?.seed).toBe(3);
    expect(seeds.some((s) => s.id === "e4")).toBe(false);
  });

  it("is stable for the same generated seed", () => {
    const entrants = [entrant("e1", null), entrant("e2", null), entrant("e3", null)];
    expect(planSeeds(entrants, mulberry32(shuffleSeedFor("c1")))).toEqual(
      planSeeds(entrants, mulberry32(shuffleSeedFor("c1"))),
    );
  });

  it("derives a different shuffle seed per category", () => {
    // Keyed on the category, so two events in one tournament do not shuffle into
    // the same order.
    expect(shuffleSeedFor("c1")).not.toBe(shuffleSeedFor("c2"));
  });
});

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

describe("draw display helpers", () => {
  it("explains a champion-only tier and a bye-bearing bracket differently", () => {
    expect(bracketNote(draw("A", { entrant_count: 1, bracket_size: 1 }))).toContain(
      "champion, no bracket played",
    );
    expect(bracketNote(draw("B", { entrant_count: 5, bracket_size: 8 }))).toContain(
      "3 byes to the top seeds",
    );
    expect(bracketNote(draw("A", { entrant_count: 4, bracket_size: 4 }))).toContain("bracket of 4");
  });

  it("treats a tier as decided only once it has a champion", () => {
    expect(tierIsDecided(draw("A"))).toBe(false);
    expect(tierIsDecided(draw("A", { champion_id: "e1" }))).toBe(true);
    expect(tierIsDecided(undefined)).toBe(false);
  });

  it("has no tier label for an entrant with an undecided record", () => {
    expect(tierLabel(undefined)).toBe("—");
    expect(
      tierLabel({
        entrantId: "e1",
        seed: 1,
        played: 1,
        wins: 1,
        losses: 0,
        firstWon: true,
        secondWon: null,
        isHeld: false,
        record: null,
        tier: null,
      }),
    ).toBe("—");
  });

  it("groups bracket matches by round and orders each round by slot", () => {
    const rounds = bracketRounds([
      tierMatch("d-A", 2, 1),
      tierMatch("d-A", 1, 2),
      tierMatch("d-A", 1, 1),
    ]);
    expect([...rounds.keys()]).toEqual([2, 1]);
    expect(rounds.get(1)?.map((m) => m.slot)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// Schedule impact
// ---------------------------------------------------------------------------

describe("scheduleImpactNote", () => {
  it("says nothing when a result moved nothing", () => {
    // The common case. A "0 matches moved" line on every score entry would train
    // the desk to ignore the line that actually matters.
    expect(
      scheduleImpactNote({ shiftedMatches: 0, largestShiftMinutes: 0, direction: "none" }),
    ).toBeNull();
  });

  it("names the direction and the largest shift when a result did move matches", () => {
    expect(
      scheduleImpactNote({ shiftedMatches: 3, largestShiftMinutes: 15, direction: "later" }),
    ).toBe("3 later matches delayed by up to 15 min");
    expect(
      scheduleImpactNote({ shiftedMatches: 1, largestShiftMinutes: 5, direction: "earlier" }),
    ).toBe("1 later match moved earlier by up to 5 min");
  });

  it("does not claim a direction when matches moved both ways", () => {
    // A late finish pushes one court later while a freed player pulls another
    // earlier, so neither direction is the truth.
    expect(
      scheduleImpactNote({ shiftedMatches: 2, largestShiftMinutes: 10, direction: "mixed" }),
    ).toBe("2 later matches rescheduled by up to 10 min");
  });
});

// ---------------------------------------------------------------------------
// The stage reset gate
// ---------------------------------------------------------------------------

describe("stageResetBlockedBy", () => {
  const cleared = { placementMatches: 0, tierDraws: 0, tierMatches: 0 };

  it("allows the reset when the schedule is clear", () => {
    // The state the gate exists to reach: nothing is paired from the seed order any
    // more, so discarding it cannot strand a bracket.
    expect(stageResetBlockedBy(cleared)).toBeNull();
  });

  it("blocks on placement matches and names them", () => {
    const reason = stageResetBlockedBy({ ...cleared, placementMatches: 31 });
    expect(reason).toContain("31 placement matches");
    // The host has to be told where to go, not just that they cannot proceed.
    expect(reason).toContain("Schedule tab");
  });

  it("blocks on knockout matches alone", () => {
    // A build writes the brackets before it schedules them, so this is the state a
    // half-finished build leaves behind: no placement rows left to name, but a
    // knockout fixture that was still paired from the seeding.
    const reason = stageResetBlockedBy({ ...cleared, tierMatches: 6 });
    expect(reason).toContain("6 knockout matches");
  });

  it("blocks on draws alone", () => {
    // The bracket itself, which can outlive its own match rows.
    const reason = stageResetBlockedBy({ ...cleared, tierDraws: 2 });
    expect(reason).toContain("2 draws");
  });

  it("counts every outstanding row in one reason", () => {
    const reason = stageResetBlockedBy({
      placementMatches: 31,
      tierDraws: 2,
      tierMatches: 6,
    });
    expect(reason).toContain("31 placement matches");
    expect(reason).toContain("6 knockout matches");
    expect(reason).toContain("2 draws");
  });

  it("singularises a lone row", () => {
    expect(stageResetBlockedBy({ ...cleared, placementMatches: 1 })).toContain(
      "1 placement match ",
    );
  });
});

describe("the reset notes", () => {
  it("says the seeding survived a schedule reset", () => {
    // The distinction the two resets exist for, restated where the host reads it.
    expect(scheduleResetNote({ placementMatches: 12, tierDraws: 2, tierMatches: 4 })).toBe(
      "Removed 12 placement matches, 4 knockout matches, 2 draws. The seed order and waivers are kept.",
    );
  });

  it("says the seeding went with a stage reset", () => {
    expect(stageResetNote({ placementMatches: 0, tierDraws: 0, tierMatches: 0, entrants: 8 })).toBe(
      "Nothing had been played yet — the seeds were unlocked.",
    );
  });
});
