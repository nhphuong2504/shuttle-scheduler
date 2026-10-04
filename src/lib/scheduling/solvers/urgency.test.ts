/**
 * Pins the one urgency order both solvers read.
 *
 * The order is a fixed tuple, so the tests are written as *dominance* assertions: a key at a higher
 * tier must beat any value of the tiers below it. That is the property the tuple claims, and it is
 * the property that was missing before — greedy ranked by completion pressure descending while GRASP
 * ranked by it ascending, and both led with a participant's raw remaining count, so a stage with one
 * match left could be benched behind an event that had barely started.
 */

import { describe, expect, it } from "vitest";

import { at, match, resource } from "../invariant-harness.test-helpers";
import type { ScheduleMatch, SchedulingProblem } from "../domain";
import { processingOrder } from "./greedy";
import {
  buildUrgencyBoard,
  comparePlayerWork,
  compareUrgency,
  rankByUrgency,
  urgencyKeysOf,
  type PlayerWorkEntry,
  type UrgencyKeys,
} from "./urgency";

const HORIZON = at(0);
const PLANNING_END = at(600);

function keys(overrides: Partial<UrgencyKeys> = {}): UrgencyKeys {
  return {
    futureConflictDegree: 0,
    fixedWindowPressure: 0,
    stageRemaining: 0,
    stageUnlocks: false,
    remainingMatches: 0,
    remainingGroupCount: 0,
    waitingTimeMinutes: 0,
    completionPressure: 0,
    phase: 0,
    softOrder: 0,
    sequence: 0,
    constrainedPlayerId: "p",
    matchId: "m",
    ...overrides,
  };
}

/** `high` sorts first whichever way the tiers below it point. */
function expectDominates(high: UrgencyKeys, low: UrgencyKeys): void {
  expect(compareUrgency(high, low)).toBeLessThan(0);
  expect(compareUrgency(low, high)).toBeGreaterThan(0);
}

describe("the urgency tuple", () => {
  it("leads with bottleneck pressure, not raw volume", () => {
    // A player in a shared, boxed-in stage is the bottleneck; a player with more matches to play but
    // no shared constraint is not. Only the first two keys may decide this.
    expectDominates(
      keys({ futureConflictDegree: 1, remainingMatches: 0, stageRemaining: 9 }),
      keys({ futureConflictDegree: 0, remainingMatches: 10, stageRemaining: 1 }),
    );
    expectDominates(
      keys({ fixedWindowPressure: 1, remainingMatches: 0 }),
      keys({ fixedWindowPressure: 0, remainingMatches: 10 }),
    );
  });

  it("puts a nearly finished stage above raw work volume", () => {
    // This is the regression the change exists for: the stage with one match left goes first even
    // though the other unit has more work outstanding and therefore more completion pressure.
    expectDominates(
      keys({ stageRemaining: 1, remainingMatches: 1, remainingGroupCount: 1, completionPressure: 1 }),
      keys({
        stageRemaining: 6,
        remainingMatches: 3,
        remainingGroupCount: 3,
        completionPressure: 6,
      }),
    );
  });

  it("breaks a stage tie with the unlock, not with volume", () => {
    expectDominates(
      keys({ stageRemaining: 2, stageUnlocks: true, remainingMatches: 1 }),
      keys({ stageRemaining: 2, stageUnlocks: false, remainingMatches: 9 }),
    );
  });

  it("then orders by raw volume, waiting time, and completion pressure", () => {
    expectDominates(
      keys({ remainingMatches: 3, waitingTimeMinutes: 0 }),
      keys({ remainingMatches: 1, waitingTimeMinutes: 100 }),
    );
    expectDominates(
      keys({ remainingMatches: 1, remainingGroupCount: 2 }),
      keys({ remainingMatches: 1, remainingGroupCount: 1 }),
    );
    expectDominates(
      keys({ remainingMatches: 0, waitingTimeMinutes: 30 }),
      keys({ remainingMatches: 0, waitingTimeMinutes: 0 }),
    );
  });

  it("pins completion pressure to a single polarity: ascending", () => {
    // The inversion that used to exist between the two solvers. The smaller unit fits, so it drains;
    // the larger one is deferred until there is room for it.
    expectDominates(keys({ completionPressure: 1 }), keys({ completionPressure: 6 }));
  });

  it("falls back to presentation and then to canonical ids", () => {
    expectDominates(keys({ phase: 0 }), keys({ phase: 1 }));
    expectDominates(keys({ softOrder: 0 }), keys({ softOrder: 1 }));
    expectDominates(keys({ sequence: 0 }), keys({ sequence: 1 }));
    expectDominates(
      keys({ constrainedPlayerId: "a", matchId: "z" }),
      keys({ constrainedPlayerId: "b", matchId: "a" }),
    );
    expectDominates(keys({ matchId: "a" }), keys({ matchId: "b" }));
  });

  it("treats two identical key sets as a tie", () => {
    expect(compareUrgency(keys(), keys())).toBe(0);
  });
});

