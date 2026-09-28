/**
 * The fixture matrix F1–F15 used by the invariant, bound and quality-regression suites.
 *
 * Every bound is closed-form from the fixture's own parameters, so a different-but-valid schedule
 * still passes and a quality regression still fails.
 */

import { expect } from "vitest";

import type { ParticipantAnchor, ScheduleMatch, SchedulingProblem } from "./domain";
import {
  assignmentOf,
  at,
  match,
  pinnedWave,
  resource,
  type HarnessFixture,
} from "./invariant-harness.test-helpers";

const HORIZON = at(0);
const PLANNING_END = at(540);

function problem(partial: Partial<SchedulingProblem> & Pick<SchedulingProblem, "matches" | "resources">): SchedulingProblem {
  return {
    horizonStart: HORIZON,
    planningEnd: PLANNING_END,
    hardEnd: null,
    floor: HORIZON,
    ...partial,
  };
}

function anchor(spec: Partial<ParticipantAnchor> & Pick<ParticipantAnchor, "id" | "start" | "end">): ParticipantAnchor {
  return { participantIds: [], ...spec };
}

// ---------------------------------------------------------------------------------------------
// F1 — dependency chain, 3 resources. 6 matches x 30 min + 5 gaps x 20 min = 280 exactly.
// ---------------------------------------------------------------------------------------------
const f1Chain: ScheduleMatch[] = ["a", "b", "c", "d", "e", "f"].map((id, index, all) =>
  match({
    id,
    participants: ["p1"],
    duration: 30,
    restAfter: 20,
    ...(index === 0 ? {} : { deps: [all[index - 1]!] }),
  }),
);

const F1: HarnessFixture = {
  id: "F1",
  description: "dependency chain, 3 resources; makespan 280 = 6*30 + 5*20",
  solver: "greedy",
  problem: problem({
    matches: f1Chain,
    resources: [resource("r1", 1), resource("r2", 2), resource("r3", 3)],
  }),
  expected: {
    unscheduled: 0,
    knownFinish: at(280),
    decisionFinish: at(280),
    makespanMinutes: 280,
    afterCutoffMinutes: 0,
    resourceIdleMinutes: 660,
    windowUtilization: 180 / 1620,
    knownActiveSpanUtilization: 180 / 840,
    decisionActiveSpanUtilization: 180 / 840,
  },
};

// ---------------------------------------------------------------------------------------------
// F2 — overrun, no decided history: 8 resources x 46 waves x 30 min = 1380 exactly.
// ---------------------------------------------------------------------------------------------
const f2Resources = Array.from({ length: 8 }, (_, i) => resource(`r${i + 1}`, i + 1));
const f2Matches = f2Resources.flatMap((r, i) => pinnedWave(r.id, 46, `r${i + 1}-`));

const F2: HarnessFixture = {
  id: "F2",
  description: "overrun without decided history; 8 resources x 46 waves = 1380, planningEnd 1080",
  solver: "greedy",
  problem: problem({
    matches: f2Matches,
    resources: f2Resources,
    planningEnd: at(1080),
  }),
  expected: {
    unscheduled: 0,
    knownFinish: at(1380),
    knownOverrunMinutes: 300,
    knownOverrun: true,
    decisionFinish: at(1380),
    makespanMinutes: 1380,
    afterCutoffMinutes: 300,
    resourceIdleMinutes: 0,
    windowUtilization: 11040 / 8640,
    knownActiveSpanUtilization: 1,
    decisionActiveSpanUtilization: 1,
  },
};

// ---------------------------------------------------------------------------------------------
// F3 — two dependency chains sharing one participant (b and d must serialize).
// ---------------------------------------------------------------------------------------------
const F3: HarnessFixture = {
  id: "F3",
  description: "two dependency chains sharing participant p-shared",
  solver: "greedy",
  problem: problem({
    matches: [
      match({ id: "a", participants: ["pa"], duration: 30 }),
      match({ id: "b", participants: ["p-shared"], duration: 30, deps: ["a"] }),
      match({ id: "c", participants: ["pc"], duration: 30 }),
      match({ id: "d", participants: ["p-shared"], duration: 30, deps: ["c"] }),
    ],
    resources: [resource("r1", 1), resource("r2", 2)],
  }),
  expected: { unscheduled: 0, decisionFinish: at(90) },
};

