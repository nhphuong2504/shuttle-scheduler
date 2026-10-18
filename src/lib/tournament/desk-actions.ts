import { matchStartMs } from "./day-scope";
import type { DeskCourtState, DeskMatchModel, MatchReadiness } from "./desk";

const MINUTE = 60_000;

/**
 * The Desk's "Needs action" rows: what a moderator should go and do, most urgent first.
 *
 * ## What earns a row
 *
 * The court board already says what is on every court. A row has to add something the tile
 * cannot: a concrete thing to do now, and a place in one venue-wide order of urgency. So a
 * row names a court, a match, one number for why it is here, what is in the way when
 * something is, and exactly one action.
 *
 *   start-late    a free court whose next match is past its scheduled start and can start
 *   blocked-late  the same, but a player is resting, busy elsewhere, or not yet known - the
 *                 moderator's job is to chase that person, and the row names them
 *   overrun       a match well past its expected finish, or one that is holding back a next
 *                 match whose start has already passed. Its result is what is owed
 *   results-late  a pool past its scheduled finish with results still missing
 *   ready         a free court with a ready match that is not late yet, once the court has
 *                 stood free long enough to be a waste rather than a moment between matches
 *
 * ## What does not
 *
 *   - **A ready match with no court.** Every way to get there is either transient (a result
 *     just unlocked it and place-ready is about to slot it) or the organiser's decision (no
 *     slot before the close, no courts, a first build or rebuild), and the Schedule page
 *     names the cause. The board's idle tile is where a moderator can still dispatch it.
 *   - **A match running a little long.** The tile turns amber at the slot; the alert waits
 *     for `OVERRUN_ALERT_AFTER_MINUTES` more, because a long rally is not yet something to
 *     walk over and ask about.
 *   - **A court that has just freed.** The moderator who entered the result is still at the
 *     desk; the tile says Ready, and the row follows once the court has been free for
 *     `READY_ALERT_AFTER_MINUTES`.
 *
 * Pure: it reads the board's own court states and the matches they came from, so it cannot
 * disagree with the tiles, and introduces no second readiness or slot rule.
 */

/** How far past its expected finish a match runs before the desk asks someone to look. */
export const OVERRUN_ALERT_AFTER_MINUTES = 10;

/** How long a court with a ready match stands free before the desk asks for it to start. */
export const READY_ALERT_AFTER_MINUTES = 3;

/** Rows shown before the rest are folded behind a "show more". */
export const MAX_ACTION_ROWS = 5;

interface CourtAction<TMatch> {
  courtId: string;
  match: TMatch;
}

export type DeskAction<TMatch extends DeskMatchModel = DeskMatchModel, TPool = unknown> =
  | (CourtAction<TMatch> & {
      kind: "start-late";
      lateMinutes: number;
    })
  | (CourtAction<TMatch> & {
      kind: "blocked-late";
      lateMinutes: number;
      /** Why it cannot start: never `ready`, by construction. */
      readiness: MatchReadiness;
    })
  | (CourtAction<TMatch> & {
      kind: "overrun";
      elapsedMinutes: number;
      /** Whole minutes past the expected finish. */
      overByMinutes: number;
      /** How late the match queued behind it already is, or null when it is not late. */
      nextLateMinutes: number | null;
    })
  | {
      kind: "results-late";
      pool: TPool;
      /** Whole minutes past the pool's scheduled finish. */
      lateMinutes: number;
    }
  | (CourtAction<TMatch> & {
      kind: "ready";
      /** The next match's scheduled start, for ordering among rows that are not late. */
      startMs: number;
    });

export interface LatePool<TPool> {
  pool: TPool;
  scheduledEndMs: number;
}

export interface DeskActionsInput<TMatch extends DeskMatchModel, TPool> {
  courtStates: readonly DeskCourtState<TMatch>[];
  /** The day's matches the court states were derived from, for when each court last freed. */
  matches: readonly TMatch[];
  slotMinutesFor: (match: TMatch) => number;
  /** Pools the desk has already found late; this only places them in the order. */
  latePools?: readonly LatePool<TPool>[];
  now: number;
}

