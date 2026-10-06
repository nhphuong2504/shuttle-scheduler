import { createFileRoute, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";

import { PublicShell } from "@/components/app-shell";
import { ExploreCard } from "@/components/explore-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/hooks/useSession";
import {
  normalizeTournamentStatus,
  type TournamentStatus,
} from "@/lib/auth/authorization";
import { signInSearch } from "@/lib/routing/redirect";
import { useExploreTournaments, type TournamentSummary } from "@/lib/tournament/data";

interface ExploreSearch {
  /** The search term, matched by the database over name, venue and events. */
  q?: string;
  /** The lifecycle word to filter on. */
  status?: TournamentStatus;
}

interface StatusOption {
  value: TournamentStatus | "all";
  label: string;
}

/**
 * The three lifecycle words, as a filter.
 *
 * "Any status" is a member of the group rather than the absence of a choice, because
 * "show me everything" and "I have not chosen yet" are the same intent here, and a cleared
 * group would read as an unanswered question. The order follows the groups below: what is
 * happening now comes first.
 */
const STATUS_OPTIONS: StatusOption[] = [
  { value: "all", label: "Any status" },
  { value: "in_progress", label: "In progress" },
  { value: "upcoming", label: "Upcoming" },
  { value: "completed", label: "Completed" },
];

/** The list is grouped in this order, so a live tournament is never buried under a past one. */
const GROUPS: { status: TournamentStatus; heading: string }[] = [
  { status: "in_progress", heading: "In progress" },
  { status: "upcoming", heading: "Upcoming" },
  { status: "completed", heading: "Completed" },
];

export const Route = createFileRoute("/explore")({
  validateSearch: (search: Record<string, unknown>): ExploreSearch => {
    const result: ExploreSearch = {};
    const query = search["q"];
    if (typeof query === "string" && query.trim().length > 0) result.q = query;
    // Validated rather than trusted: an unrecognised word is dropped, so the address
    // cannot describe a filter this page has no word for. The RPC validates it too, and
    // refusing it in both places is deliberate - a page must not send a request the
    // database will answer with an exception.
    if (
      search["status"] === "upcoming" ||
      search["status"] === "in_progress" ||
      search["status"] === "completed"
    ) {
      result.status = normalizeTournamentStatus(search["status"]);
    }
    return result;
  },
  head: () => ({
    meta: [
      { title: "Explore tournaments | Tournova Tournament Ops" },
      {
        name: "description",
        content: "Find a badminton tournament to follow or enter: who is playing, when and where.",
      },
      { property: "og:title", content: "Explore tournaments | Tournova Tournament Ops" },
      {
        property: "og:description",
        content: "Find a badminton tournament to follow or enter: who is playing, when and where.",
      },
      { property: "og:type", content: "website" },
      { property: "twitter:card", content: "summary" },
    ],
  }),
  component: ExplorePage,
});

/**
 * Browse and search, for anybody.
 *
 * This is the app's public front door for a caller who is not working in a tournament: it
 * is where the flat legacy addresses send somebody with no pointer, and it is the first
 * surface that answers "what is there" rather than "what is mine". It reads without a
 * session, on purpose - a person deciding whether to enter an event should be able to see
 * it before creating an account, and `tournament_summary` returns nothing the anonymous
 * desk view does not already show.
 *
 * ## Why the filters live in the URL
 *
 * A search is a thing people share: "these are the open tournaments" arrives as a link. So
 * the term and the status go into the address as they change, and they are `replace`d
 * rather than pushed, because a search box that adds a history entry per keystroke makes
 * the back button walk backwards through somebody's typing.
 */
function ExplorePage() {
  const { q, status } = Route.useSearch();
  const navigate = useNavigate();
  const { signedIn } = useSession();
  /**
   * This page's own address, for the sign-in links.
   *
   * It carries the filter, and that is the whole point of reading it here rather than
   * hard-coding `/explore`: somebody who signs in from a search result has to come back to
   * the search they ran, not to an unfiltered list they then have to repeat.
   */
  const href = useLocation({ select: (location) => location.href });

  const query = q ?? "";
  const statusFilter = status ?? null;
  const summaries = useExploreTournaments({ query, status: statusFilter });

  /**
   * Writes the filter into the address.
   *
   * An empty term is removed rather than stored as `q=`, so "no filter" has exactly one
   * spelling: two spellings of the same search would be two cache entries and two URLs for
   * one page.
   */
  const setSearch = (next: { q?: string; status?: TournamentStatus | null }) => {
    const term = next.q?.trim();
    void navigate({
      to: "/explore",
      search: { ...(term ? { q: term } : {}), ...(next.status ? { status: next.status } : {}) },
      replace: true,
    });
  };

  const rows = summaries.data ?? [];
  const filtered = query.trim().length > 0 || statusFilter !== null;
  const groups = GROUPS.map((group) => ({
    ...group,
    rows: rows.filter((row) => row.status === group.status),
  })).filter((group) => group.rows.length > 0);

  return (
    <PublicShell
      title="Explore tournaments"
      subtitle="Open a tournament to see who is playing, when and where, and the scores as they come in."
      actions={
        signedIn ? (
          <Button asChild>
            <Link to="/tournaments/new">New tournament</Link>
          </Button>
        ) : undefined
      }
    >
      <div className="mb-8 grid gap-4 sm:grid-cols-[minmax(0,24rem)_1fr] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="explore-search">Search</Label>
          <Input
            id="explore-search"
            value={query}
            placeholder="Name, venue or event"
            onChange={(event) => setSearch({ q: event.target.value, status: statusFilter })}
          />
        </div>
        {/*
          A group of pressed buttons rather than a select, because all four options are
          visible at once and the current one answers "what am I looking at" - which is a
          state, not a menu. `aria-pressed` describes it accurately; a radio role would
          imply a value awaiting submission.

          The tick is the redundant channel, and a filter row is where it matters most:
          four chips sit in a row and only one is pressed, so a fill alone asks a reader to
          compare four shapes and remember which colour meant "on". The tick states it
          locally, which is the same rule the rest of the system follows - every state
          carries a word and a glyph, never colour alone. It is `aria-hidden`, so the
          button's accessible name stays exactly the label rather than becoming
          "tick Upcoming".

          It costs 22px of width on the pressed chip (16px glyph + the gap), so pressing one
          nudges its neighbours. That is accepted rather than overlooked: reserving the slot
          on every chip would make the row ~88px wider at all times and buy a second wrap line
          on a phone, and the chip that grows is the one under the pointer - the pointer does
          not leave the control it just pressed.
        */}
        <div
          role="group"
          aria-label="Filter by status"
          className="flex flex-wrap items-center gap-2 sm:justify-end"
        >
          {STATUS_OPTIONS.map((option) => {
            const selected = option.value === "all" ? !statusFilter : statusFilter === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  setSearch({
                    q: query,
                    status: option.value === "all" ? null : option.value,
                  })
                }
                className={
                  selected
                    ? "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-primary bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
                    : "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border-control bg-surface px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
                }
              >
                {selected ? <Check aria-hidden="true" className="size-4 shrink-0" /> : null}
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {summaries.isLoading ? (
        <LoadingList />
      ) : summaries.isError ? (
        <div role="alert" className="rounded-xl border border-danger-border bg-danger-surface p-6">
          <h2 className="font-display text-xl font-bold text-danger-foreground">
            Couldn't load tournaments
          </h2>
          <p className="mt-2 max-w-xl text-base">
            {summaries.error instanceof Error && summaries.error.message
              ? summaries.error.message
              : "Your connection may have dropped. Try again in a moment."}
          </p>
          <Button variant="outline" className="mt-4" onClick={() => void summaries.refetch()}>
            Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-hairline bg-surface px-6 py-10 text-center shadow-panel">
          {filtered ? (
            <>
              <h2 className="font-display text-xl font-bold">No tournament matches that search</h2>
              <p className="mx-auto mt-2 max-w-md text-base text-muted-foreground">
                Check the spelling, or clear the filters to see everything.
              </p>
              <Button className="mt-5" onClick={() => setSearch({})}>
                Clear filters
              </Button>
            </>
          ) : (
            <>
              <h2 className="font-display text-xl font-bold">No tournaments yet</h2>
              <p className="mx-auto mt-2 max-w-md text-base text-muted-foreground">
                {signedIn
                  ? "Nothing has been created on Tournova yet. Yours would be the first."
                  : "Tournaments appear here as soon as an organiser creates one."}
              </p>
              {signedIn ? (
                <div className="mt-5 flex justify-center">
                  <Button asChild>
                    <Link to="/tournaments/new">New tournament</Link>
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-10">
          {/*
            The count is announced rather than only drawn, because the groups below change
            without the page moving: a reader on a screen reader would otherwise get no
            signal that a keystroke did anything.
          */}
          <p aria-live="polite" className="font-score text-sm tabular-nums text-muted-foreground">
            {rows.length} tournament{rows.length === 1 ? "" : "s"}
          </p>
          {groups.map((group) => (
            <GroupSection key={group.status} heading={group.heading} rows={group.rows} signedIn={signedIn} />
          ))}
        </div>
      )}
    </PublicShell>
  );
}

function GroupSection({
  heading,
  rows,
  signedIn,
}: {
  heading: string;
  rows: TournamentSummary[];
  /** Passed down rather than re-read per card; see `ExploreCard`. */
  signedIn: boolean;
}) {
  return (
    <section aria-label={heading}>
      <h2 className="mb-4 flex items-baseline gap-2 font-display text-xl font-bold">
        {heading}
        <span className="font-body text-base font-medium text-muted-foreground tabular-nums">
          {rows.length}
        </span>
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2">
        {rows.map((summary) => (
          <li key={summary.id} className="min-w-0">
            {/*
              Opened on Entries rather than on the participant page: this is the surface
              for reading a tournament, so a card leads into the read-only workspace - the
              five sections a viewer is offered, the first of which is Entries.

              Registering is the one exception, and it is drawn inside the card rather than
              here, because it is gated on the window and on the session while the reading
              trip is neither. See `ExploreCard`.
            */}
            <ExploreCard summary={summary} signedIn={signedIn} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Placeholders in the shape of the cards, so the page does not jump when the list arrives.
 */
function LoadingList() {
  return (
    <div role="status" aria-label="Loading tournaments" className="grid gap-4 sm:grid-cols-2">
      {[0, 1].map((key) => (
        <div
          key={key}
          aria-hidden="true"
          className="space-y-3 rounded-xl border border-hairline bg-surface p-5"
        >
          <div className="h-6 w-24 rounded-full bg-muted" />
          <div className="h-8 w-3/4 rounded-md bg-muted" />
          <div className="h-4 w-1/2 rounded bg-muted" />
          <div className="h-4 w-2/3 rounded bg-muted" />
          <div className="h-11 w-40 rounded-lg bg-muted" />
        </div>
      ))}
    </div>
  );
}
