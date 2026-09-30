import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";

import { RegistrationStatePill, TournamentStatusPill } from "@/components/app-shell";
import type { TournamentSummary } from "@/lib/tournament/data";

/**
 * One tournament, as a card.
 *
 * Explore and My Tournaments ask different questions of the same rows - "what is there to
 * work on" and "what is mine" - and they must answer the *shape* question identically, or
 * the same tournament reads as two different tournaments depending on which page a person
 * opened. So the identity, the lifecycle, the window and the counts are drawn here once,
 * and each page contributes only the actions it needs in the footer.
 *
 * ## Every fact comes from one row
 *
 * Nothing here is derived in the browser. The status, the registration window, the entry
 * and event counts, and the start and end instants all arrive from `tournament_summary`,
 * which computes them from the same predicates the write paths consult. That is the whole
 * reason the read exists: a card that derived "not ready" from a client-side rule and
 * disagreed with the RPC that refused a start would be worse than no card.
 *
 * ## Why the title is the link
 *
 * The card answers "which tournament is this", so the name is the anchor and the whole
 * card is not. A card-sized click target swallows the footer's own buttons on a touch
 * screen, and a link whose text is a whole paragraph tells a screen reader nothing.
 *
 * The destination is the tournament's Desk, which is the surface a visitor can actually
 * read today. S10 adds the participant-facing public tournament page at
 * `/tournaments/:id` and this becomes the link to it.
 *
 * ## Why the card is `min-w-0`, and why its facts are a plain list
 *
 * Every value here truncates, and `truncate` is `white-space: nowrap` with a hidden
 * overflow. A `nowrap` string that cannot fit still contributes its *whole* width to the
 * min-content size of everything above it, so a grid item holding this card is as wide as
 * the longest date range nobody can read - which is exactly how `/explore` scrolled the page
 * sideways by 29px at a 320px viewport. The automatic minimum size of a grid or flex item is
 * what lets that happen, so it is disabled where it applies: the card owns `min-w-0`, and so
 * does each list the card is placed in (`/explore`, `/me/tournaments`). The facts themselves
 * are a plain block list rather than a `grid` for the same reason - a grid inside the card
 * would put the same automatic minimum between the text and its box - and that is a
 * structural property, not an incidental one.
 */
export function TournamentCard({
  summary,
  actions,
  footnote,
}: {
  summary: TournamentSummary;
  /** Page-specific controls, rendered in the footer beside the window pill. */
  actions?: ReactNode;
  /** One line under the counts for something the page knows and the summary does not. */
  footnote?: ReactNode;
}) {
  return (
    <article className="flex h-full min-w-0 flex-col gap-3 rounded-xl border border-hairline bg-surface p-4 shadow-panel transition-shadow hover:shadow-raise">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 font-display text-sm font-semibold">
          <Link
            to="/tournaments/$tournamentId/desk"
            params={{ tournamentId: summary.id }}
            className="block truncate rounded-sm hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {summary.name}
          </Link>
        </h2>
        <TournamentStatusPill status={summary.status} />
      </div>

      {/*
        The facts are a list, not a definition list.

        A `dl` wants a term for each value, and the card is too narrow to draw one: a label
        column wide enough for "Entries and events" takes the room the date range needs, and
        hiding the term instead - which is what this did first, with `sr-only` - the layout
        matrix rejects, correctly, because visually hidden text is still laid out, still
        clipped and still unreadable on screen. So each value carries its own meaning: the
        counts say "entries" and "events", the range is a date and a time, and the venue is
        the one place name on the card. Nothing is drawn that only a screen reader can hear,
        and no reader is given a term the value already implies.
      */}
      <ul className="space-y-1 text-xs text-muted-foreground">
        <li className="truncate">{summary.venue_name || "Venue not set"}</li>
        {/* An em dash rather than a blank when there are no playing days yet: an upcoming
            tournament legitimately has none, and an empty line reads as a rendering fault
            rather than as a state. */}
        <li className="truncate">{dateRange(summary.starts_at, summary.ends_at)}</li>
        <li className="truncate">
          {count(summary.entry_count, "entry", "entries")} ·{" "}
          {count(summary.category_count, "event", "events")}
        </li>
        {footnote ? <li className="truncate">{footnote}</li> : null}
      </ul>

      <div className="mt-auto flex flex-wrap items-center gap-2">
        <RegistrationStatePill state={summary.registration_state} />
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </article>
  );
}

/**
 * The start and end instants as one readable range.
 *
 * The timezone abbreviation is printed rather than left implicit, and that is the point of
 * using the browser's own zone here. The summary deliberately carries no venue timezone -
 * it is a public shape, and the zone is configuration - so the honest thing is to say which
 * zone the times are being shown in rather than to present a bare local time as if it were
 * the venue's. A reader in another zone sees the abbreviation and knows.
 */
function dateRange(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt) return "No playing days yet";

  // Components rather than `dateStyle`/`timeStyle`, because `dateStyle` may not be combined
  // with `timeZoneName` - the pair throws, and the throw happens while rendering the card.
  // The zone abbreviation is the point: the summary deliberately carries no venue timezone,
  // so the honest thing is to say which zone these times are in rather than to present a
  // local time as if it were the venue's.
  const day = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const start = day.format(new Date(startsAt));
  if (!endsAt) return `Starts ${start}`;

  const end = new Date(endsAt);
  const startDay = new Date(startsAt).toDateString();
  const endText =
    end.toDateString() === startDay
      ? new Intl.DateTimeFormat(undefined, {
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(end)
      : day.format(end);
  return `${start} → ${endText}`;
}

/** "1 entry" and "2 entries", because "1 entries" is the kind of detail a host notices. */
function count(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}
