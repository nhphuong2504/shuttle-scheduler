/**
 * Sport-agnostic scheduling domain.
 *
 * Nothing here knows about badminton, brackets or courts. A match is a duration plus
 * participants plus requirements; a resource is a capability-bearing machine; rest,
 * availability and objectives are data. No solver strategy is referenced.
 *
 * Units: every instant (`start`, `end`, `floor`, `horizonStart`, `planningEnd`, `hardEnd`,
 * `unavailable`) is an epoch-millisecond number, and every field whose name ends in `Minutes`
 * is a count of minutes. MINUTE_MS is the only place the two meet.
 */

/** Milliseconds in a minute. The one unit bridge in the core. */
export const MINUTE_MS = 60_000;

/** A half-open time range `[start, end)`. */
export interface TimeWindow {
  start: number;
  end: number;
}

export interface ScheduleResource {
  id: string;
  label?: string | undefined;
  /** Sort and display order. */
  order: number;
  /**
   * Capability tags, e.g. "surface:wood", "streaming", "accessible". A match may
   * only use a resource whose capabilities are a superset of the match's requirements.
   */
  capabilities?: readonly string[] | undefined;
  /**
   * Resource-specific open windows. Absent or empty means open across the whole
   * horizon. A match must fit wholly inside one window; it is never split.
   */
  availability?: readonly TimeWindow[] | undefined;
  metadata?: Readonly<Record<string, string>> | undefined;
}

/** Anything carrying per-participant rest rules. Both matches and anchors satisfy it. */
export interface RestConstraint {
  /** Rest imposed on participants afterwards. Missing means 0. */
  restAfterMinutes?: number | undefined;
  /** Rest required for participants beforehand. Missing means 0. */
  restBeforeMinutes?: number | undefined;
  /** Per-participant overrides. Missing entries mean 0. */
  restOverrides?:
    | Readonly<Record<string, { afterMinutes?: number | undefined; beforeMinutes?: number | undefined }>>
    | undefined;
}

/**
 * A fixed, already-decided occupancy that constrains the solve without being a match to place.
 *
 * Its resource is optional on purpose: a reported match that was never laid out on a court has
 * no resource, but its participants still earned their rest. Using an anchor keeps the
 * fixed-match contract strict (a fixed match always has a resource) instead of reintroducing a
 * "no court" sentinel inside a match.
 *
 * An anchor's `end` counts toward the reporting family (`knownFinish`, `knownOverrunMinutes`,
 * `knownOverrun`, `knownActiveSpanUtilization`) because it is real occupancy on the same day. It
 * counts toward no optimization metric, because a decided time is not the solver's doing.
 */
export interface ParticipantAnchor extends RestConstraint {
  id: string;
  participantIds: readonly string[];
  start: number;
  end: number;
  /**
   * When present, the anchor also holds this resource for `[start, end)`, exactly as a fixed
   * match would. When absent, the anchor constrains participants only and occupies no resource.
   */
  resourceId?: string | undefined;
}

