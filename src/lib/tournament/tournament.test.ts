import { describe, expect, it, vi } from "vitest";

import { buildFirstRound, seedEntrants, totalMatchesInDraw } from "./draws";
import { gamesWinner, isLegalGameScore } from "./format";
import { circleMethod, planPoolSizes, poolMatchCount } from "./pools";
import {
  scheduleGroupStageGrasp,
  validateGraspSchedule,
  type GraspOptions,
  type GraspSchedulableMatch,
} from "./scheduler-grasp";
import { checkStartConstraints, scheduleMatches } from "./scheduler";
import { computeStandings, poolIsComplete } from "./standings";

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
      courts: Array.from({ length: 8 }, (_, index) => ({
        id: `court-${index + 1}`,
        number: index + 1,
      })),
      slotMinutes: 20,
      restGapMinutes: 10,
      seed: 9876,
    });
    expect(result.unscheduled).toEqual([]);
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 25_000);
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
