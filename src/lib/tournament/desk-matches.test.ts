import { describe, expect, it } from "vitest";

import type {
  Category,
  DrawMatch,
  PlacementMatch,
  PoolMatch,
  Team,
  TierDraw,
  TierDrawMatch,
} from "./data";
import { buildDeskMatches, type DeskMatchSources } from "./desk-matches";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOURNAMENT_ID = "t1";
const CATEGORY_ID = "cat1";

const CREATED = "2026-09-17T00:00:00Z";

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
    created_at: CREATED,
    ...overrides,
  };
}

function team(id: string, overrides: Partial<Team> = {}): Team {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    category_id: CATEGORY_ID,
    player_1_id: `${id}-p1`,
    player_2_id: null,
    seed: null,
    withdrawn: false,
    created_at: CREATED,
    ...overrides,
  };
}

function tierDraw(id: string, tier: string, overrides: Partial<TierDraw> = {}): TierDraw {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    category_id: CATEGORY_ID,
    tier,
    bracket_size: 4,
    entrant_count: 3,
    champion_id: null,
    created_at: CREATED,
    ...overrides,
  };
}

function poolMatch(id: string, overrides: Partial<PoolMatch> = {}): PoolMatch {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    pool_id: "pool-1",
    category_id: CATEGORY_ID,
    round: 1,
    team_a_id: "team-a",
    team_b_id: "team-b",
    status: "reported",
    score_a: 21,
    score_b: 15,
    court_id: null,
    started_at: null,
    ended_at: null,
    scheduled_time: null,
    reported_time: null,
    note: null,
    winner_id: "team-a",
    created_at: CREATED,
    ...overrides,
  };
}

function drawMatch(id: string, overrides: Partial<DrawMatch> = {}): DrawMatch {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    draw_id: "draw-1",
    round: 1,
    slot: 1,
    team_a_id: "team-a",
    team_b_id: "team-b",
    status: "scheduled",
    games: [],
    is_bye: false,
    note: null,
    parent_a_id: null,
    parent_b_id: null,
    court_id: null,
    started_at: null,
    ended_at: null,
    scheduled_time: null,
    reported_time: null,
    winner_id: null,
    created_at: CREATED,
    ...overrides,
  };
}

function placementMatch(id: string, overrides: Partial<PlacementMatch> = {}): PlacementMatch {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    category_id: CATEGORY_ID,
    stage: "round1",
    entrant_a_id: "e1",
    entrant_b_id: "e2",
    generation_key: `${id}-key`,
    is_makeup: false,
    is_crossover: false,
    prerequisite_ids: [],
    games: [],
    status: "scheduled",
    court_id: null,
    started_at: null,
    ended_at: null,
    scheduled_time: null,
    reported_time: null,
    note: null,
    winner_id: null,
    created_at: CREATED,
    ...overrides,
  };
}

function tierMatch(id: string, overrides: Partial<TierDrawMatch> = {}): TierDrawMatch {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    draw_id: "tier-draw-a",
    round: 1,
    slot: 1,
    entrant_a_id: "e1",
    entrant_b_id: "e2",
    status: "scheduled",
    games: [],
    is_bye: false,
    note: null,
    parent_a_id: null,
    parent_b_id: null,
    court_id: null,
    started_at: null,
    ended_at: null,
    scheduled_time: null,
    reported_time: null,
    winner_id: null,
    created_at: CREATED,
    ...overrides,
  };
}

/**
 * One row of every kind, so a test asserts on which kinds survive the format gate
 * rather than on how many of each there are.
 */
function sources(format?: string | null): DeskMatchSources {
  return {
    format,
    teams: [team("team-a"), team("team-b"), team("team-e1"), team("team-e2")],
    categories: [category()],
    tierDraws: [tierDraw("tier-draw-a", "A")],
    entrantTeam: (entrantId) => (entrantId ? `team-${entrantId}` : null),
    poolMatches: [poolMatch("pm1")],
    drawMatches: [drawMatch("dm1")],
    placementMatches: [placementMatch("plm1")],
    tierMatches: [tierMatch("tdm1")],
  };
}

const kinds = (format?: string | null) =>
  buildDeskMatches(sources(format))
    .map((match) => match.kind)
    .sort();

// ---------------------------------------------------------------------------

describe("buildDeskMatches lists the format the tournament runs", () => {
  it("lists every kind for a tournament that stored the round-robin format", () => {
    expect(kinds("round_robin")).toEqual(["draw", "placement", "pool", "tier"]);
  });

  it("omits the round-robin rows for a two-round placement tournament", () => {
    // The pools and pooled draws under such a tournament are leftovers. Listing them
    // is what put finished matches this event cannot have above the ones it is playing.
    expect(kinds("two_round_placement")).toEqual(["placement", "tier"]);
  });

  it("keeps the legacy rows when no format is known", () => {
    // Dropping them on an unknown value would hide a round-robin event's own matches
    // from a page that simply had not loaded its tournament yet.
    for (const unknown of [undefined, null]) {
      expect(kinds(unknown)).toEqual(["draw", "placement", "pool", "tier"]);
    }
  });

  it("keeps the placement rows for a placement tournament", () => {
    const rows = buildDeskMatches(sources("two_round_placement"));
    expect(rows.map((row) => row.id)).toEqual(["plm1", "tdm1"]);
  });

  it("never emits a bye, whichever format the tournament runs", () => {
    for (const format of ["round_robin", "two_round_placement"]) {
      const rows = buildDeskMatches({
        ...sources(format),
        tierMatches: [tierMatch("tdm-bye", { is_bye: true, note: "Bye", status: "reported" })],
      });
      expect(rows.map((row) => row.id)).not.toContain("tdm-bye");
    }
  });
});

describe("buildDeskMatches labels every kind", () => {
  const rows = buildDeskMatches(sources("round_robin"));
  const byId = new Map(rows.map((row) => [row.id, row]));

  it("tags a placement row with its event and round", () => {
    expect(byId.get("plm1")).toMatchObject({ tag: "MS R1", categoryId: CATEGORY_ID });
  });

  it("resolves a placement side through its entrant to a team", () => {
    // The placement tables store entrants, not teams; a row that skipped the entrant
    // would render both sides as "TBC" and drop the players from the rest checks.
    expect(byId.get("plm1")?.teams).toEqual(["team-e1", "team-e2"]);
    expect(byId.get("plm1")?.playerIds).toEqual(["team-e1-p1", "team-e2-p1"]);
  });

  it("tags a tier row with its draw and reads the draw's category", () => {
    expect(byId.get("tdm1")).toMatchObject({ tag: "Tier A", categoryId: CATEGORY_ID });
  });

  it("carries a pool score across as a raw pair and a draw score as games", () => {
    expect(byId.get("pm1")?.score).toBe("21-15");
    expect(byId.get("dm1")?.score).toBeNull();
  });
});
