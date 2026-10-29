import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, StatusPill } from "@/components/app-shell";
import { MatchIdentity } from "@/components/match-identity";
import { ReaderDayPicker } from "@/components/reader/day-picker";
import {
  ReaderMatchList,
  ReaderState,
  ReaderMatchRow,
  whereAndWhen,
  type MatchReading,
  ReaderConnection,
  ReaderPage,
  ReaderTimeGroup,
} from "@/components/reader/reader-match";
import { TournamentResults } from "@/components/tournament-results";
import { Button } from "@/components/ui/button";
import { useMyPlayer } from "@/hooks/useMyPlayer";
import { useReaderMatches } from "@/hooks/useReaderMatches";
import { normalizeTournamentStatus } from "@/lib/auth/authorization";
import { attributeMatchesToDays, resolveSelectedDay } from "@/lib/tournament/day-scope";
import type { DeskMatch } from "@/lib/tournament/desk-matches";
import { groupByTime, matchesOfPlayer, nextMatchOf, nowBoard } from "@/lib/tournament/reader-board";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/tournaments/$tournamentId/now")({
  head: () => ({
    meta: [
      { title: "Now | Tournova" },
      {
        name: "description",
        content: "What is on court right now, what is up next and what just finished.",
      },
      { property: "og:title", content: "Now | Tournova" },
      {
        property: "og:description",
        content: "What is on court right now, what is up next and what just finished.",
      },
    ],
  }),
  component: NowPage,
});

/**
 * The reader's home while a tournament is being played: one day, as a spectator reads a hall.
 *
 * It answers "what is happening" and nothing the organiser plans: like the Desk it is scoped
 * to one day and carries no tournament-wide forecast, and unlike the Desk it carries none of
 * the moderator's states (ready, waiting, overrun) because a spectator acts on none of them.
 */
function NowPage() {
  const { tournamentId } = Route.useParams();
  const data = useReaderMatches();
  const { tournament, live, matches, days, label, courtName } = data;
  const { playerId } = useMyPlayer(tournamentId);
  const [pickedDayId, setPickedDayId] = useState<string | null>(null);
  const [allCourts, setAllCourts] = useState(false);
  // The browser's clock, adopted after mount so the server and first render agree.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  const orderedDays = useMemo(() => [...days].sort((a, b) => a.day_number - b.day_number), [days]);
  const attribution = useMemo(
    () => attributeMatchesToDays(orderedDays, matches),
    [orderedDays, matches],
  );
  const dayId = resolveSelectedDay({
    days: orderedDays,
    attribution,
    now: now ?? 0,
    pickedDayId,
  });
  const dayMatches = dayId ? (attribution.byDayId.get(dayId) ?? []) : matches;
  const board = nowBoard(dayMatches, { upNext: 6, justFinished: 6 });

  // Times read in the browser's zone, as the Desk and Scores print them, so one match has one time.
  const reading: MatchReading = { label, courtName };
  const status = normalizeTournamentStatus(tournament?.status);
  const myNext = playerId ? nextMatchOf(matchesOfPlayer(matches, playerId)) : null;

  return (
    <ReaderPage
      title="Now"
      controls={<ReaderDayPicker days={orderedDays} selectedId={dayId} onSelect={setPickedDayId} />}
      actions={<ReaderConnection live={live} />}
    >
      <div className="space-y-5">
        {status === "completed" ? <TournamentResults tournamentId={tournamentId} /> : null}

        {myNext ? (
          <MyNextTeaser tournamentId={tournamentId} match={myNext} reading={reading} />
        ) : null}

        <ReaderState state={data} loadingLabel="Loading the courts">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
            <section aria-labelledby="now-on-court" className="space-y-3">
              <h2 id="now-on-court" className="font-display text-lg font-bold tracking-tight">
                On court
              </h2>
              {board.live.length === 0 ? (
                <EmptyState
                  title={status === "upcoming" ? "Play has not started" : "No match on court"}
                  hint={
                    status === "upcoming"
                      ? "Find who is playing, and open a player for their matches."
                      : "The next matches are listed as they are called."
                  }
                  action={
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/tournaments/$tournamentId/players" params={{ tournamentId }}>
                        Find a player
                      </Link>
                    </Button>
                  }
                />
              ) : (
                <>
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {board.live.map((match, index) => (
                      <CourtCard
                        key={match.id}
                        match={match}
                        reading={reading}
                        now={now}
                        demo={!!tournament?.is_demo}
                        folded={!allCourts && index >= PHONE_COURTS}
                      />
                    ))}
                  </ul>
                  {board.live.length > PHONE_COURTS && !allCourts ? (
                    <Button
                      variant="outline"
                      className="min-h-11 w-full sm:hidden"
                      onClick={() => setAllCourts(true)}
                    >
                      Show all {board.live.length} courts
                    </Button>
                  ) : null}
                </>
              )}
            </section>

            <div className="space-y-5">
              <ReaderMatchList
                title="Up next"
                headingId="now-up-next"
                empty={board.upNext.length ? null : "Nothing else is scheduled for this day."}
              >
                {groupByTime(board.upNext).map((group) => (
                  <ReaderTimeGroup
                    key={`${group.scheduled}-${group.matches[0]!.id}`}
                    group={group}
                    reading={reading}
                  >
                    {group.matches.map((match) => (
                      <ReaderMatchRow
                        key={match.id}
                        match={match}
                        reading={reading}
                        showTime={false}
                        showIdentity={!group.shared}
                      />
                    ))}
                  </ReaderTimeGroup>
                ))}
              </ReaderMatchList>
              <ReaderMatchList
                title="Just finished"
                headingId="now-finished"
                empty={board.justFinished.length ? null : "No results yet for this day."}
                right={
                  <Link
                    to="/tournaments/$tournamentId/scores"
                    params={{ tournamentId }}
                    className="inline-flex min-h-11 items-center text-sm font-semibold text-primary underline-offset-4 hover:underline"
                  >
                    All results
                  </Link>
                }
              >
                {board.justFinished.map((match) => (
                  <ReaderMatchRow key={match.id} match={match} reading={reading} showTime={false} />
                ))}
              </ReaderMatchList>
            </div>
          </div>
        </ReaderState>
      </div>
    </ReaderPage>
  );
}

