import { Link } from "@tanstack/react-router";
import { type ReactNode } from "react";

import { RegistrationStatePill, TournamentStatusPill } from "@/components/app-shell";
import type { TournamentSummary } from "@/lib/tournament/data";
import { countText, dateRangeText } from "@/lib/tournament/summary-format";

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
 * The destination defaults to the tournament's own page - the participant surface at
 * `/tournaments/:id`. A page whose reader is there to *read* the tournament overrides it:
 * Explore opens a card on the read-only workspace at `…/entries`, which is the first of the
 * five sections a reader without the edit right is offered. An operator reading the same card
 * still reaches the desk from the workspace nav or from My Tournaments' own "work in this
 * one", so nothing is lost by a page choosing the reading it wants.
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
  to = "/tournaments/$tournamentId",
}: {
  summary: TournamentSummary;
  /** Page-specific controls, rendered in the footer beside the window pill. */
  actions?: ReactNode;
  /** One line under the counts for something the page knows and the summary does not. */
  footnote?: ReactNode;
  /**
   * Where the title links, for a page that sends the card somewhere other than the
   * tournament's public page. Explore points it at the read-only workspace; every other
   * caller keeps the default.
   */
  to?: "/tournaments/$tournamentId" | "/tournaments/$tournamentId/entries";
}) {
  return (
    <article className="flex h-full min-w-0 flex-col gap-3 rounded-xl border border-hairline bg-surface p-4 shadow-panel transition-shadow hover:shadow-raise">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 font-display text-sm font-semibold">
          <Link
            to={to}
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
      <ul className="space-y-1 text-sm text-muted-foreground">
        {/* When, then where, then how big - the order a reader asks them, and the order
            `ExploreCard` uses. The two cards answer different questions ("what is there to
            work on" and "what is mine") but they describe the *same* tournament, so the
            order is part of the shape they share rather than each card's own choice.

            Both values come from `summary-format.ts`, which exists so these two cards cannot
            disagree. They used to be re-implemented here; the em dash rather than a blank
            when a tournament has no playing days is that module's decision, not this card's. */}
        <li className="truncate">{dateRangeText(summary.starts_at, summary.ends_at)}</li>
        <li className="truncate">{summary.venue_name || "Venue not set"}</li>
        <li className="truncate">
          {countText(summary.entry_count, "entry", "entries")} ·{" "}
          {countText(summary.category_count, "event", "events")}
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
