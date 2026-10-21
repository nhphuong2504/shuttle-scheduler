import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  Category,
  Draw,
  DrawMatch,
  PlacementEntrant,
  PlacementMatch,
  Pool,
  PoolEntry,
  PoolMatch,
  TierDraw,
  TierDrawMatch,
} from "./data";
import { buildRoundRobin } from "./scheduling/formats/round-robin";
import { buildStageProgress, type StageProgressRow } from "./stage-progress";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOURNAMENT_ID = "t1";
const CATEGORY_ID = "cat1";

it("counts unopened feeder slots while rounds one and two are both active", () => {
  const field = Array.from({ length: 8 }, (_, i) => entrant(`e${i + 1}`, i + 1));
  const r1 = Array.from({ length: 4 }, (_, i) =>
    placementMatch(
      `r1-${i + 1}`,
      "round1",
      `e${i + 1}`,
      `e${i + 5}`,
      i % 2 === 0 ? { status: "reported", winner_id: `e${i + 1}` } : {},
    ),
  );
  const rows = buildStageProgress({
    categories: [category()],
    entrants: field,
    placementMatches: [
      ...r1,
      placementMatch("r2-1", "round2", "e1", "e3", { status: "reported", winner_id: "e1" }),
    ],
  });
  expect(rows.find((r) => r.key === "placement:cat1:r1")?.status).toBe("current");
  const r2 = rows.find((r) => r.key === "placement:cat1:r2");
  expect(r2).toMatchObject({ status: "current", total: 4, completed: 1, remaining: 3 });
});

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: CATEGORY_ID,
    tournament_id: TOURNAMENT_ID,
    code: "MS",
    name: "Men's singles",
    sort_order: 1,
    active: true,
    entry_type: "singles",
    gender: "open",
    max_entries: null,
    created_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function entrant(
  id: string,
  seed: number | null,
  overrides: Partial<PlacementEntrant> = {},
): PlacementEntrant {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    category_id: CATEGORY_ID,
    team_id: `team-${id}`,
    skill_level: "intermediate",
    seed,
    tier: null,
    excluded: false,
    seed_locked_at: null,
    created_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
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
    category_id: CATEGORY_ID,
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
    category_id: CATEGORY_ID,
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
  overrides: Partial<TierDrawMatch> = {},
): TierDrawMatch {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    draw_id: "draw-A",
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

function pool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: "pool-1",
    tournament_id: TOURNAMENT_ID,
    category_id: CATEGORY_ID,
    name: "Pool 1",
    size: 4,
    scheduled_end: null,
    created_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function poolEntry(id: string, teamId: string, position: number): PoolEntry {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    pool_id: "pool-1",
    team_id: teamId,
    position,
    manual_rank_override: null,
  };
}

