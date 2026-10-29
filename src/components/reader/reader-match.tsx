import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState, Notice, StatusPill } from "@/components/app-shell";
import { ConnectionBadge } from "@/components/connection-badge";
import { MatchIdentity } from "@/components/match-identity";
import { Button } from "@/components/ui/button";
import { timeLabel } from "@/lib/tournament/format";
import type { DeskMatch } from "@/lib/tournament/desk-matches";
import { sideThatWon } from "@/lib/tournament/match-winner";
import type { TimeGroup } from "@/lib/tournament/reader-board";
import { cn } from "@/lib/utils";

/**
 * The pieces every reader page draws a match with.
 *
 * Watch mode (see `docs/design-principles.md`): the names and the score are the content, set
 * larger than on the operator's list, and the state is a word plus a glyph through the same
 * `StatusPill` the Desk uses. A finished match marks its winner the way Scores and the bracket
 * do - bold, with a check - so a result reads without working out whose number is whose.
 */

export interface MatchReading {
  label: (teamId: string | null) => string;
  courtName: (courtId: string | null) => string | null;
  timezone?: string | undefined;
}

function Side({
  name,
  winner,
  mine,
  inline = false,
}: {
  name: string;
  winner: boolean;
  mine: boolean;
  inline?: boolean;
}) {
  return (
    <span
      className={cn(
        "min-w-0 break-words",
        inline ? "inline" : "block",
        winner && "font-semibold",
        mine && "text-foreground",
      )}
    >
      {winner ? <Check aria-hidden className="mr-1 inline size-4 align-[-2px]" /> : null}
      {name}
      {winner ? <span className="sr-only"> (won)</span> : null}
    </span>
  );
}

/** Where and when, as one quiet line: the court, then the time. */
export function whereAndWhen(match: DeskMatch, reading: MatchReading): string {
  const court = reading.courtName(match.courtId);
  const time = match.scheduled ? timeLabel(match.scheduled, reading.timezone) : null;
  if (court && time) return `${court}, ${time}`;
  return court ?? time ?? "Court and time not assigned yet";
}

/**
 * One match as a reader scans a list: where, who, and how it stands.
 *
 * The court leads in a column of its own, because it is the address a spectator walks to and
 * a column of them reads down the hall. Each side gets its own line, so a doubles pair never
 * wraps into the other pair's name. The event and round are the least read part and come
 * last, small - or not at all, inside a group that already names them.
 */