// ---------------------------------------------------------------------------------------------
// F4 — overrun with decided history: a resource-holding anchor past planningEnd.
// ---------------------------------------------------------------------------------------------
const F4: HarnessFixture = {
  id: "F4",
  description: "late resource-holding anchor: reporting lateness 270, optimization lateness 0",
  solver: "greedy",
  problem: problem({
    matches: [...pinnedWave("r1", 18, "a"), ...pinnedWave("r2", 18, "b")],
    resources: [resource("r1", 1), resource("r2", 2)],
    anchors: [
      anchor({
        id: "late-anchor",
        participantIds: ["late-p"],
        start: at(540),
        end: at(810),
        resourceId: "r1",
      }),
    ],
  }),
  expected: {
    unscheduled: 0,
    knownFinish: at(810),
    knownOverrunMinutes: 270,
    knownOverrun: true,
    decisionFinish: at(540),
    makespanMinutes: 540,
    afterCutoffMinutes: 0,
    resourceIdleMinutes: 0,
    windowUtilization: 1350 / 1080,
    knownActiveSpanUtilization: 1350 / 1620,
    decisionActiveSpanUtilization: 1,
  },
};

// ---------------------------------------------------------------------------------------------
// F4b — not overrun, incomplete: 48 pinnable waves, hardEnd at planningEnd, 12 left over.
// ---------------------------------------------------------------------------------------------
const F4b: HarnessFixture = {
  id: "F4b",
  description: "incomplete but not late: 12 unscheduled, knownOverrun false",
  solver: "greedy",
  problem: problem({
    matches: [...pinnedWave("r1", 24, "a"), ...pinnedWave("r2", 24, "b")],
    resources: [resource("r1", 1), resource("r2", 2)],
    hardEnd: at(540),
  }),
  expected: {
    unscheduled: 12,
    knownFinish: at(540),
    knownOverrunMinutes: 0,
    knownOverrun: false,
    decisionFinish: at(540),
    afterCutoffMinutes: 0,
    resourceIdleMinutes: 0,
  },
};

// ---------------------------------------------------------------------------------------------
// F4c — overrun, incomplete: the fourth cell of the 2x2 matrix.
// ---------------------------------------------------------------------------------------------
const F4c: HarnessFixture = {
  id: "F4c",
  description: "late and incomplete at once; the two signals are independent",
  solver: "greedy",
  problem: problem({
    matches: [
      ...pinnedWave("r1", 20, "a"),
      ...pinnedWave("r2", 20, "b"),
      ...Array.from({ length: 12 }, (_, i) =>
        match({ id: `unknown${i}`, participants: [], participantsKnown: false, duration: 30 }),
      ),
    ],
    resources: [resource("r1", 1), resource("r2", 2)],
  }),
  expected: {
    unscheduled: 12,
    knownFinish: at(600),
    knownOverrunMinutes: 60,
    knownOverrun: true,
    decisionFinish: at(600),
    afterCutoffMinutes: 60,
    resourceIdleMinutes: 0,
  },
};

// ---------------------------------------------------------------------------------------------
// F5 — capability routing and an impossible requirement.
// ---------------------------------------------------------------------------------------------
const F5: HarnessFixture = {
  id: "F5",
  description: "capability routing: streaming-only match goes to r2, impossible match is unscheduled",
  solver: "greedy",
  problem: problem({
    matches: [
      match({ id: "stream", participants: ["ps"], duration: 30, requirements: ["streaming"] }),
      match({ id: "plain", participants: ["pn"], duration: 30 }),
      match({ id: "impossible", participants: ["px"], duration: 30, requirements: ["unobtainium"] }),
    ],
    resources: [resource("r1", 1), resource("r2", 2, { capabilities: ["streaming"] })],
  }),
  expected: { unscheduled: 1, decisionFinish: at(30) },
};

