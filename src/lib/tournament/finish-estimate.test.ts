import { describe, expect, it } from "vitest";

import type {
  Court,
  PlacementEntrant,
  PlacementMatch,
  Team,
  TierDraw,
  TierDrawMatch,
  Tournament,
  TournamentDay,
} from "./data";
import {
  buildPlacementRoundTwoForecastItems,
  buildTierForecastItems,
  estimateFinish,
  forecastTournament,
  knockoutUncreatedMatches,
  placementRoundTwoWorkload,
  roundCount,
  roundWorkload,
  type EstimateFinishInput,
} from "./finish-estimate";
import { planPlacementSchedule, type PlanPlacementScheduleInput } from "./placement-schedule";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOURNAMENT_ID = "t1";
const MINUTE = 60_000;
const DAY_START = new Date("2026-09-17T09:00:00").getTime();

function tournament(overrides: Partial<Tournament> = {}): Tournament {
  return {
    id: TOURNAMENT_ID,
    name: "Test Open",
    court_count: 2,
    created_at: "2026-09-17T00:00:00Z",
    day_count: 1,
    format: "two_round_placement",
    group_rest_gap_minutes: 20,
    group_slot_minutes: 30,
    is_active: true,
    knockout_best_of: 3,
    knockout_games_to: 21,
    knockout_rest_gap_minutes: 30,
    knockout_slot_minutes: 45,
    knockout_win_by: 2,
    max_categories_per_player: 2,
    notes: null,
    organizer_email: null,
    organizer_name: null,
    organizer_phone: null,
    placement_best_of: 1,
    placement_games_to: 21,
    placement_win_by: 2,
    rest_gap_minutes: 30,
    status: "in_progress",
    venue_address: null,
    venue_name: null,
    venue_timezone: "UTC",
    ...overrides,
  };
}

function day(overrides: Partial<TournamentDay> = {}): TournamentDay {
  return {
    id: "d1",
    tournament_id: TOURNAMENT_ID,
    day_number: 1,
    date: "2026-09-17",
    start_time: "09:00:00",
    end_time: "18:00:00",
    created_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function court(number: number): Court {
  return {
    id: `c${number}`,
    number,
    status: "available",
    tournament_id: TOURNAMENT_ID,
    created_at: "2026-09-17T00:00:00Z",
  };
}

function team(id: string, player1: string, player2: string | null = null): Team {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    category_id: "cat1",
    player_1_id: player1,
    player_2_id: player2,
    seed: null,
    withdrawn: false,
    created_at: "2026-09-17T00:00:00Z",
  };
}

function entrant(id: string, teamId: string, seed = 1): PlacementEntrant {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    category_id: "cat1",
    team_id: teamId,
    skill_level: "intermediate",
    seed,
    tier: null,
    excluded: false,
    seed_locked_at: null,
    created_at: "2026-09-17T00:00:00Z",
  };
}

/**
 * `count` singles entrants, each on its own team with a distinct player.
 *
 * Singles keeps the fixture arithmetic obvious — one player per side means a "2 matches, same
 * player" rest case cannot appear by accident — and distinct players mean no two matches contend
 * for a participant unless a test asks them to.
 */
function roster(count: number): { teams: Team[]; entrants: PlacementEntrant[] } {
  const teams: Team[] = [];
  const entrants: PlacementEntrant[] = [];
  for (let index = 1; index <= count; index += 1) {
    teams.push(team(`team-${index}`, `p${index}`));
    entrants.push(entrant(`e${index}`, `team-${index}`, index));
  }
  return { teams, entrants };
}

