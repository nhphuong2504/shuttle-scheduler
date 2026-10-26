import type { ScheduleConflict, ScheduleConflictKind } from "./data";

/**
 * The computed conflicts from `schedule_conflicts`, turned into text the desk reads.
 *
 * The RPC is the one place the rules live; this module is the one place their words and
 * their order live. It is deliberately pure - no React, no query, no clock - because the
 * desk, the organiser's Schedule page and their unit tests all have to agree about what a
 * kind is called and how a list of them reads.
 *
 * Nothing here re-derives a conflict: the kind, the other match, the player and the minutes are
 * taken as given from the RPC. The `detail` column is deliberately *not* rendered - it carries
 * shortened match ids for debugging rather than a sentence a moderator can act on - so a surface
 * that showed it would leak a database id into the UI.
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
  court_overlap: "Same court and time as another match",
  rest_shortfall: "A player won't have had full rest",
  break: "Scheduled during a break",
  past_closing: "Ends after the courts close",
  before_prerequisite: "Scheduled before a match it depends on",
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
  // A semicolon separates reasons rather than a comma: each is a whole clause, and a
  // comma lets one read as the previous clause continuing.
  const text = more > 0 ? `${reasons.join("; ")} +${more}` : reasons.join("; ");
  return { reasons, more, text };
}

/** How a conflict sentence names the things it points at. */
export interface ConflictWording {
  /** A match as the reader knows it, for the match on the other side of the conflict. */
  matchLabel: (matchId: string) => string;
  /** A player's name, for the player short of rest; null when the name is not known. */
  playerName: (playerId: string) => string | null;
}

const minutesText = (minutes: number) => `${minutes} min`;

/**
 * One conflict as a sentence: what is wrong, with whom, and by how much.
 *
 * The RPC names the other match, the player and the minutes (`related_match_id`, `player_id`,
 * `minutes`), so a row reads "Overlaps WS r2-1 on the same court by 3 min" rather than only its kind.
 * A row without them - an older server, or a kind that has no other side - falls back to the kind's
 * label, which is still true, only less specific.
 */
export function describeConflict(conflict: ScheduleConflict, wording: ConflictWording): string {
  const minutes = conflict.minutes ?? null;
  const other = conflict.related_match_id ? wording.matchLabel(conflict.related_match_id) : null;
  switch (conflict.conflict_kind) {
    case "court_overlap":
      if (other && minutes != null) return `Overlaps ${other} on the same court by ${minutesText(minutes)}`;
      break;
    case "rest_shortfall": {
      if (other && minutes != null) {
        const who = (conflict.player_id && wording.playerName(conflict.player_id)) || "A player";
        return `${who} would rest ${minutesText(minutes)} less than required after ${other}`;
      }
      break;
    }
    case "break":
      if (minutes != null) return `Runs ${minutesText(minutes)} into a break`;
      break;
    case "past_closing":
      if (minutes != null) return `Ends ${minutesText(minutes)} after the courts close`;
      break;
    case "before_prerequisite":
      if (other && minutes != null) return `Starts ${minutesText(minutes)} before ${other} is due to end`;
      break;
  }
  return CONFLICT_KIND_LABEL[conflict.conflict_kind];
}

/** Every conflict of one match as sentences, in the canonical kind order. */
export function describeConflicts(
  conflicts: readonly ScheduleConflict[],
  wording: ConflictWording,
): string[] {
  return sortConflicts(conflicts).map((conflict) => describeConflict(conflict, wording));
}

/** One match with everything wrong with it, ready to render as a line of the organiser's block. */
export interface ConflictMatchGroup {
  matchId: string;
  courtId: string | null;
  scheduledTime: string | null;
  reasons: string[];
}

/**
 * The conflicts grouped by match for the organiser's Schedule block, earliest first.
 *
 * By match rather than by kind: a match with two reasons used to appear under two headings, so the
 * reader counted it twice and read neither reason next to the other. One line per match, its
 * reasons beneath it, matches the headline, which already counts matches.
 */
export function groupConflictsForReview(
  conflicts: readonly ScheduleConflict[],
  wording: ConflictWording,
): ConflictMatchGroup[] {
  const groups = [...groupConflictsByMatch(conflicts).entries()].map(([matchId, rows]) => ({
    matchId,
    courtId: rows[0]?.court_id ?? null,
    scheduledTime: rows[0]?.scheduled_time ?? null,
    reasons: describeConflicts(rows, wording),
  }));
  const time = (value: string | null) => (value ? Date.parse(value) || 0 : 0);
  return groups.sort(
    (a, b) => time(a.scheduledTime) - time(b.scheduledTime) || (a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0),
  );
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