export function ReaderMatchRow({
  match,
  reading,
  mineTeamId,
  aside,
  showTime = true,
  showIdentity = true,
  id,
}: {
  match: DeskMatch;
  reading: MatchReading;
  /** The followed player's team, so their side reads as theirs. */
  mineTeamId?: string | null;
  /** Replaces the default right-hand column (the status, or the score). */
  aside?: ReactNode;
  /** False inside a group headed by the time every match in it shares. */
  showTime?: boolean;
  /** False inside a group headed by the event and round every match in it shares. */
  showIdentity?: boolean;
  /** An anchor, so a long list can be scrolled to this row. */
  id?: string;
}) {
  const won = match.status === "reported" ? sideThatWon(match.initialGames) : null;
  const finished = match.status === "reported" || match.status === "walkover";
  const court = reading.courtName(match.courtId);
  return (
    <li
      id={id}
      className="grid scroll-mt-28 grid-cols-[4rem_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-2.5 sm:grid-cols-[5rem_minmax(0,1fr)_auto]"
    >
      <div className="min-w-0 pt-px">
        {court ? (
          <p className="whitespace-nowrap font-display text-sm font-bold sm:text-base">{court}</p>
        ) : (
          <p className="text-sm text-muted-foreground">Unassigned</p>
        )}
        {showTime && match.scheduled ? (
          <p className="text-sm tabular-nums text-muted-foreground">
            {timeLabel(match.scheduled, reading.timezone)}
          </p>
        ) : null}
      </div>
      <div className="min-w-0 text-base leading-snug">
        <Side
          name={reading.label(match.teams[0])}
          winner={won === "a"}
          mine={!!mineTeamId && match.teams[0] === mineTeamId}
        />
        <span className="sr-only"> vs </span>
        <Side
          name={reading.label(match.teams[1])}
          winner={won === "b"}
          mine={!!mineTeamId && match.teams[1] === mineTeamId}
        />
        {showIdentity ? (
          <p className="mt-0.5 font-score text-xs text-muted-foreground">
            <MatchIdentity match={match} />
          </p>
        ) : null}
      </div>
      <div className="flex flex-col items-end gap-1.5 text-right">
        {aside ?? (
          <>
            {/* "Scheduled" is what every listed match is until it is called: it tells a reader nothing. */}
            {finished || match.status === "scheduled" ? null : <StatusPill status={match.status} />}
            {match.score ? (
              <span className="whitespace-nowrap font-score text-sm font-semibold tabular-nums sm:text-base">
                {match.score}
              </span>
            ) : match.status === "walkover" ? (
              <StatusPill status={match.status} />
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

/** Both sides on one line, for a table cell: the winner bold with a check, as in a row. */
export function MatchSidesInline({ match, reading }: { match: DeskMatch; reading: MatchReading }) {
  const won = match.status === "reported" ? sideThatWon(match.initialGames) : null;
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <Side name={reading.label(match.teams[0])} winner={won === "a"} mine={false} inline />
      <span className="text-muted-foreground">vs</span>
      <Side name={reading.label(match.teams[1])} winner={won === "b"} mine={false} inline />
    </span>
  );
}

/**
 * The matches of one wave - those published for the same time - under one heading.
 *
 * The heading carries the time, and the event and round when the whole wave shares them, so
 * the rows beneath carry neither. It stays in view while its rows scroll by.
 */
export function ReaderTimeGroup({
  group,
  reading,
  children,
}: {
  group: TimeGroup;
  reading: MatchReading;
  /** The rows, drawn with `showTime={false}` and, when the group is shared, `showIdentity={false}`. */
  children: ReactNode;
}) {
  const count = group.matches.length;
  return (
    <li>
      <h3 className="sticky top-0 z-10 flex flex-wrap items-baseline gap-x-3 border-b border-hairline bg-background px-4 py-1.5 text-sm">
        <span className="font-display font-bold tabular-nums">
          {group.scheduled ? timeLabel(group.scheduled, reading.timezone) : "Time to be set"}
        </span>
        {group.shared ? (
          <span className="font-score text-muted-foreground">
            <MatchIdentity match={group.shared} />
          </span>
        ) : null}
        <span className="ml-auto text-muted-foreground">
          {count} {count === 1 ? "match" : "matches"}
        </span>
      </h3>
      <ul className="divide-y divide-hairline">{children}</ul>
    </li>
  );
}

/**
 * A titled list of matches with its own empty sentence, so an empty list still says what belongs there.
 *
 * A list is flat - a hairline frame and rules, no shadow - so the raised cards on a page are
 * only the ones that matter most: the courts in play and a player's next match. An empty list
 * is a sentence under its title, not a frame around nothing.
 */
export function ReaderMatchList({
  title,
  empty,
  children,
  right,
  headingId,
  wide,
}: {
  title: string;
  empty: string | null;
  children: ReactNode;
  right?: ReactNode;
  headingId: string;
  /**
   * The same matches as a table, drawn instead of the rows from `lg` up: a phone or tablet
   * reads rows, a desktop scans columns (the running order's rule in `design-principles.md`).
   */
  wide?: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <header className="flex min-h-11 flex-wrap items-center justify-between gap-2 pb-1">
        <h2 id={headingId} className="font-display text-lg font-bold tracking-tight">
          {title}
        </h2>
        {right}
      </header>
      {empty ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <>
          <ul
            className={cn(
              "divide-y divide-hairline overflow-clip rounded-xl border border-hairline bg-surface",
              wide && "lg:hidden",
            )}
          >
            {children}
          </ul>
          {wide ? (
            <div className="hidden rounded-xl border border-hairline bg-surface lg:block">
              {wide}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * A reader page's title row: the title and the page's own controls on one line.
 *
 * `Page` gives a workspace page a 24px title and a sentence under it. Below the tournament's
 * own header that pushed the first match off a 320px screen, and off a phone held sideways
 * entirely. The section tab already says where the reader is, so the title is smaller, the
 * sentence is left to the meta description, and the day picker or filters share its line -
 * on a phone they wrap beneath it and scroll sideways rather than wrapping again.
 */
export function ReaderPage({
  title,
  meta,
  controls,
  actions,
  className,
  children,
}: {
  title: string;
  /** One short fact under the title, such as a player's events. */
  meta?: string | undefined;
  controls?: ReactNode;
  actions?: ReactNode;
  /** For a page that lays out the title row and its content together (Now's wall layout). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <div className="mb-4 flex flex-none flex-wrap items-center gap-x-4 gap-y-2 watch-short:mb-2">
        <div className="min-w-0">
          <h1 className="font-display text-xl font-bold tracking-tight">{title}</h1>
          {meta ? <p className="text-sm text-muted-foreground">{meta}</p> : null}
        </div>
        {controls ? (
          <div className="min-w-0 basis-full empty:hidden sm:basis-auto">{controls}</div>
        ) : null}
        {actions ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** The loading and error states every reader region shares. */
export function ReaderLoading({ label }: { label: string }) {
  return (
    <div role="status" className="space-y-3" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-xl bg-muted motion-reduce:animate-none"
        />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * The one way a reader page settles: loading, an error with a retry, or the content - with a
 * stale notice above it when a later refresh failed, so what was loaded stays on screen.
 */
export function ReaderState({
  state,
  loadingLabel,
  children,
}: {
  state: { loading: boolean; error: boolean; stale: boolean; retry: () => void };
  loadingLabel: string;
  children: ReactNode;
}) {
  if (state.loading) return <ReaderLoading label={loadingLabel} />;
  if (state.error) {
    return (
      <EmptyState
        title="Could not load the tournament"
        hint="The connection may have dropped. Check it, then try again."
        action={
          <Button size="sm" variant="outline" onClick={state.retry}>
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <>
      {state.stale ? (
        <Notice tone="warn" className="flex flex-wrap items-center justify-between gap-2">
          <span>Could not refresh. Showing what was last loaded.</span>
          <Button size="sm" variant="outline" onClick={state.retry}>
            Try again
          </Button>
        </Notice>
      ) : null}
      {children}
    </>
  );
}

/**
 * The connection readout as a reader sees it: said only when something is wrong.
 *
 * A healthy connection, and the moment of connecting on every load, are not news to a
 * spectator, and a green "Live" beside pages full of live matches reads as one more live
 * match. The badge stays mounted as a live region either way, so going offline is still
 * announced; it is only drawn when updates have stopped.
 */
export function ReaderConnection({
  live,
}: {
  live: { status: "connecting" | "live" | "offline" | "error"; lastUpdatedAt: number };
}) {
  const healthy = live.status === "live" || live.status === "connecting";
  return (
    <span className={healthy ? "sr-only" : undefined}>
      <ConnectionBadge status={live.status} lastUpdatedAt={live.lastUpdatedAt} />
    </span>
  );
}