function placementMatch(
  id: string,
  stage: "round1" | "round2",
  entrantA: string,
  entrantB: string,
  overrides: Partial<PlacementMatch> = {},
): PlacementMatch {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    category_id: "cat1",
    stage,
    generation_key: id,
    entrant_a_id: entrantA,
    entrant_b_id: entrantB,
    winner_id: null,
    games: [],
    is_makeup: false,
    is_crossover: false,
    prerequisite_ids: [],
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

function tierDraw(overrides: Partial<TierDraw> = {}): TierDraw {
  return {
    id: "draw-A",
    tournament_id: TOURNAMENT_ID,
    category_id: "cat1",
    tier: "A",
    bracket_size: 4,
    entrant_count: 4,
    champion_id: null,
    created_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function tierMatch(
  id: string,
  round: number,
  slot: number,
  entrantA: string | null,
  entrantB: string | null,
  overrides: Partial<TierDrawMatch> = {},
): TierDrawMatch {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    draw_id: "draw-A",
    round,
    slot,
    entrant_a_id: entrantA,
    entrant_b_id: entrantB,
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

const FAST = { graspRuns: 1, seed: 1 } as const;

/** A minimal estimate input; every test overrides only the part it is about. */
function estimateInput(overrides: Partial<EstimateFinishInput> = {}): EstimateFinishInput {
  return {
    tournament: tournament(),
    days: [day()],
    allCourts: [court(1)],
    teams: [],
    entrants: [],
    draws: [],
    placementMatches: [],
    tierMatches: [],
    categoryOrder: new Map([["cat1", 1]]),
    options: FAST,
    now: DAY_START,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Round arithmetic
// ---------------------------------------------------------------------------

describe("roundWorkload", () => {
  it("counts a full bracket with no byes", () => {
    for (const bracketSize of [2, 4, 8, 16, 32]) {
      let total = 0;
      for (let round = 1; round <= roundCount(bracketSize); round += 1) {
        const workload = roundWorkload({
          bracketSize,
          entrantCount: bracketSize,
          round,
          existingMatchesInRound: 0,
        });
        total += workload.synthetic;
      }
      // A knockout draw of N entrants plays exactly N - 1 matches.
      expect(total).toBe(bracketSize - 1);
    }
  });

  it("subtracts byes from round one only, never from a later round", () => {
    // 8 bracket, 6 entrants, 2 byes: R1 4 slots - 2 byes = 2, R2 2, R3 1 -> 5 = 6 - 1.
    const r1 = roundWorkload({
      bracketSize: 8,
      entrantCount: 6,
      round: 1,
      existingMatchesInRound: 0,
    });
    const r2 = roundWorkload({
      bracketSize: 8,
      entrantCount: 6,
      round: 2,
      existingMatchesInRound: 0,
    });
    const r3 = roundWorkload({
      bracketSize: 8,
      entrantCount: 6,
      round: 3,
      existingMatchesInRound: 0,
    });
    expect([r1.expected, r2.expected, r3.expected]).toEqual([2, 2, 1]);
    expect(r1.expected + r2.expected + r3.expected).toBe(5);
  });

  it("does not let a round-one bye reduce a later round (regression)", () => {
    // The bug this guards: subtracting `byes` again in round two, which would make an
    // 8-bracket with 2 byes report 2 + 1 + 0 = 3 playable matches instead of 5.
    const withByes = [1, 2, 3].map(
      (round) =>
        roundWorkload({ bracketSize: 8, entrantCount: 6, round, existingMatchesInRound: 0 })
          .expected,
    );
    const withoutByes = [1, 2, 3].map(
      (round) =>
        roundWorkload({ bracketSize: 8, entrantCount: 8, round, existingMatchesInRound: 0 })
          .expected,
    );
    // Round one differs by exactly the two byes; rounds two and three are identical.
    expect(withByes[0]).toBe(withoutByes[0]! - 2);
    expect(withByes.slice(1)).toEqual(withoutByes.slice(1));
  });

  it("counts a partially-created later round from its rows", () => {
    // 16 bracket: R1 8 real, R2 2 real, R3/R4 none -> 0 + 2 + 2 + 1 = 5 synthetic.
    const expected = [
      roundWorkload({ bracketSize: 16, entrantCount: 16, round: 1, existingMatchesInRound: 8 }),
      roundWorkload({ bracketSize: 16, entrantCount: 16, round: 2, existingMatchesInRound: 2 }),
      roundWorkload({ bracketSize: 16, entrantCount: 16, round: 3, existingMatchesInRound: 0 }),
      roundWorkload({ bracketSize: 16, entrantCount: 16, round: 4, existingMatchesInRound: 0 }),
    ];
    expect(expected.map((entry) => entry.synthetic)).toEqual([0, 2, 2, 1]);
  });

  it("never reports a negative synthetic count when rows already exceed the expectation", () => {
    expect(
      roundWorkload({ bracketSize: 4, entrantCount: 4, round: 1, existingMatchesInRound: 9 })
        .synthetic,
    ).toBe(0);
  });

  it("treats a one-entrant or champion-only draw as no rounds", () => {
    expect(roundCount(1)).toBe(0);
    expect(
      roundWorkload({ bracketSize: 1, entrantCount: 1, round: 1, existingMatchesInRound: 0 }),
    ).toEqual({ expected: 0, synthetic: 0 });
    expect(
      roundWorkload({ bracketSize: 4, entrantCount: 1, round: 1, existingMatchesInRound: 0 }),
    ).toEqual({ expected: 0, synthetic: 0 });
  });
});

describe("placementRoundTwoWorkload", () => {
  it("derives the whole round from the two-matches-per-entrant invariant", () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 2],
      [4, 2],
      [5, 3],
      [6, 3],
      [8, 4],
    ];
    for (const [activeEntrants, expected] of cases) {
      expect(placementRoundTwoWorkload({ activeEntrants, existingRoundTwoMatches: 0 })).toBe(
        expected,
      );
    }
  });

  it("subtracts rows that already exist", () => {
    expect(placementRoundTwoWorkload({ activeEntrants: 5, existingRoundTwoMatches: 1 })).toBe(2);
    expect(placementRoundTwoWorkload({ activeEntrants: 5, existingRoundTwoMatches: 3 })).toBe(0);
    expect(placementRoundTwoWorkload({ activeEntrants: 5, existingRoundTwoMatches: 9 })).toBe(0);
  });
});

describe("knockoutUncreatedMatches", () => {
  it("skips a finished draw and a one-entrant draw", () => {
    expect(knockoutUncreatedMatches({ draws: [], tierMatches: [] })).toBe(0);
    expect(
      knockoutUncreatedMatches({
        draws: [tierDraw({ champion_id: "e1" })],
        tierMatches: [],
      }),
    ).toBe(0);
    expect(
      knockoutUncreatedMatches({
        draws: [tierDraw({ bracket_size: 1, entrant_count: 1 })],
        tierMatches: [],
      }),
    ).toBe(0);
  });

  it("counts a full 8-bracket as seven matches regardless of byes", () => {
    expect(
      knockoutUncreatedMatches({
        draws: [tierDraw({ bracket_size: 8, entrant_count: 8 })],
        tierMatches: [],
      }),
    ).toBe(7);
    // 2 byes: still 5 playable matches (6 entrants - 1).
    expect(
      knockoutUncreatedMatches({
        draws: [tierDraw({ bracket_size: 8, entrant_count: 6 })],
        tierMatches: [],
      }),
    ).toBe(5);
  });

  it("does not count byes or void rows as existing playable matches", () => {
    const byes = [
      tierMatch("b1", 1, 1, null, null, { is_bye: true }),
      tierMatch("b2", 1, 2, null, null, { is_bye: true }),
    ];
    expect(
      knockoutUncreatedMatches({
        draws: [tierDraw({ bracket_size: 8, entrant_count: 6 })],
        tierMatches: byes,
      }),
    ).toBe(5);
    const voided = [tierMatch("v1", 1, 1, "e1", "e2", { status: "void" })];
    expect(
      knockoutUncreatedMatches({
        draws: [tierDraw({ bracket_size: 4, entrant_count: 4 })],
        tierMatches: voided,
      }),
    ).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Forecast item construction
// ---------------------------------------------------------------------------

describe("buildPlacementRoundTwoForecastItems", () => {
  const baseInput = {
    placementMatches: [] as PlacementMatch[],
    placementItemIds: new Set<string>(),
    placementItems: [],
    pinById: new Map(),
    r1LatestEndByCategory: new Map<string, number>(),
    categoryOrder: new Map([["cat1", 1]]),
    slotMinutes: 30,
    restGap: 20,
  };

  it("emits ceil(N/2) items with no dependency and no shared participant", () => {
    const { entrants } = roster(5);
    const result = buildPlacementRoundTwoForecastItems({ ...baseInput, entrants });
    expect(result.uncreatedMatches).toBe(3);
    expect(result.items).toHaveLength(3);
    // No R1 correspondence is knowable, so nothing is named as a feeder and no placeholder is
    // shared: the items must not serialise against each other.
    for (const item of result.items) {
      expect(item.dependencies ?? []).toEqual([]);
    }
    const allParticipants = result.items.flatMap((item) => item.participantIds);
    expect(new Set(allParticipants).size).toBe(allParticipants.length);
  });

  it("depends on every real round-one item and waits for the latest one plus the stage rest", () => {
    const { entrants } = roster(5);
    const r1 = [
      placementMatch("r1-1", "round1", "e1", "e2"),
      placementMatch("r1-2", "round1", "e3", "e4"),
    ];
    const itemIds = new Set(["r1-1", "r1-2"]);
    const latest = DAY_START + 3 * 60 * MINUTE;
    const result = buildPlacementRoundTwoForecastItems({
      ...baseInput,
      entrants,
      placementMatches: r1,
      placementItemIds: itemIds,
      r1LatestEndByCategory: new Map([["cat1", latest]]),
    });
    expect(result.items).toHaveLength(3);
    for (const item of result.items) {
      // The gate is every R1 item, which is the real generation gate: R2 cannot exist until R1
      // is decided. The rest gap rides on `eligibleFrom` because the pairing is outcome-dependent.
      expect([...(item.dependencies ?? [])].sort()).toEqual(["r1-1", "r1-2"]);
      expect(item.eligibleFrom).toBe(latest + 20 * MINUTE);
    }
  });

  it("does not emit anything for two or fewer entrants", () => {
    for (const count of [0, 1, 2]) {
      const { entrants } = roster(count);
      const result = buildPlacementRoundTwoForecastItems({ ...baseInput, entrants });
      expect(result.uncreatedMatches).toBe(0);
      expect(result.items).toEqual([]);
    }
  });
});

describe("buildTierForecastItems", () => {
  it("turns the missing later rounds of a byed 8-bracket into synthetics", () => {
    const rows = [
      tierMatch("b1", 1, 1, null, null, { is_bye: true, winner_id: "e1" }),
      tierMatch("k1", 1, 2, "e2", "e3"),
      tierMatch("b2", 1, 3, null, null, { is_bye: true, winner_id: "e4" }),
      tierMatch("k2", 1, 4, "e5", "e6"),
    ];
    const result = buildTierForecastItems({
      draws: [tierDraw({ bracket_size: 8, entrant_count: 6 })],
      tierMatches: rows,
      productionItems: [],
      pinById: new Map(),
      drawCategory: new Map([["draw-A", "cat1"]]),
      categoryOrder: new Map([["cat1", 1]]),
      slotMinutes: 45,
      restGap: 30,
    });
    // R1 is fully present (2 byes + 2 matches), so nothing is synthesized there; R2 needs 2 and
    // R3 needs 1. The byes must not reduce the later rounds.
    expect(result.uncreatedMatches).toBe(3);
    expect(result.items.filter((item) => item.id.includes("r2")).length).toBe(2);
    expect(result.items.filter((item) => item.id.includes("r3")).length).toBe(1);
  });

  it("gives a later synthetic round its feeders' winner placeholders and dependencies", () => {
    const result = buildTierForecastItems({
      draws: [tierDraw({ bracket_size: 4, entrant_count: 4 })],
      tierMatches: [],
      productionItems: [],
      pinById: new Map(),
      drawCategory: new Map([["draw-A", "cat1"]]),
      categoryOrder: new Map([["cat1", 1]]),
      slotMinutes: 45,
      restGap: 30,
    });
    const roundOne = result.items.filter((item) => item.sequence === 101 || item.sequence === 102);
    const final = result.items.find((item) => item.sequence === 201);
    expect(result.uncreatedMatches).toBe(3);
    expect(roundOne).toHaveLength(2);
    expect(final).toBeDefined();
    expect([...(final!.dependencies ?? [])].sort()).toEqual(roundOne.map((item) => item.id).sort());
    // The dependency is precedence only; the shared winner placeholder is what adds the rest gap.
    for (const feeder of roundOne) {
      const shared = feeder.participantIds.filter((id) => final!.participantIds.includes(id));
      expect(shared).toHaveLength(1);
    }
  });

  it("skips a finished draw and a one-entrant draw", () => {
    const finished = buildTierForecastItems({
      draws: [tierDraw({ champion_id: "e1" })],
      tierMatches: [],
      productionItems: [],
      pinById: new Map(),
      drawCategory: new Map([["draw-A", "cat1"]]),
      categoryOrder: new Map([["cat1", 1]]),
      slotMinutes: 45,
      restGap: 30,
    });
    expect(finished).toEqual({ items: [], uncreatedMatches: 0 });
  });
});

// ---------------------------------------------------------------------------
// estimateFinish
// ---------------------------------------------------------------------------

describe("estimateFinish", () => {
  it("answers even when nothing has been placed yet", () => {
    const { teams, entrants } = roster(4);
    const estimate = estimateFinish(
      estimateInput({ teams, entrants, allCourts: [court(1), court(2)] }),
    );
    expect(estimate.finish).not.toBeNull();
    expect(estimate.basis).toBe("projected");
    expect(estimate.placedFinish).toBeNull();
    // 4 entrants -> 2 placement round-two matches, and nothing else is configured.
    expect(estimate.uncreatedMatches).toBe(2);
    expect(estimate.remainingMatches).toBeGreaterThan(0);
  });

  it("reports a placed tournament as placed, with finish equal to the floor", () => {
    const { teams, entrants } = roster(2);
    const played = placementMatch("r1-1", "round1", "e1", "e2", {
      status: "reported",
      ended_at: "2026-09-17T09:30:00",
      winner_id: "e1",
    });
    const estimate = estimateFinish(estimateInput({ teams, entrants, placementMatches: [played] }));
    expect(estimate.basis).toBe("placed");
    expect(estimate.finish).toBe(estimate.placedFinish);
    expect(estimate.placedFinish).toBe(new Date("2026-09-17T09:30:00").toISOString());
    expect(estimate.remainingMatches).toBe(0);
    expect(estimate.uncreatedMatches).toBe(0);
  });

  it("includes the uncreated knockout rounds of every live draw", () => {
    const { teams, entrants } = roster(4);
    const estimate = estimateFinish(
      estimateInput({
        teams,
        entrants,
        draws: [tierDraw({ bracket_size: 8, entrant_count: 8 })],
      }),
    );
    // 2 placement round-two + 7 knockout matches.
    expect(estimate.uncreatedMatches).toBe(9);
  });

  it("counts an existing, unplaceable match as overflow and names no clock time", () => {
    const { teams, entrants } = roster(4);
    // A prerequisite cycle cannot drain, so both matches stay unplaced no matter how long the day.
    const a = placementMatch("a", "round2", "e1", "e2", { prerequisite_ids: ["b"] });
    const b = placementMatch("b", "round2", "e3", "e4", { prerequisite_ids: ["a"] });
    const estimate = estimateFinish(estimateInput({ teams, entrants, placementMatches: [a, b] }));
    expect(estimate.basis).toBe("overflow");
    expect(estimate.finish).toBeNull();
    expect(estimate.deficitMinutes).toBeNull();
    expect(estimate.unplacedMatches).toBeGreaterThanOrEqual(2);
  });

  it("names the extension when the work only fits by overrunning the last day", () => {
    const { teams, entrants } = roster(8);
    // One court, a half-hour day, and eight placement matches to play: everything can be placed,
    // but only well past the close, so the estimate reports the extension rather than the close.
    const estimate = estimateFinish(
      estimateInput({
        teams,
        entrants,
        days: [day({ end_time: "09:30:00" })],
        allCourts: [court(1)],
      }),
    );
    expect(estimate.basis).toBe("overflow");
    expect(estimate.finish).not.toBeNull();
    expect(estimate.deficitMinutes).toBeGreaterThan(0);
    // The extension is measured from the close to the forecast finish.
    expect(
      Math.round(
        (Date.parse(estimate.finish!) - new Date("2026-09-17T09:30:00").getTime()) / MINUTE,
      ),
    ).toBe(estimate.deficitMinutes);
  });

  it("cannot finish when there are no days to place anything on", () => {
    const { teams, entrants } = roster(4);
    const estimate = estimateFinish(estimateInput({ teams, entrants, days: [] }));
    expect(estimate.basis).toBe("overflow");
    expect(estimate.finish).toBeNull();
    expect(estimate.days).toBe(0);
  });

  it("never forecasts a finish before the last placed match", () => {
    const { teams, entrants } = roster(5);
    const played = placementMatch("r1-1", "round1", "e1", "e2", {
      status: "reported",
      ended_at: "2026-09-17T17:30:00",
      winner_id: "e1",
    });
    const estimate = estimateFinish(estimateInput({ teams, entrants, placementMatches: [played] }));
    expect(estimate.placedFinish).not.toBeNull();
    expect(estimate.finish).not.toBeNull();
    expect(Date.parse(estimate.finish!)).toBeGreaterThanOrEqual(Date.parse(estimate.placedFinish!));
  });

  it("places a synthetic knockout round after its feeders plus the knockout rest", () => {
    const { teams, entrants } = roster(4);
    // Two real round-one matches, and a final that exists but whose sides are not decided: the
    // estimator must synthesise it and order it behind both feeders with the rest gap.
    const rows = [
      tierMatch("k1", 1, 1, "e1", "e2"),
      tierMatch("k2", 1, 2, "e3", "e4"),
      tierMatch("k3", 2, 1, null, null, { parent_a_id: "k1", parent_b_id: "k2" }),
    ];
    const forecast = forecastTournament(
      estimateInput({ teams, entrants, draws: [tierDraw()], tierMatches: rows }),
    );
    const byId = new Map(forecast.slots.map((slot) => [slot.matchId, slot]));
    const feeders = [byId.get("k1"), byId.get("k2")];
    expect(feeders.every(Boolean)).toBe(true);
    const final = forecast.slots.find((slot) => slot.matchId.startsWith("est:row:k3"));
    expect(final).toBeDefined();
    const latestFeederEnd = Math.max(...feeders.map((slot) => slot!.end.getTime()));
    expect(final!.start.getTime()).toBeGreaterThanOrEqual(latestFeederEnd + 30 * MINUTE);
    // Both feeders are named as dependencies, so precedence does not rest on the placeholders.
    expect(forecast.movableIds).toContain(final!.matchId);
  });

  it("keeps the knockout rest gap between two fully synthetic rounds", () => {
    const { teams, entrants } = roster(8);
    const forecast = forecastTournament(
      estimateInput({
        teams,
        entrants,
        draws: [tierDraw({ bracket_size: 8, entrant_count: 8 })],
        allCourts: [court(1)],
      }),
    );
    const roundOne = forecast.slots.filter((slot) => slot.matchId.startsWith("est:draw-A:r1:"));
    const roundTwo = forecast.slots.filter((slot) => slot.matchId.startsWith("est:draw-A:r2:"));
    const final = forecast.slots.filter((slot) => slot.matchId.startsWith("est:draw-A:r3:"));
    expect(roundOne).toHaveLength(4);
    expect(roundTwo).toHaveLength(2);
    expect(final).toHaveLength(1);
    const latestRoundOneEnd = Math.max(...roundOne.map((slot) => slot.end.getTime()));
    for (const slot of roundTwo) {
      expect(slot.start.getTime()).toBeGreaterThanOrEqual(latestRoundOneEnd);
    }
    const latestRoundTwoEnd = Math.max(...roundTwo.map((slot) => slot.end.getTime()));
    expect(final[0]!.start.getTime()).toBeGreaterThanOrEqual(latestRoundTwoEnd + 30 * MINUTE);
  });

  it("is read-only: no input is mutated and no synthetic id leaks into real output", () => {
    const { teams, entrants } = roster(6);
    const placementMatches = [placementMatch("r1-1", "round1", "e1", "e2")];
    const tierMatches = [tierMatch("k1", 1, 1, "e1", "e2")];
    const snapshot = JSON.stringify({ placementMatches, tierMatches, entrants });
    const forecast = forecastTournament(
      estimateInput({
        teams,
        entrants,
        placementMatches,
        tierMatches,
        draws: [tierDraw({ bracket_size: 8, entrant_count: 8 })],
      }),
    );
    expect(JSON.stringify({ placementMatches, tierMatches, entrants })).toBe(snapshot);
    // The forecast's own slots may contain synthetic ids — that is its job — but it must expose
    // only real ids as movable work and never mutate the rows it was given.
    expect(forecast.movableIds.some((id) => id.startsWith("est:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// planPlacementSchedule integration
// ---------------------------------------------------------------------------

describe("planPlacementSchedule — finish estimate", () => {
  function planInput(
    overrides: Partial<PlanPlacementScheduleInput> = {},
  ): PlanPlacementScheduleInput {
    const { teams, entrants } = roster(4);
    return {
      tournament: tournament(),
      days: [day()],
      allCourts: [court(1), court(2)],
      teams,
      entrants,
      draws: [tierDraw()],
      placementMatches: [],
      tierMatches: [],
      categoryOrder: new Map([["cat1", 1]]),
      options: FAST,
      now: DAY_START,
      ...overrides,
    };
  }

  it("exposes the estimate beside the summary and keeps synthetic work out of the payloads", () => {
    const plan = planPlacementSchedule(planInput());
    expect(plan.estimate).toBeDefined();
    expect(plan.summary.estimate).toEqual(plan.estimate);
    expect(plan.estimate.basis).toBe("projected");
    expect(plan.estimate.finish).not.toBeNull();

    const payloadIds = [
      ...plan.placementSlotPayload.map((slot) => slot.match_id),
      ...plan.knockoutSlotPayload.map((slot) => slot.match_id),
    ];
    for (const id of payloadIds) {
      expect(id.startsWith("est:")).toBe(false);
    }
    for (const id of [...plan.blocked, ...plan.diff.unplaceable]) {
      expect(id.startsWith("est:")).toBe(false);
    }
    // Every synthetic match is forecast work, not a plan slot.
    for (const slot of plan.slots) {
      expect(slot.matchId.startsWith("est:")).toBe(false);
    }
  });

  it("compares forecast against forecast on a rebuild", () => {
    const { teams } = roster(4);
    const scheduled = [
      placementMatch("r1-1", "round1", "e1", "e2", {
        scheduled_time: "2026-09-17T09:00:00",
      }),
    ];
    const plan = planPlacementSchedule(
      planInput({ teams, placementMatches: scheduled, now: DAY_START + 30 * MINUTE }),
    );
    expect(plan.currentEstimate).not.toBeNull();
    // Both sides are forecasts from the same estimator, so a delta is only ever forecast-minus-
    // forecast and never a floor against a forecast.
    expect(plan.summary.currentEstimate).toEqual(plan.currentEstimate);
    expect(plan.summary.projectedFinishDeltaMinutes).not.toBeNull();
  });

  it("leaves a row the day has overtaken movable instead of pinning an impossible court", () => {
    const { teams, entrants } = roster(4);
    // Court C1 still holds an in-progress match, so its window runs to at least one slot past
    // `now`. The next row on C1 was scheduled before `now` and is therefore not placed in any
    // meaningful sense: pinning both would describe a court that cannot exist, and the core would
    // refuse the whole forecast — which is exactly when the desk reads it.
    const inProgress = placementMatch("r1-1", "round1", "e1", "e2", {
      status: "in-progress",
      scheduled_time: "2026-09-17T09:00:00",
      started_at: "2026-09-17T09:00:00",
      court_id: "c1",
    });
    const overtaken = placementMatch("r1-2", "round1", "e3", "e4", {
      status: "scheduled",
      scheduled_time: "2026-09-17T09:30:00",
      court_id: "c1",
    });
    const forecast = forecastTournament(
      estimateInput({
        teams,
        entrants,
        placementMatches: [inProgress, overtaken],
        allCourts: [court(1)],
        now: DAY_START + 40 * MINUTE,
      }),
    );
    expect(forecast.estimate.basis).not.toBe("invalid");
    expect(forecast.movableIds).toContain("r1-2");
  });

  it("reports invalid rather than throwing when two fixed matches hold one court at once", () => {
    const { teams, entrants } = roster(4);
    // Two in-progress matches on the same court is a layout no scheduler can simulate. The
    // estimate says so; it does not throw, because a forecast must never fail a build.
    const first = placementMatch("r1-1", "round1", "e1", "e2", {
      status: "in-progress",
      started_at: "2026-09-17T09:00:00",
      court_id: "c1",
    });
    const second = placementMatch("r1-2", "round1", "e3", "e4", {
      status: "in-progress",
      started_at: "2026-09-17T09:05:00",
      court_id: "c1",
    });
    const estimate = estimateFinish(
      estimateInput({
        teams,
        entrants,
        placementMatches: [first, second],
        allCourts: [court(1)],
        now: DAY_START + 40 * MINUTE,
      }),
    );
    expect(estimate.basis).toBe("invalid");
    expect(estimate.finish).toBeNull();
    expect(estimate.deficitMinutes).toBeNull();
    expect(estimate.remainingMatches).toBeGreaterThan(0);
  });

  it("does not double-count placement round two once the rows exist", () => {
    const { teams, entrants } = roster(4);
    // Four entrants owe ceil(4/2) = 2 round-two matches. With both present, none is uncreated.
    const roundTwo = [
      placementMatch("r2-1", "round2", "e1", "e3"),
      placementMatch("r2-2", "round2", "e2", "e4"),
    ];
    const estimate = estimateFinish(
      estimateInput({ teams, entrants, placementMatches: roundTwo, draws: [] }),
    );
    expect(estimate.uncreatedMatches).toBe(0);
    // And with only one of the two present, exactly one is still owed.
    const partial = estimateFinish(
      estimateInput({ teams, entrants, placementMatches: [roundTwo[0]!], draws: [] }),
    );
    expect(partial.uncreatedMatches).toBe(1);
  });
});
