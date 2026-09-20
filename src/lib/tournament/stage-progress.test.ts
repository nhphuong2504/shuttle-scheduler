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

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe("placement stage progress", () => {
  /** A field of four: two round-one matches, then two round-two matches. */
  const fourEntrants = [entrant("e1", 1), entrant("e2", 2), entrant("e3", 3), entrant("e4", 4)];

  it("emits a row per round the field has, with nothing created yet", () => {
    const rows = buildStageProgress({
      categories: [category()],
      entrants: fourEntrants,
      placementMatches: [],
    });

    expect(rows.map((row) => row.key)).toEqual(["placement:cat1:r1", "placement:cat1:r2"]);
    expect(rows.map((row) => row.roundLabel)).toEqual(["Round 1", "Round 2"]);
    expect(rows.every((row) => row.stageLabel === "Placement")).toBe(true);
    expect(rows.every((row) => row.eventLabel === "MS")).toBe(true);
    // Progress is reported against the rows that exist, so nothing generated means zeroes and
    // no invented total for the rounds that have not been created.
    expect(rows.map((row) => row.created)).toEqual([0, 0]);
    expect(rows.map((row) => row.completed)).toEqual([0, 0]);
    expect(rows.every((row) => !("expected" in row))).toBe(true);
  });

  it("will not offer round one before the seeds are locked", () => {
    // Seeding is a separate step: until every entrant has a seed, round one has no pairing to
    // generate, even though the field size already says how many matches there will be.
    const unseeded = [
      entrant("e1", null),
      entrant("e2", null),
      entrant("e3", null),
      entrant("e4", null),
    ];
    const row = find(
      buildStageProgress({ categories: [category()], entrants: unseeded, placementMatches: [] }),
      "placement:cat1:r1",
    );
    expect(row.canAdvance).toBe(false);
    expect(row.blockedReason).toBe("Seeds are not locked yet");
  });

  it("offers round one once the seeds are locked", () => {
    const locked = fourEntrants.map((row) => ({
      ...row,
      seed_locked_at: "2026-09-17T00:00:00Z",
    }));
    const row = find(
      buildStageProgress({ categories: [category()], entrants: locked, placementMatches: [] }),
      "placement:cat1:r1",
    );
    expect(row.canAdvance).toBe(true);
    expect(row.advanceLabel).toBe("Ready to generate round one");
  });

  it("counts a walkover as completed without claiming the field is done", () => {
    const matches = [
      placementMatch("r1-a", "round1", "e1", "e2", { status: "reported", winner_id: "e1" }),
      placementMatch("r1-b", "round1", "e3", "e4", { status: "walkover", winner_id: "e3" }),
    ];
    const rows = buildStageProgress({
      categories: [category()],
      entrants: fourEntrants,
      placementMatches: matches,
    });

    expect(find(rows, "placement:cat1:r1").completed).toBe(2);
    expect(find(rows, "placement:cat1:r1").created).toBe(2);
    // Both round-one matches are decided, so round two can be generated now.
    const roundTwo = find(rows, "placement:cat1:r2");
    expect(roundTwo.canAdvance).toBe(true);
    expect(roundTwo.advanceLabel).toBe("Ready to generate round two");
  });

  it("will not offer round two while round one is undecided", () => {
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
    expect(roundTwo.canAdvance).toBe(false);
    expect(roundTwo.blockedReason).toBe("1 match still to decide in round one");
  });

  it("reports draws readiness once every entrant has played both matches", () => {
    // The gate is the same one the Placement tab gates its generate buttons on, and this is
    // what absorbs the Desk's removed "Draws ready" link.
    const matches = [
      placementMatch("r1-a", "round1", "e1", "e2", { status: "reported", winner_id: "e1" }),
      placementMatch("r1-b", "round1", "e3", "e4", { status: "reported", winner_id: "e3" }),
      placementMatch("r2-a", "round2", "e1", "e3", { status: "reported", winner_id: "e1" }),
      placementMatch("r2-b", "round2", "e2", "e4", { status: "reported", winner_id: "e2" }),
    ];
    const roundTwo = find(
      buildStageProgress({
        categories: [category()],
        entrants: fourEntrants,
        placementMatches: matches,
      }),
      "placement:cat1:r2",
    );
    expect(roundTwo.completed).toBe(2);
    expect(roundTwo.canAdvance).toBe(true);
    expect(roundTwo.advanceLabel).toBe("Draws ready");
  });

  it("names the entrants still short of results while the placement stage runs", () => {
    const matches = [
      placementMatch("r1-a", "round1", "e1", "e2", { status: "reported", winner_id: "e1" }),
      placementMatch("r1-b", "round1", "e3", "e4", { status: "reported", winner_id: "e3" }),
      placementMatch("r2-a", "round2", "e1", "e3", { status: "reported", winner_id: "e1" }),
      placementMatch("r2-b", "round2", "e2", "e4"),
    ];
    const roundTwo = find(
      buildStageProgress({
        categories: [category()],
        entrants: fourEntrants,
        placementMatches: matches,
      }),
      "placement:cat1:r2",
    );
    expect(roundTwo.canAdvance).toBe(false);
    expect(roundTwo.blockedReason).toBe("2 entrants still need placement results");
  });

  it("gives a field of two only a round one", () => {
    const rows = buildStageProgress({
      categories: [category()],
      entrants: [entrant("e1", 1), entrant("e2", 2)],
      placementMatches: [],
    });
    expect(rows.map((row) => row.key)).toEqual(["placement:cat1:r1"]);
    expect(rows[0]!.created).toBe(0);
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
  it("reports only the rounds the draw actually has", () => {
    expect(buildStageProgress({ tierDraws: [tierDraw()], tierMatches: [] })).toEqual([]);

    const rows = buildStageProgress({
      tierDraws: [tierDraw()],
      tierMatches: [tierMatch("r1-a", 1, 1, { status: "scheduled" })],
    });
    expect(rows.map((row) => row.roundLabel)).toEqual(["Round 1"]);
    expect(rows[0]!.created).toBe(1);
    expect(rows[0]!.completed).toBe(0);
  });

  it("carries the draw's own tier label rather than a hardcoded one", () => {
    const rows = buildStageProgress({
      tierDraws: [tierDraw({ tier: "C" })],
      tierMatches: [tierMatch("r1-a", 1, 1, { status: "scheduled" })],
    });
    expect(rows.every((row) => row.stageLabel === "Tier C")).toBe(true);
  });

  it("excludes byes from both counts, so an all-bye round has no row", () => {
    // A bracket of four with two entrants is two byes and one real match: round one has
    // nothing to play, so it contributes no progress row at all.
    const rows = buildStageProgress({
      tierDraws: [tierDraw({ bracket_size: 4, entrant_count: 2 })],
      tierMatches: [
        tierMatch("bye-1", 1, 1, { is_bye: true, status: "bye", winner_id: "x" }),
        tierMatch("bye-2", 1, 2, { is_bye: true, status: "bye", winner_id: "y" }),
        tierMatch("final", 2, 1, { status: "scheduled" }),
      ],
    });
    expect(rows.map((row) => row.key)).toEqual(["tier:draw-A:r2"]);
    const final = find(rows, "tier:draw-A:r2");
    expect(final.created).toBe(1);
    expect(final.completed).toBe(0);
  });

  it("offers the next round only once the deepest round is fully decided", () => {
    const pending = buildStageProgress({
      tierDraws: [tierDraw()],
      tierMatches: [
        tierMatch("r1-a", 1, 1, { status: "reported", winner_id: "e1" }),
        tierMatch("r1-b", 1, 2),
      ],
    });
    const roundOne = find(pending, "tier:draw-A:r1");
    expect(roundOne.canAdvance).toBe(false);
    expect(roundOne.blockedReason).toBe("1 match still to decide in round 1");

    const decided = buildStageProgress({
      tierDraws: [tierDraw()],
      tierMatches: [
        tierMatch("r1-a", 1, 1, { status: "reported", winner_id: "e1" }),
        tierMatch("r1-b", 1, 2, { status: "reported", winner_id: "e2" }),
      ],
    });
    const ready = find(decided, "tier:draw-A:r1");
    expect(ready.canAdvance).toBe(true);
    expect(ready.advanceLabel).toBe("Ready for round 2");
  });

  it("offers nothing after the final round", () => {
    const rows = buildStageProgress({
      tierDraws: [tierDraw({ champion_id: "e1" })],
      tierMatches: [
        tierMatch("r1-a", 1, 1, { status: "reported", winner_id: "e1" }),
        tierMatch("r1-b", 1, 2, { status: "reported", winner_id: "e2" }),
        tierMatch("final", 2, 1, { status: "reported", winner_id: "e1" }),
      ],
    });
    const final = find(rows, "tier:draw-A:r2");
    expect(final.canAdvance).toBe(false);
    expect(final.blockedReason).toBeNull();
  });

  it("ignores a draw with no bracket", () => {
    expect(
      buildStageProgress({ tierDraws: [tierDraw({ bracket_size: 1, entrant_count: 1 })] }),
    ).toEqual([]);
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
    expect(rows[0]!.stageLabel).toBe("Group");
    expect(rows[0]!.roundLabel).toBe("Pool 1");
    expect(rows[0]!.created).toBe(0);
    // The pool's fixture list is generated rather than forecast, so the outstanding count is
    // known before a single match row exists.
    expect(expected).toBe(6);
    expect(rows[0]!.blockedReason).toBe("6 matches still to come");
  });

  it("keeps its pool name as the row label rather than inventing one", () => {
    const rows = buildStageProgress({
      pools: [pool({ name: "Group B" })],
      poolEntries: entries,
      poolMatches: [],
    });
    expect(rows[0]!.roundLabel).toBe("Group B");
  });

  it("offers the draw once every pool result is in", () => {
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
    expect(rows[0]!.canAdvance).toBe(true);
    expect(rows[0]!.advanceLabel).toBe("Ready for the draw");
  });

  it("names how many results a running pool still owes", () => {
    const rows = buildStageProgress({
      pools: [pool()],
      poolEntries: entries,
      poolMatches: [poolMatch("pm1", "t1", "t2", { status: "reported", winner_id: "t1" })],
    });
    expect(rows[0]!.canAdvance).toBe(false);
    expect(rows[0]!.blockedReason).toBe("5 matches still to come");
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
    expect(rows[0]!.created).toBe(1);
    expect(rows[0]!.completed).toBe(1);
    expect(rows[1]!.created).toBe(1);
    expect(rows[1]!.completed).toBe(0);
    // The legacy draw rounds report progress only; the desk drives their generation.
    expect(rows.every((row) => !row.canAdvance)).toBe(true);
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
    expect(rows.map((row) => row.eventLabel)).toEqual(["WS", "MS"]);
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
