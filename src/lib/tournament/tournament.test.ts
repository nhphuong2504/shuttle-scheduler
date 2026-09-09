import { describe, expect, it } from "vitest";

import { buildFirstRound, seedEntrants, totalMatchesInDraw } from "./draws";
import { gamesWinner, isLegalGameScore } from "./format";
import { circleMethod, planPoolSizes, poolMatchCount } from "./pools";
import { scheduleMatches } from "./scheduler";
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
    expect(gamesWinner([{ a: 21, b: 19 }, { a: 21, b: 18 }])).toBe("a");
    expect(isLegalGameScore(21, 19)).toBe(true);
    expect(isLegalGameScore(21, 20)).toBe(false);
  });
});

describe("standings", () => {
  it("uses head-to-head for two-team ties", () => {
    const matches = [
      { team_a_id: "A", team_b_id: "B", score_a: 21, score_b: 10, winner_id: "A", status: "reported" },
      { team_a_id: "A", team_b_id: "C", score_a: 21, score_b: 10, winner_id: "A", status: "reported" },
      { team_a_id: "A", team_b_id: "D", score_a: 10, score_b: 21, winner_id: "D", status: "reported" },
      { team_a_id: "B", team_b_id: "C", score_a: 21, score_b: 10, winner_id: "B", status: "reported" },
      { team_a_id: "B", team_b_id: "D", score_a: 21, score_b: 10, winner_id: "B", status: "reported" },
      { team_a_id: "C", team_b_id: "D", score_a: 21, score_b: 10, winner_id: "C", status: "reported" },
    ];
    const rows = computeStandings(["A", "B", "C", "D"], matches);
    expect(rows.slice(0, 2).map((r) => r.teamId)).toEqual(["A", "B"]);
  });

  it("does not let a single override beat more wins", () => {
    const matches = [
      { team_a_id: "A", team_b_id: "B", score_a: 21, score_b: 10, winner_id: "A", status: "reported" },
    ];
    const rows = computeStandings(["A", "B"], matches, { B: 1 });
    expect(rows[0]?.teamId).toBe("A");
  });

  it("resolves three-way cycles deterministically", () => {
    const matches = [
      { team_a_id: "A", team_b_id: "B", score_a: 21, score_b: 19, winner_id: "A", status: "reported" },
      { team_a_id: "B", team_b_id: "C", score_a: 21, score_b: 10, winner_id: "B", status: "reported" },
      { team_a_id: "C", team_b_id: "A", score_a: 21, score_b: 5, winner_id: "C", status: "reported" },
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
        [{ team_a_id: "A", team_b_id: "B", score_a: 21, score_b: 10, winner_id: "A", status: "reported" }],
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
        { id: "m1", categoryId: "MS", categoryOrder: 1, playerIds: ["p1"], kind: "group", order: 1 },
        { id: "m2", categoryId: "MS", categoryOrder: 1, playerIds: ["p1"], kind: "group", order: 2 },
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
    expect(result.slots[0]?.start.toISOString()).toBe(new Date(parentEnd + 30 * 60000).toISOString());
  });
});