export interface ScheduleMatch extends RestConstraint {
  id: string;
  /** Opaque participant ids, already resolved by the sport. */
  participantIds: readonly string[];
  /** False when the participants are not yet decided (a knockout side awaiting a winner). */
  participantsKnown?: boolean | undefined;
  /** Feeder match ids; each must have ended before this match may start. */
  dependencies?: readonly string[] | undefined;
  /** How long this match occupies its resource. */
  durationMinutes: number;
  /** Earliest wall-clock start, e.g. from a finished dependency. */
  eligibleFrom?: number | undefined;
  fixed?: boolean | undefined;
  start?: number | undefined;
  end?: number | undefined;
  /**
   * Declared resource, meaningful **only** when `fixed: true`, where it is required, must name a
   * resource in the problem, and must satisfy `resourceRequirements`. For a non-fixed match the
   * solver chooses the resource, so this must be absent; the chosen resource is reported on
   * `Assignment.resourceId` / `Assignment.resourceOrder`, never here.
   */
  resourceId?: string | undefined;
  /** Declared resource sort order, paired with a fixed `resourceId`. Outputs live on `Assignment`. */
  resourceOrder?: number | undefined;
  /** Explicit allow-list of resource ids. Absent means any compatible resource. */
  resourceCandidates?: readonly string[] | undefined;
  /** Capability tags the chosen resource must provide. */
  resourceRequirements?: readonly string[] | undefined;
  /** Fragmentation and remaining-count key. */
  groupKey: string;
  /** Completion unit for pressure. Falls back to groupKey. */
  completionKey?: string | undefined;
  /**
   * The milestone this match belongs to, e.g. `"MD:round1"`.
   *
   * A *stage* is a round or phase of one event — the unit that closes as a whole and whose closure
   * releases the next one. It is a ranking input only: nothing in `constraints.ts` reads it, so a
   * stage can never relax a hard rule, only reorder two otherwise-legal placements.
   */
  stageKey?: string | undefined;
  /**
   * True when finishing this stage is what releases a later stage of the same event.
   *
   * Round two does not exist as a row while round one is closing, so "will this unlock something"
   * cannot be read off the match set; it comes from the format's own pipeline knowledge. Absent
   * means false, which is the pre-stage-identity behaviour.
   */
  stageUnlocks?: boolean | undefined;
  /** Soft phase. */
  phase?: number | undefined;
  /** Intra-group ordering. */
  sequence?: number | undefined;
  /** Soft cross-group preference. */
  softOrder?: number | undefined;
}

/** A criterion the objective can order by. Lower is better for every one of them. */
export type ObjectiveCriterion =
  | "unscheduled"
  | "afterCutoff"
  | "stageProgression"
  | "makespan"
  | "resourceIdle"
  | "excessWait"
  | "fragmentation"
  | "softOrderDeviation"
  | "disruption";

/**
 * Where a still-movable match already sits, so a rebuild can be scored on how little it disturbs.
 *
 * `resourceId` is the resource the current rows name. A rebuild onto a different resource counts as
 * a court change even when that resource is not in the problem's own list, which is the honest
 * reading: the desk is being shown a different court either way.
 */
export interface BaselineSlot {
  matchId: string;
  start: number;
  resourceId: string;
}

export interface SchedulingProblem {
  matches: readonly ScheduleMatch[];
  resources: readonly ScheduleResource[];
  /**
   * Already-decided occupancies that constrain the solve but are not matches to place. Anchors
   * are seeded into feasibility state before the first sweep and are never returned in
   * `assignments` or `unscheduled`.
   */
  anchors?: readonly ParticipantAnchor[] | undefined;
  /**
   * The schedule the desk is currently looking at, for the `disruption` criterion only.
   *
   * Absent on a first build, and read by nothing but `metricsOf`: a problem's constraints never
   * consult it, so it cannot make a candidate infeasible, only less attractive. A match named here
   * that the problem marks `fixed` contributes nothing.
   */
  baseline?: readonly BaselineSlot[] | undefined;
  horizonStart: number;
  /**
   * Soft target. `planningEnd` is what both lateness numbers measure against: finishing after it
   * costs `decisionAfterCutoff` (optimization) and `knownOverrunMinutes` (reporting), but it is
   * not a hard boundary and the run may cross it.
   */
  planningEnd: number;
  /**
   * Absolute boundary. When non-null, no non-fixed assignment may have `end > hardEnd`, and any
   * match that cannot fit before it is left unscheduled. `null` (or omitted) means the run may
   * overrun without limit past `planningEnd`. This is the only hard time boundary in the problem;
   * `planningEnd` never blocks an assignment. Fixed matches and anchors are exempt.
   */
  hardEnd?: number | null | undefined;
  /** Earliest a non-fixed match may start. */
  floor: number;
  /** Global unavailable windows, applied to every resource. */
  unavailable?: readonly TimeWindow[] | undefined;
  /** Ordered criteria, highest priority first. Defaults to DEFAULT_OBJECTIVE_ORDER. */
  objective?: readonly ObjectiveCriterion[] | undefined;
}

export interface Assignment {
  matchId: string;
  resourceId: string;
  resourceOrder: number;
  start: number;
  end: number;
  groupKey: string;
}

