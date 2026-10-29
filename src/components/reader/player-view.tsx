import { Trophy } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { StatusPill } from "@/components/app-shell";
import { MatchIdentity } from "@/components/match-identity";
import {
  ReaderMatchList,
  ReaderMatchRow,
  whereAndWhen,
  type MatchReading,
} from "@/components/reader/reader-match";
import type { MatchNotification } from "@/hooks/useMyMatchNotifications";
import type { useReaderMatches } from "@/hooks/useReaderMatches";
import { compareEventOrder } from "@/lib/tournament/event-order";
import type { DeskMatch } from "@/lib/tournament/desk-matches";
import {
  matchesOfPlayer,
  nextMatchOf,
  outcomeFor,
  placementPath,
  type PlacementPath,
} from "@/lib/tournament/reader-board";
import { cn } from "@/lib/utils";

type ReaderData = ReturnType<typeof useReaderMatches>;

/**
 * One person's tournament: the next match, the path through the draws, and every match.
 *
 * The same view answers "when do I play" on My matches and "when does she play" on a player's
 * page, so a parent following a child and the player themself read one layout. The next match
 * leads because it is the one thing a player standing at the hall needs; the path is what makes
 * the two-round placement format legible - two results decide which of four draws you are in -
 * so it comes straight after, with every match in a column of its own beside them on a desktop.
 */
