import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Check, X } from "lucide-react";

import { PublicShell } from "@/components/app-shell";
import { ExploreCard } from "@/components/explore-card";
import { CompletedList, ExploreRow, groupByMonth } from "@/components/explore-rows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/hooks/useSession";
import {
  normalizeTournamentStatus,
  type TournamentStatus,
} from "@/lib/auth/authorization";
import {
  EXPLORE_RANGES,
  EXPLORE_SORTS,
  useExploreCounts,
  useExploreSection,
  type ExploreFilters,
  type ExploreRange,
  type ExploreSort,
} from "@/lib/tournament/data";

const VIEWS = ["timeline", "cards"] as const;
type ExploreView = (typeof VIEWS)[number];

interface ExploreSearch {
  /** The search term, matched by the database over name, venue and events. */
  q?: string;
  /** The lifecycle word to filter on. */
  status?: TournamentStatus;
  /** Only tournaments whose registration is open. */
  reg?: true;
  /** Only tournaments playing within this window from now. */
  when?: ExploreRange;
  /** The order each group is read in. Absent is "soonest". */
  sort?: ExploreSort;
  /** How upcoming and finished tournaments are drawn. Absent is the timeline. */
  view?: "cards";
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

const RANGE_LABEL: Record<ExploreRange, string> = {
  week: "This week",
  month: "This month",
  quarter: "Next 3 months",
};

const SORT_LABEL: Record<ExploreSort, string> = {
  soonest: "Soonest first",
  newest: "Newest first",
  entries: "Most entries",
  name: "Name A to Z",
};

/** A page of a long group. Live events are few, and are read in one go. */
const PAGE_SIZE = 12;
const LIVE_LIMIT = 50;

export const Route = createFileRoute("/explore")({
  validateSearch: (search: Record<string, unknown>): ExploreSearch => {
    const result: ExploreSearch = {};
    const query = search["q"];
    if (typeof query === "string" && query.trim().length > 0) result.q = query;
    // Every value is validated rather than trusted: an unrecognised word is dropped, so the
    // address cannot describe a filter this page has no word for. The RPC validates them too,
    // and refusing them in both places is deliberate - a page must not send a request the
    // database will answer with an exception.
    if (
      search["status"] === "upcoming" ||
      search["status"] === "in_progress" ||
      search["status"] === "completed"
    ) {
      result.status = normalizeTournamentStatus(search["status"]);
    }
    if (search["reg"] === true || search["reg"] === "1" || search["reg"] === "true") {
      result.reg = true;
    }
    const when = search["when"];
    if (typeof when === "string" && (EXPLORE_RANGES as readonly string[]).includes(when)) {
      result.when = when as ExploreRange;
    }
    const sort = search["sort"];
    if (
      typeof sort === "string" &&
      sort !== "soonest" &&
      (EXPLORE_SORTS as readonly string[]).includes(sort)
    ) {
      result.sort = sort as ExploreSort;
    }
    if (search["view"] === "cards") result.view = "cards";
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

const CONTROL_CLASS =
  "h-11 w-full rounded-[10px] border border-input bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Browse and search, for anybody.
 *
 * This is the app's public front door for a caller who is not working in a tournament: it
 * is where the flat legacy addresses send somebody with no pointer, and it is the first
 * surface that answers "what is there" rather than "what is mine". It reads without a
 * session, on purpose - a person deciding whether to enter an event should be able to see
 * it before creating an account.
 *
 * ## Why the filters live in the URL
 *
 * A search is a thing people share: "these are the open tournaments" arrives as a link. So
 * every filter goes into the address as it changes, and is `replace`d rather than pushed,
 * because a search box that adds a history entry per keystroke makes the back button walk
 * backwards through somebody's typing. Paging is deliberately *not* in the address: "show 12
 * more" is a position in a list, not a different list.
 *
 * ## Why each status is its own read
 *
 * Live, upcoming and finished tournaments are read separately and each pages on its own, so
 * a long run of finished tournaments can never push a live one off the page, and the server
 * sorts each group by the rule that suits it. When a status filter has chosen one group, the
 * other two are not read at all.
 */
function ExplorePage() {
  const { q, status, reg, when, sort, view } = Route.useSearch();
  const navigate = useNavigate();
  const { signedIn } = useSession();

  const query = q ?? "";
  const statusFilter = status ?? null;
  const registrationOpen = reg === true;
  const range = when ?? null;
  const order: ExploreSort = sort ?? "soonest";
  const layout: ExploreView = view ?? "timeline";

  const filters: ExploreFilters = { query, registrationOpen, range, sort: order };
  const wants = (word: TournamentStatus) => statusFilter === null || statusFilter === word;

  const live = useExploreSection("in_progress", filters, LIVE_LIMIT, wants("in_progress"));
  const upcoming = useExploreSection("upcoming", filters, PAGE_SIZE, wants("upcoming"));
  const completed = useExploreSection("completed", filters, PAGE_SIZE, wants("completed"));
  const counts = useExploreCounts(filters);

  const sections = [
    wants("in_progress") ? live : null,
    wants("upcoming") ? upcoming : null,
    wants("completed") ? completed : null,
  ].filter((section): section is typeof live => section !== null);

  /**
   * Writes the filters into the address.
   *
   * Empty and default values are removed rather than stored, so "no filter" has exactly one
   * spelling: two spellings of the same search would be two cache entries and two URLs for
   * one page.
   */
  const go = (
    next: Partial<{
      q: string;
      status: TournamentStatus | null;
      reg: boolean;
      when: ExploreRange | null;
      sort: ExploreSort;
      view: ExploreView;
    }>,
  ) => {
    const merged = {
      q: next.q ?? query,
      status: next.status === undefined ? statusFilter : next.status,
      reg: next.reg ?? registrationOpen,
      when: next.when === undefined ? range : next.when,
      sort: next.sort ?? order,
      view: next.view ?? layout,
    };
    const term = merged.q.trim();
    void navigate({
      to: "/explore",
      search: {
        ...(term ? { q: term } : {}),
        ...(merged.status ? { status: merged.status } : {}),
        ...(merged.reg ? { reg: true as const } : {}),
        ...(merged.when ? { when: merged.when } : {}),
        ...(merged.sort !== "soonest" ? { sort: merged.sort } : {}),
        ...(merged.view === "cards" ? { view: "cards" as const } : {}),
      },
      replace: true,
    });
  };
  const clearFilters = () => go({ q: "", status: null, reg: false, when: null });

  const filtered =
    query.trim().length > 0 || statusFilter !== null || registrationOpen || range !== null;
  const firstLoad = sections.length > 0 && sections.every((section) => section.isLoading);
  const failed = sections.find((section) => section.isError);
  const total = sections.reduce((sum, section) => sum + section.total, 0);

  const countOf = (option: StatusOption): number | null => {
    if (!counts.data) return null;
    return option.value === "all"
      ? counts.data.in_progress + counts.data.upcoming + counts.data.completed
      : counts.data[option.value];
  };

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
      <section
        aria-label="Find and filter"
        className="mb-8 space-y-3 rounded-2xl border border-hairline bg-surface p-4 shadow-sm"
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_11rem_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="explore-search">Search</Label>
            <Input
              id="explore-search"
              value={query}
              placeholder="Name, venue or event"
              className="h-11 rounded-[10px]"
              onChange={(event) => go({ q: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="explore-when">When</Label>
            <select
              id="explore-when"
              value={range ?? ""}
              className={CONTROL_CLASS}
              onChange={(event) => go({ when: (event.target.value || null) as ExploreRange | null })}
            >
              <option value="">Any time</option>
              {EXPLORE_RANGES.map((word) => (
                <option key={word} value={word}>
                  {RANGE_LABEL[word]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="explore-sort">Sort by</Label>
            <select
              id="explore-sort"
              value={order}
              className={CONTROL_CLASS}
              onChange={(event) => go({ sort: event.target.value as ExploreSort })}
            >
              {EXPLORE_SORTS.map((word) => (
                <option key={word} value={word}>
                  {SORT_LABEL[word]}
                </option>
              ))}
            </select>
          </div>
          <div
            role="group"
            aria-label="Layout"
            className="grid grid-cols-2 gap-1 rounded-xl bg-secondary p-1"
          >
            {VIEWS.map((word) => (
              <button
                key={word}
                type="button"
                aria-pressed={layout === word}
                onClick={() => go({ view: word })}
                className={
                  layout === word
                    ? "h-9 rounded-lg border border-border-control bg-surface px-3 text-sm font-bold"
                    : "h-9 rounded-lg px-3 text-sm font-semibold text-muted-foreground hover:text-foreground"
                }
              >
                {word === "timeline" ? "Timeline" : "Cards"}
              </button>
            ))}
          </div>
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

          The number beside the label is `aria-hidden` for the same reason, and because each
          group's own heading below already says how many it holds: the button's name stays the
          word the reader chose, not the word plus a figure that changes under them.
        */}
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-2">
            {STATUS_OPTIONS.map((option) => {
              const selected =
                option.value === "all" ? !statusFilter : statusFilter === option.value;
              const count = countOf(option);
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => go({ status: option.value === "all" ? null : option.value })}
                  className={
                    selected
                      ? "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-primary bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
                      : "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border-control bg-surface px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
                  }
                >
                  {selected ? <Check aria-hidden="true" className="size-4 shrink-0" /> : null}
                  {option.label}
                  {count !== null ? (
                    <span
                      aria-hidden="true"
                      className={`font-medium tabular-nums ${selected ? "text-primary-foreground/90" : "text-muted-foreground"}`}
                    >
                      {count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <span aria-hidden="true" className="mx-1 hidden h-6 w-px bg-hairline sm:block" />
          <button
            type="button"
            aria-pressed={registrationOpen}
            onClick={() => go({ reg: !registrationOpen })}
            className={
              registrationOpen
                ? "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-primary bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
                : "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border-control bg-surface px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
            }
          >
            {registrationOpen ? <Check aria-hidden="true" className="size-4 shrink-0" /> : null}
            Registration open
          </button>
        </div>

        {filtered ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
            <span className="text-sm font-semibold text-muted-foreground">Showing</span>
            {statusFilter ? (
              <FilterChip
                label={STATUS_OPTIONS.find((option) => option.value === statusFilter)?.label ?? ""}
                onRemove={() => go({ status: null })}
              />
            ) : null}
            {registrationOpen ? (
              <FilterChip label="Registration open" onRemove={() => go({ reg: false })} />
            ) : null}
            {range ? (
              <FilterChip label={RANGE_LABEL[range]} onRemove={() => go({ when: null })} />
            ) : null}
            <Button variant="ghost" size="sm" className="text-primary-ink" onClick={clearFilters}>
              Clear all
            </Button>
          </div>
        ) : null}
      </section>

      {firstLoad ? (
        <LoadingList />
      ) : failed ? (
        <div role="alert" className="rounded-xl border border-danger-border bg-danger-surface p-6">
          <h2 className="font-display text-xl font-bold text-danger-foreground">
            Couldn't load tournaments
          </h2>
          <p className="mt-2 max-w-xl text-base">
            {failed.error instanceof Error && failed.error.message
              ? failed.error.message
              : "Your connection may have dropped. Try again in a moment."}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => sections.forEach((section) => section.refetch())}
          >
            Try again
          </Button>
        </div>
      ) : total === 0 ? (
        <div className="rounded-xl border border-hairline bg-surface px-6 py-10 text-center shadow-panel">
          {filtered ? (
            <>
              <h2 className="font-display text-xl font-bold">No tournament matches that search</h2>
              <p className="mx-auto mt-2 max-w-md text-base text-muted-foreground">
                Check the spelling, or clear the filters to see everything.
              </p>
              <Button className="mt-5" onClick={clearFilters}>
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
            {total} tournament{total === 1 ? "" : "s"}
          </p>

          {live.rows.length > 0 ? (
            <section aria-labelledby="explore-live">
              <h2
                id="explore-live"
                className="mb-4 flex items-center gap-2.5 font-display text-xl font-bold"
              >
                <span
                  aria-hidden="true"
                  className="size-2.5 rounded-full bg-foreground ring-4 ring-state-live-chip"
                />
                In progress
                <span className="font-body text-base font-medium text-muted-foreground tabular-nums">
                  {live.total}
                </span>
              </h2>
              <ul className="grid gap-4 sm:grid-cols-2">
                {live.rows.map((summary) => (
                  <li key={summary.id} className="min-w-0">
                    <ExploreCard summary={summary} signedIn={signedIn} variant="live" />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {upcoming.rows.length > 0 ? (
            <section aria-labelledby="explore-upcoming">
              <h2 id="explore-upcoming" className="mb-4 font-display text-xl font-bold">
                Upcoming{" "}
                <span className="font-body text-base font-medium text-muted-foreground tabular-nums">
                  {upcoming.total}
                </span>
              </h2>
              {layout === "cards" ? (
                <ul className="grid gap-4 sm:grid-cols-2">
                  {upcoming.rows.map((summary) => (
                    <li key={summary.id} className="min-w-0">
                      <ExploreCard summary={summary} signedIn={signedIn} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="space-y-6">
                  {groupByMonth(upcoming.rows).map((group) => (
                    <div key={group.key}>
                      <h3 className="mb-2.5 text-sm font-bold uppercase tracking-wide text-muted-foreground">
                        {group.label}
                      </h3>
                      <ul className="space-y-2.5">
                        {group.rows.map((summary) => (
                          <li key={summary.id} className="min-w-0">
                            <ExploreRow summary={summary} signedIn={signedIn} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
              <MoreButton section={upcoming} noun="upcoming" />
            </section>
          ) : null}

          {completed.rows.length > 0 ? (
            <section aria-labelledby="explore-completed">
              <h2 id="explore-completed" className="mb-4 font-display text-xl font-bold">
                Completed{" "}
                <span className="font-body text-base font-medium text-muted-foreground tabular-nums">
                  {completed.total}
                </span>
              </h2>
              {layout === "cards" ? (
                <ul className="grid gap-4 sm:grid-cols-2">
                  {completed.rows.map((summary) => (
                    <li key={summary.id} className="min-w-0">
                      <ExploreCard summary={summary} signedIn={signedIn} />
                    </li>
                  ))}
                </ul>
              ) : (
                <CompletedList rows={completed.rows} />
              )}
              <MoreButton section={completed} noun="completed" />
            </section>
          ) : null}
        </div>
      )}
    </PublicShell>
  );
}

/** One applied filter, which can be taken off on its own. */
function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex min-h-9 items-center gap-1 rounded-full bg-info-surface pl-3.5 pr-1.5 text-sm font-semibold text-info-foreground">
      {label}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="grid size-8 place-items-center rounded-full hover:bg-info-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </span>
  );
}

/**
 * "Showing 12 of 37" and the way to the next page.
 *
 * The line is always drawn; the button only while there is more to load. Both read the
 * figures the database reported, so they cannot disagree about how much is left.
 */
function MoreButton({
  section,
  noun,
}: {
  section: ReturnType<typeof useExploreSection>;
  noun: string;
}) {
  const remaining = section.total - section.rows.length;
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground tabular-nums">
        Showing <strong className="text-foreground">{section.rows.length}</strong> of{" "}
        <strong className="text-foreground">{section.total}</strong> {noun}
      </p>
      {section.hasMore ? (
        <Button
          variant="outline"
          className="h-12 px-6"
          disabled={section.isLoadingMore}
          onClick={section.loadMore}
        >
          {section.isLoadingMore ? "Loading…" : `Show ${Math.min(remaining, PAGE_SIZE)} more`}
        </Button>
      ) : null}
    </div>
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
