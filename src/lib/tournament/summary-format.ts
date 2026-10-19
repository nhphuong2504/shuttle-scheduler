/**
 * How a `tournament_summary` row reads, in words.
 *
 * The card in a list and the page about one tournament draw the same facts - the range, the
 * counts, the venue - and they must read them the same way, or the tournament a person
 * clicked describes itself differently from the tournament they arrived at. So the three
 * formatters live here rather than in either surface, and both import them.
 *
 * Nothing here decides anything. Every value is a rendering of what the row already says,
 * which is why these are plain functions and not reads.
 */

/**
 * One instant, with the zone it is being shown in.
 *
 * The timezone abbreviation is printed rather than left implicit, and that is the point of
 * using the browser's own zone here. The summary deliberately carries no venue timezone -
 * it is a public shape, and the zone is configuration - so the honest thing is to say which
 * zone the times are being shown in rather than to present a bare local time as if it were
 * the venue's. A reader in another zone sees the abbreviation and knows.
 *
 * Components rather than `dateStyle`/`timeStyle`, because `dateStyle` may not be combined
 * with `timeZoneName` - the pair throws, and the throw happens while rendering.
 */
export function instantText(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

/**
 * The last instant a tournament window includes.
 *
 * `tournament_ends_at` is the *exclusive* end of the window - midnight after `ends_on`, which
 * is the boundary a `[start, end)` range needs for filtering. Printing it as a day turns every
 * one-day tournament into a two-day range: a window of 19 Oct to 19 Oct ends at 20 Oct 00:00,
 * so a card read "Oct 19 – 20" and a host saw a date they never chose. The last instant that
 * is actually inside the window is one millisecond earlier.
 *
 * Only a midnight is treated this way. Any other end instant is already inclusive - the
 * playing-day span (`tournament_play_ends_at`) ends at the venue's closing time - and is left
 * exactly as the row says.
 */
function windowEnd(value: string): Date {
  const end = new Date(value);
  const midnight =
    end.getHours() === 0 &&
    end.getMinutes() === 0 &&
    end.getSeconds() === 0 &&
    end.getMilliseconds() === 0;
  return midnight ? new Date(end.getTime() - 1) : end;
}

/**
 * The start and end instants as one readable range.
 *
 * An em dash rather than a blank when there are no playing days yet: an upcoming tournament
 * legitimately has none, and an empty line reads as a rendering fault rather than as a
 * state. A range that begins and ends on the same day prints the start's full instant and
 * then only the end's time, because repeating the date is noise.
 */
export function dateRangeText(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt) return "No playing days yet";
  const start = instantText(startsAt);
  if (!endsAt) return `Starts ${start}`;

  const end = windowEnd(endsAt);
  const sameDay = end.toDateString() === new Date(startsAt).toDateString();
  const endText = sameDay
    ? new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(end)
    : instantText(end.toISOString());
  return `${start} → ${endText}`;
}

/** "1 entry" and "2 entries", because "1 entries" is the kind of detail a host notices. */
export function countText(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * The days a tournament covers, without the clock: "Oct 4", or "Oct 4 – 5", or "Oct 30 – Nov 2".
 *
 * The line under a tournament's name wants *when*, not the hour it opens, and the zone
 * abbreviation that `dateRangeText` prints beside every time is noise on a line that has no
 * times. Both ends are read in the reader's own zone, as every other date on the page is, and
 * the window's exclusive midnight end is read as the day it closes (`windowEnd`), so a
 * one-day tournament prints one date rather than two.
 */
export function shortDays(startsAt: string | null, endsAt: string | null): string | null {
  if (!startsAt) return null;
  const month = new Intl.DateTimeFormat(undefined, { month: "short" });
  const start = new Date(startsAt);
  const end = endsAt ? windowEnd(endsAt) : start;
  const from = `${month.format(start)} ${start.getDate()}`;
  if (end.toDateString() === start.toDateString()) return from;
  const to =
    month.format(end) === month.format(start)
      ? String(end.getDate())
      : `${month.format(end)} ${end.getDate()}`;
  return `${from} – ${to}`;
}
