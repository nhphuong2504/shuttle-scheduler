/**
 * The one place that turns a schedule's finish and a day's schedule status into words.
 *
 * Both are statements about the plan and never predictions. A finish is the latest end among
 * matches that already have a time; a day's status compares that day's latest scheduled finish
 * against that day's own configured close. Nothing here forecasts work that has not been
 * created, because no such estimate exists in this app.
 *
 *   * `scheduledFinishWording` is the **organizer's** tournament-wide summary. It is the only
 *     finish wording the Schedule tab renders, and the Desk renders none of it: a
 *     tournament-wide figure is planning oversight, not a live operational metric.
 *   * `dayScheduleWording` is the **moderator's** answer to "how is *this day* laid out?".
 *
 * Both live here so no surface can invent a second phrasing of the same number.
 */

import { dateTimeLabel } from "./format";

const MINUTE = 60_000;

export interface ScheduledFinishWording {
  /** The latest scheduled end, e.g. "Latest scheduled finish Sat, Sep 19, 16:19". */
  finish: string;
  /** The official close of the tournament, e.g. "Official close Tue, Oct 6, 11:00". */
  close: string | null;
  /** The past-close warning, or null when the scheduled matches fit inside the window. */
  warning: string | null;
  tone: "normal" | "warn";
}

/**
 * The organizer's schedule summary.
 *
 * `finishMs` is the latest end among matches that already have a court and a time, and it is
 * reported as a fact about the schedule rather than as an estimate of when the event will end.
 * `closeMs` is the official close — the end of the last configured day that has courts.
 */
export function scheduledFinishWording(input: {
  /** Latest scheduled end among matches still to play, or null when none have a time. */
  finishMs: number | null;
  /** The official close, or null when no configured day has a usable window. */
  closeMs: number | null;
}): ScheduledFinishWording {
  const finish =
    input.finishMs == null
      ? "No matches left to play"
      : `Latest scheduled finish ${dateTimeLabel(input.finishMs)}`;
  const close = input.closeMs == null ? null : `Official close ${dateTimeLabel(input.closeMs)}`;

  const overrunMinutes =
    input.finishMs == null || input.closeMs == null
      ? 0
      : Math.round((input.finishMs - input.closeMs) / MINUTE);

  if (overrunMinutes <= 0) return { finish, close, warning: null, tone: "normal" };
  return { finish, close, warning: `${overrunMinutes} min past the close`, tone: "warn" };
}

export interface DayScheduleWording {
  /** The day's latest scheduled finish, e.g. "Last match scheduled to finish 18:20". */
  latestFinish: string;
  /** The day's configured close, e.g. "Day closes 17:30". */
  closingTime: string;
  /** The day-overrun warning, or null when the plan fits inside the day. */
  warning: string | null;
  tone: "normal" | "warn";
}

/**
 * A single tournament day's schedule status.
 *
 * Both inputs are plan facts: the latest finish among matches that already have a time,
 * and the day's own configured close. Nothing here predicts when the day will end.
 */
export function dayScheduleWording(input: {
  /** Latest scheduled or in-progress finish on the day, or null when nothing is left. */
  latestFinishMs: number | null;
  /** The day's configured closing time, or null when the day has no usable window. */
  closeMs: number | null;
}): DayScheduleWording {
  const latestFinish =
    input.latestFinishMs == null
      ? "No matches left on the schedule"
      : `Last match scheduled to finish ${dateTimeLabel(input.latestFinishMs)}`;
  const closingTime =
    input.closeMs == null
      ? "No closing time configured"
      : `Day closes ${dateTimeLabel(input.closeMs)}`;

  if (
    input.latestFinishMs == null ||
    input.closeMs == null ||
    input.latestFinishMs <= input.closeMs
  ) {
    return { latestFinish, closingTime, warning: null, tone: "normal" };
  }

  const minutes = Math.round((input.latestFinishMs - input.closeMs) / MINUTE);
  return {
    latestFinish,
    closingTime,
    warning: `Scheduled ${minutes} min past the day's close`,
    tone: "warn",
  };
}