describe("choosing a match's most constrained participant", () => {
  const player = (overrides: Partial<PlayerWorkEntry> & Pick<PlayerWorkEntry, "playerId">) => ({
    remainingMatches: 0,
    remainingGroupCount: 0,
    futureConflictDegree: 0,
    fixedWindowPressure: 0,
    ...overrides,
  });

  it("reads bottleneck pressure before volume, matching the tuple", () => {
    expect(
      comparePlayerWork(
        player({ playerId: "boxed", futureConflictDegree: 2, remainingMatches: 1 }),
        player({ playerId: "busy", futureConflictDegree: 0, remainingMatches: 9 }),
      ),
    ).toBeLessThan(0);
  });

  it("is total, so the choice cannot depend on insertion order", () => {
    expect(comparePlayerWork(player({ playerId: "a" }), player({ playerId: "b" }))).toBeLessThan(0);
    expect(comparePlayerWork(player({ playerId: "b" }), player({ playerId: "a" }))).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The board, and what both solvers read off it
// ---------------------------------------------------------------------------------------------

/** Six isolated pairs: every player is in exactly one match, so no bottlenecks exist. */
function isolatedPairs(stageKey: string, prefix: string, stageUnlocks = false): ScheduleMatch[] {
  return Array.from({ length: 6 }, (_, index) =>
    match({
      id: `${prefix}-m${index}`,
      participants: [`${prefix}-p${index}a`, `${prefix}-p${index}b`],
      groupKey: stageKey,
      completionKey: stageKey,
      stageKey,
      stageUnlocks,
    }),
  );
}

function problemWith(matches: readonly ScheduleMatch[]): SchedulingProblem {
  return {
    matches,
    resources: [resource("r1", 1), resource("r2", 2)],
    horizonStart: HORIZON,
    planningEnd: PLANNING_END,
    hardEnd: null,
    floor: HORIZON,
  };
}

describe("the urgency board", () => {
  it("counts only what is still unplaced, so stageRemaining falls as a stage drains", () => {
    const all = isolatedPairs("MD:round1", "md");
    const full = buildUrgencyBoard({
      remaining: all,
      planningEnd: PLANNING_END,
      referenceTime: HORIZON,
    });
    expect(urgencyKeysOf(all[0]!, full).stageRemaining).toBe(6);

    // Five of the six already placed: the stage is one match from closing.
    const nearlyDone = buildUrgencyBoard({
      remaining: all.slice(0, 1),
      planningEnd: PLANNING_END,
      referenceTime: HORIZON,
    });
    expect(urgencyKeysOf(all[0]!, nearlyDone).stageRemaining).toBe(1);
  });

  it("treats an absent stage key as no stage rather than as a stage of its own", () => {
    const [stageLess] = isolatedPairs("ignored", "x");
    const bare: ScheduleMatch = { ...stageLess!, stageKey: undefined };
    const board = buildUrgencyBoard({
      remaining: [bare],
      planningEnd: PLANNING_END,
      referenceTime: HORIZON,
    });
    const built = urgencyKeysOf(bare, board);
    expect(built.stageRemaining).toBe(0);
    expect(built.stageUnlocks).toBe(false);
  });
});

describe("both solvers read one order", () => {
  it("greedy's processing order is the shared order over the whole problem", () => {
    // Not a tautology: it pins the *inputs* greedy feeds the comparator — the non-fixed set, the
    // problem floor as the reference instant, and zero waiting — so a future divergence in how
    // greedy builds its board fails here rather than silently changing what "urgency" means.
    const problem = problemWith([
      ...isolatedPairs("MD:round1", "md", true),
      ...isolatedPairs("WS:round1", "ws"),
    ]);
    const nonFixed = problem.matches.filter((candidate) => !candidate.fixed);
    const board = buildUrgencyBoard({
      remaining: nonFixed,
      planningEnd: problem.planningEnd,
      referenceTime: problem.floor,
    });
    expect(processingOrder(problem)).toEqual(rankByUrgency(nonFixed, board));
  });

  it("closes the near-finished stage before the events that still owe a whole round", () => {
    // The reported bug, in miniature. Every player is in one match and no stage has a bottleneck, so
    // only the stage tier and completion pressure differ: MD round one has one match left, WS and MS
    // have six each. The old order drained the biggest completion unit first and benched the
    // straggler; the shared order must not.
    const problem = problemWith([
      ...isolatedPairs("MD:round1", "md", true),
      ...isolatedPairs("WS:round1", "ws"),
      ...isolatedPairs("MS:round1", "ms"),
    ]);
    const order = processingOrder(problem);
    expect(order[0]?.id).toBe("md-m0");
    // And the rest of the straggler stage is the very next thing, not merely first by luck.
    expect(order[1]?.id).toBe("md-m1");
    expect(order.slice(0, 6).every((candidate) => candidate.id.startsWith("md-"))).toBe(true);
  });

  it("still lets a genuine bottleneck outrank stage closure", () => {
    // Bottleneck pressure stays the highest priority, as agreed. A four-player round robin boxes
    // every one of its players in three matches, which is a real bottleneck; the stage that is one
    // match from closing is not.
    const roundRobin: ScheduleMatch[] = [];
    const players = ["p1", "p2", "p3", "p4"];
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        roundRobin.push(
          match({
            id: `ws-${i}${j}`,
            participants: [players[i]!, players[j]!],
            groupKey: "WS:round1",
            completionKey: "WS:round1",
            stageKey: "WS:round1",
          }),
        );
      }
    }
    const problem = problemWith([...isolatedPairs("MD:round1", "md", true), ...roundRobin]);
    const order = processingOrder(problem);
    expect(order[0]?.id.startsWith("ws-")).toBe(true);
  });
});
