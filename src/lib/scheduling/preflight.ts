/**
 * Problem preflight. Invalid *input* is distinct from an unschedulable *outcome*, so it is
 * reported before any solver runs and never degrades into a phantom `unscheduled` entry.
 *
 * Fixed matches and anchors are exempt from `hardEnd` here, and `validateSolution` does not
 * report `hard-end` for either: both are already-decided history, so a wall that postdates them
 * cannot invalidate them. The exemption is implemented identically in both validators.
 */

import {
  compareIds,
  relateToDecided,
  type ParticipantAnchor,
  type ScheduleMatch,
  type SchedulingProblem,
} from "./domain";

export type ProblemIssueKind =
  | "duplicate-match-id"
  | "duplicate-anchor-id"
  | "duplicate-resource-id"
  | "fixed-missing-start"
  | "fixed-missing-end"
  | "fixed-missing-resource"
  | "fixed-unknown-resource"
  | "fixed-invalid-range"
  | "fixed-resource-conflict"
  | "fixed-participant-conflict"
  | "fixed-capability-violation"
  | "unknown-dependency"
  | "self-dependency"
  | "anchor-invalid-range"
  | "anchor-unknown-resource"
  | "anchor-conflict"
  | "hard-end-before-planning-end";

export interface ProblemIssue {
  kind: ProblemIssueKind;
  matchId?: string | undefined;
  resourceId?: string | undefined;
  otherId?: string | undefined;
}

/** Thrown by `assertValidProblem`; carries every issue, deterministically ordered. */
export class ProblemValidationError extends Error {
  readonly issues: readonly ProblemIssue[];

  constructor(issues: readonly ProblemIssue[]) {
    super(
      `Invalid scheduling problem (${issues.length} issue${issues.length === 1 ? "" : "s"}): ` +
        issues.map(describeIssue).join("; "),
    );
    this.name = "ProblemValidationError";
    this.issues = issues;
  }
}

function describeIssue(issue: ProblemIssue): string {
  const parts: string[] = [issue.kind];
  if (issue.matchId != null) parts.push(`match=${issue.matchId}`);
  if (issue.otherId != null) parts.push(`other=${issue.otherId}`);
  if (issue.resourceId != null) parts.push(`resource=${issue.resourceId}`);
  return parts.join(" ");
}

/** Deterministic issue order: kind, then match, then other, then resource. */
function compareIssues(a: ProblemIssue, b: ProblemIssue): number {
  return (
    compareIds(a.kind, b.kind) ||
    compareIds(a.matchId ?? "", b.matchId ?? "") ||
    compareIds(a.otherId ?? "", b.otherId ?? "") ||
    compareIds(a.resourceId ?? "", b.resourceId ?? "")
  );
}

/** A decided interval: a fixed match or an anchor, both of which carry a concrete range. */
type Decided = { start: number; end: number; resourceId?: string | undefined } & (
  | ScheduleMatch
  | ParticipantAnchor
);

function participantsOf(entity: ScheduleMatch | ParticipantAnchor): string[] {
  return [...new Set(entity.participantIds)];
}

/**
 * True when two decided intervals conflict for `participantId` in either direction.
 * A conflict means the left start lies inside the right-side forbidden interval, which also
 * covers a partial overlap, so classifying one direction is exhaustive.
 */
function participantConflict(left: Decided, right: Decided, participantId: string): boolean {
  // A decided interval's own span is its duration for this classification.
  const candidate = { ...left, durationMinutes: (left.end - left.start) / 60_000 };
  return relateToDecided(left.start, candidate, right, participantId) === "conflict";
}

function resourcesOverlap(left: Decided, right: Decided): boolean {
  if (left.resourceId == null || right.resourceId == null) return false;
  if (left.resourceId !== right.resourceId) return false;
  return left.start < right.end && right.start < left.end;
}

/**
 * Returns every issue found. An empty array means the problem is well formed.
 *
 * Rules: unique match, anchor and resource ids; known and non-self dependencies; a fixed match
 * must carry `start`, `end` and a known capability-compatible `resourceId` with `end > start`; an
 * anchor needs `end > start` and a known `resourceId` when present; a non-null `hardEnd` must be
 * at or after `planningEnd`.
 *
 * Deliberately *not* an issue: two already-decided occupancies overlapping. A fixed match and an
 * anchor are history, and the core never chooses between them, so an overlap cannot make a problem
 * unsolvable. Reporting it would reject a legitimate day the moment a match overran its slot.
 */
