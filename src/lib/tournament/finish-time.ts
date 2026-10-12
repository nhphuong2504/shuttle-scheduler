/**
 * "When did it finish?" as a time of day, turned into the minutes-ago the RPCs take.
 *
 * The placement and knockout report RPCs accept an offset in minutes, so the screen keeps
 * that contract and only changes how a person states it: people remember a clock time, not a
 * subtraction. Both sides of the subtraction are read in the venue's timezone when one is
 * known, so a moderator on a laptop set to another zone still reads the wall clock they see.
 *
 * Working in minutes since midnight in that zone, rather than building a Date from a local
 * string, is what keeps this correct across a daylight-saving change and independent of the
 * device's own offset.
 */

/** Minutes since midnight of `date`, as read on the wall clock of `timezone`. */
function minutesOfDay(date: Date, timezone?: string): number {
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  };
  if (timezone) options.timeZone = timezone;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", options).formatToParts(date);
  } catch {
    // An unknown zone name: fall back to the device clock rather than refuse to answer.
    parts = new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(date);
  }
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

/** How far a time later than "now" is forgiven as clock drift between two devices. */
const CLOCK_DRIFT_MINUTES = 3;

/**
 * Minutes between an `HH:MM` entry and `now`, or `null` when it is not a time.
 *
 * An entry a little *after* now is read as "just now" (two clocks disagreeing by a minute is
 * not a result from the future). Anything later than that is read as yesterday's time, which
 * comes out as a very large offset that the caller's maximum then refuses, rather than being
 * silently accepted.
 */
export function minutesAgoFromClock(
  clock: string,
  now: Date,
  timezone?: string,
): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const diff = minutesOfDay(now, timezone) - (hour * 60 + minute);
  if (diff >= 0) return diff;
  if (diff >= -CLOCK_DRIFT_MINUTES) return 0;
  return diff + 24 * 60;
}

/** The `HH:MM` that was `minutesAgo` minutes before `now`, on the venue's wall clock. */
export function clockFromMinutesAgo(
  minutesAgo: number,
  now: Date,
  timezone?: string,
): string {
  const total = (((minutesOfDay(now, timezone) - minutesAgo) % 1440) + 1440) % 1440;
  const hour = String(Math.floor(total / 60)).padStart(2, "0");
  const minute = String(total % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}
