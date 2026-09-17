import { describe, expect, it, vi } from "vitest";

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
import {
  scheduleGroupStageGrasp,
  validateGraspSchedule,
  type GraspOptions,
  type GraspSchedulableMatch,
} from "./scheduler-grasp";
import { applyDayPlan, planDay, type DayPlan } from "./actions";
import type { Court, PoolMatch, Team, Tournament, TournamentDay } from "./data";
import { stagesForDay } from "./data";
import { checkStartConstraints, scheduleMatches } from "./scheduler";
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

describe("scheduler", () => {
  it("places later matches after rest and has no hard end cap", () => {
    const courts = [
      { id: "c1", number: 1 },
      { id: "c2", number: 2 },
    ];
    const dayStart = new Date("2026-09-12T08:00:00");
    const planningEnd = new Date("2026-09-12T17:00:00");
    const result = scheduleMatches(
      [
        {
          id: "m1",
          categoryId: "MS",
          categoryOrder: 1,
          playerIds: ["p1"],
          kind: "group",
          order: 1,
        },
        {
          id: "m2",
          categoryId: "MS",
          categoryOrder: 1,
          playerIds: ["p1"],
          kind: "group",
          order: 2,
        },
      ],
      { dayStart, planningEnd, courts, slotMinutes: 20, restGapMinutes: 10 },
    );
    const first = result.slots.find((s) => s.matchId === "m1")!;
    const second = result.slots.find((s) => s.matchId === "m2")!;
    expect((second.start.getTime() - first.end.getTime()) / 60000).toBe(10);
  });

  it("respects parent earliest start for knockouts", () => {
    const courts = [{ id: "c1", number: 1 }];
    const dayStart = new Date("2026-09-13T08:00:00");
    const planningEnd = new Date("2026-09-13T17:00:00");
    const parentEnd = new Date("2026-09-13T10:00:00").getTime();
    const result = scheduleMatches(
      [
        {
          id: "sf",
          categoryId: "MS",
          playerIds: ["p1", "p2"],
          kind: "knockout",
          order: 201,
          earliestStart: parentEnd + 30 * 60000,
        },
      ],
      { dayStart, planningEnd, courts, slotMinutes: 25, restGapMinutes: 30 },
    );
    expect(result.slots[0]?.start.toISOString()).toBe(
      new Date(parentEnd + 30 * 60000).toISOString(),
    );
  });
});

