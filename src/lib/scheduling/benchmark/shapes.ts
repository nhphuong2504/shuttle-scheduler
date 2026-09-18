/**
 * Benchmark instances for the generic scheduling core.
 *
 * These are deliberately larger than the F1–F15 fixture matrix. The fixtures pin *semantics* with
 * closed-form bounds; these exist to compare solver quality and runtime at realistic sizes, so they
 * are generated from a compact spec and every generated problem is valid by construction:
 *
 *   - Fixed matches are staggered 60 minutes apart on rotating resources, so no two of them share a
 *     resource at the same time, and any two that share a participant are separated by far more than
 *     the required rest.
 *   - Anchors start strictly after the whole fixed block and are staggered 60 minutes apart, so an
 *     anchor can never overlap a fixed match or another anchor.
 *
 * Participant contention is generated on purpose. A "cross" team is entered in *every* group, the
 * way one player really enters two categories. Those matches have no dependency relationship to each
 * other but do share participants, so the order the solver picks changes the outcome and the rest
 * rule actually binds. That contention, plus a planning window set near the demand, is what creates
 * room for a search strategy to out-perform a greedy one — if it can.
 */

import type {
  ParticipantAnchor,
  ScheduleMatch,
  ScheduleResource,
  SchedulingProblem,
} from "../domain";
import { at, match, resource, T0 } from "../invariant-harness.test-helpers";

export interface ShapeSpec {
  id: string;
  description: string;
  /** Independent groups, e.g. MS / WS / MD. Maps to `groupKey` and `completionKey`. */
  groups: number;
  /** Entrants per group. In doubles an entrant is a team, so it carries `teamSize` players. */
  entrantsPerGroup: number;
  /** Players per entrant: 1 is singles, 2 is doubles. */
  teamSize: number;
  /** Dependency depth. Round r depends on round r-1, so chains and shared participants coexist. */
  rounds: number;
  resources: number;
  /** Entrants (by index) entered in every group, which is where cross-group contention comes from. */
  crossEntrants: number;
  /**
   * How many groups each cross entrant is entered in. Unset means every group, which is the original
   * shape. Setting it to 2 or 3 is what models a real multi-event player — one person, two or three
   * categories — instead of one person in every category on the programme.
   */
  crossEventsPerEntrant?: number;
  fixedMatches: number;
  anchors: number;
  /** Whether anchors hold a resource, or constrain their participants only. */
  anchorsHoldResource: boolean;
  /**
   * Planning window as a multiple of demand: `planningMinutes = demand / resources / target`.
   * Below 1 the window is tighter than the work, which is what forces contention.
   */
  targetUtilization: number;
  durationMinutes: number;
  restMinutes: number;
  /** When set, `hardEnd` equals `planningEnd`, so work that does not fit is unscheduled. */
  hardEnd: boolean;
}

export interface BenchInstance {
  id: string;
  description: string;
  problem: SchedulingProblem;
  matchCount: number;
  solverMatchCount: number;
  fixedMatchCount: number;
  anchorCount: number;
  resourceCount: number;
  /** Window length in minutes, for reporting the shape. */
  planningMinutes: number;
}

const MINUTE = 60_000;

/**
 * Standard circle-method pairings: every entrant appears exactly once per round, and rotating by
 * round produces a different set of opponents. Within one round the matches are participant-disjoint,
 * which is what lets a group's first round be used for fixed matches without them colliding.
 */
function circlePairings(entrantCount: number, round: number): Array<[number, number]> {
  const order: number[] = [entrantCount - 1];
  for (let i = 0; i < entrantCount - 1; i++) order.push(i);
  const rotations = ((round % (entrantCount - 1)) + (entrantCount - 1)) % (entrantCount - 1);
  for (let step = 0; step < rotations; step++) {
    const head = order.splice(1, 1)[0]!;
    order.push(head);
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < entrantCount / 2; i++) pairs.push([order[i]!, order[entrantCount - 1 - i]!]);
  return pairs;
}

/** The participant ids of one entrant. A cross entrant is shared across the groups it enters. */
function entrantParticipants(spec: ShapeSpec, group: number, index: number): string[] {
  const base = crossEntrantId(spec, group, index) ?? `g${group}e${index}`;
  return spec.teamSize === 1 ? [base] : [`${base}a`, `${base}b`];
}