export type ViolationKind =
  | "unknown-assignment-match"
  | "unknown-unscheduled-match"
  | "bad-resource"
  | "outside-availability"
  | "before-floor"
  | "appearance-count"
  | "duration-mismatch"
  | "resource-overlap"
  | "participant-overlap"
  | "rest-gap"
  | "fixed-moved"
  | "fixed-unscheduled"
  | "hard-end"
  | "dependency";

export interface Violation {
  kind: ViolationKind;
  matchId?: string | undefined;
  resourceId?: string | undefined;
  resourceOrder?: number | undefined;
  participantId?: string | undefined;
  /** The other party in an overlap, rest gap or dependency: a match id or an anchor id. */
  otherId?: string | undefined;
  restMinutes?: number | undefined;
  requiredMinutes?: number | undefined;
  appearanceCount?: number | undefined;
}

export interface SolverTraceEntry {
  time: number;
  event: string;
  matchId?: string;
  resourceId?: string;
}

/**
 * Generic per-run diagnostics. Sport- and format-agnostic: every field is derived from the
 * problem and the solution, never from badminton concepts.
 */
export interface SolverDiagnostics {
  /** Which strategy produced this solution, e.g. "greedy" or "grasp". */
  solverId: string;
  /** Runs attempted, and the seed of the winning run. */
  runs: number;
  seed: number;
  /** Mirrors of the optimization family, so the diagnostics panel needs no recomputation. */
  makespanMinutes: number;
  resourceIdleMinutes: number;
  matchesAfterCutoff: number;
  /** Null when a participant has fewer than two assignments. */
  minimumObservedRestMinutes: number | null;
  maximumParticipantExcessWaitMinutes: number;
  averageParticipantExcessWaitMinutes: number;
  /**
   * Merged occupancy over the still-open remainder of the planning window; `null` when the
   * solver finished at or after `planningEnd`, i.e. no window remains.
   */
  remainingWindowUtilization: number | null;
  fragmentation: number;
  softOrderDeviation: number;
  /**
   * The winning run's lexicographic tuple, in `objective` order. A tuple has no scalar
   * equivalent to the legacy weighted `winningScore`.
   */
  winningScore: readonly number[];
  /** Deterministic explanation when the run stopped early; `null` on a completed run. */
  deadlockReason: string | null;
  /** Present only when `SolverRunOptions.debugTrace` is set. */
  trace?: readonly SolverTraceEntry[] | undefined;
}

export interface Solution {
  assignments: readonly Assignment[];
  /**
   * Matches the solver could not place. This is the incompleteness signal and it stands on its
   * own: it is folded into neither lateness number. A plan can be incomplete without being late,
   * and late without being incomplete.
   */
  unscheduled: readonly string[];

  // ---- Reporting / known-state family. Desk-facing; includes decided history. ----
  /** max end over fixed matches, anchors and solver-created assignments; null when all empty. */
  knownFinish: number | null;
  /** `knownFinish === null ? 0 : Math.max(0, knownFinish - planningEnd)`. Reporting lateness. */
  knownOverrunMinutes: number;
  /** `knownOverrunMinutes > 0`. Incompleteness never sets it; see `unscheduled`. */
  knownOverrun: boolean;
  /** Merged occupancy (all sources) over `(knownFinish - horizonStart) * resourceCount`. */
  knownActiveSpanUtilization: number;
  /** Merged occupancy (all sources) over `(planningEnd - horizonStart) * resourceCount`. */
  windowUtilization: number;

  // ---- Optimization / solver-controlled family. These score a run. ----
  /**
   * max end over non-fixed solver-created assignments; null when the solver placed nothing.
   * Decided history is deliberately excluded: a late anchor must not change what the solver is
   * judged on.
   */
  decisionFinish: number | null;
  /** `decisionFinish === null ? 0 : Math.max(0, decisionFinish - planningEnd)`. */
  decisionAfterCutoff: number;
  /** Resource-minutes in the decision span not usable by a solver assignment. */
  decisionResourceIdle: number;
  /** `1 - decisionResourceIdle / (decisionSpanMinutes * resourceCount)`, or 0 when empty. */
  decisionActiveSpanUtilization: number;