describe("Day 1 GRASP scheduler", () => {
  const dayStart = new Date("2026-09-12T08:00:00Z");
  const planningEnd = new Date("2026-09-12T17:00:00Z");
  const courts = [
    { id: "c1", number: 1 },
    { id: "c2", number: 2 },
  ];
  const options: GraspOptions = {
    dayStart,
    planningEnd,
    courts,
    slotMinutes: 20,
    restGapMinutes: 10,
    graspRuns: 8,
    seed: 1234,
  };
  const matches: GraspSchedulableMatch[] = [
    {
      id: "m1",
      categoryId: "MS",
      categoryOrder: 1,
      poolId: "pool-a",
      playerIds: ["p1", "p2"],
      kind: "group",
      order: 1,
      round: 1,
    },
    {
      id: "m2",
      categoryId: "MS",
      categoryOrder: 1,
      poolId: "pool-a",
      playerIds: ["p1", "p3"],
      kind: "group",
      order: 2,
      round: 2,
    },
    {
      id: "m3",
      categoryId: "WS",
      categoryOrder: 2,
      poolId: "pool-b",
      playerIds: ["p4", "p5"],
      kind: "group",
      order: 1,
      round: 1,
    },
    {
      id: "m4",
      categoryId: "XD",
      categoryOrder: 3,
      poolId: "pool-c",
      playerIds: ["p2", "p6", "p7", "p8"],
      kind: "group",
      order: 1,
      round: 1,
    },
  ];

  it("is deterministic for the same input, options, and seed", () => {
    const first = scheduleGroupStageGrasp(matches, options);
    const second = scheduleGroupStageGrasp(matches, options);
    expect(second.slots).toEqual(first.slots);
    expect(second.unscheduled).toEqual(first.unscheduled);
    expect(second.diagnostics.winningSeed).toBe(first.diagnostics.winningSeed);
  });

  it("never places an unplayed match before a rebuild scheduling floor", () => {
    const schedulingFloor = new Date(dayStart.getTime() + 2 * 60 * 60_000);
    const result = scheduleGroupStageGrasp([matches[0]!], {
      ...options,
      schedulingFloor,
      graspRuns: 1,
    });
    expect(result.slots[0]?.start).toEqual(schedulingFloor);

    const invalid = {
      ...result.slots[0]!,
      start: new Date(schedulingFloor.getTime() - 20 * 60_000),
      end: schedulingFloor,
    };
    expect(
      validateGraspSchedule([matches[0]!], [invalid], [], {
        ...options,
        schedulingFloor,
      }).errors,
    ).toContain("Match m1 starts before the scheduling floor.");
  });

  it("calculates displayed utilization from the configured time window", () => {
    const result = scheduleGroupStageGrasp([matches[0]!], {
      ...options,
      courts: [{ id: "c1", number: 1 }],
      planningEnd: new Date(dayStart.getTime() + 60 * 60_000),
      graspRuns: 1,
    });
    expect(result.utilization).toBeCloseTo(1 / 3);
    expect(result.diagnostics.courtUtilization).toBe(1);
  });

  it("produces a schedule that independently passes all hard constraints", () => {
    const result = scheduleGroupStageGrasp(matches, options);
    expect(result.unscheduled).toEqual([]);
    expect(validateGraspSchedule(matches, result.slots, result.unscheduled, options)).toEqual({
      valid: true,
      errors: [],
    });

    const p1Slots = result.slots
      .filter((slot) => ["m1", "m2"].includes(slot.matchId))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    expect(
      (p1Slots[1]!.start.getTime() - p1Slots[0]!.end.getTime()) / 60_000,
    ).toBeGreaterThanOrEqual(10);
  });

  it("preserves fixed matches and schedules around their court and player windows", () => {
    const fixedStart = dayStart.getTime() + 20 * 60_000;
    const fixedEnd = fixedStart + 20 * 60_000;
    const fixedMatches: GraspSchedulableMatch[] = [
      {
        id: "fixed",
        categoryId: "MS",
        playerIds: ["fixed-player"],
        kind: "group",
        order: 1,
        fixed: true,
        start: fixedStart,
        end: fixedEnd,
        courtNumber: 1,
      },
      {
        id: "before",
        categoryId: "WS",
        playerIds: ["other-player"],
        kind: "group",
        order: 1,
      },
      {
        id: "same-player",
        categoryId: "MS",
        playerIds: ["fixed-player"],
        kind: "group",
        order: 2,
      },
    ];
    const result = scheduleGroupStageGrasp(fixedMatches, {
      ...options,
      courts: [{ id: "c1", number: 1 }],
      graspRuns: 2,
      rclSize: 1,
    });
    const fixed = result.slots.find((slot) => slot.matchId === "fixed")!;
    const samePlayer = result.slots.find((slot) => slot.matchId === "same-player")!;
    expect(fixed).toMatchObject({
      courtId: "c1",
      courtNumber: 1,
      start: new Date(fixedStart),
      end: new Date(fixedEnd),
    });
    expect(samePlayer.start.getTime()).toBeGreaterThanOrEqual(fixedEnd + 10 * 60_000);
  });

  it("uses best-first ranking when the RCL size is one", () => {
    const result = scheduleGroupStageGrasp(
      [
        {
          id: "later",
          categoryId: "MS",
          categoryOrder: 1,
          playerIds: ["p-later"],
          kind: "group",
          order: 2,
          round: 2,
        },
        {
          id: "earlier",
          categoryId: "MS",
          categoryOrder: 1,
          playerIds: ["p-earlier"],
          kind: "group",
          order: 1,
          round: 1,
        },
      ],
      { ...options, courts: [{ id: "c1", number: 1 }], graspRuns: 1, rclSize: 1 },
    );
    expect(result.slots[0]?.matchId).toBe("earlier");
  });

  it("treats round and category order as soft priorities and honors dependencies", () => {
    const dependencyMatches: GraspSchedulableMatch[] = [
      {
        id: "early-category-later-start",
        categoryId: "preferred",
        categoryOrder: 1,
        playerIds: ["p1"],
        kind: "group",
        order: 1,
        round: 1,
        earliestStart: dayStart.getTime() + 60 * 60_000,
      },
      {
        id: "parent",
        categoryId: "available",
        categoryOrder: 2,
        playerIds: ["p2"],
        kind: "group",
        order: 2,
        round: 2,
      },
      {
        id: "child",
        categoryId: "available",
        categoryOrder: 2,
        playerIds: ["p3"],
        kind: "group",
        order: 3,
        round: 3,
        dependsOn: ["parent"],
      },
    ];
    const result = scheduleGroupStageGrasp(dependencyMatches, {
      ...options,
      courts: [{ id: "c1", number: 1 }],
      graspRuns: 1,
      rclSize: 1,
    });
    const parent = result.slots.find((slot) => slot.matchId === "parent")!;
    const child = result.slots.find((slot) => slot.matchId === "child")!;
    expect(parent.start).toEqual(dayStart);
    expect(child.start.getTime()).toBeGreaterThanOrEqual(parent.end.getTime());
  });

  it("captures an explainable assignment trace only when requested", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const result = scheduleGroupStageGrasp(matches, {
      ...options,
      graspRuns: 2,
      debugTrace: true,
    });
    expect(result.trace).toHaveLength(matches.length);
    expect(result.trace?.[0]).toMatchObject({
      eligibleCandidateCount: expect.any(Number),
      selectedMatch: expect.any(String),
      randomSeed: result.diagnostics.winningSeed,
    });
    expect(result.trace?.[0]?.rankedCandidates.length).toBeGreaterThan(0);
    expect(result.trace?.[0]?.RCLCandidates.length).toBeGreaterThan(0);
    expect(debug).toHaveBeenCalledTimes(matches.length);
    debug.mockRestore();
  });

  it("terminates and reports circular dependencies as a deadlock", () => {
    const circular: GraspSchedulableMatch[] = [
      {
        id: "a",
        categoryId: "MS",
        playerIds: ["p1"],
        kind: "group",
        order: 1,
        dependsOn: ["b"],
      },
      {
        id: "b",
        categoryId: "MS",
        playerIds: ["p2"],
        kind: "group",
        order: 2,
        dependsOn: ["a"],
      },
    ];
    const result = scheduleGroupStageGrasp(circular, {
      ...options,
      graspRuns: 3,
      maxIterationsPerRun: 10,
    });
    expect(result.unscheduled).toEqual(["a", "b"]);
    expect(result.diagnostics.deadlockedRunCount).toBe(3);
  });

  it("independently reports overlaps, moved fixed matches, and omissions", () => {
    const fixedStart = dayStart.getTime();
    const invalidMatches: GraspSchedulableMatch[] = [
      {
        id: "m1",
        categoryId: "MS",
        playerIds: ["shared"],
        kind: "group",
        order: 1,
      },
      {
        id: "m2",
        categoryId: "MS",
        playerIds: ["shared"],
        kind: "group",
        order: 2,
      },
      {
        id: "fixed",
        categoryId: "WS",
        playerIds: ["fixed-player"],
        kind: "group",
        order: 1,
        fixed: true,
        start: fixedStart,
        end: fixedStart + 20 * 60_000,
        courtNumber: 2,
      },
      {
        id: "omitted",
        categoryId: "XD",
        playerIds: ["missing"],
        kind: "group",
        order: 1,
      },
    ];
    const slots = [
      {
        matchId: "m1",
        courtId: "c1",
        courtNumber: 1,
        start: new Date(fixedStart),
        end: new Date(fixedStart + 20 * 60_000),
        categoryId: "MS",
        overrun: false,
      },
      {
        matchId: "m2",
        courtId: "c1",
        courtNumber: 1,
        start: new Date(fixedStart + 10 * 60_000),
        end: new Date(fixedStart + 30 * 60_000),
        categoryId: "MS",
        overrun: false,
      },
      {
        matchId: "fixed",
        courtId: "c1",
        courtNumber: 1,
        start: new Date(fixedStart + 40 * 60_000),
        end: new Date(fixedStart + 60 * 60_000),
        categoryId: "WS",
        overrun: false,
      },
    ];
    const validation = validateGraspSchedule(invalidMatches, slots, [], options);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => error.includes("Court c1 overlaps"))).toBe(true);
    expect(validation.errors.some((error) => error.includes("Player shared overlaps"))).toBe(true);
    expect(validation.errors.some((error) => error.includes("Fixed match fixed was moved"))).toBe(
      true,
    );
    expect(validation.errors.some((error) => error.includes("Match omitted appears 0 times"))).toBe(
      true,
    );
  });

  it("returns complete non-negative scoring diagnostics", () => {
    const result = scheduleGroupStageGrasp(matches, options);
    expect(result.diagnostics).toMatchObject({
      unscheduledMatches: 0,
      validCandidateCount: 8,
      invalidCandidateCount: 0,
      deadlockedRunCount: 0,
    });
    expect(result.diagnostics.courtIdleMinutes).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.categoryFragmentation).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.categoryOrderDeviationMagnitude).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.averageRuntimePerRun).toBeGreaterThanOrEqual(0);
  });

  it("schedules about 230 matches across 8 courts within the performance budget", () => {
    const synthetic = Array.from({ length: 230 }, (_, index): GraspSchedulableMatch => ({
      id: `synthetic-${index.toString().padStart(3, "0")}`,
      categoryId: `category-${index % 8}`,
      categoryOrder: index % 8,
      poolId: `pool-${Math.floor(index / 10)}`,
      playerIds: [`player-${index}-a`, `player-${index}-b`],
      kind: "group",
      order: (index % 5) + 1,
      round: (index % 5) + 1,
    }));
    const started = performance.now();
    const result = scheduleGroupStageGrasp(synthetic, {
      dayStart,
      planningEnd,
      courts: courtsFor(DEFAULT_CONFIG),
      slotMinutes: 20,
      restGapMinutes: 10,
      seed: 9876,
    });
    expect(result.unscheduled).toEqual([]);
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 25_000);
});

