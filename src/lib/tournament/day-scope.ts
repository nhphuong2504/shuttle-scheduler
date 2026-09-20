/**
 * Day scoping for the control desk.
 *
 * The desk is strictly about **one tournament day at a time**: the courts on it, the
 * matches on it, and what needs doing on it. Nothing here forecasts anything, runs the
 * scheduler, or decides whether a match may start — readiness and dispatch stay in
 * `desk.ts` and `live-constraints.ts`, which are the only eligibility system.
 *
 * This module has exactly three jobs:
 *
 * 1. **Day resolution** (`resolveSelectedDay`) — which day the desk should be showing.
 * 2. **Match attribution** (`attributeMatchesToDays`) — which day a match belongs to.
 * 3. **Simple derived counts** (`dayOperationalCounts`) — what the day looks like.
 *
 * ---------------------------------------------------------------------------------------------
 * Why attribution is not "the calendar date"
 * ---------------------------------------------------------------------------------------------
 *
 * The last day is allowed to overrun its close, so a match can legitimately start after its own
 * day's `end_time` — including after midnight, on the next calendar date. Bucketing by calendar
 * date would file such a match under the *following* day, or under no day at all. Matching is
 * therefore by "which configured day had already opened when this match started", which is
 * exactly the rule the planner itself works to; it is reused from `sliceRowsByDay` rather than
 * reimplemented.
 *
 * Court is never part of attribution: a match with a scheduled time but no court yet still
 * belongs to its day. Only a row with no usable time at all is unattributable, and it is
 * reported separately (`untimed`) rather than being assigned to a day on a guess.
 *
 * Pure and read-only.
 */

import type { TournamentDay } from "./data";
import { dayWindowBounds, localDateKey, sliceRowsByDay } from "./scheduling/day-plan";

/** Statuses that mean a match is decided and needs nothing more from anyone. */
const DECIDED = new Set(["reported", "walkover"]);

/**
 * The slice of a match this module needs.
 *
 * A structural subset of `DeskMatchModel`, so a desk match can be passed straight in without
 * this module having to know about courts, kinds or players.
 */