// ---------------------------------------------------------------------------------------------
// F6 — restAfter 10 on the previous match, restBefore 30 on the next: the unlock is T+30, not T+10.
// ---------------------------------------------------------------------------------------------
const F6: HarnessFixture = {
  id: "F6",
  description: "candidate-specific rest unlock: restAfter 10 vs restBefore 30 must not deadlock",
  solver: "greedy",
  problem: problem({
    matches: [
      match({ id: "prev", participants: ["q"], duration: 30, restAfter: 10 }),
      match({ id: "next", participants: ["q"], duration: 30, restBefore: 30, deps: ["prev"] }),
    ],
    resources: [resource("r1", 1)],
  }),
  expected: { unscheduled: 0, decisionFinish: at(90), makespanMinutes: 90 },
};

// ---------------------------------------------------------------------------------------------
// F7 — dependency cycle: everything unscheduled, no hang.
// ---------------------------------------------------------------------------------------------
const F7: HarnessFixture = {
  id: "F7",
  description: "dependency cycle terminates with both matches unscheduled",
  solver: "greedy",
  problem: problem({
    matches: [
      match({ id: "cycle-a", participants: ["pa"], duration: 30, deps: ["cycle-b"] }),
      match({ id: "cycle-b", participants: ["pb"], duration: 30, deps: ["cycle-a"] }),
    ],
    resources: [resource("r1", 1)],
  }),
  expected: {
    unscheduled: 2,
    knownFinish: null,
    decisionFinish: null,
    knownOverrun: false,
    makespanMinutes: 0,
  },
};

// ---------------------------------------------------------------------------------------------
// F8 — zero-duration match at exactly hardEnd.
// ---------------------------------------------------------------------------------------------
const F8: HarnessFixture = {
  id: "F8",
  description: "zero-duration match placed at hardEnd, not left unscheduled",
  solver: "greedy",
  problem: problem({
    matches: [
      match({ id: "filler", participants: ["pf"], duration: 30 }),
      match({ id: "zero", participants: ["pz"], duration: 0, deps: ["filler"] }),
    ],
    resources: [resource("r1", 1)],
    hardEnd: at(30),
    planningEnd: at(30),
  }),
  expected: { unscheduled: 0, decisionFinish: at(30), makespanMinutes: 30 },
};

// ---------------------------------------------------------------------------------------------
// F9 — the exact boundary uses `<=`: a match may start exactly when another ends with zero rest.
// ---------------------------------------------------------------------------------------------
const F9: HarnessFixture = {
  id: "F9",
  description: "touching boundaries are allowed (<=, not <)",
  solver: "greedy",
  problem: problem({
    matches: [
      match({ id: "first", participants: ["p"], duration: 30 }),
      match({ id: "second", participants: ["p"], duration: 30 }),
    ],
    resources: [resource("r1", 1)],
  }),
  expected: { unscheduled: 0, decisionFinish: at(60) },
};

// ---------------------------------------------------------------------------------------------
// F10 — late anchor changes reporting metrics only.
// ---------------------------------------------------------------------------------------------
const F10: HarnessFixture = {
  id: "F10",
  description: "an anchor ending after planningEnd raises reporting lateness with zero optimization lateness",
  solver: "greedy",
  problem: problem({
    matches: [match({ id: "solved", participants: ["p"], duration: 30 })],
    resources: [resource("r1", 1)],
    anchors: [anchor({ id: "late", participantIds: ["p"], start: at(120), end: at(180) })],
    planningEnd: at(60),
  }),
  expected: {
    unscheduled: 0,
    knownFinish: at(180),
    knownOverrunMinutes: 120,
    knownOverrun: true,
    decisionFinish: at(30),
    afterCutoffMinutes: 0,
  },
};