  diagnostics: SolverDiagnostics;
}

// ---------------------------------------------------------------------------------------------
// Canonical ordering. Two comparators, used everywhere a tie or a scan order must be
// deterministic. No localeCompare, no reliance on collection insertion order.
// ---------------------------------------------------------------------------------------------

/** Code-unit order, locale-independent. Differs from localeCompare for integer-like ids. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `order` ascending, then canonical id comparator. */
export function compareResources(a: ScheduleResource, b: ScheduleResource): number {
  return a.order - b.order || compareIds(a.id, b.id);
}

// ---------------------------------------------------------------------------------------------
// Completion key and rest
// ---------------------------------------------------------------------------------------------

/** The pressure/fragmentation unit of a match: its own completion key, else its group key. */
export function completionKeyOf(match: ScheduleMatch): string {
  return match.completionKey ?? match.groupKey;
}

export function restAfterOf(constraint: RestConstraint, participantId: string): number {
  return constraint.restOverrides?.[participantId]?.afterMinutes ?? constraint.restAfterMinutes ?? 0;
}

export function restBeforeOf(constraint: RestConstraint, participantId: string): number {
  return constraint.restOverrides?.[participantId]?.beforeMinutes ?? constraint.restBeforeMinutes ?? 0;
}

/** The rest that must separate `previous` from `next` for one participant, in minutes. */
export function requiredRestBetween(
  previous: RestConstraint,
  next: RestConstraint,
  participantId: string,
): number {
  return Math.max(restAfterOf(previous, participantId), restBeforeOf(next, participantId));
}

// ---------------------------------------------------------------------------------------------
// The bidirectional decided-occupancy relation
// ---------------------------------------------------------------------------------------------

export type IntervalRelation = "after" | "before" | "conflict";

/** A candidate as `relateToDecided` sees it: a duration plus its own rest rules. */
export type CandidateInterval = { durationMinutes: number } & RestConstraint;

/** A decided occupancy as `relateToDecided` sees it: a decided range plus its rest rules. */
export type DecidedInterval = { start: number; end: number } & RestConstraint;

/** The inclusive forbidden start range: legal at `start <= lo` or `start >= hi`. */
export interface ForbiddenStartInterval {
  lo: number;
  hi: number;
}

/**
 * The inclusive forbidden set of start times for a candidate against one decided occupancy and
 * one shared participant. `start <= lo` is legal (before, touching allowed), `start >= hi` is
 * legal (after, touching allowed), and `lo < start < hi` conflicts. The interval is empty when
 * `lo >= hi`, in which case nothing conflicts.
 */
export function forbiddenStartInterval(
  candidate: CandidateInterval,
  decided: DecidedInterval,
  participantId: string,
): ForbiddenStartInterval {
  const beforeMinutes = requiredRestBetween(candidate, decided, participantId);
  const afterMinutes = requiredRestBetween(decided, candidate, participantId);
  return {
    lo: decided.start - candidate.durationMinutes * MINUTE_MS - beforeMinutes * MINUTE_MS,
    hi: decided.end + afterMinutes * MINUTE_MS,
  };
}

/**
 * Classifies a candidate start against one decided occupancy for one shared participant.
 *
 * `after` uses `max(restAfterOf(decided), restBeforeOf(candidate))`; `before` uses
 * `max(restAfterOf(candidate), restBeforeOf(decided))`. Both boundaries are inclusive.
 *
 * This is the single gate shared by greedy's gap search, GRASP's eligibility and event logic,
 * and validation, so the three cannot disagree about rest in either direction. An empty
 * forbidden interval never yields `conflict`.
 */
export function relateToDecided(
  candidateStart: number,
  candidate: CandidateInterval,
  decided: DecidedInterval,
  participantId: string,
): IntervalRelation {
  const { lo, hi } = forbiddenStartInterval(candidate, decided, participantId);
  if (candidateStart <= lo) return "before";
  if (candidateStart >= hi) return "after";
  return "conflict";
}
