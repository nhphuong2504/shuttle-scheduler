/**
 * Indexes, eligibility gates and solution validation.
 *
 * Everything that decides whether a match may occupy a resource at an instant lives here, so
 * greedy, GRASP and `validateSolution` cannot disagree. The one relation they share is
 * `relateToDecided` from the domain: a participant constraint is satisfied in either direction
 * (before or after a decided occupancy) within the required rest, never only after it.
 */

import {
  compareIds,
  compareResources,
  MINUTE_MS,
  relateToDecided,
  requiredRestBetween,
  restAfterOf,
  restBeforeOf,
  type Assignment,
  type ParticipantAnchor,
  type ScheduleMatch,
  type ScheduleResource,
  type SchedulingProblem,
  type Solution,
  type TimeWindow,
  type Violation,
} from "./domain";
import { fitsInWindows, globalOpenWindows, resourceOpenWindows } from "./time";

/** A decided occupancy, resolved to a concrete interval plus its own rest rules. */
export interface DecidedOccupancy {
  id: string;
  start: number;
  end: number;
  resourceId?: string | undefined;
  restAfterMinutes?: number | undefined;
  restBeforeMinutes?: number | undefined;
  restOverrides?:
    | Readonly<Record<string, { afterMinutes?: number | undefined; beforeMinutes?: number | undefined }>>
    | undefined;
  /** True when this came from a `fixed: true` problem match. */
  fixedMatch: boolean;
  /** The problem match id when this is a match (fixed), absent for an anchor. */
  matchId?: string | undefined;
}

/** Decided occupancies per participant, keyed by participant id. Mutable during a run. */
export type DecidedByParticipant = Map<string, DecidedOccupancy[]>;