export function PlayerView({
  playerId,
  data,
  calls = [],
  showName = true,
}: {
  playerId: string;
  data: ReaderData;
  /** The caller's own match calls, so a called match says so. Empty for anyone else's page. */
  calls?: readonly MatchNotification[];
  /** False where the page title already names the player. */
  showName?: boolean;
}) {
  const { matches, teams, catMap, entrants, tierDraws, label, courtName, tournament } = data;
  // Times read in the browser's zone, as the Desk and Scores print them, so one match has one time.
  const reading: MatchReading = { label, courtName };

  const mine = useMemo(() => matchesOfPlayer(matches, playerId), [matches, playerId]);
  const next = nextMatchOf(mine);

  const events = useMemo(
    () =>
      teams
        .filter((team) => team.player_1_id === playerId || team.player_2_id === playerId)
        .map((team) => ({ team, category: catMap.get(team.category_id) }))
        .sort((a, b) => (a.category && b.category ? compareEventOrder(a.category, b.category) : 0)),
    [teams, catMap, playerId],
  );

  const callFor = (match: DeskMatch) =>
    calls.find((call) => call.match_id === match.id && !call.outdated) ?? null;

  const name = data.playerMap.get(playerId)?.name ?? "Unknown player";

  return (
    <div className="space-y-5">
      {showName ? (
        <div>
          <h2 className="break-words font-display text-2xl font-bold tracking-tight">{name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{eventNames(data, playerId)}</p>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <div className="space-y-5">
          {next ? (
            <NextMatchCard
              match={next}
              reading={reading}
              teamId={events.find(({ team }) => next.teams.includes(team.id))?.team.id ?? null}
              call={callFor(next)}
            />
          ) : (
            <div className="rounded-xl border border-hairline bg-surface p-5 shadow-panel">
              <p className="font-display text-lg font-bold">
                {mine.length ? "No more matches to play" : "No matches yet"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {mine.length
                  ? "Every match this player is in has finished."
                  : "Matches appear here once the draw is made."}
              </p>
            </div>
          )}

          {tournament?.format === "two_round_placement" && events.length ? (
            <section aria-labelledby={`player-path-${playerId}`} className="space-y-3">
              <h2
                id={`player-path-${playerId}`}
                className="font-display text-lg font-bold tracking-tight"
              >
                Path to the draws
              </h2>
              {events.map(({ team, category }) => {
                const entrant = entrants.find((row) => row.team_id === team.id);
                const teamMatches = mine.filter((m) => m.teams.includes(team.id));
                const path = placementPath(
                  teamMatches.filter((m) => m.kind === "placement"),
                  team.id,
                );
                const knockout = teamMatches.filter((m) => m.kind === "tier");
                const champion = entrant
                  ? (tierDraws.find((draw) => draw.champion_id === entrant.id) ?? null)
                  : null;
                return (
                  <PathCard
                    key={team.id}
                    title={category?.name ?? category?.code ?? "Event"}
                    path={path}
                    placementOnCourt={teamMatches.some(
                      (m) => m.kind === "placement" && m.status === "in-progress",
                    )}
                    knockout={knockout}
                    teamId={team.id}
                    champion={champion?.tier ?? null}
                  />
                );
              })}
            </section>
          ) : null}
        </div>

        <ReaderMatchList
          title="All matches"
          headingId={`player-matches-${playerId}`}
          empty={mine.length ? null : "No matches have been drawn for this player yet."}
        >
          {mine.map((match) => (
            <ReaderMatchRow
              key={match.id}
              match={match}
              reading={reading}
              mineTeamId={events.find(({ team }) => match.teams.includes(team.id))?.team.id ?? null}
            />
          ))}
        </ReaderMatchList>
      </div>
    </div>
  );
}

/** The events a player is entered in, by name, in the standard event order. */
export function eventNames(data: ReaderData, playerId: string): string {
  return data.teams
    .filter((team) => team.player_1_id === playerId || team.player_2_id === playerId)
    .flatMap((team) => {
      const category = data.catMap.get(team.category_id);
      return category ? [category] : [];
    })
    .sort(compareEventOrder)
    .map((category) => category.name || category.code)
    .join(", ");
}

function NextMatchCard({
  match,
  reading,
  teamId,
  call,
}: {
  match: DeskMatch;
  reading: MatchReading;
  teamId: string | null;
  call: MatchNotification | null;
}) {
  const opponent = teamId ? (match.teams.find((id) => id !== teamId) ?? null) : null;
  const onCourt = match.status === "in-progress";
  const state = onCourt
    ? "On court now"
    : call
      ? `Called to Court ${call.court_number}`
      : "Next match";
  return (
    <section
      aria-label="Next match"
      className={cn(
        "space-y-4 rounded-xl border p-5 shadow-panel",
        call && !onCourt ? "border-primary/40 bg-primary/5" : "border-hairline bg-surface",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          className={cn(
            "font-semibold",
            call && !onCourt ? "text-primary-ink" : "text-muted-foreground",
          )}
        >
          {state}
        </p>
        {/* Every next match is scheduled until it is called; only a change of state is news. */}
        {match.status === "scheduled" ? null : <StatusPill status={match.status} />}
      </div>
      <div>
        <p className="text-sm text-muted-foreground">{opponent ? "Against" : "Match"}</p>
        <p className="break-words font-display text-2xl font-bold leading-tight tracking-tight">
          {opponent
            ? reading.label(opponent)
            : `${reading.label(match.teams[0])} vs ${reading.label(match.teams[1])}`}
        </p>
      </div>
      <p className="font-display text-xl font-bold tabular-nums">{whereAndWhen(match, reading)}</p>
      <p className="font-score text-t2 text-muted-foreground">
        <MatchIdentity match={match} />
      </p>
      {call && !onCourt ? (
        <p className="whitespace-pre-wrap break-words rounded-lg bg-surface px-3 py-2 text-sm">
          {call.message}
        </p>
      ) : null}
    </section>
  );
}

function Step({ children, tone }: { children: ReactNode; tone: "won" | "lost" | "open" | "draw" }) {
  return (
    <li
      className={cn(
        "rounded-lg border px-3 py-2 text-sm font-semibold",
        tone === "won" && "border-success-foreground/40 bg-success-surface text-success-foreground",
        tone === "lost" && "border-hairline bg-muted text-foreground",
        tone === "open" && "border-dashed border-border-control bg-surface text-muted-foreground",
        tone === "draw" && "border-primary/40 bg-primary/5 text-primary-ink",
      )}
    >
      {children}
    </li>
  );
}

function PathCard({
  title,
  path,
  placementOnCourt,
  knockout,
  teamId,
  champion,
}: {
  title: string;
  path: PlacementPath;
  /** Whether the next placement match is being played right now. */
  placementOnCourt: boolean;
  knockout: readonly DeskMatch[];
  teamId: string;
  champion: string | null;
}) {
  const round = (index: number) => {
    const result = path.results[index];
    const pending = index === path.results.length && placementOnCourt ? "on court" : "to play";
    return (
      <Step tone={result ?? "open"}>
        Placement {index + 1}: {result === "won" ? "won" : result === "lost" ? "lost" : pending}
      </Step>
    );
  };
  const lastKnockout = [...knockout]
    .reverse()
    .find((m) => m.status === "reported" || m.status === "walkover");
  const lastOutcome = lastKnockout ? outcomeFor(lastKnockout, teamId) : null;
  return (
    <div className="space-y-3 rounded-xl border border-hairline bg-surface p-4 shadow-panel">
      <h3 className="font-display text-base font-bold">{title}</h3>
      <ol className="flex flex-wrap items-center gap-2" aria-label={`${title} path`}>
        {round(0)}
        {round(1)}
        {path.draw ? <Step tone="draw">Draw {path.draw}</Step> : null}
      </ol>
      {path.next ? (
        <p className="text-sm text-muted-foreground">
          Win the next placement match for Draw {path.next.ifWin}. Lose it for Draw{" "}
          {path.next.ifLose}.
        </p>
      ) : !path.draw && path.results.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Two placement results decide which of four draws comes next.
        </p>
      ) : null}
      {champion ? (
        <p className="flex items-center gap-2 font-semibold">
          <Trophy aria-hidden className="size-4" />
          Won Draw {champion}
        </p>
      ) : lastKnockout ? (
        <p className="text-sm text-muted-foreground">
          Last knockout match: {lastKnockout.roundTag ?? lastKnockout.tag},{" "}
          {lastOutcome === "won" ? "won" : lastOutcome === "lost" ? "lost" : "decided"}.
        </p>
      ) : null}
    </div>
  );
}