// ---------------------------------------------------------------------------------------------
// F11 — a zero-duration match whose only feasible start is exactly hardEnd.
// ---------------------------------------------------------------------------------------------
const F11: HarnessFixture = {
  id: "F11",
  description: "zero-duration match whose only feasible start equals hardEnd",
  solver: "greedy",
  problem: problem({
    matches: [
      ...pinnedWave("r1", 18, "fill"),
      match({ id: "tail", participants: ["pt"], duration: 0, deps: ["fill17"] }),
    ],
    resources: [resource("r1", 1)],
    hardEnd: at(540),
  }),
  expected: { unscheduled: 0, decisionFinish: at(540), makespanMinutes: 540 },
};

// ---------------------------------------------------------------------------------------------
// F12/F13 — a candidate may be placed *before* a later fixed match / anchor.
// ---------------------------------------------------------------------------------------------
const F12: HarnessFixture = {
  id: "F12",
  description: "non-fixed candidate placed before a later fixed match sharing its participant",
  solver: "greedy",
  problem: problem({
    matches: [
      match({
        id: "fixed",
        participants: ["pf"],
        duration: 30,
        fixed: true,
        start: at(100),
        end: at(130),
        resourceId: "r1",
      }),
      match({ id: "candidate", participants: ["pf"], duration: 30 }),
    ],
    resources: [resource("r1", 1)],
  }),
  expected: { unscheduled: 0, knownFinish: at(130), decisionFinish: at(30) },
};

const F13: HarnessFixture = {
  id: "F13",
  description: "non-fixed candidate placed before a later anchor sharing its participant",
  solver: "greedy",
  problem: problem({
    matches: [match({ id: "candidate", participants: ["pf"], duration: 30 })],
    resources: [resource("r1", 1)],
    anchors: [
      anchor({ id: "fixed-anchor", participantIds: ["pf"], start: at(100), end: at(130), resourceId: "r1" }),
    ],
  }),
  expected: { unscheduled: 0, knownFinish: at(130), decisionFinish: at(30) },
};

// ---------------------------------------------------------------------------------------------
// F14 — the exact rest boundary before a fixed match is accepted.
// ---------------------------------------------------------------------------------------------
const F14: HarnessFixture = {
  id: "F14",
  description: "exact rest boundary before a fixed match (touching the forbidden interval's edge)",
  solver: "greedy",
  problem: problem({
    matches: [
      match({
        id: "fixed",
        participants: ["pf"],
        duration: 30,
        restAfter: 20,
        fixed: true,
        start: at(100),
        end: at(130),
        resourceId: "r1",
      }),
      match({ id: "candidate", participants: ["pf"], duration: 30, eligibleFrom: at(70) }),
    ],
    resources: [resource("r1", 1)],
  }),
  expected: { unscheduled: 0, knownFinish: at(130), decisionFinish: at(100) },
};

// ---------------------------------------------------------------------------------------------
// F15 — a candidate whose only candidate start lies inside the forbidden interval is rejected.
// ---------------------------------------------------------------------------------------------
const F15: HarnessFixture = {
  id: "F15",
  description: "candidate inside the forbidden interval is unscheduled, never emitted invalid",
  solver: "greedy",
  problem: problem({
    matches: [
      match({
        id: "fixed",
        participants: ["pf"],
        duration: 30,
        restAfter: 20,
        fixed: true,
        start: at(100),
        end: at(130),
        resourceId: "r1",
      }),
      match({ id: "candidate", participants: ["pf"], duration: 30, eligibleFrom: at(80) }),
    ],
    resources: [resource("r1", 1)],
    hardEnd: at(130),
    planningEnd: at(130),
  }),
  expected: {
    unscheduled: 1,
    knownFinish: at(130),
    knownOverrunMinutes: 0,
    knownOverrun: false,
    decisionFinish: null,
  },
};

// ---------------------------------------------------------------------------------------------
// F16 — a straggler stage is not postponed behind events with a full round still to play.
//
// The reported bug, in its smallest form. `pc` is the straggler: one match left in `C:r1`, and it
// unlocks `C:r2`, which does not exist as a row until `C:r1` closes. `pa` still has three matches
// in `A:r1`. Every participant is disjoint, so bottleneck pressure ties at zero for all of them and
// the only key that can separate the matches is stage-closing urgency.
//
// Closed form: with both resources busy until 30 and every match 30 minutes, the earliest any
// movable match can end is 60. The straggler must end exactly there. Ranking by raw remaining work
// first — the pre-change behaviour — would drain `A:r1` ahead of it, ending `c-last` at 150 and
// closing `C:r1` only after the full round has been played out.
// ---------------------------------------------------------------------------------------------
const F16_FREE = at(60);

