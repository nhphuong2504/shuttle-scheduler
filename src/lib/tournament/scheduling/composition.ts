/**
 * Composition layer: the join between the tournament domain and the sport-agnostic core.
 *
 * This module is the only place that knows both sides. It maps tournament-side matches, courts and
 * times into a `SchedulingProblem`, runs the selected solver, and maps the `Solution` back into
 * `ScheduledSlot`s for the desk, the diff and the UI.
 *
 * It deliberately does no format or sport reasoning: durations, rest and participant ids arrive
 * already resolved, and the only thing it decides is which solver the policy selects.
 */

import {
  MINUTE_MS,
  normalizeBreaks,
  solve,
  solverIdFor,
  type ParticipantAnchor,
  type ScheduleMatch,
  type ScheduleResource,
  type SchedulingProblem,
  type Solution,
  type TimeWindow,
} from "@/lib/scheduling";

import { defaultSchedulingPolicy, type DayOneSchedulerOptions, type SchedulingPolicy } from "./policy";
import type { ScheduledSlot } from "./types";

/** A tournament-side match, reduced to generic scheduling input. */
export interface ComposedMatch {
  id: string;
  /** Resolved participant ids. Empty is allowed only when `participantsKnown` is false. */
  participantIds: readonly string[];
  participantsKnown?: boolean | undefined;
  durationMinutes: number;
  restAfterMinutes?: number | undefined;
  restBeforeMinutes?: number | undefined;
  restOverrides?:
    | Readonly<Record<string, { afterMinutes?: number | undefined; beforeMinutes?: number | undefined }>>
    | undefined;
  dependencies?: readonly string[] | undefined;
  eligibleFrom?: number | undefined;
  fixed?: boolean | undefined;
  start?: number | undefined;
  end?: number | undefined;
  resourceId?: string | undefined;
  resourceOrder?: number | undefined;
  resourceCandidates?: readonly string[] | undefined;
  resourceRequirements?: readonly string[] | undefined;
  groupKey: string;
  completionKey?: string | undefined;
  phase?: number | undefined;
  sequence?: number | undefined;
  softOrder?: number | undefined;
  /** Tournament-side attribution, echoed onto `ScheduledSlot.categoryId`. */
  categoryId: string;
  /**
   * A fixed item with no usable court. Instead of a pinned match it becomes a participant/time
   * anchor: its participants still earn their rest and its end still counts toward the reporting
   * metrics, but it occupies no court. `resourceId` is ignored when this is set.
   */
  anchorOnly?: boolean | undefined;
}

/** An already-decided occupancy handed in as input, e.g. an earlier day's placements. */
export interface ComposedAnchor {
  id: string;
  participantIds: readonly string[];
  start: number;
  end: number;
  resourceId?: string | undefined;
  restAfterMinutes?: number | undefined;
  restBeforeMinutes?: number | undefined;
}

export interface ComposedResource {
  id: string;
  /** Court number. Also the output `ScheduledSlot.courtNumber`. */
  order: number;
  label?: string | undefined;
  capabilities?: readonly string[] | undefined;
  availability?: readonly TimeWindow[] | undefined;
}

export interface DayCompositionInput {
  matches: readonly ComposedMatch[];
  resources: readonly ComposedResource[];
  anchors?: readonly ComposedAnchor[] | undefined;
  /** Problem horizon: the earliest instant any assignment may occupy. */
  horizonStart: number;
  /** Soft target. Lateness is measured against it, but it never blocks an assignment. */
  planningEnd: number;
  /** Absolute boundary. `null` lets the run overrun without limit. */
  hardEnd?: number | null | undefined;
  /** Earliest a non-fixed match may start. */
  floor: number;
  breaks?: readonly TimeWindow[] | undefined;
  policy?: SchedulingPolicy | undefined;
  /** Convenience alternative to building a policy: maps legacy options onto the default policy. */
  options?: DayOneSchedulerOptions | undefined;
}

export interface DayCompositionResult {
  problem: SchedulingProblem;
  solution: Solution;
  /** Solver assignments as desk-facing slots, ordered by start then court number. */
  slots: ScheduledSlot[];
  /** Resource id to court number, for callers that only carry ids. */
  courtNumbers: ReadonlyMap<string, number>;
}