/**
 * The shared id for a multi-event entrant in one group, or null when this entrant is not entered in
 * this group and is therefore a group-local player.
 *
 * With `crossEventsPerEntrant` unset the entrant is in every group, which is the original behaviour.
 * Setting it to 2 or 3 is what makes a shape model the real multi-event player: one person, two or
 * three categories. An entrant's categories are a consecutive run of groups offset by its index, so
 * the overlap is spread across the event list instead of clustering on the first few groups, and
 * every group ends up with about the same share of multi-event players.
 */
function crossEntrantId(spec: ShapeSpec, group: number, index: number): string | null {
  if (index >= spec.crossEntrants) return null;
  const events = spec.crossEventsPerEntrant;
  if (events == null || events >= spec.groups) return `x${index}`;
  const first = index % spec.groups;
  for (let offset = 0; offset < Math.max(1, events); offset++) {
    if ((first + offset) % spec.groups === group) return `x${index}`;
  }
  return null;
}

export function buildInstance(spec: ShapeSpec): BenchInstance {
  const resources: ScheduleResource[] = Array.from({ length: spec.resources }, (_, i) =>
    resource(`r${i + 1}`, i + 1),
  );

  const matches: ScheduleMatch[] = [];
  /** Round-zero ids across all groups, which is the pool the fixed matches are drawn from. */
  const firstRoundIds: string[] = [];

  for (let group = 0; group < spec.groups; group++) {
    let previousIds: string[] = [];
    for (let round = 0; round < spec.rounds; round++) {
      const roundIds: string[] = [];
      circlePairings(spec.entrantsPerGroup, round).forEach(([left, right], slot) => {
        const id = `g${group}-r${round}-m${slot}`;
        const dependencies =
          round === 0
            ? []
            : [
                previousIds[(2 * slot) % previousIds.length]!,
                previousIds[(2 * slot + 1) % previousIds.length]!,
              ];
        const uniqueDependencies = [...new Set(dependencies)];
        matches.push(
          match({
            id,
            participants: [
              ...entrantParticipants(spec, group, left),
              ...entrantParticipants(spec, group, right),
            ],
            duration: spec.durationMinutes,
            groupKey: `g${group}`,
            completionKey: `g${group}`,
            phase: round,
            sequence: round * 1000 + slot,
            softOrder: group,
            restAfter: spec.restMinutes,
            ...(uniqueDependencies.length ? { deps: uniqueDependencies } : {}),
          }),
        );
        roundIds.push(id);
      });
      if (round === 0) firstRoundIds.push(...roundIds);
      previousIds = roundIds;
    }
  }

  // Fixed matches: history the solver must route around rather than move.
  const byId = new Map(matches.map((m) => [m.id, m]));
  firstRoundIds.slice(0, spec.fixedMatches).forEach((id, index) => {
    const existing = byId.get(id)!;
    const start = at(index * 60);
    byId.set(id, {
      ...existing,
      fixed: true,
      start,
      end: start + spec.durationMinutes * MINUTE,
      resourceId: resources[index % resources.length]!.id,
    });
  });

  const anchorBase = spec.fixedMatches * 60 + 30;
  const anchors: ParticipantAnchor[] = Array.from({ length: spec.anchors }, (_, index) => {
    const start = at(anchorBase + index * 60);
    const participants =
      spec.crossEntrants > 0
        ? entrantParticipants(spec, 0, index % spec.crossEntrants)
        : [`anchor${index}`];
    return {
      id: `anchor-${index}`,
      participantIds: participants,
      start,
      end: start + spec.durationMinutes * MINUTE,
      ...(spec.anchorsHoldResource
        ? { resourceId: resources[(index + 1) % resources.length]!.id }
        : {}),
    };
  });

  // Size the window from demand so a shape's tightness is a single auditable number, not a
  // hand-tuned absolute that drifts when the shape changes.
  const demandMinutes =
    [...byId.values()].reduce((total, m) => total + m.durationMinutes, 0) +
    anchors.reduce((total, a) => total + (a.end - a.start) / MINUTE, 0);
  const planningMinutes = Math.ceil(demandMinutes / spec.resources / spec.targetUtilization);
  const planningEnd = at(planningMinutes);

  const problem: SchedulingProblem = {
    matches: [...byId.values()],
    resources,
    ...(anchors.length ? { anchors } : {}),
    horizonStart: T0,
    planningEnd,
    hardEnd: spec.hardEnd ? planningEnd : null,
    floor: T0,
  };

  const solverMatchCount = problem.matches.filter((m) => !m.fixed).length;

  return {
    id: spec.id,
    description: spec.description,
    problem,
    matchCount: problem.matches.length,
    solverMatchCount,
    fixedMatchCount: problem.matches.length - solverMatchCount,
    anchorCount: anchors.length,
    resourceCount: resources.length,
    planningMinutes,
  };
}