export interface DayScopedMatch {
  id: string;
  status: string;
  scheduled: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface DayAttribution<T extends DayScopedMatch> {
  /** Rows attributable to each day id, in the order they were given. Every day gets a key. */
  byDayId: Map<string, T[]>;
  /** Rows with no usable time, which belong to no day. Never assigned to one on a guess. */
  untimed: T[];
}

/**
 * The instant a match should be attributed by: when it started, else when it was scheduled,
 * else when it ended. A reported match is still attributed by when it was played, not by the
 * moment the result happened to be entered.
 */
export function matchStartMs(match: DayScopedMatch): number | null {
  const raw = match.startedAt ?? match.scheduled ?? match.endedAt;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Buckets matches into tournament days.
 *
 * Reuses the planner's own `sliceRowsByDay` rule, which is the whole point: the desk and the
 * schedule must agree about which day a post-midnight overrun belongs to.
 */
export function attributeMatchesToDays<T extends DayScopedMatch>(
  days: readonly TournamentDay[],
  matches: readonly T[],
): DayAttribution<T> {
  const byDayId = new Map<string, T[]>();
  for (const day of days) byDayId.set(day.id, []);

  const timed: T[] = [];
  const untimed: T[] = [];
  for (const match of matches) {
    if (matchStartMs(match) == null) untimed.push(match);
    else timed.push(match);
  }

  if (!days.length) return { byDayId, untimed };

  const slices = sliceRowsByDay(timed, days, (match) => new Date(matchStartMs(match)!));
  for (const slice of slices) byDayId.set(slice.day.id, slice.rows);

  return { byDayId, untimed };
}

/** The matches attributed to one day. */
export function matchesForDay<T extends DayScopedMatch>(
  days: readonly TournamentDay[],
  matches: readonly T[],
  dayId: string | null,
): T[] {
  if (!dayId) return [];
  return attributeMatchesToDays(days, matches).byDayId.get(dayId) ?? [];
}

/**
 * The id of the day a single instant belongs to, by the same rule as match attribution: the
 * last day that had already opened. Used for things that carry one timestamp rather than a
 * match row, such as a pool's scheduled end.
 */
export function dayIdForTime(days: readonly TournamentDay[], ms: number): string | null {
  if (!days.length) return null;
  const slices = sliceRowsByDay([{ ms }], days, (row) => new Date(row.ms));
  const found = slices.find((slice) => slice.rows.length > 0);
  return found?.day.id ?? null;
}

export interface ResolveSelectedDayInput<T extends DayScopedMatch> {
  days: readonly TournamentDay[];
  attribution: DayAttribution<T>;
  /** Injectable clock, so the resolution is testable rather than wall-clock. */
  now: number;
  /**
   * The day the moderator picked, or null while the opening view is still derived.
   *
   * A pick that still exists always wins, and is deliberately never reset by a realtime
   * update: a board that jumps to another day while someone is reading it is worse than one
   * showing a day that has just emptied.
   */
  pickedDayId: string | null;
}

/**
 * Which tournament day the desk should show.
 *
 * In order:
 *
 * 1. the day the moderator explicitly picked, if it still exists;
 * 2. the day whose configured window contains `now`;
 * 3. the day with work in progress, then the earliest day with work still to play — this is
 *    what keeps the desk on the right day after midnight, when no configured window contains
 *    `now` because a window can never cross midnight by configuration;
 * 4. the day whose date is today;
 * 5. the earliest day that has anything on it;
 * 6. the first configured day.
 *
 * Returns null only when there are no configured days at all.
 */
export function resolveSelectedDay<T extends DayScopedMatch>(
  input: ResolveSelectedDayInput<T>,
): string | null {
  const ordered = [...input.days].sort((a, b) => a.day_number - b.day_number);
  if (!ordered.length) return null;

  const known = new Set(ordered.map((day) => day.id));
  if (input.pickedDayId && known.has(input.pickedDayId)) return input.pickedDayId;

  const containing = ordered.find((day) => {
    const { start, end } = dayWindowBounds(day);
    return input.now >= start && input.now <= end;
  });
  if (containing) return containing.id;

  const rowsOn = (day: TournamentDay) => input.attribution.byDayId.get(day.id) ?? [];
  const inProgress = ordered.find((day) =>
    rowsOn(day).some((match) => match.status === "in-progress"),
  );
  if (inProgress) return inProgress.id;

  const unfinished = ordered.find((day) =>
    rowsOn(day).some((match) => match.status === "scheduled"),
  );
  if (unfinished) return unfinished.id;

  const todayKey = localDateKey(input.now);
  const today = ordered.find((day) => day.date === todayKey);
  if (today) return today.id;

  const withRows = ordered.find((day) => rowsOn(day).length > 0);
  if (withRows) return withRows.id;

  return ordered[0]!.id;
}

/**
 * When a match is expected to finish: from when it actually started, else from when it was
 * scheduled, plus one slot. Null when it has no usable time, so callers cannot treat an
 * untimed row as overdue.
 */
export function expectedEndMs<T extends DayScopedMatch>(
  match: T,
  slotMinutesFor: (match: T) => number,
): number | null {
  const start = matchStartMs(match);
  if (start == null) return null;
  return start + slotMinutesFor(match) * 60_000;
}

/**
 * Undecided matches past their expected end, so somebody owes a result.
 *
 * Either the match never started on time or it is overrunning; both need chasing, which is
 * what makes this distinct from "in progress" (a match comfortably inside its slot). A row
 * with no usable time can never be overdue, because there is nothing to be overdue against.
 */
export function awaitingResultMatches<T extends DayScopedMatch>(
  matches: readonly T[],
  slotMinutesFor: (match: T) => number,
  now: number,
): T[] {
  return matches.filter((match) => {
    if (DECIDED.has(match.status) || match.status === "void") return false;
    const end = expectedEndMs(match, slotMinutesFor);
    return end != null && end <= now;
  });
}

export interface DayOperationalCounts {
  /** Decided matches: reported or walked over. */
  completed: number;
  /** Still to be played or in progress. */
  remaining: number;
  /** On court right now. */
  inProgress: number;
  /**
   * Undecided and past its expected end, so somebody owes a result. Either it never started
   * on time or it is overrunning; both need chasing, which is what makes this distinct from
   * `inProgress` (a match comfortably inside its slot).
   */
  awaitingResults: number;
  /** Completed matches that were not decided by play. */
  walkovers: number;
  /** Latest expected end among matches still to be played, or null when none are left. */
  latestFinishMs: number | null;
}

/**
 * What the selected day looks like, from that day's rows alone.
 *
 * `slotMinutesFor` is passed in rather than derived here: how long a match holds a court is a
 * sport and format fact that `desk.ts` already owns (`deskKindPhase`), and a second opinion
 * here would be a second set of rules.
 */
export function dayOperationalCounts<T extends DayScopedMatch>(
  matches: readonly T[],
  slotMinutesFor: (match: T) => number,
  now: number,
): DayOperationalCounts {
  let completed = 0;
  let remaining = 0;
  let inProgress = 0;
  let awaitingResults = 0;
  let walkovers = 0;
  let latestFinishMs: number | null = null;

  for (const match of matches) {
    if (DECIDED.has(match.status)) {
      completed += 1;
      if (match.status === "walkover") walkovers += 1;
      continue;
    }
    if (match.status === "void") continue;

    // Anything neither decided nor void is work the day still owes.
    remaining += 1;
    if (match.status === "in-progress") inProgress += 1;

    const end = expectedEndMs(match, slotMinutesFor);
    if (end == null) continue;
    if (end <= now) awaitingResults += 1;
    latestFinishMs = latestFinishMs == null ? end : Math.max(latestFinishMs, end);
  }

  return { completed, remaining, inProgress, awaitingResults, walkovers, latestFinishMs };
}
