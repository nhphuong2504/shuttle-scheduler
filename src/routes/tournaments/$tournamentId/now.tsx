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
import {
  groupByTime,
  hallBoard,
  matchesOfPlayer,
  nextMatchOf,
  nowBoard,
} from "@/lib/tournament/reader-board";
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
  const { tournament, live, matches, days, courts, dayCourts, label, courtName } = data;
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
  const hall = useMemo(() => {
    const ids = new Set(dayCourts.filter((row) => row.day_id === dayId).map((row) => row.court_id));
    return hallBoard(courts, ids, board.live);
  }, [courts, dayCourts, dayId, board.live]);

  // Times read in the browser's zone, as the Desk and Scores print them, so one match has one time.
  const reading: MatchReading = { label, courtName };
  const status = normalizeTournamentStatus(tournament?.status);
  const myNext = playerId ? nextMatchOf(matchesOfPlayer(matches, playerId)) : null;

  return (
    <ReaderPage
      title="Now"
      className="watch-wall:flex watch-wall:h-dvh watch-wall:flex-col watch-wall:py-3 watch-wall-short:py-1.5"
      controls={<ReaderDayPicker days={orderedDays} selectedId={dayId} onSelect={setPickedDayId} />}
      actions={<ReaderConnection live={live} />}
    >
      <div className="space-y-5 watch-wall:flex watch-wall:min-h-0 watch-wall:flex-1 watch-wall:flex-col watch-wall:gap-4 watch-wall:space-y-0 [&>*]:flex-none">
        {status === "completed" ? <TournamentResults tournamentId={tournamentId} /> : null}

        {myNext ? (
          <MyNextTeaser tournamentId={tournamentId} match={myNext} reading={reading} />
        ) : null}

        <ReaderState state={data} loadingLabel="Loading the courts">
          {/*
            On a wall each column scrolls inside itself, so the hall stays where the eye left
            it while a long Up next runs on.
          */}
          <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start watch-wall:!flex-1 watch-wall:min-h-0 watch-wall:grid-rows-[minmax(0,1fr)] watch-wall:items-stretch">
            <section
              aria-labelledby="now-on-court"
              className="min-w-0 watch-wall:min-h-0 watch-wall:overflow-y-auto"
            >
              {/* The same height as the lists' headings beside it, so the two columns start level. */}
              <h2
                id="now-on-court"
                className="flex min-h-11 items-center pb-1 font-display text-lg font-bold tracking-tight"
              >
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
                  {/*
                    As many columns as the screen holds, as the Desk lays its courts out: one on
                    a 320px phone, two on a phone, three on a tablet, a whole hall on a wide one.
                  */}
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9.5rem),1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] sm:gap-3">
                    {hall.map((tile, index) => {
                      const folded = !allCourts && index >= PHONE_COURTS;
                      return tile.match ? (
                        <CourtCard
                          key={tile.match.id}
                          match={tile.match}
                          reading={reading}
                          now={now}
                          demo={!!tournament?.is_demo}
                          folded={folded}
                        />
                      ) : (
                        <FreeCourt
                          key={tile.court!.id}
                          number={tile.court!.number}
                          folded={folded}
                        />
                      );
                    })}
                  </ul>
                  {hall.length > PHONE_COURTS && !allCourts ? (
                    <Button
                      variant="outline"
                      className="mt-3 min-h-11 w-full sm:hidden"
                      onClick={() => setAllCourts(true)}
                    >
                      Show all {hall.length} courts
                    </Button>
                  ) : null}
                </>
              )}
            </section>

            {/* Side by side under the courts on a tablet; a column beside them on a wider screen. */}
            <div className="grid gap-5 md:grid-cols-2 md:items-start lg:grid-cols-1 watch-wall:min-h-0 watch-wall:content-start watch-wall:overflow-y-auto">
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

/** A match "on court" for longer than this is a record nobody closed, not a match. */
const MAX_SHOWN_MINUTES = 180;
/**
 * Courts a phone shows before "Show all": a full hall would otherwise push Up next several
 * screens down. A wider screen shows them all.
 */
const PHONE_COURTS = 6;

/**
 * One court with a match on it, set like a scoreboard: the court leads, because it is the
 * address a spectator walks to, then one side per line and how long they have been on.
 */
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
  // A sample tournament is a snapshot, so its matches have no running time worth printing.
  const minutes = elapsed != null && elapsed <= MAX_SHOWN_MINUTES && !demo ? elapsed : null;
  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-xl border border-hairline bg-surface p-3 shadow-panel sm:p-4",
        folded && "max-sm:hidden",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <p className="whitespace-nowrap font-display text-lg font-bold tracking-tight sm:text-xl watch-wall:text-2xl watch-wall-short:text-xl">
          {reading.courtName(match.courtId) ?? "Unassigned"}
        </p>
        <StatusPill status={match.status} />
      </div>
      <div className="min-w-0 text-base font-semibold leading-snug watch-wall:text-lg watch-wall-short:text-base">
        <p className="break-words">{reading.label(match.teams[0])}</p>
        <span className="sr-only"> vs </span>
        <p className="break-words">{reading.label(match.teams[1])}</p>
      </div>
      <p className="mt-auto flex flex-wrap items-baseline justify-between gap-x-3 font-score text-xs text-muted-foreground">
        <MatchIdentity match={match} />
        {minutes != null ? <span className="tabular-nums">{minutes} min</span> : null}
      </p>
    </li>
  );
}

/**
 * A court with nothing on it, kept in its place so the hall never reshuffles as matches start
 * and finish. Quiet on purpose: a spectator is looking for the courts in play.
 */
function FreeCourt({ number, folded }: { number: number; folded: boolean }) {
  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-xl border border-dashed border-hairline p-3 text-muted-foreground sm:p-4",
        folded && "max-sm:hidden",
      )}
    >
      <p className="whitespace-nowrap font-display text-lg font-bold tracking-tight sm:text-xl">
        Court {number}
      </p>
      <p className="text-sm">Free</p>
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
