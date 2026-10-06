import { createFileRoute, Link, useLocation, useNavigate } from "@tanstack/react-router";

import { EmptyState, Panel, PublicShell } from "@/components/app-shell";
import { TournamentCard } from "@/components/tournament-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/hooks/useSession";
import {
  normalizeTournamentStatus,
  type TournamentStatus,
} from "@/lib/auth/authorization";
import { signInSearch } from "@/lib/routing/redirect";
import { useExploreTournaments } from "@/lib/tournament/data";

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
 * group would read as an unanswered question.
 */
const STATUS_OPTIONS: StatusOption[] = [
  { value: "all", label: "Any status" },
  { value: "upcoming", label: "Upcoming" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
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
        content: "Find a badminton tournament to follow or enter, or start one of your own.",
      },
      { property: "og:title", content: "Explore tournaments | Tournova Tournament Ops" },
      {
        property: "og:description",
        content: "Find a badminton tournament to follow or enter, or start one of your own.",
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

  return (
    <PublicShell
      title="Explore tournaments"
      subtitle="Every tournament on Tournova. Open one to follow it, or start your own."
      actions={
        signedIn ? (
          <Button size="sm" asChild>
            <Link to="/tournaments/new">New tournament</Link>
          </Button>
        ) : (
          <Button size="sm" asChild>
            <Link to="/auth" search={signInSearch(href)}>
              Sign in
            </Link>
          </Button>
        )
      }
    >
      <Panel className="mb-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="explore-search">Search</Label>
            <Input
              id="explore-search"
              value={query}
              placeholder="Tournament, venue or event"
              onChange={(event) => setSearch({ q: event.target.value, status: statusFilter })}
            />
          </div>
          {/*
            A group of pressed buttons rather than a select, because all four options are
            visible at once and the current one answers "what am I looking at" - which is a
            state, not a menu. `aria-pressed` describes it accurately; a radio role would
            imply a value awaiting submission.
          */}
          <div
            role="group"
            aria-label="Filter by status"
            className="flex flex-wrap items-center gap-1"
          >
            {STATUS_OPTIONS.map((option) => {
              const selected =
                option.value === "all" ? !statusFilter : statusFilter === option.value;
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
                      ? "rounded-full bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground shadow-panel"
                      : "rounded-full border border-input bg-surface px-3 py-1.5 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  }
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      </Panel>

      {summaries.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading tournaments…</p>
      ) : summaries.isError ? (
        <Panel title="Could not read tournaments">
          <p className="text-sm text-muted-foreground">
            {summaries.error instanceof Error
              ? summaries.error.message
              : "The tournament read failed. Try again in a moment."}
          </p>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          {filtered ? (
            <EmptyState
              title="No tournament matches that search"
              hint="Try a shorter term, or clear the status filter to widen it."
              action={
                <Button size="sm" variant="outline" onClick={() => setSearch({})}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No tournaments yet"
              hint={
                signedIn
                  ? "Nothing has been created on Tournova yet. Yours would be the first."
                  : "Nothing has been created on Tournova yet. Sign in to create the first one."
              }
              action={
                signedIn ? (
                  <Button size="sm" asChild>
                    <Link to="/tournaments/new">New tournament</Link>
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link to="/auth" search={signInSearch(href)}>
                      Sign in
                    </Link>
                  </Button>
                )
              }
            />
          )}
        </Panel>
      ) : (
        <>
          {/*
            The count is announced rather than only drawn, because the grid below changes
            without the page moving: a reader on a screen reader would otherwise get no
            signal that a keystroke did anything.
          */}
          <p aria-live="polite" className="mb-3 font-score text-sm text-muted-foreground">
            {rows.length} tournament{rows.length === 1 ? "" : "s"}
          </p>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((summary) => (
              <li key={summary.id} className="min-w-0">
                {/*
                  Opened on Entries rather than on the participant page: this is the surface
                  for reading a tournament, so a card leads into the read-only workspace -
                  the five sections a viewer is offered, the first of which is Entries.
                */}
                <TournamentCard summary={summary} to="/tournaments/$tournamentId/entries" />
              </li>
            ))}
          </ul>
        </>
      )}
    </PublicShell>
  );
}
