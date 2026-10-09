/**
 * Calendar dates as `YYYY-MM-DD` strings, and nothing else.
 *
 * A tournament's window and its playing days are dates in the venue's timezone, not instants.
 * Parsing one with `new Date("2026-10-20")` reads it as UTC midnight, which is the previous day
 * everywhere west of Greenwich, so every helper here reads and writes UTC and never touches the
 * viewer's own zone. They also never throw on a bad string: an unreadable date stays blank.
 */

/** Adds whole days to a `YYYY-MM-DD` string. Blank if the input is not a date. */
export function shiftIsoDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Inclusive day count between two `YYYY-MM-DD` strings; at least 1 for a real range. */
export function countIsoDays(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

/** Every date from `start` to `end`, inclusive. Empty if either is unreadable or they are backwards. */
export function isoDatesBetween(start: string, end: string): string[] {
  const count = countIsoDays(start, end);
  if (!Number.isFinite(count) || count < 1) return [];
  return Array.from({ length: count }, (_, index) => shiftIsoDate(start, index));
}

/** "October 2030" for a date's month. */
export function monthLabel(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}

/** "Sat, Oct 26" for a date. */
export function shortDateLabel(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}
