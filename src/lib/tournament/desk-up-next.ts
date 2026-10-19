import { expectedEndMs, matchStartMs } from "./day-scope";
import type { DeskCourtState, DeskMatchModel } from "./desk";

const MINUTE = 60_000;

/**
 * Up next: the call queue. For each court, the match to call next, when its court frees, and
 * whether its players will be free by then.
 *
 * ## What it answers, and what it leaves to others
 *
 * Needs action answers "what is already late"; this answers "who do I call next", so the two
 * never list one match. A court's next match is left out when it is late (past its scheduled
 * start - that is a Needs-action row) or when Needs action names it for another reason (the
 * "Court N is ready" row), which the caller passes in as `listedElsewhere`.
 *
 * ## When a court frees
 *
 *   now      nothing is playing on it
 *   at       a match is playing and its expected end - the slot measured from its start, the
 *            same projection the overrun rule uses - is still ahead
 *   over     a match is playing past its expected end: there is no honest time to give
 *
 * ## Whether the players are free then
 *
 * Judged at the moment the court frees, not now: a player resting for ten more minutes is no
 * problem for a court that frees in fifteen. A player is free at
 *
 *   - the end of their rest, if their last match has ended;
 *   - the expected end of the match they are playing elsewhere, plus the rest gap - or never
 *     knowably, if that match is already past its own expected end.
 *
 * The row is at risk when the latest of those is at least `UP_NEXT_RISK_MARGIN_MINUTES` after
 * the court frees; under that the gap is inside the estimate's own error and the row reads
 * "Players free". Pure, and built only on rules the board already uses.
 */

/** How much later than the court a player must be free before the row says so. */
export const UP_NEXT_RISK_MARGIN_MINUTES = 3;

export type UpNextFree = { kind: "now" } | { kind: "at"; ms: number } | { kind: "over" };

export type UpNextStatus =
  | { kind: "free" }
  /** Not every player is known yet - a slot waiting on an earlier result. */
  | { kind: "unknown" }
  | { kind: "resting"; playerId: string; readyAtMs: number }
  /**
   * On another court. `readyAtMs` is that match's expected end plus the rest gap, or null when
   * that match is already past its expected end.
   */
  | { kind: "busy"; playerId: string; courtId: string | null; readyAtMs: number | null };

export interface UpNextRow<TMatch extends DeskMatchModel = DeskMatchModel> {
  courtId: string;
  match: TMatch;
  free: UpNextFree;
  /**
   * The match's published start, when it says something the free time does not: always for a
   * court that is free now or running over, and for a projected time only when the two differ.
   */
  scheduledMs: number | null;
  status: UpNextStatus;
}

export interface UpNextInput<TMatch extends DeskMatchModel> {
  courtStates: readonly DeskCourtState<TMatch>[];
  /** The day's matches the court states were derived from. */
  matches: readonly TMatch[];
  slotMinutesFor: (match: TMatch) => number;
  restMinutesFor: (match: TMatch) => number;
  /** Match ids Needs action already lists; they are not repeated here. */
  listedElsewhere?: ReadonlySet<string>;
  /** Whether every player of a match is known. Defaults to "it has any player at all". */
  playersKnown?: (match: TMatch) => boolean;
  now: number;
}

function asTime(value: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function wholeMinute(ms: number): number {
  return Math.floor(ms / MINUTE);
}

export function upNext<TMatch extends DeskMatchModel>({
  courtStates,
  matches,
  slotMinutesFor,
  restMinutesFor,
  listedElsewhere = new Set(),
  playersKnown = (match) => match.playerIds.length > 0,
  now,
}: UpNextInput<TMatch>): UpNextRow<TMatch>[] {
  const rows: (UpNextRow<TMatch> & { sortMs: number; order: number })[] = [];

  courtStates.forEach((court, order) => {
    const { courtId, playing, next } = court;
    if (!next || listedElsewhere.has(next.id)) return;
    const startMs = matchStartMs(next);
    if (startMs == null) return;
    // Late is Needs action's, from the first whole minute - the same line it draws.
    if (now - startMs >= MINUTE) return;

    let free: UpNextFree;
    if (!playing) {
      free = { kind: "now" };
    } else {
      const end = expectedEndMs(playing, slotMinutesFor);
      free = end != null && end > now ? { kind: "at", ms: end } : { kind: "over" };
    }
    const freeMs = free.kind === "at" ? free.ms : now;
    const scheduledMs =
      free.kind !== "at" || wholeMinute(startMs) !== wholeMinute(free.ms) ? startMs : null;

    rows.push({
      courtId,
      match: next,
      free,
      scheduledMs,
      status: playersKnown(next)
        ? statusAt(next, freeMs, matches, slotMinutesFor, restMinutesFor(next), now)
        : { kind: "unknown" },
      sortMs: freeMs,
      order,
    });
  });

  return rows
    .sort((a, b) => a.sortMs - b.sortMs || a.order - b.order)
    .map(({ sortMs: _sortMs, order: _order, ...row }) => row);
}

function statusAt<TMatch extends DeskMatchModel>(
  match: TMatch,
  freeMs: number,
  matches: readonly TMatch[],
  slotMinutesFor: (match: TMatch) => number,
  restMinutes: number,
  now: number,
): UpNextStatus {
  const rest = restMinutes * MINUTE;
  let worst: UpNextStatus = { kind: "free" };
  let worstMs = -Infinity;

  for (const playerId of match.playerIds) {
    const elsewhere = matches.find(
      (other) => other.id !== match.id && other.status === "in-progress" && other.playerIds.includes(playerId),
    );
    if (elsewhere) {
      const end = expectedEndMs(elsewhere, slotMinutesFor);
      if (end == null || end <= now) {
        // Running over somewhere else: unknowable, and so the worst case there is.
        return { kind: "busy", playerId, courtId: elsewhere.courtId, readyAtMs: null };
      }
      const readyAtMs = end + rest;
      if (readyAtMs > worstMs) {
        worstMs = readyAtMs;
        worst = { kind: "busy", playerId, courtId: elsewhere.courtId, readyAtMs };
      }
      continue;
    }

    const lastEnd = matches
      .filter((other) => other.id !== match.id && other.playerIds.includes(playerId))
      .map((other) => asTime(other.endedAt))
      .reduce<number | null>((latest, ended) => (ended != null && (latest == null || ended > latest) ? ended : latest), null);
    if (lastEnd == null) continue;
    const readyAtMs = lastEnd + rest;
    if (readyAtMs > worstMs) {
      worstMs = readyAtMs;
      worst = { kind: "resting", playerId, readyAtMs };
    }
  }

  return worstMs - freeMs >= UP_NEXT_RISK_MARGIN_MINUTES * MINUTE ? worst : { kind: "free" };
}
