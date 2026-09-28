/**
 * Guards the benchmark shapes themselves.
 *
 * The shape generator is what every solver comparison rests on, so a quiet change to it would move
 * every number the benchmark reports without failing anything. These tests pin the two properties
 * that make a shape mean what its name says: that omitting `crossEventsPerEntrant` still means
 * "entered in every group", and that `multi-event` really does put players in exactly two events
 * with a recovery rule that binds across them.
 */

import { describe, expect, it } from "vitest";

import { assertValidProblem } from "../preflight";
import { BENCH_INSTANCES, SHAPES, buildInstance, instanceById } from "./shapes";
import type { ScheduleMatch, SchedulingProblem } from "../domain";
import { solve } from "../solvers";
import { stageCloseTimes } from "./harness";

/** Groups each participant appears in, keyed by participant id. */
function groupsByParticipant(problem: SchedulingProblem): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const match of problem.matches) {
    for (const participantId of match.participantIds) {
      const groups = map.get(participantId) ?? new Set<string>();
      groups.add(match.groupKey);
      map.set(participantId, groups);
    }
  }
  return map;
}

function solverMatches(problem: SchedulingProblem): ScheduleMatch[] {
  return problem.matches.filter((match) => !match.fixed);
}

describe("benchmark shapes", () => {
  it("generates a valid problem for every shape", () => {
    for (const instance of BENCH_INSTANCES) {
      expect(() => assertValidProblem(instance.problem), `${instance.id} preflight`).not.toThrow();
      expect(instance.solverMatchCount).toBeGreaterThan(0);
    }
  });

  it("keeps the unset cross-entry meaning every group", () => {
    // The original shapes must stay byte-identical, and the only way a cross entrant is invisible in
    // a group is a group-local id. So every group of a shape with no `crossEventsPerEntrant` must
    // contain the first cross entrant.
    for (const spec of SHAPES.filter((candidate) => candidate.crossEventsPerEntrant == null)) {
      const instance = buildInstance(spec);
      const groups = groupsByParticipant(instance.problem);
      const crossId = spec.teamSize === 1 ? "x0" : "x0a";
      expect(groups.get(crossId)?.size, `${spec.id} ${crossId} groups`).toBe(spec.groups);
    }
  });

  it("puts multi-event players in exactly two categories, spread across the events", () => {
    const spec = SHAPES.find((candidate) => candidate.id === "multi-event")!;
    expect(spec.crossEventsPerEntrant).toBe(2);

    const instance = buildInstance(spec);
    const groups = groupsByParticipant(instance.problem);
    const perGroup: number[] = Array.from({ length: spec.groups }, () => 0);

    for (let index = 0; index < spec.crossEntrants; index++) {
      for (const suffix of ["a", "b"]) {
        const entered = groups.get(`x${index}${suffix}`);
        expect(entered?.size, `x${index}${suffix} categories`).toBe(2);
        for (const group of entered ?? []) perGroup[Number(group.slice(1))]! += 1;
      }
    }

    // Every group carries multi-event players from two to four of its teams, so a sizeable share of
    // the field is shared with another event. That sharing is the whole point of the shape.
    const fieldSize = spec.teamSize * spec.entrantsPerGroup;
    for (const [group, count] of perGroup.entries()) {
      expect(count, `group ${group} multi-event players`).toBeGreaterThanOrEqual(4);
      expect(count, `group ${group} multi-event players`).toBeLessThan(fieldSize);
    }
  });

  it("makes recovery bind between a multi-event player's categories", () => {
    const instance = instanceById("multi-event");
    const matched = solverMatches(instance.problem);
    // Every solver match must carry the shape's recovery requirement, otherwise the rest rule the
    // shape exists to exercise is not actually in play.
    for (const match of matched) {
      expect(match.restAfterMinutes, `${match.id} restAfter`).toBe(30);
      expect(match.restBeforeMinutes).toBeUndefined();
    }
    // 25-minute matches and 30 minutes of recovery means a player cannot be in two places within the
    // hour, so consecutive matches are forced apart rather than merely ordered.
    expect(matched[0]!.durationMinutes).toBe(25);
  });

  it("gives the window no slack beyond the court time the work needs", () => {
    const instance = instanceById("multi-event");
    const problem = instance.problem;
    // Mirrors the generator's own demand formula, anchors included, so the expectation cannot drift
    // from the code it is checking.
    const demandMinutes =
      problem.matches.reduce((total, match) => total + match.durationMinutes, 0) +
      (problem.anchors ?? []).reduce(
        (total, anchor) => total + (anchor.end - anchor.start) / 60_000,
        0,
      );
    // targetUtilization is 1, so the window is the pure court-time lower bound. Everything the
    // recovery rule adds on top has to show up as lateness, which is the criterion under test.
    expect(instance.planningMinutes).toBe(Math.ceil(demandMinutes / problem.resources.length));
  });
});

/**
 * The straggler shape, in the terms the reported bug is stated in.
 *
 * The pre-change baseline is a recorded number, not a formula: with raw remaining work leading the
 * order, group 0's two surviving round-one matches were scheduled behind every other match, so its
 * stage closed at 240 minutes. The assertion below is therefore an upstream bound plus an ordering
 * property — the straggler's stage must close before every other event's stage, not merely at some
 * smaller number.
 */
describe("straggler shape", () => {
  const PRE_CHANGE_STAGE_CLOSE_MINUTES = 240;

  it("leaves the straggler group with only its last round-one matches on the board", () => {
    const spec = SHAPES.find((candidate) => candidate.id === "straggler")!;
    const instance = instanceById("straggler");
    const stragglerKey = `g${spec.straggler!.group}:r0`;
    const opening = instance.problem.matches.filter((match) => match.stageKey === stragglerKey);

    expect(opening.length).toBeGreaterThan(spec.straggler!.remaining);
    expect(opening.filter((match) => !match.fixed).length).toBe(spec.straggler!.remaining);
    // The other groups are untouched and still hold a full opening round.
    for (let group = 0; group < spec.groups; group++) {
      if (group === spec.straggler!.group) continue;
      const stage = `g${group}:r0`;
      expect(
        instance.problem.matches.filter((match) => match.stageKey === stage && !match.fixed).length,
        `${stage} movable`,
      ).toBe(spec.entrantsPerGroup / 2);
    }
  });

  for (const solver of ["greedy", "grasp-hybrid"] as const) {
    it(`closes the straggler stage before every other stage (${solver})`, () => {
      const spec = SHAPES.find((candidate) => candidate.id === "straggler")!;
      const instance = instanceById("straggler");
      const solution = solve(instance.problem, solver, solver === "greedy" ? {} : { runs: 1 });
      // The harness's own reporting measure, so this asserts on the number the benchmark reports:
      // per-stage close in minutes, decided history excluded.
      const closes = stageCloseTimes(instance.problem, solution);
      const stragglerKey = `g${spec.straggler!.group}:r0`;
      const stragglerClose = closes[stragglerKey];

      expect(stragglerClose, `${stragglerKey} must close`).toBeDefined();
      expect(stragglerClose!, "no later than the recorded pre-change baseline").toBeLessThanOrEqual(
        PRE_CHANGE_STAGE_CLOSE_MINUTES,
      );
      for (const [stageKey, minutes] of Object.entries(closes)) {
        if (stageKey === stragglerKey) continue;
        expect(stragglerClose!, `${stragglerKey} before ${stageKey}`).toBeLessThan(minutes);
      }
    });
  }
});