const F16: HarnessFixture = {
  id: "F16",
  description: "straggler stage closes at the first free instant, not after the full rounds",
  solver: "greedy",
  problem: problem({
    matches: [
      // Declared history: both resources busy for the first wave.
      match({
        id: "h1",
        participants: ["h1p"],
        duration: 30,
        fixed: true,
        start: at(0),
        end: at(30),
        resourceId: "r1",
        groupKey: "H",
        stageKey: "H:r0",
      }),
      match({
        id: "h2",
        participants: ["h2p"],
        duration: 30,
        fixed: true,
        start: at(0),
        end: at(30),
        resourceId: "r2",
        groupKey: "H",
        stageKey: "H:r0",
      }),
      // A: a full round still to play, and one participant who plays all of it.
      ...["a0", "a1", "a2"].map((id, index) =>
        match({
          id,
          participants: ["pa"],
          duration: 30,
          groupKey: "A",
          stageKey: "A:r1",
          sequence: index,
        }),
      ),
      // B: a full round with independent participants.
      ...["b0", "b1"].map((id, index) =>
        match({ id, participants: [`pb${index}`], duration: 30, groupKey: "B", stageKey: "B:r1" }),
      ),
      // C: the straggler. One match left, and closing it releases the next round.
      match({
        id: "c-last",
        participants: ["pc"],
        duration: 30,
        groupKey: "C",
        stageKey: "C:r1",
        stageUnlocks: true,
      }),
      match({
        id: "c-r2",
        participants: ["pc2"],
        duration: 30,
        deps: ["c-last"],
        groupKey: "C",
        stageKey: "C:r2",
      }),
    ],
    resources: [resource("r1", 1), resource("r2", 2)],
  }),
  expected: { unscheduled: 0, decisionFinish: at(180), makespanMinutes: 180 },
  assertExtra: (solution, problem) => {
    const stageKeyOf = new Map(problem.matches.map((m) => [m.id, m.stageKey]));
    const closeOfStage = (stageKey: string) =>
      Math.max(
        ...solution.assignments
          .filter((a) => stageKeyOf.get(a.matchId) === stageKey)
          .map((a) => a.end),
      );

    const straggler = assignmentOf(solution, "c-last");
    expect(straggler, "c-last must be placed").toBeDefined();
    // The earliest a resource can take it: history ends at 30, plus its own 30 minutes.
    expect(straggler!.end, "straggler closes at the first free instant").toBe(F16_FREE);
    // The stage is closed there, before the events that still had a full round to play.
    expect(closeOfStage("C:r1"), "C:r1 closes at the first free instant").toBe(F16_FREE);
    expect(closeOfStage("C:r1"), "C:r1 closes before A:r1").toBeLessThan(closeOfStage("A:r1"));
    expect(closeOfStage("C:r1"), "C:r1 closes before B:r1").toBeLessThan(closeOfStage("B:r1"));
    // And the round it releases is played immediately, not left waiting behind the full rounds.
    const released = assignmentOf(solution, "c-r2");
    expect(released, "c-r2 must be placed").toBeDefined();
    expect(released!.start, "the released round starts as soon as the dependency clears").toBe(
      F16_FREE,
    );
  },
};

export const FIXTURES: HarnessFixture[] = [
  F1,
  F2,
  F3,
  F4,
  F4b,
  F4c,
  F5,
  F6,
  F7,
  F8,
  F9,
  F10,
  F11,
  F12,
  F13,
  F14,
  F15,
  F16,
];

export function fixtureById(id: string): HarnessFixture {
  const fixture = FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Unknown fixture ${id}`);
  return fixture;
}