export function validateProblem(problem: SchedulingProblem): ProblemIssue[] {
  const issues: ProblemIssue[] = [];
  const resourceById = new Map(problem.resources.map((resource) => [resource.id, resource]));

  // ---- uniqueness ----
  const matchSeen = new Set<string>();
  for (const match of problem.matches) {
    if (matchSeen.has(match.id)) issues.push({ kind: "duplicate-match-id", matchId: match.id });
    matchSeen.add(match.id);
  }
  const anchors = problem.anchors ?? [];
  const anchorSeen = new Set<string>();
  for (const anchor of anchors) {
    if (anchorSeen.has(anchor.id)) issues.push({ kind: "duplicate-anchor-id", matchId: anchor.id });
    anchorSeen.add(anchor.id);
  }
  const resourceSeen = new Set<string>();
  for (const resource of problem.resources) {
    if (resourceSeen.has(resource.id)) {
      issues.push({ kind: "duplicate-resource-id", resourceId: resource.id });
    }
    resourceSeen.add(resource.id);
  }

  // ---- dependencies ---- A dependency may name a match or an anchor: a carried slot from an
  // earlier day is only ever an anchor, and a match that follows it must still be resolvable.
  const dependencyTargets = new Set([...matchSeen, ...anchorSeen]);
  for (const match of problem.matches) {
    for (const dependencyId of match.dependencies ?? []) {
      if (dependencyId === match.id) {
        issues.push({ kind: "self-dependency", matchId: match.id });
      } else if (!dependencyTargets.has(dependencyId)) {
        issues.push({ kind: "unknown-dependency", matchId: match.id, otherId: dependencyId });
      }
    }
  }

  // ---- fixed matches ----
  const fixedMatches: Decided[] = [];
  for (const match of problem.matches) {
    if (!match.fixed) continue;
    if (match.start == null) issues.push({ kind: "fixed-missing-start", matchId: match.id });
    if (match.end == null) issues.push({ kind: "fixed-missing-end", matchId: match.id });
    if (match.resourceId == null) {
      issues.push({ kind: "fixed-missing-resource", matchId: match.id });
    }
    if (match.start == null || match.end == null) continue;
    if (match.end <= match.start) issues.push({ kind: "fixed-invalid-range", matchId: match.id });
    const resource = match.resourceId != null ? resourceById.get(match.resourceId) : undefined;
    if (match.resourceId != null && !resource) {
      issues.push({
        kind: "fixed-unknown-resource",
        matchId: match.id,
        resourceId: match.resourceId,
      });
    }
    if (resource) {
      const provided = new Set(resource.capabilities ?? []);
      const missing = (match.resourceRequirements ?? []).filter((req) => !provided.has(req));
      if (missing.length) {
        issues.push({
          kind: "fixed-capability-violation",
          matchId: match.id,
          resourceId: resource.id,
        });
      }
    }
    fixedMatches.push(match as Decided);
  }

  // ---- anchors ----
  const decidedAnchors: Decided[] = [];
  for (const anchor of anchors) {
    if (anchor.end <= anchor.start) {
      issues.push({ kind: "anchor-invalid-range", matchId: anchor.id });
    }
    if (anchor.resourceId != null && !resourceById.has(anchor.resourceId)) {
      issues.push({
        kind: "anchor-unknown-resource",
        matchId: anchor.id,
        resourceId: anchor.resourceId,
      });
    }
    decidedAnchors.push(anchor as Decided);
  }

  // ---- decided-vs-decided. Two already-decided occupancies are history: their overlap is a
  // recorded fact rather than a planning choice, and the core never has to choose between them.
  // Demanding rest between them would make legitimate history (an overrunning match, a carried
  // slot, a reported result) unrepresentable, so only the *resource* conflicts, which are a
  // physical impossibility on a real court, are reported.
  for (let i = 0; i < fixedMatches.length; i++) {
    const left = fixedMatches[i]!;
    for (let j = i + 1; j < fixedMatches.length; j++) {
      const right = fixedMatches[j]!;
      if (resourcesOverlap(left, right)) {
        issues.push({
          kind: "fixed-resource-conflict",
          matchId: left.id,
          otherId: right.id,
          resourceId: left.resourceId,
        });
      }
    }
  }

  // ---- anchor vs every decided occupancy. Anchors are checked against all fixed matches
  // regardless of array position, and against later anchors only, so no pair is reported twice.
  for (const anchor of decidedAnchors) {
    for (const fixed of fixedMatches) {
      if (resourcesOverlap(anchor, fixed)) {
        issues.push({
          kind: "anchor-conflict",
          matchId: anchor.id,
          otherId: fixed.id,
          resourceId: anchor.resourceId,
        });
      }
    }
  }
  for (let i = 0; i < decidedAnchors.length; i++) {
    const left = decidedAnchors[i]!;
    for (let j = i + 1; j < decidedAnchors.length; j++) {
      const right = decidedAnchors[j]!;
      if (resourcesOverlap(left, right)) {
        issues.push({
          kind: "anchor-conflict",
          matchId: left.id,
          otherId: right.id,
          resourceId: left.resourceId,
        });
      }
    }
  }

  // ---- hard end ----
  if (problem.hardEnd != null && problem.hardEnd < problem.planningEnd) {
    issues.push({ kind: "hard-end-before-planning-end" });
  }

  return issues.sort(compareIssues);
}

/** Runs `validateProblem` and throws `ProblemValidationError` when it finds anything. */
export function assertValidProblem(problem: SchedulingProblem): void {
  const issues = validateProblem(problem);
  if (issues.length) throw new ProblemValidationError(issues);
}