function poolMatch(
  id: string,
  teamA: string,
  teamB: string,
  overrides: Partial<PoolMatch> = {},
): PoolMatch {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    category_id: CATEGORY_ID,
    pool_id: "pool-1",
    round: 1,
    team_a_id: teamA,
    team_b_id: teamB,
    winner_id: null,
    score_a: null,
    score_b: null,
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

const find = (rows: StageProgressRow[], key: string): StageProgressRow => {
  const row = rows.find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no stage progress row for ${key}`);
  return row;
};

/** A field of four with its seeds frozen, so round one can be generated. */
const fourEntrants = [entrant("e1", 1),
  entrant("e2", 2),
  entrant("e3", 3),
  entrant("e4", 4)];

/** Round one decided, round two created but not played out. */
const roundTwoInProgress = [
  placementMatch("r1-a", "round1", "e1", "e2", { status: "reported", winner_id: "e1" }),
  placementMatch("r1-b", "round1", "e3", "e4", { status: "reported", winner_id: "e3" }),
  placementMatch("r2-a", "round2", "e1", "e3", { status: "reported", winner_id: "e1" }),
  placementMatch("r2-b", "round2", "e2", "e4"),
];

/** Both placement rounds played out, so every entrant holds their full record. */
const placementComplete = [
  placementMatch("r1-a", "round1", "e1", "e2", { status: "reported", winner_id: "e1" }),
  placementMatch("r1-b", "round1", "e3", "e4", { status: "reported", winner_id: "e3" }),
  placementMatch("r2-a", "round2", "e1", "e3", { status: "reported", winner_id: "e1" }),
  placementMatch("r2-b", "round2", "e2", "e4", { status: "reported", winner_id: "e2" }),
];

/** One bracket of four, its first round decided and its final still to play. */
const knockoutInProgress = [
  tierMatch("k1", 1, 1, { status: "reported", winner_id: "e1" }),
  tierMatch("k2", 1, 2, { status: "reported", winner_id: "e3" }),
  tierMatch("k3", 2, 1),
];

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

describe("placement pipeline", () => {
  it("lays out one event's stages in pipelined order", () => {
    const rows = buildStageProgress({
      categories: [category()],
      entrants: fourEntrants,
      placementMatches: [],
    });

    expect(rows.map((row) => row.key)).toEqual([
      "placement:cat1:r1",
      "placement:cat1:r2",
      "knockout:cat1",
    ]);
    expect(rows.map((row) => row.stageLabel)).toEqual(["Round 1", "Round 2", "Knockout"]);
    expect(rows.every((row) => row.eventLabel === "MS")).toBe(true);
    // Nothing is generated, so every stage is waiting and nothing has a count yet.
    expect(rows.map((row) => row.status)).toEqual(["waiting", "waiting", "waiting"]);
    expect(rows.map((row) => row.total)).toEqual([0, 0, 0]);
  });

  it("withholds round one until the seeds are locked", () => {
    // Seeding is a separate step: with no seed order there is no pairing to generate, even
    // though the field size already says how many matches there will be.
    const unseeded = fourEntrants.map((row) => ({ ...row, seed: null }));
    const row = find(
      buildStageProgress({ categories: [category()], entrants: unseeded, placementMatches: [] }),
      "placement:cat1:r1",
    );

    expect(row.status).toBe("waiting");
    expect(row.action).toBeNull();
    expect(row.note).toBe("Seeds are not locked yet");
  });

  it("offers round one once the seeds are locked", () => {
    const row = find(
      buildStageProgress({ categories: [category()], entrants: fourEntrants, placementMatches: [], }),
      "placement:cat1:r1",
    );

    expect(row.status).toBe("waiting");
    expect(row.note).toBe("Ready to generate");
    expect(row.action).toEqual({
      kind: "generate",
      label: "Generate Round 1",
      scopeId: "cat1",
    });
  });

  it("reports a running round in matches, and offers the results surface", () => {
    const rows = buildStageProgress({
      categories: [category()],
      entrants: fourEntrants,
      placementMatches: roundTwoInProgress,
    });

    const roundOne = find(rows, "placement:cat1:r1");
    expect(roundOne.status).toBe("completed");
    expect(roundOne.total).toBe(2);
    expect(roundOne.completed).toBe(2);
    expect(roundOne.remaining).toBe(0);
    expect(roundOne.action).toBeNull();

    const roundTwo = find(rows, "placement:cat1:r2");
    expect(roundTwo.status).toBe("current");
    expect(roundTwo.total).toBe(2);
    expect(roundTwo.completed).toBe(1);
    expect(roundTwo.remaining).toBe(1);
    expect(roundTwo.action).toEqual({ kind: "enter-results", label: "Enter Results", scopeId: null, });
  });

  it("counts a running round in matches even when every undecided one involves two entrants", () => {
    // The bug this pipeline replaces: once round two existed, progress switched from matches to
    // entrants and a single undecided match read as "2 entrants still need placement results".
    // The stage still owes one match, and that is what it must say.
    const rows = buildStageProgress({
      categories: [category()],
      entrants: fourEntrants,
      placementMatches: roundTwoInProgress,
    });

    const roundTwo = find(rows, "placement:cat1:r2");
    expect(roundTwo.remaining).toBe(1);
    expect(roundTwo.completed).toBe(1);
    // No row anywhere may describe progress in entrants.
    expect(JSON.stringify(rows)).not.toMatch(/entrant/i);
  });

  it("offers round two the moment round one is decided", () => {
    const matches = [
      placementMatch("r1-a", "round1", "e1", "e2", { status: "reported", winner_id: "e1" }),
      placementMatch("r1-b", "round1", "e3", "e4", { status: "walkover", winner_id: "e3" }),
    ];
    const rows = buildStageProgress({
      categories: [category()],
      entrants: fourEntrants,
      placementMatches: matches,
    });

    // A walkover is decided, so round one is complete and round two is ready to be created.
    expect(find(rows, "placement:cat1:r1").completed).toBe(2);
    expect(find(rows, "placement:cat1:r1").status).toBe("completed");

    const roundTwo = find(rows, "placement:cat1:r2");
    expect(roundTwo.status).toBe("waiting");
    expect(roundTwo.note).toBe("Ready to generate");
    expect(roundTwo.action?.label).toBe("Generate Round 2");
  });

  it("names the stage a waiting round is waiting on, rather than counting entrants", () => {
    const matches = [
      placementMatch("r1-a", "round1", "e1", "e2", { status: "reported", winner_id: "e1" }),
      placementMatch("r1-b", "round1", "e3", "e4"),
    ];
    const roundTwo = find(
      buildStageProgress({
        categories: [category()],
        entrants: fourEntrants,
        placementMatches: matches,
      }),
      "placement:cat1:r2",
    );

    expect(roundTwo.status).toBe("waiting");
    expect(roundTwo.action).toBeNull();
    expect(roundTwo.note).toBe("Waiting on Round 1");
  });

  it("offers the knockout once the placement stage is played out", () => {
    const rows = buildStageProgress({
      categories: [category()],
      entrants: fourEntrants,
      placementMatches: placementComplete,
    });

    expect(find(rows, "placement:cat1:r1").status).toBe("completed");
    expect(find(rows, "placement:cat1:r2").status).toBe("completed");

    const knockout = find(rows, "knockout:cat1");
    expect(knockout.status).toBe("waiting");
    expect(knockout.note).toBe("Ready to generate");
    expect(knockout.action).toEqual({
      kind: "generate",
      label: "Generate Knockout",
      scopeId: "cat1",
    });
    // The event is not finished, so there is no terminal stage yet.
    expect(rows.some((row) => row.key.startsWith("complete:"))).toBe(false);
  });

  it("gives a field of two round one and the knockout, with no round two", () => {
    const rows = buildStageProgress({
      categories: [category()],
      entrants: [entrant("e1", 1), entrant("e2", 2)],
      placementMatches: [],
    });

    expect(rows.map((row) => row.key)).toEqual(["placement:cat1:r1", "knockout:cat1"]);
    // Round one is all this event plays, so the knockout is what it waits on after it.
    expect(find(rows, "knockout:cat1").note).toBe("Waiting on Round 1");
  });

  it("settles a field of two once its champion-only brackets exist", () => {
    // Two entrants sort into two one-player brackets, which hold no matches at all. The stage
    // still has to settle, or the event would offer to generate a knockout it already has and
    // the terminal stage would never arrive.
    const rows = buildStageProgress({
      categories: [category()],
      entrants: [entrant("e1", 1), entrant("e2", 2)],
      placementMatches: [
        placementMatch("r1-a", "round1", "e1", "e2", { status: "reported", winner_id: "e1" }),
      ],
      tierDraws: [
        tierDraw({ id: "draw-A", tier: "A", bracket_size: 1, entrant_count: 1, champion_id: "e1" }),
        tierDraw({ id: "draw-D", tier: "D", bracket_size: 1, entrant_count: 1, champion_id: "e2" }),
      ],
    });

    const knockout = find(rows, "knockout:cat1");
    expect(knockout.status).toBe("completed");
    expect(knockout.action).toBeNull();

    expect(rows.map((row) => row.stageLabel)).toEqual([
      "Round 1",
      "Knockout",
      "Tournament Complete",
    ]);
  });

  it("adds no rows for a waived-only field", () => {
    const rows = buildStageProgress({
      categories: [category()],
      entrants: [entrant("e1", 1, { excluded: true })],
      placementMatches: [],
    });
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Knockout
// ---------------------------------------------------------------------------

describe("knockout stage progress", () => {
  it("sizes the bracket from the draw, so a half-generated one is not called complete", () => {
    // A bracket of four plays three matches. Two of them are decided and the final does not
    // exist yet, so a count taken from the rows that exist would report "2 / 2 completed" and
    // call the event finished.
    const rows = buildStageProgress({
      tierDraws: [tierDraw()],
      tierMatches: knockoutInProgress,
    });

    expect(rows).toHaveLength(1);
    const row = find(rows, "knockout:cat1");
    expect(row.total).toBe(3);
    expect(row.completed).toBe(2);
    expect(row.remaining).toBe(1);
    expect(row.status).toBe("current");
    expect(row.action?.label).toBe("Enter Results");
  });

  it("completes once every match of every bracket is decided", () => {
    const rows = buildStageProgress({
      tierDraws: [tierDraw()],
      tierMatches: [
        ...knockoutInProgress.slice(0, 2),
        tierMatch("k3", 2, 1, { status: "reported", winner_id: "e1" }),
      ],
    });

    const row = find(rows, "knockout:cat1");
    expect(row.total).toBe(3);
    expect(row.completed).toBe(3);
    expect(row.remaining).toBe(0);
    expect(row.status).toBe("completed");
    expect(row.action).toBeNull();
  });

  it("excludes byes from the bracket's size", () => {
    // A bracket of four holding two entrants is two byes and one match to play.
    const rows = buildStageProgress({
      tierDraws: [tierDraw({ bracket_size: 4, entrant_count: 2 })],
      tierMatches: [
        tierMatch("bye-1", 1, 1, { is_bye: true, status: "bye", winner_id: "e1" }),
        tierMatch("bye-2", 1, 2, { is_bye: true, status: "bye", winner_id: "e2" }),
        tierMatch("final", 2, 1),
      ],
    });

    const row = find(rows, "knockout:cat1");
    expect(row.total).toBe(1);
    expect(row.completed).toBe(0);
    expect(row.remaining).toBe(1);
    expect(row.status).toBe("current");
  });

  it("reports one stage for every tier of an event, not one per bracket", () => {
    // The four brackets are generated by one action and finish together, so they are one stage.
    const rows = buildStageProgress({
      tierDraws: [
        tierDraw({ id: "draw-A", tier: "A", bracket_size: 4, entrant_count: 4 }),
        tierDraw({ id: "draw-B", tier: "B", bracket_size: 4, entrant_count: 4 }),
      ],
      tierMatches: [
        tierMatch("a1", 1, 1, { status: "reported", winner_id: "e1" }),
        tierMatch("a2", 1, 2, { status: "reported", winner_id: "e3" }),
        tierMatch("a3", 2, 1, { status: "reported", winner_id: "e1" }),
        tierMatch("b1", 1, 1, { draw_id: "draw-B", status: "reported", winner_id: "e2" }),
        tierMatch("b2", 1, 2, { draw_id: "draw-B" }),
        tierMatch("b3", 2, 1, { draw_id: "draw-B" }),
      ],
    });

    const knockouts = rows.filter((row) => row.stageLabel === "Knockout");
    expect(knockouts).toHaveLength(1);
    expect(knockouts[0]!.total).toBe(6);
    expect(knockouts[0]!.completed).toBe(4);
    expect(knockouts[0]!.remaining).toBe(2);
  });

  it("reports a draw whose event was not passed in rather than dropping it", () => {
    const rows = buildStageProgress({
      tierDraws: [tierDraw()],
      tierMatches: [tierMatch("k1", 1, 1, { status: "reported", winner_id: "e1" })],
    });

    expect(rows.map((row) => row.key)).toEqual(["knockout:cat1"]);
    expect(rows[0]!.eventLabel).toBeNull();
  });

  it("ignores a draw with no bracket", () => {
    expect(
      buildStageProgress({ tierDraws: [tierDraw({ bracket_size: 1, entrant_count: 1 })] }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tournament complete
// ---------------------------------------------------------------------------

describe("the terminal stage", () => {
  it("arrives only when every stage of the event is done", () => {
    const rows = buildStageProgress({
      categories: [category()],
      entrants: fourEntrants,
      placementMatches: placementComplete,
      tierDraws: [tierDraw()],
      tierMatches: [
        ...knockoutInProgress.slice(0, 2),
        tierMatch("k3", 2, 1, { status: "reported", winner_id: "e1" }),
      ],
    });

    expect(rows.map((row) => row.stageLabel)).toEqual([
      "Round 1",
      "Round 2",
      "Knockout",
      "Tournament Complete",
    ]);
    const complete = rows[rows.length - 1]!;
    expect(complete.status).toBe("completed");
    // It carries no count: there is nothing left to measure, which is what it says.
    expect(complete.total).toBe(0);
    expect(complete.remaining).toBe(0);
    expect(complete.action).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round robin
// ---------------------------------------------------------------------------

describe("round-robin stage progress", () => {
  const entries = [
    poolEntry("pe1", "t1", 1),
    poolEntry("pe2", "t2", 2),
    poolEntry("pe3", "t3", 3),
    poolEntry("pe4", "t4", 4),
  ];

  it("takes a pool's outstanding count from the round-robin generator", () => {
    const rows = buildStageProgress({ pools: [pool()], poolEntries: entries, poolMatches: [] });
    const expected = buildRoundRobin({
      entrants: ["t1", "t2", "t3", "t4"],
      groupKey: "pool-1",
    }).length;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("pool:pool-1");
    expect(rows[0]!.eventLabel).toBeNull();
    expect(rows[0]!.stageLabel).toBe("Group");
    expect(rows[0]!.roundLabel).toBe("Pool 1");
    // The pool's fixture list is generated rather than forecast, so the outstanding count is
    // known before a single match row exists.
    expect(expected).toBe(6);
    expect(rows[0]!.total).toBe(6);
    expect(rows[0]!.completed).toBe(0);
    expect(rows[0]!.remaining).toBe(6);
    // Nothing has been created, so there is nothing to score and nothing to advance.
    expect(rows[0]!.status).toBe("waiting");
    expect(rows[0]!.action).toBeNull();
  });

  it("counts a running pool in matches and offers its results", () => {
    const rows = buildStageProgress({
      pools: [pool()],
      poolEntries: entries,
      poolMatches: [poolMatch("pm1", "t1", "t2", { status: "reported", winner_id: "t1" })],
    });

    expect(rows[0]!.completed).toBe(1);
    expect(rows[0]!.remaining).toBe(5);
    expect(rows[0]!.status).toBe("current");
    expect(rows[0]!.action?.label).toBe("Enter Results");
  });

  it("completes the pool once every fixture is played", () => {
    const pairs: [string, string][] = [
      ["t1", "t2"],
      ["t3", "t4"],
      ["t1", "t3"],
      ["t2", "t4"],
      ["t1", "t4"],
      ["t2", "t3"],
    ];
    const complete = pairs.map(([a, b], index) =>
      poolMatch(`pm${index}`, a, b, { status: "reported", winner_id: a }),
    );
    const rows = buildStageProgress({
      pools: [pool()],
      poolEntries: entries,
      poolMatches: complete,
    });

    expect(rows[0]!.completed).toBe(6);
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.note).toBe("Ready for the draw");
    expect(rows[0]!.action).toBeNull();
  });

  it("keeps its pool name as the row label rather than inventing one", () => {
    const rows = buildStageProgress({
      pools: [pool({ name: "Group B" })],
      poolEntries: entries,
      poolMatches: [],
    });
    expect(rows[0]!.roundLabel).toBe("Group B");
  });

  it("ignores a pool with fewer than two teams", () => {
    expect(
      buildStageProgress({ pools: [pool()], poolEntries: [poolEntry("pe1", "t1", 1)] }),
    ).toEqual([]);
  });

  it("splits legacy draws into one row per round", () => {
    const draw: Draw = {
      id: "legacy-A",
      tournament_id: TOURNAMENT_ID,
      category_id: CATEGORY_ID,
      tier: "A",
      bracket_size: 4,
      entrant_count: 4,
      created_at: "2026-09-17T00:00:00Z",
    };
    const drawMatch: DrawMatch = {
      id: "dm1",
      tournament_id: TOURNAMENT_ID,
      draw_id: "legacy-A",
      round: 1,
      slot: 1,
      team_a_id: "t1",
      team_b_id: "t2",
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
      status: "reported",
      note: null,
      created_at: "2026-09-17T00:00:00Z",
    };

    const rows = buildStageProgress({
      draws: [draw],
      drawMatches: [drawMatch, { ...drawMatch, id: "dm2", round: 2, slot: 1, status: "scheduled" }],
    });

    expect(rows.map((row) => row.roundLabel)).toEqual(["Round 1", "Round 2"]);
    expect(rows.map((row) => row.stageLabel)).toEqual(["Draw A", "Draw A"]);
    expect(rows[0]!.completed).toBe(1);
    expect(rows[0]!.status).toBe("completed");
    expect(rows[1]!.completed).toBe(0);
    expect(rows[1]!.status).toBe("current");
    // The legacy draw rounds report progress only; the desk drives their generation.
    expect(rows.every((row) => row.action === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ordering and format-agnosticism
// ---------------------------------------------------------------------------

describe("stage progress assembly", () => {
  it("orders events by the configured category order", () => {
    const rows = buildStageProgress({
      categories: [
        category({ id: "cat1", code: "MS", sort_order: 2 }),
        category({ id: "cat2", code: "WS", sort_order: 1 }),
      ],
      categoryOrder: new Map([
        ["cat1", 2],
        ["cat2", 1],
      ]),
      entrants: [
        entrant("e1", 1, { category_id: "cat1" }),
        entrant("e2", 2, { category_id: "cat1" }),
        entrant("e3", 1, { category_id: "cat2" }),
        entrant("e4", 2, { category_id: "cat2" }),
      ],
      placementMatches: [],
    });

    expect([...new Set(rows.map((row) => row.eventLabel))]).toEqual(["WS", "MS"]);
  });

  it("returns nothing for a tournament with no stages", () => {
    expect(buildStageProgress({})).toEqual([]);
  });

  it("keeps stage and tier literals out of the shared component", () => {
    // A new format must mean a new adapter, not an edit to the view. Everything the view shows
    // comes from a row, so the file must contain no stage or tier name of its own.
    const source = readFileSync(join(__dirname, "../../components/stage-progress.tsx"), "utf8");
    expect(source).not.toMatch(/\bR1\b|\bR2\b/);
    expect(source).not.toMatch(/Round 1|Round 2/);
    expect(source).not.toMatch(/["'`]A["'`]|["'`]B["'`]|["'`]C["'`]|["'`]D["'`]/);
    expect(source).not.toMatch(/Tier |Placement|Knockout|Group|Pool/);
  });

  it("imports no scheduler and no writer", () => {
    const source = readFileSync(join(__dirname, "stage-progress.ts"), "utf8");
    expect(source).not.toMatch(/planPlacementSchedule|applyPlacementSchedulePlan/);
    expect(source).not.toMatch(/supabase/);
  });
});
