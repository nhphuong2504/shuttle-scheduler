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

  const end = new Date(endsAt);
  const sameDay = end.toDateString() === new Date(startsAt).toDateString();
  const endText = sameDay
    ? new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(end)
    : instantText(endsAt);
  return `${start} → ${endText}`;
}

/** "1 entry" and "2 entries", because "1 entries" is the kind of detail a host notices. */
export function countText(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}