function toScheduleMatch(match: ComposedMatch): ScheduleMatch {
  // A fixed match's window is decided, so its declared duration can disagree with it — a match
  // that overran its slot is the normal case. The window wins: it is the real occupancy, and the
  // validator requires `end - start === durationMinutes`.
  const durationMinutes =
    match.fixed && match.start != null && match.end != null
      ? (match.end - match.start) / MINUTE_MS
      : match.durationMinutes;
  return {
    id: match.id,
    participantIds: [...match.participantIds],
    durationMinutes,
    groupKey: match.groupKey,
    ...(match.participantsKnown === undefined ? {} : { participantsKnown: match.participantsKnown }),
    ...(match.restAfterMinutes === undefined ? {} : { restAfterMinutes: match.restAfterMinutes }),
    ...(match.restBeforeMinutes === undefined ? {} : { restBeforeMinutes: match.restBeforeMinutes }),
    ...(match.restOverrides === undefined ? {} : { restOverrides: match.restOverrides }),
    ...(match.dependencies === undefined ? {} : { dependencies: [...match.dependencies] }),
    ...(match.eligibleFrom === undefined ? {} : { eligibleFrom: match.eligibleFrom }),
    ...(match.fixed === undefined ? {} : { fixed: match.fixed }),
    ...(match.start === undefined ? {} : { start: match.start }),
    ...(match.end === undefined ? {} : { end: match.end }),
    ...(match.resourceId === undefined ? {} : { resourceId: match.resourceId }),
    ...(match.resourceOrder === undefined ? {} : { resourceOrder: match.resourceOrder }),
    ...(match.resourceCandidates === undefined
      ? {}
      : { resourceCandidates: [...match.resourceCandidates] }),
    ...(match.resourceRequirements === undefined
      ? {}
      : { resourceRequirements: [...match.resourceRequirements] }),
    ...(match.completionKey === undefined ? {} : { completionKey: match.completionKey }),
    ...(match.phase === undefined ? {} : { phase: match.phase }),
    ...(match.sequence === undefined ? {} : { sequence: match.sequence }),
    ...(match.softOrder === undefined ? {} : { softOrder: match.softOrder }),
  };
}

function toAnchor(anchor: ComposedAnchor): ParticipantAnchor {
  return {
    id: anchor.id,
    participantIds: [...anchor.participantIds],
    start: anchor.start,
    end: anchor.end,
    ...(anchor.resourceId === undefined ? {} : { resourceId: anchor.resourceId }),
    ...(anchor.restAfterMinutes === undefined ? {} : { restAfterMinutes: anchor.restAfterMinutes }),
    ...(anchor.restBeforeMinutes === undefined
      ? {}
      : { restBeforeMinutes: anchor.restBeforeMinutes }),
  };
}

function toProblem(input: DayCompositionInput, policy: SchedulingPolicy): SchedulingProblem {
  const resources: ScheduleResource[] = input.resources.map((resource) => ({
    id: resource.id,
    order: resource.order,
    ...(resource.label === undefined ? {} : { label: resource.label }),
    ...(resource.capabilities === undefined ? {} : { capabilities: [...resource.capabilities] }),
    ...(resource.availability === undefined ? {} : { availability: resource.availability }),
  }));

  const unavailable = normalizeBreaks(input.breaks, input.planningEnd);
  const anchors = (input.anchors ?? []).map(toAnchor);

  const matches: ScheduleMatch[] = [];
  for (const match of input.matches) {
    if (match.anchorOnly) {
      // A fixed item the day has no court for: participant and time only.
      anchors.push({
        id: match.id,
        participantIds: [...match.participantIds],
        start: match.start ?? match.eligibleFrom ?? input.horizonStart,
        end: match.end ?? match.start ?? input.horizonStart,
        ...(match.restAfterMinutes === undefined
          ? {}
          : { restAfterMinutes: match.restAfterMinutes }),
        ...(match.restBeforeMinutes === undefined
          ? {}
          : { restBeforeMinutes: match.restBeforeMinutes }),
      });
      continue;
    }
    matches.push(toScheduleMatch(match));
  }

  return {
    matches,
    resources,
    ...(anchors.length ? { anchors } : {}),
    horizonStart: input.horizonStart,
    planningEnd: input.planningEnd,
    hardEnd: input.hardEnd ?? null,
    floor: input.floor,
    ...(unavailable.length ? { unavailable } : {}),
    objective: policy.objective,
  };
}

/**
 * Builds the problem, runs the policy's solver, and maps the result back to slots.
 *
 * `assertValidProblem` runs inside `solve`, so malformed input (an unfixed match with a declared
 * resource, a fixed match beyond `hardEnd`, conflicting fixed anchors) throws here rather than
 * silently reappearing as an unscheduled match.
 */
export function composeDayPlan(input: DayCompositionInput): DayCompositionResult {
  return composeDayPlanFor(input, undefined);
}

/**
 * Like `composeDayPlan`, but lets a timing bucket pick its own solver from the policy. Used where
 * one day is filled stage by stage.
 */
export function composeDayPlanFor(
  input: DayCompositionInput,
  timingKey: string | undefined,
): DayCompositionResult {
  const policy = input.policy ?? defaultSchedulingPolicy(input.options);
  const problem = toProblem(input, policy);
  const solution = solve(problem, solverIdFor(policy, timingKey), policy.solverOptions);
  return finish(problem, solution, input);
}

function finish(
  problem: SchedulingProblem,
  solution: Solution,
  input: DayCompositionInput,
): DayCompositionResult {
  const categoryByMatchId = new Map(input.matches.map((match) => [match.id, match.categoryId]));
  const courtNumbers = new Map(input.resources.map((resource) => [resource.id, resource.order]));

  const slots: ScheduledSlot[] = solution.assignments
    .map((assignment) => ({
      matchId: assignment.matchId,
      courtId: assignment.resourceId,
      courtNumber: assignment.resourceOrder,
      start: new Date(assignment.start),
      end: new Date(assignment.end),
      categoryId: categoryByMatchId.get(assignment.matchId) ?? "",
      overrun: assignment.end > input.planningEnd,
    }))
    .sort(
      (a, b) => a.start.getTime() - b.start.getTime() || a.courtNumber - b.courtNumber,
    );

  return { problem, solution, slots, courtNumbers };
}