/** Whole minutes `at` is behind `now`, or null when it is not at least a minute behind. */
function minutesLate(at: number | null, now: number): number | null {
  if (at == null) return null;
  const late = Math.floor((now - at) / MINUTE);
  return late >= 1 ? late : null;
}

/** When a court last freed: the latest end among the matches played on it, or null. */
function courtFreeSinceMs(courtId: string, matches: readonly DeskMatchModel[]): number | null {
  let latest: number | null = null;
  for (const match of matches) {
    if (match.courtId !== courtId || !match.endedAt) continue;
    const ended = new Date(match.endedAt).getTime();
    if (Number.isFinite(ended) && (latest == null || ended > latest)) latest = ended;
  }
  return latest;
}

/**
 * The minutes a row is ranked by. Every late row is ranked by how late it is, whatever kind it
 * is, so a court twelve minutes behind sorts above a pool eight minutes behind. An overrun is
 * ranked by the larger of its own overrun and the lateness of the match waiting for its court,
 * because that waiting match is the cost.
 */
function urgencyOf(action: DeskAction<DeskMatchModel, unknown>): number | null {
  switch (action.kind) {
    case "start-late":
    case "blocked-late":
    case "results-late":
      return action.lateMinutes;
    case "overrun":
      return Math.max(action.overByMinutes, action.nextLateMinutes ?? 0);
    case "ready":
      return null;
  }
}

export function deskActions<TMatch extends DeskMatchModel, TPool = unknown>({
  courtStates,
  matches,
  slotMinutesFor,
  latePools = [],
  now,
}: DeskActionsInput<TMatch, TPool>): DeskAction<TMatch, TPool>[] {
  const actions: DeskAction<TMatch, TPool>[] = [];

  for (const court of courtStates) {
    const { courtId, playing, next, readiness } = court;
    const nextLate = next ? minutesLate(matchStartMs(next), now) : null;

    if (playing) {
      if (court.state !== "overrun" || court.elapsedMinutes == null) continue;
      const overByMinutes = court.elapsedMinutes - slotMinutesFor(playing);
      if (overByMinutes < OVERRUN_ALERT_AFTER_MINUTES && nextLate == null) continue;
      actions.push({
        kind: "overrun",
        courtId,
        match: playing,
        elapsedMinutes: court.elapsedMinutes,
        overByMinutes,
        nextLateMinutes: nextLate,
      });
      continue;
    }

    if (!next || !readiness) continue;

    if (nextLate != null) {
      actions.push(
        readiness.state === "ready"
          ? { kind: "start-late", courtId, match: next, lateMinutes: nextLate }
          : { kind: "blocked-late", courtId, match: next, lateMinutes: nextLate, readiness },
      );
      continue;
    }

    if (court.state !== "free-ready") continue;
    // A court nothing has finished on has been free since the day began, which is long enough.
    const freeSince = courtFreeSinceMs(courtId, matches);
    if (freeSince != null && now - freeSince < READY_ALERT_AFTER_MINUTES * MINUTE) continue;
    actions.push({ kind: "ready", courtId, match: next, startMs: matchStartMs(next) ?? now });
  }

  for (const { pool, scheduledEndMs } of latePools) {
    actions.push({
      kind: "results-late",
      pool,
      lateMinutes: Math.max(0, Math.floor((now - scheduledEndMs) / MINUTE)),
    });
  }

  // Late rows first, latest first; then the ready courts, soonest scheduled first. `sort` is
  // stable, so rows that tie keep the board's court order.
  return actions.sort((a, b) => {
    const ua = urgencyOf(a);
    const ub = urgencyOf(b);
    if (ua != null && ub != null) return ub - ua;
    if (ua != null) return -1;
    if (ub != null) return 1;
    return (a.kind === "ready" ? a.startMs : 0) - (b.kind === "ready" ? b.startMs : 0);
  });
}

/** The rows drawn up front and the ones folded behind "show more", in rank order. */
export function splitActions<T>(
  actions: readonly T[],
  limit: number = MAX_ACTION_ROWS,
): { shown: T[]; folded: T[] } {
  return { shown: actions.slice(0, limit), folded: actions.slice(limit) };
}