/**
 * The benchmark shapes.
 *
 * `small` / `medium` / `large` scale the same structure and leave the window soft, so the questions
 * are how early the day finishes and how idle the resources are. `contended` inverts the shape: few
 * resources, many cross-entered teams, and a `hardEnd` set below a feasible packing, so the top
 * priority criterion — completing the work — is actually contested.
 *
 * `multi-event` models the case real tournaments are actually hardest on, and which none of the
 * others do: the multi-event player. Its teams are entered in two categories each, recovery is 30
 * minutes (a real BWF-style minimum) against 25-minute matches, and three courts have to carry six
 * events. So the rest rule binds between events and not just within one, the window is exactly the
 * court time the work needs so nothing is free, and every ordering decision either opens or closes
 * a gap in some player's recovery chain.
 */
export const SHAPES: readonly ShapeSpec[] = [
  {
    id: "small",
    description: "3 groups, doubles, 3 rounds, 2 resources, soft window",
    groups: 3,
    entrantsPerGroup: 8,
    teamSize: 2,
    rounds: 3,
    resources: 2,
    crossEntrants: 1,
    fixedMatches: 4,
    anchors: 2,
    anchorsHoldResource: false,
    targetUtilization: 0.9,
    durationMinutes: 30,
    restMinutes: 5,
    hardEnd: false,
  },
  {
    id: "medium",
    description: "5 groups, doubles, 3 rounds, 4 resources, soft window",
    groups: 5,
    entrantsPerGroup: 12,
    teamSize: 2,
    rounds: 3,
    resources: 4,
    crossEntrants: 2,
    fixedMatches: 6,
    anchors: 3,
    anchorsHoldResource: true,
    targetUtilization: 0.9,
    durationMinutes: 30,
    restMinutes: 5,
    hardEnd: false,
  },
  {
    id: "large",
    description: "8 groups, doubles, 4 rounds, 8 resources, soft window",
    groups: 8,
    entrantsPerGroup: 16,
    teamSize: 2,
    rounds: 4,
    resources: 8,
    crossEntrants: 3,
    fixedMatches: 8,
    anchors: 4,
    anchorsHoldResource: true,
    targetUtilization: 0.9,
    durationMinutes: 30,
    restMinutes: 5,
    hardEnd: false,
  },
  {
    id: "contended",
    description: "4 groups, doubles, 3 rounds, 2 resources, hard wall short of a full packing",
    groups: 4,
    entrantsPerGroup: 16,
    teamSize: 2,
    rounds: 3,
    resources: 2,
    crossEntrants: 4,
    fixedMatches: 2,
    anchors: 1,
    anchorsHoldResource: false,
    targetUtilization: 1.05,
    durationMinutes: 30,
    restMinutes: 5,
    hardEnd: true,
  },
  {
    id: "multi-event",
    description:
      "6 events, 12 teams each, 8 teams in 2 categories, 3 courts, 30-minute recovery, no slack",
    groups: 6,
    entrantsPerGroup: 12,
    teamSize: 2,
    rounds: 3,
    resources: 3,
    crossEntrants: 8,
    crossEventsPerEntrant: 2,
    fixedMatches: 4,
    anchors: 2,
    anchorsHoldResource: false,
    // Exactly the court time the work needs, so there is no cushion to hide a bad ordering in. The
    // real minimum is longer still, because recovery serialises each player's own matches.
    targetUtilization: 1,
    durationMinutes: 25,
    restMinutes: 30,
    hardEnd: false,
  },
];

export const BENCH_INSTANCES: readonly BenchInstance[] = SHAPES.map(buildInstance);

export function instanceById(id: string): BenchInstance {
  const instance = BENCH_INSTANCES.find((candidate) => candidate.id === id);
  if (!instance) throw new Error(`Unknown benchmark instance "${id}".`);
  return instance;
}
