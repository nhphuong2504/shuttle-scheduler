import type { ScheduleConflict, ScheduleConflictKind } from "./data";

/**
 * The computed conflicts from `schedule_conflicts`, turned into text the desk reads.
 *
 * The RPC is the one place the rules live; this module is the one place their words and
 * their order live. It is deliberately pure - no React, no query, no clock - because the
 * desk, the organiser's Schedule page and their unit tests all have to agree about what a
 * kind is called and how a list of them reads.
 *
 * Nothing here re-derives a conflict: the kind is taken as given from the RPC. The
 * `detail` column is deliberately *not* rendered - it carries shortened match ids for
 * debugging rather than a sentence a moderator can act on - so a surface that showed it
 * would leak a database id into the UI.
 */

/**
 * The order kinds are shown in, most structural first.
 *
 * One order for every surface, so the organiser's grouped block and a moderator's two-line
 * chip agree on which reason leads. Reading it top to bottom is reading from "two matches
 * share a court" down to "this one is waiting on another", which is roughly the order a
 * host would fix them in.
 */
export const CONFLICT_KIND_ORDER = [
  "court_overlap",
  "rest_shortfall",
  "break",
  "past_closing",
  "before_prerequisite",
] as const satisfies readonly ScheduleConflictKind[];

/**
 * What each kind says to a person. Sentence case, no ids, no jargon.
 *
 * These are the exact strings a moderator reads on a chip and an organiser reads on a
 * Schedule row, so they are written to be understood standing in a hall rather than to
 * name the database column. `ScheduleConflictKind` is imported rather than restated, so a
 * sixth kind added to the RPC fails this map's type instead of rendering blank.
 */
export const CONFLICT_KIND_LABEL: Record<ScheduleConflictKind, string> = {
  court_overlap: "Overlaps another match on this court",
  rest_shortfall: "A player is short of rest",
  break: "Falls in a break",
  past_closing: "Runs past closing time",
  before_prerequisite: "Starts before the match it waits on",
};

/** The rank of a kind in `CONFLICT_KIND_ORDER`; unknown kinds sort last, stably. */
const KIND_RANK = new Map<ScheduleConflictKind, number>(
  CONFLICT_KIND_ORDER.map((kind, index) => [kind, index]),
);

function timeOf(conflict: ScheduleConflict): number {
  if (!conflict.scheduled_time) return 0;
  const parsed = Date.parse(conflict.scheduled_time);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A stable order for a set of conflicts.
 *
 * Kind first, then the published time, then the match id, then the RPC's own `detail` as a
 * final tie-break. Stable rather than merely sorted: two renders of the same rows must not
 * swap places, because a list that reorders itself when nothing changed reads as a change.
 */
export function sortConflicts(conflicts: readonly ScheduleConflict[]): ScheduleConflict[] {
  return [...conflicts].sort((a, b) => {
    const byKind = (KIND_RANK.get(a.conflict_kind) ?? 99) - (KIND_RANK.get(b.conflict_kind) ?? 99);
    if (byKind !== 0) return byKind;
    const byTime = timeOf(a) - timeOf(b);
    if (byTime !== 0) return byTime;
    if (a.match_id !== b.match_id) return a.match_id < b.match_id ? -1 : 1;
    return (a.detail ?? "").localeCompare(b.detail ?? "");
  });
}

/**
 * Every conflict for a match, keyed by the match's id.
 *
 * This is what the desk draws a chip from: a court tile knows the match in front of it, and
 * asks this map "is that match in trouble". A match with no conflict has no key at all,
 * which is why a caller must treat `undefined` and `[]` the same.
 */
export function groupConflictsByMatch(
  conflicts: readonly ScheduleConflict[],
): Map<string, ScheduleConflict[]> {
  const byMatch = new Map<string, ScheduleConflict[]>();
  for (const conflict of sortConflicts(conflicts)) {
    const existing = byMatch.get(conflict.match_id);
    if (existing) existing.push(conflict);
    else byMatch.set(conflict.match_id, [conflict]);
  }
  return byMatch;
}

/**
 * The distinct reasons a single match carries, in the canonical kind order.
 *
 * Distinct by *kind* on purpose: `court_overlap` is emitted once per overlapping partner,
 * so a match can carry two overlap rows that are one reason, not two. A chip that said
 * "overlaps, overlaps" would be noise during a live day.
 */
export function conflictKindLabels(conflicts: readonly ScheduleConflict[]): string[] {
  const kinds = new Set<ScheduleConflictKind>();
  for (const conflict of sortConflicts(conflicts)) kinds.add(conflict.conflict_kind);
  return [...kinds].map((kind) => CONFLICT_KIND_LABEL[kind]);
}

/** A short chip line: up to `max` reasons, then how many are not shown. */
export interface ConflictSummary {
  /** The reasons to show, at most `max`, in canonical order. */
  reasons: string[];
  /** How many further reasons were left off, for a `+N` tail. */
  more: number;
  /** The whole line, ready to drop after "Needs attention": reasons joined, then `+N`. */
  text: string;
}

/**
 * Collapses one match's conflicts to a chip line. `max` is a parameter rather than a
 * constant because the chip caps at two while the confirmation dialog shows them all.
 */
export function summarizeConflicts(
  conflicts: readonly ScheduleConflict[],
  max = 2,
): ConflictSummary {
  const labels = conflictKindLabels(conflicts);
  const reasons = labels.slice(0, Math.max(0, max));
  const more = Math.max(0, labels.length - reasons.length);
  // A middot separates reasons rather than a comma: the reasons are phrases, not a list of
  // nouns, and a comma can be mistaken for one phrase continuing.
  const text = more > 0 ? `${reasons.join(" · ")} +${more}` : reasons.join(" · ");
  return { reasons, more, text };
}

/** One kind's conflicts, ready to render as a section of the organiser's block. */
export interface ConflictKindGroup {
  kind: ScheduleConflictKind;
  label: string;
  conflicts: ScheduleConflict[];
}

/**
 * The conflicts grouped by kind for the organiser's Schedule block.
 *
 * The RPC already returns one row per (match, kind), so each group's rows are distinct
 * matches. Empty kinds are omitted rather than rendered as an empty section, and the groups
 * come back in `CONFLICT_KIND_ORDER` so the block does not reshuffle between renders.
 */
export function groupConflictsByKind(
  conflicts: readonly ScheduleConflict[],
): ConflictKindGroup[] {
  const sorted = sortConflicts(conflicts);
  return CONFLICT_KIND_ORDER.flatMap((kind) => {
    const group = sorted.filter((conflict) => conflict.conflict_kind === kind);
    return group.length ? [{ kind, label: CONFLICT_KIND_LABEL[kind], conflicts: group }] : [];
  });
}

/**
 * How many distinct matches carry at least one conflict.
 *
 * The organiser's headline is a count of matches, not of rows: two kinds on one match is
 * one match that cannot run. `within`, when given, restricts the count to those match ids -
 * the desk passes the matches on the day it is showing, so its toast counts the board the
 * moderator is actually looking at rather than the whole tournament.
 */
export function conflictedMatchCount(
  conflicts: readonly ScheduleConflict[],
  within?: ReadonlySet<string>,
): number {
  const ids = new Set<string>();
  for (const conflict of conflicts) {
    if (within && !within.has(conflict.match_id)) continue;
    ids.add(conflict.match_id);
  }
  return ids.size;
}