/** One court with a match on it: the court is the address a spectator walks to, so it leads. */
const MAX_SHOWN_MINUTES = 180;
/**
 * Courts a phone shows before "Show all": a full hall would otherwise push Up next several
 * screens down. A wider screen lays the courts out in two columns and shows them all.
 */
const PHONE_COURTS = 4;

function CourtCard({
  match,
  reading,
  now,
  demo,
  folded,
}: {
  match: DeskMatch;
  reading: MatchReading;
  now: number | null;
  demo: boolean;
  /** Hidden on a phone until the reader asks for every court. */
  folded: boolean;
}) {
  const started = match.startedAt ? new Date(match.startedAt).getTime() : null;
  const elapsed =
    started != null && now != null ? Math.max(0, Math.floor((now - started) / 60_000)) : null;
  // A sample tournament is a snapshot, and a match "on court" for hours is a record nobody
  // closed rather than a match: neither has a running time worth printing.
  const minutes = elapsed != null && elapsed <= MAX_SHOWN_MINUTES && !demo ? elapsed : null;
  return (
    <li
      className={cn(
        "space-y-2 rounded-xl border border-hairline bg-surface p-3 shadow-panel sm:space-y-3 sm:p-4",
        folded && "max-sm:hidden",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="font-display text-lg font-bold tracking-tight sm:text-xl">
          {reading.courtName(match.courtId) ?? "Court not assigned"}
        </p>
        <StatusPill status={match.status} />
      </div>
      {/* On a phone "vs" leads the second line rather than taking one of its own. */}
      <div className="space-y-0.5 text-base font-semibold leading-snug sm:space-y-1 sm:text-lg">
        <p className="break-words">{reading.label(match.teams[0])}</p>
        <p className="text-sm font-normal text-muted-foreground max-sm:hidden">vs</p>
        <p className="break-words">
          <span className="text-sm font-normal text-muted-foreground sm:hidden">vs </span>
          {reading.label(match.teams[1])}
        </p>
      </div>
      <p className="flex flex-wrap justify-between gap-x-3 font-score text-t2 text-muted-foreground">
        <MatchIdentity match={match} />
        {minutes != null ? <span className="tabular-nums">{minutes} min on court</span> : null}
      </p>
    </li>
  );
}

function MyNextTeaser({
  tournamentId,
  match,
  reading,
}: {
  tournamentId: string;
  match: DeskMatch;
  reading: MatchReading;
}) {
  return (
    <Link
      to="/tournaments/$tournamentId/me"
      params={{ tournamentId }}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3 transition-colors hover:bg-primary/10"
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-primary-ink">
          {match.status === "in-progress" ? "You are on court" : "Your next match"}
        </span>
        <span className="block break-words font-semibold">
          {reading.label(match.teams[0])} vs {reading.label(match.teams[1])}
        </span>
      </span>
      <span className="text-sm text-muted-foreground">{whereAndWhen(match, reading)}</span>
    </Link>
  );
}
