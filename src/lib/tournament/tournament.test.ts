import { describe, expect, it } from "vitest";

import { buildFirstRound, seedEntrants, totalMatchesInDraw } from "./draws";
import {
  CUSTOM_PRESET_ID,
  DEFAULT_KNOCKOUT_RULE,
  DEFAULT_PLACEMENT_RULE,
  gamesNeededToWin,
  isOddBestOf,
  isScoringRuleValid,
  LEGACY_GAME_RULE,
  LEGACY_KNOCKOUT_RULE,
  presetForRule,
  ruleForStage,
  SCORING_PRESETS,
  scoringRuleLabel,
  suggestedSlotMinutes,
} from "./scoring";
import { gamesWinner, gamesWinnerFor, isLegalGameScore, isLegalGameScoreFor } from "./format";
import { circleMethod, planPoolSizes, poolMatchCount } from "./pools";
import { applyDayPlan, planDay, type DayPlan } from "./actions";
import type { Court, PoolMatch, Team, Tournament, TournamentDay } from "./data";
import { stagesForDay } from "./data";
import { checkStartConstraints } from "./scheduling/live-constraints";
import { computeStandings, poolIsComplete } from "./standings";

/**
 * The tournament the desk has run so far: 8 courts, 2 days, four categories,
 * 09:00–18:30 doors. The scoping refactor made all of that configurable, so this
 * config is the reference point for "no behavior change".
 */
const DEFAULT_CONFIG = {
  court_count: 8,
  created_at: "2026-09-01T00:00:00.000Z",
  day_count: 2,
  format: "round_robin",
  group_rest_gap_minutes: 10,
  group_slot_minutes: 20,
  id: "tournament-default",
  is_active: true,
  knockout_best_of: 3,
  knockout_games_to: 21,
  knockout_rest_gap_minutes: 30,
  knockout_slot_minutes: 25,
  knockout_win_by: 2,
  max_categories_per_player: 2,
  name: "City Open 2026",
  notes: null,
  organizer_email: null,
  organizer_name: null,
  organizer_phone: null,
  placement_best_of: 1,
  placement_games_to: 21,
  placement_win_by: 2,
  rest_gap_minutes: 10,
  status: "in_progress",
  owner_profile_id: "00000000-0000-0000-0000-0000000000a1",
  registration_opens_at: null,
  registration_closes_at: null,
  venue_address: null,
  venue_name: null,
  venue_timezone: "America/Chicago",
} satisfies Tournament;

const DAY_ONE: TournamentDay = {
  created_at: "2026-09-01T00:00:00.000Z",
  date: "2026-09-12",
  day_number: 1,
  end_time: "18:30:00",
  id: "day-1",
  start_time: "09:00:00",
  tournament_id: DEFAULT_CONFIG.id,
};

/** Courts are materialised into rows from `court_count` when the tournament is created. */
function courtsFor(config: Tournament): Court[] {
  return Array.from({ length: config.court_count }, (_, index) => ({
    created_at: config.created_at,
    id: `court-${index + 1}`,
    number: index + 1,
    status: "available",
    tournament_id: config.id,
  }));
}

