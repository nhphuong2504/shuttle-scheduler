/**
 * The provider seams. These are the interfaces a format, a sport, a venue configuration and a
 * scheduling policy implement. None of them mentions a sport, a bracket or a court.
 */

import type {
  ObjectiveCriterion,
  ScheduleMatch,
  ScheduleResource,
  TimeWindow,
} from "./domain";
import type { SolverRunOptions } from "./solvers/types";

export interface FormatMatch {
  id: string;
  /** Opaque participant slot refs, resolved by SportRules. Null is an undecided side. */
  participantRefs: readonly (string | null)[];
  /** Feeder match ids. */
  dependencyRefs?: readonly string[] | undefined;
  /**
   * Format-owned timing bucket, mapped to minutes by SportRules. When absent, the sport's
   * `defaultTimingKey` applies, so `timingFor(undefined)` must be total.
   */
  timingKey?: string | undefined;
  groupKey: string;
  completionKey?: string | undefined;
  /**
   * The stage — a round or phase of one event — this match belongs to, e.g. `"draw-7:r1"`.
   * Mirrors onto `ScheduleMatch.stageKey`; ranking input only.
   */
  stageKey?: string | undefined;
  /** True when finishing this stage is what releases a later stage of the same event. */
  stageUnlocks?: boolean | undefined;
  phase?: number | undefined;
  sequence?: number | undefined;
  softOrder?: number | undefined;
  /**
   * Structural bye: no match is played. Exactly one `participantRefs` entry is non-null and it
   * advances directly; a bye is never schedulable and is not a match in the problem.
   */
  bye?: boolean | undefined;
}

/** Turns a tournament format into structural match definitions. Sport-agnostic. */
export interface FormatProvider<In = unknown> {
  id: string;
  name: string;
  timingKeys: readonly string[];
  buildMatches(input: In): readonly FormatMatch[];
}

/** Resolution of a format's participant refs into concrete participant ids. */
export interface ParticipantResolution {
  participantIds: string[];
  /** False when a side is not yet decided (a knockout slot awaiting a winner). */
  participantsKnown: boolean;
}

export interface TimingRule {
  durationMinutes: number;
  restAfterMinutes?: number | undefined;
  restBeforeMinutes?: number | undefined;
}

/** Sport semantics: participant resolution, durations, rest, capability requirements. */
export interface SportRules {
  id: string;
  /** Used when a format match declares no timing bucket. `timingFor` must handle it. */
  defaultTimingKey: string;
  resolveParticipants(refs: readonly (string | null)[]): ParticipantResolution;
  /** Minutes of play and rest for a timing bucket. Total over `string | undefined`. */
  timingFor(timingKey: string | undefined): TimingRule;
  /** Capability tags a match in this bucket requires of its resource. */
  resourceRequirementsFor(timingKey: string | undefined): readonly string[];
}

/** Venue and tournament configuration: the concrete resources and the planning horizon. */
export interface TournamentConfig {
  id: string;
  resources: readonly ScheduleResource[];
  horizonStart: number;
  planningEnd: number;
  /** `null` means the run may overrun `planningEnd` without limit. */
  hardEnd: number | null;
  floor: number;
  unavailable?: readonly TimeWindow[] | undefined;
}

export interface SolverSelection {
  default: string;
  byTimingKey?: Readonly<Record<string, string>> | undefined;
}

/** Scheduling policy: objective order, solver selection and search options. Never sport knowledge. */
export interface SchedulingPolicy {
  id: string;
  objective: readonly ObjectiveCriterion[];
  solvers: SolverSelection;
  solverOptions: SolverRunOptions;
}

/** The solver a policy picks for a timing bucket, falling back to its default. */
export function solverIdFor(policy: SchedulingPolicy, timingKey: string | undefined): string {
  if (timingKey != null) {
    const byKey = policy.solvers.byTimingKey;
    if (byKey && byKey[timingKey] != null) return byKey[timingKey]!;
  }
  return policy.solvers.default;
}

/** The match fields every `ScheduleMatch` needs; providers fill the rest. */
export type MatchCore = Pick<ScheduleMatch, "id" | "participantIds" | "durationMinutes" | "groupKey">;
