/**
 * The shared rendering of a schedule's finish and a day's schedule status.
 *
 * `ScheduledFinish` is the organizer's summary on the Schedule tab: the latest end among
 * matches that already have a time, measured against the tournament's official close. It is a
 * fact about the schedule, not an estimate of when the event will end, and it never predicts
 * work that has not been created.
 *
 * `DayScheduleStatus` is the moderator's day-scoped counterpart on the Desk. The two are
 * separate components so they can never be conflated: one reports the whole tournament's
 * schedule, the other the selected day's.
 *
 * The wording lives in `finish-wording.ts`; this file only lays it out.
 */

import { dayScheduleWording, scheduledFinishWording } from "@/lib/tournament/finish-wording";

interface ScheduledFinishProps {
  /** Latest scheduled end among matches still to play, or null when none have a time. */
  finishMs: number | null;
  /** The official close, so the finish can be measured against what it must fit inside. */
  closeMs?: number | null | undefined;
}

export function ScheduledFinish({ finishMs, closeMs = null }: ScheduledFinishProps) {
  const wording = scheduledFinishWording({ finishMs, closeMs });

  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span className="font-semibold text-foreground">
        {wording.finish}
        {wording.close ? ";" : ""}
      </span>
      {wording.close ? (
        <span className="text-muted-foreground">
          {wording.close}
          {wording.warning ? ";" : ""}
        </span>
      ) : null}
      {wording.warning ? <span className="text-warn-foreground">{wording.warning}</span> : null}
    </span>
  );
}

/**
 * A single day's schedule status, as the Desk reads it.
 *
 * Both values are plan facts about the selected day. It never predicts when the day will
 * actually end.
 */
export function DayScheduleStatus({
  latestFinishMs,
  closeMs,
}: {
  latestFinishMs: number | null;
  closeMs: number | null;
}) {
  const wording = dayScheduleWording({ latestFinishMs, closeMs });
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span className="text-muted-foreground">
        {wording.latestFinish}
        {wording.closingTime ? ";" : ""}
      </span>
      <span className="text-muted-foreground">
        {wording.closingTime}
        {wording.warning ? ";" : ""}
      </span>
      {wording.warning ? (
        <span className="font-semibold text-warn-foreground">{wording.warning}</span>
      ) : null}
    </span>
  );
}