describe("pool sizing", () => {
  it("uses fours and fives only", () => {
    expect(planPoolSizes(8)).toEqual([4, 4]);
    expect(planPoolSizes(9)).toEqual([5, 4]);
    expect(planPoolSizes(55)).toEqual([5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
  });

  it("rejects unsupported counts", () => {
    expect(() => planPoolSizes(6)).toThrow(/4 or 5/);
    expect(() => planPoolSizes(7)).toThrow(/4 or 5/);
    expect(() => planPoolSizes(11)).toThrow(/4 or 5/);
  });

  it("circle method is unique and exclusive per round", () => {
    const teams = ["A", "B", "C", "D", "E"];
    const pairs = circleMethod(teams);
    expect(pairs).toHaveLength(poolMatchCount(5));
    const keys = pairs.map((p) => [p.teamA, p.teamB].sort().join("-"));
    expect(new Set(keys).size).toBe(keys.length);
    const byRound = new Map<number, string[]>();
    for (const p of pairs) {
      const list = byRound.get(p.round) ?? [];
      list.push(p.teamA, p.teamB);
      byRound.set(p.round, list);
    }
    for (const list of byRound.values()) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe("scores", () => {
  it("rejects one-game knockouts", () => {
    expect(gamesWinner([{ a: 21, b: 19 }])).toBeNull();
    expect(
      gamesWinner([
        { a: 21, b: 19 },
        { a: 21, b: 18 },
      ]),
    ).toBe("a");
    expect(isLegalGameScore(21, 19)).toBe(true);
    expect(isLegalGameScore(21, 20)).toBe(false);
  });
});

describe("scoring rules", () => {
  it("derives games needed to win from best of", () => {
    expect(gamesNeededToWin({ gamesTo: 21, winBy: 2, bestOf: 1 })).toBe(1);
    expect(gamesNeededToWin({ gamesTo: 21, winBy: 2, bestOf: 3 })).toBe(2);
    expect(gamesNeededToWin({ gamesTo: 21, winBy: 2, bestOf: 5 })).toBe(3);
    expect(gamesNeededToWin({ gamesTo: 21, winBy: 2, bestOf: 9 })).toBe(5);
  });

  it("accepts odd best-of counts only", () => {
    for (const bestOf of [1, 3, 5, 7, 9]) {
      expect(isOddBestOf(bestOf)).toBe(true);
      expect(isScoringRuleValid({ gamesTo: 21, winBy: 2, bestOf })).toBe(true);
    }
    for (const bestOf of [0, 2, 4, 10, 1.5]) {
      expect(isOddBestOf(bestOf)).toBe(false);
      expect(isScoringRuleValid({ gamesTo: 21, winBy: 2, bestOf })).toBe(false);
    }
  });

  it("rejects out-of-range point targets and margins", () => {
    expect(isScoringRuleValid({ gamesTo: 0, winBy: 2, bestOf: 1 })).toBe(false);
    expect(isScoringRuleValid({ gamesTo: 100, winBy: 2, bestOf: 1 })).toBe(false);
    expect(isScoringRuleValid({ gamesTo: 21, winBy: 0, bestOf: 1 })).toBe(false);
    expect(isScoringRuleValid({ gamesTo: 21, winBy: 21, bestOf: 1 })).toBe(false);
    expect(isScoringRuleValid({ gamesTo: 11, winBy: 1, bestOf: 5 })).toBe(true);
  });

  it("matches a rule back to its preset, falling back to custom", () => {
    expect(presetForRule({ gamesTo: 21, winBy: 2, bestOf: 3 }).id).toBe("best-of-3-21");
    expect(presetForRule({ gamesTo: 15, winBy: 2, bestOf: 1 }).id).toBe("single-15");
    expect(presetForRule({ gamesTo: 11, winBy: 2, bestOf: 3 }).id).toBe(CUSTOM_PRESET_ID);
    // A preset shape with a different margin is not the same preset.
    expect(presetForRule({ gamesTo: 21, winBy: 1, bestOf: 1 }).id).toBe(CUSTOM_PRESET_ID);
  });

  it("suggests the preset duration when one matches", () => {
    for (const preset of SCORING_PRESETS) {
      expect(suggestedSlotMinutes(preset)).toBe(preset.suggestedMinutes);
    }
  });

  it("suggests a tidy, positive duration for a custom rule", () => {
    const custom = suggestedSlotMinutes({ gamesTo: 17, winBy: 3, bestOf: 5 });
    expect(custom).toBeGreaterThan(0);
    expect(custom % 5).toBe(0);
    // A longer point target cannot suggest a shorter slot than a shorter one.
    expect(custom).toBeGreaterThan(suggestedSlotMinutes({ gamesTo: 7, winBy: 3, bestOf: 1 }));
    // Even an extreme rule still yields at least one workable slot.
    expect(suggestedSlotMinutes({ gamesTo: 1, winBy: 1, bestOf: 1 })).toBeGreaterThanOrEqual(5);
  });

  it("labels a rule in the host's words", () => {
    expect(scoringRuleLabel({ gamesTo: 21, winBy: 2, bestOf: 1 })).toBe(
      "Single game to 21, win by 2",
    );
    expect(scoringRuleLabel({ gamesTo: 15, winBy: 2, bestOf: 3 })).toBe(
      "Best of 3 to 15, win by 2",
    );
    expect(scoringRuleLabel({ gamesTo: 11, winBy: 1, bestOf: 5 })).toBe("Best of 5 to 11");
  });

  it("reads the rule for the stage the tournament stores it for", () => {
    const tournament = {
      placement_games_to: 15,
      placement_win_by: 2,
      placement_best_of: 1,
      knockout_games_to: 21,
      knockout_win_by: 2,
      knockout_best_of: 3,
    };
    expect(ruleForStage(tournament, "placement")).toEqual({ gamesTo: 15, winBy: 2, bestOf: 1 });
    expect(ruleForStage(tournament, "knockout")).toEqual({ gamesTo: 21, winBy: 2, bestOf: 3 });
    // The legacy constants are what the un-migrated surfaces still assume.
    expect(LEGACY_GAME_RULE).toEqual({ gamesTo: 21, winBy: 2, bestOf: 1 });
    expect(LEGACY_KNOCKOUT_RULE).toEqual({ gamesTo: 21, winBy: 2, bestOf: 3 });
    expect(DEFAULT_PLACEMENT_RULE).toEqual(LEGACY_GAME_RULE);
    expect(DEFAULT_KNOCKOUT_RULE).toEqual(LEGACY_KNOCKOUT_RULE);
  });

  it("falls back to the stage default when the stored rule is unusable", () => {
    // This is the shape of a row read before the scoring columns existed.
    const missing = {
      placement_games_to: undefined,
      placement_win_by: undefined,
      placement_best_of: undefined,
      knockout_games_to: undefined,
      knockout_win_by: undefined,
      knockout_best_of: undefined,
    } as unknown as Parameters<typeof ruleForStage>[0];
    expect(ruleForStage(missing, "placement")).toEqual(DEFAULT_PLACEMENT_RULE);
    expect(ruleForStage(missing, "knockout")).toEqual(DEFAULT_KNOCKOUT_RULE);

    // A stored even best-of is nonsense; the desk must not be locked out by it.
    const broken = { ...missing, knockout_games_to: 21, knockout_win_by: 2, knockout_best_of: 4 };
    expect(ruleForStage(broken, "knockout")).toEqual(DEFAULT_KNOCKOUT_RULE);
  });
});

describe("rule-driven score validation", () => {
  it("honours the configured target and margin", () => {
    const to15 = { gamesTo: 15, winBy: 2, bestOf: 1 };
    expect(isLegalGameScoreFor(15, 13, to15)).toBe(true);
    expect(isLegalGameScoreFor(15, 14, to15)).toBe(false);
    expect(isLegalGameScoreFor(14, 12, to15)).toBe(false);
    // The same scores are illegal under the 21 rule, which is the point of the split.
    expect(isLegalGameScoreFor(15, 13, LEGACY_GAME_RULE)).toBe(false);
    expect(isLegalGameScoreFor(21, 19, LEGACY_GAME_RULE)).toBe(true);
    // `winBy: 1` permits a one-point game.
    expect(isLegalGameScoreFor(21, 20, { gamesTo: 21, winBy: 1, bestOf: 1 })).toBe(true);
  });

  it("still rejects non-integer, negative and drawn games", () => {
    expect(isLegalGameScoreFor(21.5, 19, LEGACY_GAME_RULE)).toBe(false);
    expect(isLegalGameScoreFor(-1, 21, LEGACY_GAME_RULE)).toBe(false);
    expect(isLegalGameScoreFor(21, 21, LEGACY_GAME_RULE)).toBe(false);
  });

  it("decides a match under any best-of", () => {
    const bo3 = { gamesTo: 15, winBy: 2, bestOf: 3 };
    expect(gamesWinnerFor([{ a: 15, b: 13 }], bo3)).toBeNull();
    expect(
      gamesWinnerFor(
        [
          { a: 15, b: 13 },
          { a: 15, b: 11 },
        ],
        bo3,
      ),
    ).toBe("a");
    expect(
      gamesWinnerFor(
        [
          { a: 15, b: 13 },
          { a: 11, b: 15 },
          { a: 15, b: 9 },
        ],
        bo3,
      ),
    ).toBe("a");

    const bo1 = { gamesTo: 15, winBy: 2, bestOf: 1 };
    expect(gamesWinnerFor([{ a: 15, b: 13 }], bo1)).toBe("a");
    // A best-of-one has no second game to play.
    expect(
      gamesWinnerFor(
        [
          { a: 15, b: 13 },
          { a: 15, b: 13 },
        ],
        bo1,
      ),
    ).toBeNull();

    const bo5 = { gamesTo: 11, winBy: 2, bestOf: 5 };
    expect(
      gamesWinnerFor(
        [
          { a: 11, b: 9 },
          { a: 11, b: 9 },
        ],
        bo5,
      ),
    ).toBeNull();
    expect(
      gamesWinnerFor(
        [
          { a: 11, b: 9 },
          { a: 11, b: 9 },
          { a: 11, b: 9 },
        ],
        bo5,
      ),
    ).toBe("a");
  });

  it("rejects a result that keeps playing after it is decided", () => {
    expect(
      gamesWinnerFor(
        [
          { a: 21, b: 19 },
          { a: 21, b: 19 },
          { a: 21, b: 19 },
        ],
        LEGACY_KNOCKOUT_RULE,
      ),
    ).toBeNull();
  });

  it("rejects an invalid rule outright rather than guessing", () => {
    expect(gamesWinnerFor([{ a: 21, b: 19 }], { gamesTo: 21, winBy: 2, bestOf: 2 })).toBeNull();
  });

  it("keeps the legacy wrappers pinned to 21 / best of three", () => {
    expect(isLegalGameScore(21, 19)).toBe(true);
    expect(isLegalGameScore(15, 13)).toBe(false);
    expect(gamesWinner([{ a: 21, b: 19 }])).toBeNull();
    expect(gamesWinner([{ a: 15, b: 13 }])).toBeNull();
    expect(
      gamesWinner([
        { a: 21, b: 19 },
        { a: 21, b: 18 },
      ]),
    ).toBe("a");
  });
});

describe("standings", () => {
  it("uses head-to-head for two-team ties", () => {
    const matches = [
      {
        team_a_id: "A",
        team_b_id: "B",
        score_a: 21,
        score_b: 10,
        winner_id: "A",
        status: "reported",
      },
      {
        team_a_id: "A",
        team_b_id: "C",
        score_a: 21,
        score_b: 10,
        winner_id: "A",
        status: "reported",
      },
      {
        team_a_id: "A",
        team_b_id: "D",
        score_a: 10,
        score_b: 21,
        winner_id: "D",
        status: "reported",
      },
      {
        team_a_id: "B",
        team_b_id: "C",
        score_a: 21,
        score_b: 10,
        winner_id: "B",
        status: "reported",
      },
      {
        team_a_id: "B",
        team_b_id: "D",
        score_a: 21,
        score_b: 10,
        winner_id: "B",
        status: "reported",
      },
      {
        team_a_id: "C",
        team_b_id: "D",
        score_a: 21,
        score_b: 10,
        winner_id: "C",
        status: "reported",
      },
    ];
    const rows = computeStandings(["A", "B", "C", "D"], matches);
    expect(rows.slice(0, 2).map((r) => r.teamId)).toEqual(["A", "B"]);
  });

  it("does not let a single override beat more wins", () => {
    const matches = [
      {
        team_a_id: "A",
        team_b_id: "B",
        score_a: 21,
        score_b: 10,
        winner_id: "A",
        status: "reported",
      },
    ];
    const rows = computeStandings(["A", "B"], matches, { B: 1 });
    expect(rows[0]?.teamId).toBe("A");
  });

  it("resolves three-way cycles deterministically", () => {
    const matches = [
      {
        team_a_id: "A",
        team_b_id: "B",
        score_a: 21,
        score_b: 19,
        winner_id: "A",
        status: "reported",
      },
      {
        team_a_id: "B",
        team_b_id: "C",
        score_a: 21,
        score_b: 10,
        winner_id: "B",
        status: "reported",
      },
      {
        team_a_id: "C",
        team_b_id: "A",
        score_a: 21,
        score_b: 5,
        winner_id: "C",
        status: "reported",
      },
    ];
    const first = computeStandings(["A", "B", "C"], matches).map((r) => r.teamId);
    const second = computeStandings(["C", "B", "A"], matches).map((r) => r.teamId);
    expect(first).toEqual(second);
    expect(first[0]).toBe("B");
  });

  it("requires the full pairing set", () => {
    expect(
      poolIsComplete(
        ["A", "B", "C", "D"],
        [
          {
            team_a_id: "A",
            team_b_id: "B",
            score_a: 21,
            score_b: 10,
            winner_id: "A",
            status: "reported",
          },
        ],
      ),
    ).toBe(false);
  });
});

describe("draws", () => {
  it("seeds by differential first", () => {
    const seeded = seedEntrants([
      { teamId: "low", diff: 1, wins: 4, poolName: "A", poolRank: 1 },
      { teamId: "high", diff: 20, wins: 3, poolName: "B", poolRank: 1 },
    ]);
    expect(seeded[0]?.teamId).toBe("high");
  });

  it("gives byes to the top seed", () => {
    const { pairs, byes } = buildFirstRound([
      { teamId: "1", diff: 30, wins: 3, poolName: "A", poolRank: 1 },
      { teamId: "2", diff: 10, wins: 3, poolName: "B", poolRank: 1 },
      { teamId: "3", diff: 5, wins: 3, poolName: "C", poolRank: 1 },
    ]);
    expect(byes).toBe(1);
    expect(totalMatchesInDraw(3)).toBe(2);
    expect(pairs.some((p) => p.isBye && (p.teamA === "1" || p.teamB === "1"))).toBe(true);
  });
});

describe("applyDayPlan", () => {
  it("refuses to apply when blocked matches remain", async () => {
    const plan: DayPlan = {
      day: 1,
      stage: "group",
      tournamentId: "tournament-id",
      slots: [],
      fixedMatchIds: [],
      blocked: ["blocked-match"],
      awaitingTeams: [],
      diff: {
        changes: [],
        anchorCount: 0,
        placedCount: 0,
        movedCount: 0,
        newlyPlacedCount: 0,
        largestShiftMinutes: 0,
        unplaceable: ["blocked-match"],
      },
      summary: {
        placed: 0,
        anchorCount: 0,
        movedCount: 0,
        unscheduled: 1,
        awaitingTeams: 0,
        utilization: 0,
        remainingUtilization: null,
        overrun: true,
        projectedFinish: null,
        currentProjectedFinish: null,
        projectedFinishDeltaMinutes: null,
        overrunMinutes: 0,
        diagnostics: {
          deadlockReason: "No future event can make 1 remaining match(es) eligible.",
        } as never,
      },
      poolEnds: {},
      movableSlotPayload: [],
    };

    await expect(applyDayPlan(plan)).rejects.toThrow(/Cannot apply rebuild/);
  });
});

describe("start constraints", () => {
  it("blocks starting when a player is already in-progress elsewhere", () => {
    const { conflicts, warnings } = checkStartConstraints(["p1", "p2"], 10, [
      { id: "other", playerIds: ["p1"], status: "in-progress", courtNumber: 3, endedAt: null },
    ]);
    expect(conflicts).toEqual([{ playerId: "p1", matchId: "other", courtNumber: 3 }]);
    expect(warnings).toEqual([]);
  });

  it("warns, but does not block, when rest gap is too short", () => {
    const now = new Date("2026-09-12T10:00:00").getTime();
    const endedAt = new Date(now - 5 * 60000).toISOString(); // ended 5 minutes ago
    const { conflicts, warnings } = checkStartConstraints(
      ["p1"],
      10,
      [{ id: "prev", playerIds: ["p1"], status: "reported", courtNumber: 2, endedAt }],
      now,
    );
    expect(conflicts).toEqual([]);
    expect(warnings).toEqual([
      { playerId: "p1", matchId: "prev", restMinutes: 5, requiredMinutes: 10 },
    ]);
  });

  it("raises no warning once enough rest has passed", () => {
    const now = new Date("2026-09-12T10:00:00").getTime();
    const endedAt = new Date(now - 15 * 60000).toISOString(); // ended 15 minutes ago
    const { conflicts, warnings } = checkStartConstraints(
      ["p1"],
      10,
      [{ id: "prev", playerIds: ["p1"], status: "reported", courtNumber: 2, endedAt }],
      now,
    );
    expect(conflicts).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("only counts a player's most recently finished match for the rest gap", () => {
    const now = new Date("2026-09-12T10:00:00").getTime();
    const older = new Date(now - 60 * 60000).toISOString(); // 60 min ago — would pass
    const recent = new Date(now - 5 * 60000).toISOString(); // 5 min ago — fails
    const { warnings } = checkStartConstraints(
      ["p1"],
      10,
      [
        { id: "older", playerIds: ["p1"], status: "reported", courtNumber: 1, endedAt: older },
        { id: "recent", playerIds: ["p1"], status: "reported", courtNumber: 2, endedAt: recent },
      ],
      now,
    );
    expect(warnings).toEqual([
      { playerId: "p1", matchId: "recent", restMinutes: 5, requiredMinutes: 10 },
    ]);
  });

  it("skips the rest-gap check for a player who has a hard conflict", () => {
    const now = new Date("2026-09-12T10:00:00").getTime();
    const { conflicts, warnings } = checkStartConstraints(
      ["p1"],
      10,
      [{ id: "other", playerIds: ["p1"], status: "in-progress", courtNumber: 4, endedAt: null }],
      now,
    );
    expect(conflicts).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

/**
 * Integration invariants for a whole day of group-stage planning.
 *
 * This suite used to pin the exact court-by-court order the legacy GRASP produced. That is
 * incidental output: a valid day depends on the orderings, not on which of two equally good
 * courts a match lands on. So these tests assert the properties a desk actually relies on — every
 * match placed, no court or participant double-booked, rest respected, and the bound the fixture's
 * own arithmetic implies — and leave the search free to pick.
 */
describe("group-stage day plan", () => {
  const CATEGORY_CODES = ["MS", "MD", "WD", "XD"] as const;

  /** A deterministic four-category morning: 16 teams in four pools of four. */
  function goldenFixture() {
    const teams: Team[] = [];
    const poolMatches: PoolMatch[] = [];
    const categoryOrder = new Map<string, number>();

    CATEGORY_CODES.forEach((code, categoryIndex) => {
      const categoryId = `category-${code}`;
      const poolId = `pool-${code}`;
      categoryOrder.set(categoryId, categoryIndex);

      const teamIds = Array.from({ length: 4 }, (_, index) => `team-${code}-${index + 1}`);
      for (const teamId of teamIds) {
        teams.push({
          category_id: categoryId,
          created_at: DEFAULT_CONFIG.created_at,
          id: teamId,
          player_1_id: `${teamId}-a`,
          player_2_id: `${teamId}-b`,
          seed: null,
          tournament_id: DEFAULT_CONFIG.id,
          withdrawn: false,
        });
      }

      circleMethod(teamIds).forEach((pair, index) => {
        poolMatches.push({
          category_id: categoryId,
          court_id: null,
          created_at: DEFAULT_CONFIG.created_at,
          ended_at: null,
          id: `match-${code}-${index + 1}`,
          note: null,
          pool_id: poolId,
          reported_time: null,
          round: pair.round,
          scheduled_time: null,
          score_a: null,
          score_b: null,
          started_at: null,
          status: "scheduled",
          team_a_id: pair.teamA,
          team_b_id: pair.teamB,
          tournament_id: DEFAULT_CONFIG.id,
          winner_id: null,
        });
      });
    });

    return { teams, poolMatches, categoryOrder };
  }

  function planGolden(overrides: Partial<Tournament> = {}) {
    const { teams, poolMatches, categoryOrder } = goldenFixture();
    const courts = courtsFor(DEFAULT_CONFIG);
    return {
      courts,
      poolMatches,
      teams,
      plan: planDay(
        1,
        "group",
        { ...DEFAULT_CONFIG, ...overrides },
        DAY_ONE,
        courts,
        teams,
        poolMatches,
        [],
        new Map(),
        categoryOrder,
        { seed: 4242 },
      ),
    };
  }

  it("places every group match exactly once, within the day window", () => {
    const { plan, poolMatches, courts, teams } = planGolden();
    expect(plan.blocked).toEqual([]);
    expect(plan.awaitingTeams).toEqual([]);
    expect(plan.summary.placed).toBe(poolMatches.length);
    expect(plan.slots).toHaveLength(poolMatches.length);
    expect(plan.summary.overrun).toBe(false);
    void courts;
    void teams;
  });

  it("places later matches after rest and has no hard end cap", () => {
    const { plan, poolMatches, teams, courts } = planGolden();
    const dayEnd = new Date(`${DAY_ONE.date}T${DAY_ONE.end_time}`).getTime();
    expect(plan.summary.overrun).toBe(false);
    expect(plan.summary.projectedFinish).not.toBeNull();
    expect(new Date(plan.summary.projectedFinish as string).getTime()).toBeLessThanOrEqual(dayEnd);

    const playerOfTeam = new Map(
      teams.map((team) => [
        team.id,
        [team.player_1_id, ...(team.player_2_id ? [team.player_2_id] : [])],
      ]),
    );
    const source = new Map(poolMatches.map((match) => [match.id, match]));
    const playersOf = (matchId: string): string[] => {
      const match = source.get(matchId);
      if (!match) return [];
      return [
        ...(playerOfTeam.get(match.team_a_id ?? "") ?? []),
        ...(playerOfTeam.get(match.team_b_id ?? "") ?? []),
      ];
    };
    const courtIds = new Set(courts.map((court) => court.id));

    for (const slot of plan.slots) {
      expect(courtIds.has(slot.courtId)).toBe(true);
      expect(slot.end.getTime() - slot.start.getTime()).toBe(
        DEFAULT_CONFIG.group_slot_minutes * 60_000,
      );
    }
    for (const a of plan.slots) {
      for (const b of plan.slots) {
        if (a.matchId === b.matchId) continue;
        if (a.courtId === b.courtId) {
          expect(a.end.getTime() <= b.start.getTime() || b.end.getTime() <= a.start.getTime()).toBe(
            true,
          );
        }
        const shared = playersOf(a.matchId).filter((id) => playersOf(b.matchId).includes(id));
        if (!shared.length) continue;
        const gap =
          a.start.getTime() <= b.start.getTime()
            ? b.start.getTime() - a.end.getTime()
            : a.start.getTime() - b.end.getTime();
        expect(gap).toBeGreaterThanOrEqual(DEFAULT_CONFIG.group_rest_gap_minutes * 60_000);
      }
    }
  });

  it("takes slot minutes and rest gaps from the tournament row, not from constants", () => {
    const overrides = { group_slot_minutes: 30 } as const;
    const { plan, poolMatches } = planGolden(overrides);
    expect(plan.summary.placed).toBe(poolMatches.length);

    // Bound, not a pinned pattern: with 30-minute slots and a 10-minute rest gap, the three
    // rounds of a pool cannot be closer than 40 minutes apart, so the day needs at least the
    // 2 x 40 = 80 minutes after the first start.
    const starts = [...plan.slots.map((slot) => slot.start.getTime())].sort((a, b) => a - b);
    const first = starts[0]!;
    expect(new Set(starts).size).toBeGreaterThanOrEqual(2);
    expect(starts[starts.length - 1]! - first).toBeGreaterThanOrEqual(80 * 60_000);
    expect(plan.summary.overrun).toBe(false);
  });
});

describe("stage placement across the configured day count", () => {
  it("opens groups on day 1 and closes knockouts on the final day", () => {
    expect(stagesForDay(1, 2)).toEqual(["group"]);
    expect(stagesForDay(2, 2)).toEqual(["knockout"]);
  });

  it("leaves the intermediate days of a three-day tournament without a stage", () => {
    expect(stagesForDay(1, 3)).toEqual(["group"]);
    expect(stagesForDay(2, 3)).toEqual([]);
    expect(stagesForDay(3, 3)).toEqual(["knockout"]);
  });

  it("runs both stages on a single-day tournament", () => {
    expect(stagesForDay(1, 1)).toEqual(["group", "knockout"]);
  });
});
