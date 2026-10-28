import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState, Notice, Panel, StatusPill } from "@/components/app-shell";
import { MatchIdentity } from "@/components/match-identity";
import { Button } from "@/components/ui/button";
import { timeLabel } from "@/lib/tournament/format";
import type { DeskMatch } from "@/lib/tournament/desk-matches";
import { sideThatWon } from "@/lib/tournament/match-winner";
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

function Side({ name, winner, mine }: { name: string; winner: boolean; mine: boolean }) {
  return (
    <span
      className={cn("min-w-0 break-words", winner && "font-semibold", mine && "text-foreground")}
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

export function ReaderMatchRow({
  match,
  reading,
  mineTeamId,
  aside,
}: {
  match: DeskMatch;
  reading: MatchReading;
  /** The followed player's team, so their side reads as theirs. */
  mineTeamId?: string | null;
  /** Replaces the default right-hand column (the status, or the score). */
  aside?: ReactNode;
}) {
  const won = match.status === "reported" ? sideThatWon(match.initialGames) : null;
  const finished = match.status === "reported" || match.status === "walkover";
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 py-3">
      <div className="min-w-0 space-y-1">
        <p className="font-score text-t2 text-muted-foreground">
          <MatchIdentity match={match} />
        </p>
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-base">
          <Side
            name={reading.label(match.teams[0])}
            winner={won === "a"}
            mine={!!mineTeamId && match.teams[0] === mineTeamId}
          />
          <span className="text-muted-foreground">vs</span>
          <Side
            name={reading.label(match.teams[1])}
            winner={won === "b"}
            mine={!!mineTeamId && match.teams[1] === mineTeamId}
          />
        </p>
        <p className="text-sm text-muted-foreground">{whereAndWhen(match, reading)}</p>
      </div>
      <div className="flex flex-col items-end gap-1.5 text-right">
        {aside ?? (
          <>
            {finished ? null : <StatusPill status={match.status} />}
            {match.score ? (
              <span className="whitespace-nowrap font-score text-base font-semibold tabular-nums">
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

/** A titled list of matches with its own empty sentence, so an empty list still says what belongs there. */
export function ReaderMatchList({
  title,
  empty,
  children,
  right,
  headingId,
}: {
  title: string;
  empty: string | null;
  children: ReactNode;
  right?: ReactNode;
  headingId: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-hairline bg-surface shadow-panel"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-2.5">
        <h2 id={headingId} className="font-display text-base font-bold tracking-tight">
          {title}
        </h2>
        {right}
      </header>
      {empty ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-hairline">{children}</ul>
      )}
    </section>
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
      <Panel>
        <EmptyState
          title="Could not load the tournament"
          hint="The connection may have dropped. Check it, then try again."
          action={
            <Button size="sm" variant="outline" onClick={state.retry}>
              Try again
            </Button>
          }
        />
      </Panel>
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