describe("Day 1 rebuild hardening", () => {
  const dayStart = new Date("2026-09-12T08:00:00Z");
  const planningEnd = new Date("2026-09-12T17:00:00Z");
  const schedulingFloor = new Date("2026-09-12T13:00:00Z");
  const options: GraspOptions = {
    dayStart,
    planningEnd,
    schedulingFloor,
    courts: [{ id: "c1", number: 1 }],
    slotMinutes: 20,
    restGapMinutes: 10,
    graspRuns: 4,
    seed: 4242,
  };

  it("schedules around in-progress anchors that started later than scheduled_time", () => {
    const reportedStart = dayStart.getTime() + 4 * 60 * 60_000;
    const reportedEnd = reportedStart + 35 * 60_000;
    const liveStart = dayStart.getTime() + 4 * 60 * 60_000 + 48 * 60_000;
    const liveEnd = Math.max(liveStart + 20 * 60_000, schedulingFloor.getTime() + 20 * 60_000);
    const rebuildMatches: GraspSchedulableMatch[] = [
      {
        id: "reported",
        categoryId: "MS",
        playerIds: ["p1", "p2"],
        kind: "group",
        order: 1,
        fixed: true,
        start: reportedStart,
        end: reportedEnd,
        courtNumber: 1,
      },
      {
        id: "live",
        categoryId: "MS",
        playerIds: ["p1", "p3"],
        kind: "group",
        order: 2,
        round: 2,
        fixed: true,
        start: liveStart,
        end: liveEnd,
        courtNumber: 1,
      },
      {
        id: "next",
        categoryId: "WS",
        playerIds: ["p4", "p5"],
        kind: "group",
        order: 1,
        round: 1,
      },
    ];

    const result = scheduleGroupStageGrasp(rebuildMatches, options);
    expect(result.unscheduled).toEqual([]);
    const nextSlot = result.slots.find((slot) => slot.matchId === "next");
    expect(nextSlot?.start.getTime()).toBeGreaterThanOrEqual(liveEnd);
    expect(nextSlot?.start.getTime()).toBeGreaterThanOrEqual(schedulingFloor.getTime());
    expect(
      validateGraspSchedule(rebuildMatches, result.slots, result.unscheduled, options).valid,
    ).toBe(true);
  });

  it("does not invalidate candidates because two fixed anchors overlap historically", () => {
    const firstStart = dayStart.getTime() + 4 * 60 * 60_000;
    const firstEnd = firstStart + 35 * 60_000;
    const secondStart = dayStart.getTime() + 4 * 60 * 60_000 + 20 * 60_000;
    const secondEnd = secondStart + 20 * 60_000;
    const rebuildMatches: GraspSchedulableMatch[] = [
      {
        id: "first",
        categoryId: "MS",
        playerIds: ["p1", "p2"],
        kind: "group",
        order: 1,
        fixed: true,
        start: firstStart,
        end: firstEnd,
        courtNumber: 1,
      },
      {
        id: "second",
        categoryId: "MS",
        playerIds: ["p1", "p3"],
        kind: "group",
        order: 2,
        fixed: true,
        start: secondStart,
        end: secondEnd,
        courtNumber: 1,
      },
      {
        id: "next",
        categoryId: "WS",
        playerIds: ["p4", "p5"],
        kind: "group",
        order: 1,
      },
    ];

    const result = scheduleGroupStageGrasp(rebuildMatches, options);
    expect(result.unscheduled).toEqual([]);
    expect(
      validateGraspSchedule(rebuildMatches, result.slots, result.unscheduled, options).valid,
    ).toBe(true);
  });

  it("reports remaining-window utilization during a mid-day rebuild", () => {
    const movable: GraspSchedulableMatch[] = [
      {
        id: "m1",
        categoryId: "MS",
        playerIds: ["p1", "p2"],
        kind: "group",
        order: 1,
        round: 1,
      },
      {
        id: "m2",
        categoryId: "WS",
        playerIds: ["p3", "p4"],
        kind: "group",
        order: 1,
        round: 1,
      },
    ];
    const result = scheduleGroupStageGrasp(movable, {
      ...options,
      schedulingFloor,
      graspRuns: 2,
    });
    expect(result.diagnostics.remainingWindowUtilization).not.toBeNull();
    expect(result.diagnostics.remainingWindowUtilization).toBeGreaterThan(0);
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
 * Golden plan for a default-config tournament.
 *
 * The scoping refactor moved slot minutes, rest gaps, day windows, court count and
 * day count out of the code and into the active tournament row. This test runs the
 * scheduler against a tournament configured exactly like the desk always ran (8
 * courts, 2 days, four categories — `DEFAULT_CONFIG`) and pins the resulting
 * group-stage plan. If a future change alters placement for the default config,
 * this fails.
 */
describe("default tournament golden plan", () => {
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

  /** Wall-clock minutes, so the golden does not move with the test runner's timezone. */
  function clock(iso: string): string {
    const at = new Date(iso);
    return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  }

  it("places every group match and finishes inside the day-1 window", () => {
    const { teams, poolMatches, categoryOrder } = goldenFixture();
    const courts = courtsFor(DEFAULT_CONFIG);
    const plan = planDay(
      1,
      "group",
      DEFAULT_CONFIG,
      DAY_ONE,
      courts,
      teams,
      poolMatches,
      [],
      new Map(),
      categoryOrder,
      { seed: 4242 },
    );

    const courtNumber = new Map(courts.map((court) => [court.id, court.number]));
    const schedule = plan.movableSlotPayload
      .map(
        (slot) =>
          `court ${courtNumber.get(slot.court_id) ?? "?"} ${clock(slot.scheduled_time)} ${slot.match_id}`,
      )
      .sort();

    expect(plan.blocked).toEqual([]);
    expect(plan.awaitingTeams).toEqual([]);
    expect(plan.summary.placed).toBe(poolMatches.length);
    expect(schedule).toEqual([
      "court 1 09:00 match-MD-3",
      "court 1 09:30 match-MD-2",
      "court 1 10:00 match-MD-5",
      "court 2 09:00 match-MS-3",
      "court 2 09:30 match-MS-5",
      "court 2 10:00 match-MD-6",
      "court 3 09:00 match-WD-5",
      "court 3 09:30 match-WD-2",
      "court 3 10:00 match-MS-1",
      "court 4 09:00 match-XD-3",
      "court 4 09:30 match-XD-5",
      "court 4 10:00 match-WD-4",
      "court 5 09:00 match-MS-4",
      "court 5 09:30 match-WD-1",
      "court 5 10:00 match-MS-2",
      "court 6 09:00 match-MD-4",
      "court 6 09:30 match-MD-1",
      "court 6 10:00 match-WD-3",
      "court 7 09:00 match-WD-6",
      "court 7 09:30 match-MS-6",
      "court 7 10:00 match-XD-2",
      "court 8 09:00 match-XD-4",
      "court 8 09:30 match-XD-6",
      "court 8 10:00 match-XD-1",
    ]);
    // The whole group stage fits in one hour of wall clock on eight courts.
    expect(plan.summary.projectedFinish).not.toBeNull();
    expect(clock(plan.summary.projectedFinish as string)).toBe("10:20");
    expect(plan.summary.overrun).toBe(false);
  });

  it("takes slot minutes and rest gaps from the tournament row, not from constants", () => {
    const { teams, poolMatches, categoryOrder } = goldenFixture();
    const courts = courtsFor(DEFAULT_CONFIG);
    const stretched = planDay(
      1,
      "group",
      { ...DEFAULT_CONFIG, group_slot_minutes: 30 },
      DAY_ONE,
      courts,
      teams,
      poolMatches,
      [],
      new Map(),
      categoryOrder,
      { seed: 4242 },
    );

    const starts = [
      ...new Set(stretched.movableSlotPayload.map((slot) => clock(slot.scheduled_time))),
    ].sort();
    // 30-minute slots plus the 10-minute group rest gap makes a 40-minute cadence.
    expect(starts).toEqual(["09:00", "09:40", "10:20"]);
    expect(clock(stretched.summary.projectedFinish as string)).toBe("10:50");
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
