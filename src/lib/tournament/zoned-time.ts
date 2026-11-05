/**
 * Wall-clock time in a named timezone, and the absolute instant it names.
 *
 * A tournament's times mean something at its venue: "registration closes at 23:59" is 23:59
 * where the courts are, not where the host happens to be typing. The browser's own zone is
 * therefore the wrong one to use for any of it, and `datetime-local` inputs deal in
 * wall-clock strings with no zone at all. These helpers do the one conversion that matters -
 * a `YYYY-MM-DDTHH:mm` string read in the venue's zone, to the instant the database stores,
 * and back - using only `Intl`, so there is no timezone library to carry.
 *
 * A wall-clock string is compared as text elsewhere (it sorts chronologically within one
 * zone), so conversion to an instant is needed only at the edge: when saving, and when
 * showing a stored instant.
 */

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Whether the runtime knows this IANA zone. */
export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  const known = zoneValidity.get(zone);
  if (known !== undefined) return known;
  let valid: boolean;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    valid = true;
  } catch {
    valid = false;
  }
  zoneValidity.set(zone, valid);
  return valid;
}
const zoneValidity = new Map<string, boolean>();

/**
 * One formatter per zone. The planners convert a day's window inside their placement loops,
 * and building an `Intl.DateTimeFormat` costs far more than using one.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
function wallFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** How far ahead of UTC the zone's clocks are at this instant, in milliseconds. */
function offsetAt(zone: string, utcMs: number): number {
  const parts = wallFormatter(zone).formatToParts(new Date(utcMs));
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  const wallAsUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The instant a wall-clock string names in a zone, as an ISO string. Null if the string is
 * not `YYYY-MM-DDTHH:mm` or the zone is unknown.
 *
 * The offset is measured twice: once at the naive guess and once at the corrected instant.
 * Around a daylight-saving change the first measurement can be on the wrong side of it, and
 * the second settles it. A wall-clock time that does not exist (the hour skipped in spring)
 * resolves to the instant just after the gap.
 */
export function zonedToInstant(local: string, zone: string): string | null {
  const match = LOCAL.exec(local);
  if (!match || !isValidTimeZone(zone)) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - offsetAt(zone, guess);
  const settled = guess - offsetAt(zone, utc);
  if (settled !== utc) utc = settled;
  return new Date(utc).toISOString();
}

/** The wall-clock string a stored instant shows in a zone, as `YYYY-MM-DDTHH:mm`. */
export function instantToZoned(iso: string, zone: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || !isValidTimeZone(zone)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(ms));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** Now, as a wall-clock string in the zone. */
export function nowInZone(zone: string, now: Date = new Date()): string | null {
  return instantToZoned(now.toISOString(), zone);
}

/** 00:00 of a `YYYY-MM-DD` date in the zone: the instant a tournament window opens. */
export function startOfDayInstant(date: string, zone: string): string | null {
  return zonedToInstant(`${date}T00:00`, zone);
}

const WALL_TIME = /^(\d{2}):(\d{2})(?::(\d{2}))?/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * The instant a day's wall-clock time names at the venue, in epoch milliseconds.
 *
 * This is how the database reads `date + start_time` (`AT TIME ZONE venue_timezone`), and the
 * planners must read it the same way: in the browser's own zone a host working away from the
 * venue - or a server on UTC - would place every match hours off the window the server checks.
 * The time may carry seconds (`09:00:00`, as Postgres returns a `time`). An unknown zone falls
 * back to UTC rather than to the process's zone, so a bad value fails the same way everywhere.
 */
export function wallClockMs(date: string, time: string, zone: string): number {
  const day = DATE.exec(date);
  const clock = WALL_TIME.exec(time);
  if (!day || !clock) return Number.NaN;
  const [year, month, dayOfMonth] = day.slice(1).map(Number) as [number, number, number];
  const [hour, minute] = [Number(clock[1]), Number(clock[2])];
  const second = Number(clock[3] ?? 0);
  const guess = Date.UTC(year, month - 1, dayOfMonth, hour, minute, second);
  if (!isValidTimeZone(zone)) return guess;
  let utc = guess - offsetAt(zone, guess);
  const settled = guess - offsetAt(zone, utc);
  if (settled !== utc) utc = settled;
  return utc;
}

/** The venue's calendar date at an instant, as `YYYY-MM-DD`. */
export function dateKeyInZone(ms: number, zone: string): string {
  const parts = wallFormatter(isValidTimeZone(zone) ? zone : "UTC").formatToParts(new Date(ms));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The zone a tournament's days are read in: its venue's, once the row has loaded.
 *
 * Until then there is no venue to ask, and nothing is drawn against a window either, so the
 * browser's own zone stands in - what every screen used before the venue's zone was honoured.
 */
export function venueZoneOf(
  tournament: { venue_timezone?: string | null } | null | undefined,
): string {
  const zone = tournament?.venue_timezone;
  if (zone && isValidTimeZone(zone)) return zone;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