export interface SchedulingIndexes {
  problem: SchedulingProblem;
  matchById: ReadonlyMap<string, ScheduleMatch>;
  anchorById: ReadonlyMap<string, ParticipantAnchor>;
  /** Canonically sorted. */
  resources: readonly ScheduleResource[];
  resourceById: ReadonlyMap<string, ScheduleResource>;
  resourceCount: number;
  /** Unique participant ids per match. */
  playersByMatch: ReadonlyMap<string, readonly string[]>;
  matchesByPlayer: ReadonlyMap<string, readonly string[]>;
  dependenciesOf: ReadonlyMap<string, readonly string[]>;
  /** Anchor ids are distinct from match ids; both may share a participant. */
  anchorIds: readonly string[];
  fixedMatchIds: readonly string[];
  nonFixedMatchIds: readonly string[];
  /** Fixed matches and anchors, per participant. Sorted by start then id. */
  seedDecidedByParticipant: DecidedByParticipant;
  /** Fixed matches and resource-holding anchors, per resource. Sorted by start then id. */
  seedDecidedByResource: Map<string, DecidedOccupancy[]>;
  globalOpen: readonly TimeWindow[];
  openByResource: ReadonlyMap<string, readonly TimeWindow[]>;
  /** match id to the resource it is pinned to, for fixed matches. */
  fixedResourceOf: ReadonlyMap<string, string>;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function emptyDecided(): DecidedByParticipant {
  return new Map<string, DecidedOccupancy[]>();
}

/** Clones the seed decided index so a run can mutate it without touching the problem. */
export function cloneDecided(
  source: ReadonlyMap<string, readonly DecidedOccupancy[]>,
): DecidedByParticipant {
  const clone: DecidedByParticipant = new Map();
  for (const [key, list] of source) clone.set(key, [...list]);
  return clone;
}

function cloneByResource(
  source: ReadonlyMap<string, readonly DecidedOccupancy[]>,
): Map<string, DecidedOccupancy[]> {
  const clone = new Map<string, DecidedOccupancy[]>();
  for (const [key, list] of source) clone.set(key, [...list]);
  return clone;
}

function byStartThenId(a: DecidedOccupancy, b: DecidedOccupancy): number {
  return a.start - b.start || compareIds(a.id, b.id);
}

/**
 * Adds a run-made assignment to the mutable decided indexes, keeping each touched list canonically
 * sorted so scans stay deterministic and input-order independent.
 */
export function addDecidedOccupancy(
  occupancy: DecidedOccupancy,
  participantIds: readonly string[],
  decidedByParticipant: DecidedByParticipant,
  decidedByResource: Map<string, DecidedOccupancy[]>,
): void {
  for (const participantId of participantIds) {
    const list = decidedByParticipant.get(participantId) ?? [];
    list.push(occupancy);
    list.sort(byStartThenId);
    decidedByParticipant.set(participantId, list);
  }
  if (occupancy.resourceId != null) {
    const list = decidedByResource.get(occupancy.resourceId) ?? [];
    list.push(occupancy);
    list.sort(byStartThenId);
    decidedByResource.set(occupancy.resourceId, list);
  }
}

function decidedFromMatch(match: ScheduleMatch): DecidedOccupancy {
  return {
    id: match.id,
    matchId: match.id,
    start: match.start!,
    end: match.end!,
    resourceId: match.resourceId,
    restAfterMinutes: match.restAfterMinutes,
    restBeforeMinutes: match.restBeforeMinutes,
    restOverrides: match.restOverrides,
    fixedMatch: true,
  };
}

function decidedFromAnchor(anchor: ParticipantAnchor): DecidedOccupancy {
  return {
    id: anchor.id,
    start: anchor.start,
    end: anchor.end,
    resourceId: anchor.resourceId,
    restAfterMinutes: anchor.restAfterMinutes,
    restBeforeMinutes: anchor.restBeforeMinutes,
    restOverrides: anchor.restOverrides,
    fixedMatch: false,
  };
}

/**
 * Builds the static indexes for a problem. Assumes the problem is well formed; `validateProblem`
 * is what rejects malformed input, and `solve()` runs it first.
 */
export function buildIndexes(problem: SchedulingProblem): SchedulingIndexes {
  const matchById = new Map<string, ScheduleMatch>();
  const playersByMatch = new Map<string, readonly string[]>();
  const matchesByPlayer = new Map<string, string[]>();
  const dependenciesOf = new Map<string, readonly string[]>();
  const fixedMatchIds: string[] = [];
  const nonFixedMatchIds: string[] = [];
  const fixedResourceOf = new Map<string, string>();

  for (const match of problem.matches) {
    matchById.set(match.id, match);
    const players = uniqueIds(match.participantIds);
    playersByMatch.set(match.id, players);
    for (const playerId of players) {
      const list = matchesByPlayer.get(playerId) ?? [];
      list.push(match.id);
      matchesByPlayer.set(playerId, list);
    }
    dependenciesOf.set(match.id, [...(match.dependencies ?? [])]);
    if (match.fixed) {
      fixedMatchIds.push(match.id);
      if (match.resourceId != null) fixedResourceOf.set(match.id, match.resourceId);
    } else {
      nonFixedMatchIds.push(match.id);
    }
  }

  const resources = [...problem.resources].sort(compareResources);
  const resourceById = new Map(resources.map((r) => [r.id, r]));

  const anchorById = new Map<string, ParticipantAnchor>();
  const seedDecidedByParticipant = emptyDecided();
  const seedDecidedByResource = new Map<string, DecidedOccupancy[]>();
  const anchorIds: string[] = [];

  const addDecided = (occupancy: DecidedOccupancy, participantIds: readonly string[]) => {
    for (const participantId of participantIds) {
      const list = seedDecidedByParticipant.get(participantId) ?? [];
      list.push(occupancy);
      seedDecidedByParticipant.set(participantId, list);
    }
    if (occupancy.resourceId != null) {
      const list = seedDecidedByResource.get(occupancy.resourceId) ?? [];
      list.push(occupancy);
      seedDecidedByResource.set(occupancy.resourceId, list);
    }
  };

  for (const match of problem.matches) {
    if (!match.fixed) continue;
    addDecided(decidedFromMatch(match), playersByMatch.get(match.id) ?? []);
  }
  for (const anchor of problem.anchors ?? []) {
    anchorById.set(anchor.id, anchor);
    anchorIds.push(anchor.id);
    addDecided(decidedFromAnchor(anchor), uniqueIds(anchor.participantIds));
  }

  for (const list of seedDecidedByParticipant.values()) list.sort(byStartThenId);
  for (const list of seedDecidedByResource.values()) list.sort(byStartThenId);

  const globalOpen = globalOpenWindows(problem.horizonStart, problem.unavailable);
  const openByResource = new Map<string, readonly TimeWindow[]>();
  for (const resource of resources) {
    openByResource.set(resource.id, resourceOpenWindows(resource, globalOpen));
  }

  return {
    problem,
    matchById,
    anchorById,
    resources,
    resourceById,
    resourceCount: resources.length,
    playersByMatch,
    matchesByPlayer,
    dependenciesOf,
    anchorIds: anchorIds.sort(compareIds),
    fixedMatchIds: fixedMatchIds.sort(compareIds),
    nonFixedMatchIds: nonFixedMatchIds.sort(compareIds),
    seedDecidedByParticipant,
    seedDecidedByResource,
    globalOpen,
    openByResource,
    fixedResourceOf,
  };
}

// ---------------------------------------------------------------------------------------------
// Eligibility gates
// ---------------------------------------------------------------------------------------------

/** True when the resource provides every capability the match requires, and is allowed by name. */
export function resourceMeetsRequirements(
  match: ScheduleMatch,
  resource: ScheduleResource,
): boolean {
  const candidates = match.resourceCandidates;
  if (candidates && candidates.length && !candidates.includes(resource.id)) return false;
  const required = match.resourceRequirements ?? [];
  if (!required.length) return true;
  const provided = new Set(resource.capabilities ?? []);
  return required.every((capability) => provided.has(capability));
}

/** A participant constraint failure: which participant, and which decided occupancy it hit. */
export interface ParticipantGateFailure {
  participantId: string;
  decided: DecidedOccupancy;
}

/**
 * The participant gate: `relateToDecided` must not return `conflict` for any participant against
 * any decided occupancy. Returns the first failure in canonical order, or null.
 *
 * `excludeId` skips an occupancy by id, which is how a match is never compared against itself.
 */
export function participantGate(
  match: ScheduleMatch,
  start: number,
  participantIds: readonly string[],
  decided: ReadonlyMap<string, readonly DecidedOccupancy[]>,
  excludeId?: string | undefined,
): ParticipantGateFailure | null {
  for (const participantId of participantIds) {
    const occupancies = decided.get(participantId);
    if (!occupancies) continue;
    for (const decidedOccupancy of occupancies) {
      if (excludeId != null && decidedOccupancy.id === excludeId) continue;
      if (relateToDecided(start, match, decidedOccupancy, participantId) === "conflict") {
        return { participantId, decided: decidedOccupancy };
      }
    }
  }
  return null;
}

/** Everything a violation renderer needs about a conflict the gate reported. */
export interface ConflictDetail {
  otherId: string;
  otherStart: number;
  otherEnd: number;
  overlaps: boolean;
  restMinutes: number;
  requiredMinutes: number;
}

export interface ParticipantConflict extends ParticipantGateFailure, ConflictDetail {}

/** Expands a gate failure into the numbers a `participant-overlap` / `rest-gap` violation shows. */
export function describeParticipantConflict(
  match: ScheduleMatch,
  start: number,
  failure: ParticipantGateFailure,
): ParticipantConflict {
  const end = start + match.durationMinutes * MINUTE_MS;
  const detail = participantConflictDetail(match, start, end, failure.decided, failure.participantId);
  return { ...failure, ...detail };
}

function participantConflictDetail(
  match: ScheduleMatch,
  start: number,
  end: number,
  decidedOccupancy: DecidedOccupancy,
  participantId: string,
): ConflictDetail {
  const overlaps = start < decidedOccupancy.end && decidedOccupancy.start < end;
  const requiredAfter = requiredRestBetween(decidedOccupancy, match, participantId);
  const requiredBefore = requiredRestBetween(match, decidedOccupancy, participantId);
  // Intervals that do not overlap sit wholly on one side, so the achieved rest is unambiguous.
  const candidateBefore = end <= decidedOccupancy.start;
  const restMinutes = candidateBefore
    ? Math.max(0, Math.round((decidedOccupancy.start - end) / MINUTE_MS))
    : Math.max(0, Math.round((start - decidedOccupancy.end) / MINUTE_MS));
  const requiredMinutes = candidateBefore ? requiredBefore : requiredAfter;
  return {
    otherId: decidedOccupancy.id,
    otherStart: decidedOccupancy.start,
    otherEnd: decidedOccupancy.end,
    overlaps,
    restMinutes,
    requiredMinutes,
  };
}

/** True when no decided occupancy already holds this resource across `[start, end)`. */
export function resourceFree(
  resourceId: string,
  start: number,
  end: number,
  decidedByResource: ReadonlyMap<string, readonly DecidedOccupancy[]>,
): boolean {
  const occupancies = decidedByResource.get(resourceId);
  if (!occupancies) return true;
  for (const occupancy of occupancies) {
    if (start < occupancy.end && occupancy.start < end) return false;
  }
  return true;
}

/** True when `[start, start + durationMs)` fits inside the resource's open windows. */
export function fitsResourceAvailability(
  indexes: SchedulingIndexes,
  resourceId: string,
  start: number,
  durationMs: number,
): boolean {
  const windows = indexes.openByResource.get(resourceId);
  if (!windows) return false;
  return fitsInWindows(start, durationMs, windows);
}

/**
 * Everything a match needs at a start instant on a resource, except the participant gate (which
 * callers run separately because they carry the run-local decided index).
 */
export interface SlotFeasibility {
  ok: boolean;
  /** When not ok, the next instant at which the failing condition may clear, if known. */
  retryAt?: number | undefined;
}

/** Resource existence, requirements, availability and non-overlap, evaluated at one instant. */
export function resourceGate(
  indexes: SchedulingIndexes,
  match: ScheduleMatch,
  resource: ScheduleResource,
  start: number,
  decidedByResource: ReadonlyMap<string, readonly DecidedOccupancy[]>,
): SlotFeasibility {
  const durationMs = match.durationMinutes * MINUTE_MS;
  const end = start + durationMs;
  if (!resourceMeetsRequirements(match, resource)) return { ok: false };
  if (!fitsResourceAvailability(indexes, resource.id, start, durationMs)) {
    const windows = indexes.openByResource.get(resource.id) ?? [];
    const nextStart = windows
      .map((w) => w.start)
      .filter((w) => w > start)
      .sort((a, b) => a - b)[0];
    return nextStart == null ? { ok: false } : { ok: false, retryAt: nextStart };
  }
  const occupancies = decidedByResource.get(resource.id);
  if (occupancies) {
    for (const occupancy of occupancies) {
      if (start < occupancy.end && occupancy.start < end) {
        return { ok: false, retryAt: occupancy.end };
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// validateSolution
// ---------------------------------------------------------------------------------------------

function assignmentEnd(match: ScheduleMatch, start: number): number {
  return start + match.durationMinutes * MINUTE_MS;
}

/**
 * Judges a solver's output against every invariant in the core contract. Returns a
 * deterministically ordered list of violations; an empty list means the solution is valid.
 */
export function validateSolution(
  problem: SchedulingProblem,
  solution: Solution,
): Violation[] {
  const indexes = buildIndexes(problem);
  const violations: Violation[] = [];
  const hardEnd = problem.hardEnd ?? null;

  const assignmentById = new Map<string, Assignment>();
  for (const assignment of solution.assignments) {
    // Later duplicates are still reported through appearance-count below.
    if (!assignmentById.has(assignment.matchId)) assignmentById.set(assignment.matchId, assignment);
  }

  // ---- unknown ids, from the two distinct sources ----
  for (const assignment of solution.assignments) {
    if (!indexes.matchById.has(assignment.matchId)) {
      violations.push({ kind: "unknown-assignment-match", matchId: assignment.matchId });
    }
  }
  for (const matchId of solution.unscheduled) {
    if (!indexes.matchById.has(matchId)) {
      violations.push({ kind: "unknown-unscheduled-match", matchId });
    }
  }

  // ---- no loss, no duplication ----
  const appearanceCount = new Map<string, number>();
  for (const assignment of solution.assignments) {
    appearanceCount.set(assignment.matchId, (appearanceCount.get(assignment.matchId) ?? 0) + 1);
  }
  for (const matchId of solution.unscheduled) {
    appearanceCount.set(matchId, (appearanceCount.get(matchId) ?? 0) + 1);
  }
  for (const match of problem.matches) {
    const count = appearanceCount.get(match.id) ?? 0;
    if (count !== 1) {
      violations.push({ kind: "appearance-count", matchId: match.id, appearanceCount: count });
    }
    if (match.fixed && solution.unscheduled.includes(match.id)) {
      violations.push({ kind: "fixed-unscheduled", matchId: match.id });
    }
  }

  // ---- per-assignment checks ----
  for (const match of problem.matches) {
    const assignment = assignmentById.get(match.id);
    if (!assignment) continue;
    const resource = indexes.resourceById.get(assignment.resourceId);
    if (!resource) {
      violations.push({ kind: "bad-resource", matchId: match.id, resourceId: assignment.resourceId });
      continue;
    }
    if (!resourceMeetsRequirements(match, resource)) {
      violations.push({ kind: "bad-resource", matchId: match.id, resourceId: resource.id });
    }
    const durationMs = match.durationMinutes * MINUTE_MS;
    if (assignment.end !== assignment.start + durationMs) {
      violations.push({ kind: "duration-mismatch", matchId: match.id });
    }

    if (match.fixed) {
      if (
        match.start !== assignment.start ||
        match.end !== assignment.end ||
        (match.resourceId ?? null) !== assignment.resourceId
      ) {
        violations.push({ kind: "fixed-moved", matchId: match.id });
      }
    } else {
      if (assignment.start < problem.floor) {
        violations.push({ kind: "before-floor", matchId: match.id });
      }
      if (match.eligibleFrom != null && assignment.start < match.eligibleFrom) {
        violations.push({ kind: "before-floor", matchId: match.id });
      }
      if (hardEnd != null && assignment.end > hardEnd) {
        violations.push({ kind: "hard-end", matchId: match.id });
      }
      const granularity = problem.startGranularityMs;
      if (granularity && assignment.start % granularity !== 0) {
        violations.push({ kind: "off-granularity", matchId: match.id });
      }
    }

    // Availability and breaks bind work the solver chooses. A fixed match is decided history —
    // it may have overrun into a break — so it is exempt for the same reason it is exempt from
    // `hardEnd`, and the two exemptions are deliberately kept together.
    if (!match.fixed && !fitsResourceAvailability(indexes, resource.id, assignment.start, durationMs)) {
      violations.push({
        kind: "outside-availability",
        matchId: match.id,
        resourceId: resource.id,
      });
    }

    // Dependencies bind work the solver chooses. A fixed match's window is decided history — a
    // feeder that overran its planned slot can put the dependent's recorded start inside it — so
    // the recorded relationship is not re-judged. Same exemption as `hardEnd` and availability.
    if (!match.fixed) {
      for (const dependencyId of match.dependencies ?? []) {
        const dependency = indexes.matchById.get(dependencyId);
        const dependencyEnd =
          dependencyEndOf(dependency, assignmentById) ??
          indexes.anchorById.get(dependencyId)?.end ??
          null;
        if (dependencyEnd == null || dependencyEnd > assignment.start) {
          violations.push({ kind: "dependency", matchId: match.id, otherId: dependencyId });
        }
      }
    }
  }

  // ---- resource double-booking, over assignments only (anchors checked separately) ----
  const byResource = new Map<string, Assignment[]>();
  for (const assignment of solution.assignments) {
    if (!indexes.matchById.has(assignment.matchId)) continue;
    const list = byResource.get(assignment.resourceId) ?? [];
    list.push(assignment);
    byResource.set(assignment.resourceId, list);
  }
  for (const [resourceId, list] of [...byResource.entries()].sort((a, b) => compareIds(a[0], b[0]))) {
    const sorted = [...list].sort((a, b) => a.start - b.start || compareIds(a.matchId, b.matchId));
    for (let i = 0; i < sorted.length; i++) {
      const left = sorted[i]!;
      for (let j = i + 1; j < sorted.length; j++) {
        const right = sorted[j]!;
        // Sorted by start, so once a subsequent start reaches this end nothing later can overlap.
        if (right.start >= left.end) break;
        // Two fixed matches double-booked is recorded history, not a solver mistake: an
        // overrunning match legitimately runs into the next one. Only a pair the solver itself
        // produced, or a solver placement colliding with history, is a violation.
        const leftFixed = indexes.matchById.get(left.matchId)?.fixed === true;
        const rightFixed = indexes.matchById.get(right.matchId)?.fixed === true;
        if (leftFixed && rightFixed) continue;
        // An explicit test is still required: a zero-duration occupancy shares a start with the
        // next one but occupies nothing, and must not be reported as a double booking.
        if (left.start < right.end && right.start < left.end) {
          violations.push({
            kind: "resource-overlap",
            matchId: left.matchId,
            otherId: right.matchId,
            resourceId,
          });
        }
      }
    }
  }

  // ---- participant double-booking and rest gaps ----
  const participantsOf = new Map<string, string[]>();
  for (const match of problem.matches) {
    participantsOf.set(match.id, [...(indexes.playersByMatch.get(match.id) ?? [])]);
  }
  const allDecided: DecidedOccupancy[] = [];
  for (const match of problem.matches) {
    const assignment = assignmentById.get(match.id);
    if (!assignment) continue;
    allDecided.push({
      id: match.id,
      matchId: match.id,
      start: assignment.start,
      end: assignment.end,
      resourceId: assignment.resourceId,
      restAfterMinutes: match.restAfterMinutes,
      restBeforeMinutes: match.restBeforeMinutes,
      restOverrides: match.restOverrides,
      fixedMatch: match.fixed === true,
    });
  }

  const seenPair = new Set<string>();
  for (let i = 0; i < allDecided.length; i++) {
    const left = allDecided[i]!;
    const leftMatch = left.matchId != null ? indexes.matchById.get(left.matchId) : undefined;
    if (!leftMatch) continue;
    for (let j = i + 1; j < allDecided.length; j++) {
      const right = allDecided[j]!;
      // Two decided occupancies are both history. Their rest relationship is a recorded fact, not
      // a planning decision, so it is never a violation — only a solver placement meeting history
      // (or another solver placement) can be wrong.
      if (leftMatch.fixed && right.fixedMatch) continue;
      const pairKey = `${left.id}|${right.id}`;
      if (seenPair.has(pairKey)) continue;
      for (const participantId of participantsOf.get(left.id) ?? []) {
        const shares = (participantsOf.get(right.id) ?? []).includes(participantId);
        if (!shares) continue;
        // `relateToDecided` classifies by the candidate's start, and a conflict means the start
        // lies inside the forbidden interval. That is exhaustive, so one direction is enough.
        const relation = relateToDecided(left.start, leftMatch, right, participantId);
        if (relation !== "conflict") continue;
        seenPair.add(pairKey);
        const detail = participantConflictDetail(leftMatch, left.start, left.end, right, participantId);
        violations.push({
          kind: detail.overlaps ? "participant-overlap" : "rest-gap",
          matchId: left.id,
          otherId: right.id,
          participantId,
          restMinutes: detail.restMinutes,
          requiredMinutes: detail.requiredMinutes,
        });
      }
    }
  }

  // ---- anchors constrain participants, and their resource when they hold one ----
  for (const anchor of problem.anchors ?? []) {
    if (anchor.resourceId != null) {
      for (const assignment of solution.assignments) {
        if (assignment.resourceId !== anchor.resourceId) continue;
        // A fixed match and an anchor are both history; a reported match that ran over its
        // window is not a conflict the solver should be blamed for.
        if (indexes.matchById.get(assignment.matchId)?.fixed === true) continue;
        if (assignment.start < anchor.end && anchor.start < assignment.end) {
          violations.push({
            kind: "resource-overlap",
            matchId: assignment.matchId,
            otherId: anchor.id,
            resourceId: anchor.resourceId,
          });
        }
      }
    }
    for (const assignment of solution.assignments) {
      const match = indexes.matchById.get(assignment.matchId);
      if (!match) continue;
      if (match.fixed) continue;
      const shared = uniqueIds(match.participantIds).filter((p) =>
        anchor.participantIds.includes(p),
      );
      for (const participantId of shared) {
        const relation = relateToDecided(assignment.start, match, anchor, participantId);
        if (relation !== "conflict") continue;
        const detail = participantConflictDetail(
          match,
          assignment.start,
          assignment.end,
          decidedFromAnchor(anchor),
          participantId,
        );
        violations.push({
          kind: detail.overlaps ? "participant-overlap" : "rest-gap",
          matchId: assignment.matchId,
          otherId: anchor.id,
          participantId,
          restMinutes: detail.restMinutes,
          requiredMinutes: detail.requiredMinutes,
        });
      }
    }
  }

  return violations.sort(compareViolations);
}

function dependencyEndOf(
  dependency: ScheduleMatch | undefined,
  assignmentById: ReadonlyMap<string, Assignment>,
): number | null {
  if (!dependency) return null;
  if (dependency.fixed && dependency.end != null) return dependency.end;
  const assignment = assignmentById.get(dependency.id);
  return assignment ? assignment.end : null;
}

/** Deterministic violation order: kind, then match, then other, then participant. */
export function compareViolations(a: Violation, b: Violation): number {
  return (
    compareIds(a.kind, b.kind) ||
    compareIds(a.matchId ?? "", b.matchId ?? "") ||
    compareIds(a.otherId ?? "", b.otherId ?? "") ||
    compareIds(a.participantId ?? "", b.participantId ?? "")
  );
}

/** Rest exposed for callers that need the same numbers validation uses. */
export { requiredRestBetween, restAfterOf, restBeforeOf };

/** Re-exported so solvers can clone the run-local decided index without importing internals. */
export { cloneDecided as cloneDecidedByParticipant, cloneByResource as cloneDecidedByResource };

/** Convenience for callers that need a match's absolute end for a given start. */
export function matchEnd(match: ScheduleMatch, start: number): number {
  return assignmentEnd(match, start);
}
