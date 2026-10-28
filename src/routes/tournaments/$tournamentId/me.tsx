import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { EmptyState, Notice, Page, Panel } from "@/components/app-shell";
import { ConnectionBadge } from "@/components/connection-badge";
import { PlayerView } from "@/components/reader/player-view";
import { ReaderState } from "@/components/reader/reader-match";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMyMatchNotifications, type MatchNotification } from "@/hooks/useMyMatchNotifications";
import { useMyPlayer } from "@/hooks/useMyPlayer";
import { useReaderMatches } from "@/hooks/useReaderMatches";
import type { Player } from "@/lib/tournament/data";

export const Route = createFileRoute("/tournaments/$tournamentId/me")({
  head: () => ({
    meta: [
      { title: "My matches | Tournova" },
      {
        name: "description",
        content: "Your next match, where it is, and the path your results open through the draws.",
      },
      { property: "og:title", content: "My matches | Tournova" },
      {
        property: "og:description",
        content: "Your next match, where it is, and the path your results open through the draws.",
      },
    ],
  }),
  component: MyMatchesPage,
});

/**
 * A player's own page: which match is next, where, against whom, and where it leads.
 *
 * "Me" is the player this browser follows (`useMyPlayer`), chosen once by name. A call from the
 * Desk (`my_match_notifications`, the same read the header inbox makes) lights the next-match
 * card up as "Called to Court N", and when nobody is followed yet a call offers its own match's
 * players as the likely answer. Choosing grants nothing: everything shown is public already.
 */
function MyMatchesPage() {
  const { tournamentId } = Route.useParams();
  const data = useReaderMatches();
  const { playerId, ready, choose } = useMyPlayer(tournamentId);
  const { session, query: callsQuery } = useMyMatchNotifications();
  const calls = useMemo(
    () => (callsQuery.data ?? []).filter((call) => call.tournament_id === tournamentId),
    [callsQuery.data, tournamentId],
  );

  const followed = playerId ? (data.playerMap.get(playerId) ?? null) : null;

  return (
    <Page
      title="My matches"
      subtitle="Your next match, and where your results lead."
      actions={
        <ConnectionBadge status={data.live.status} lastUpdatedAt={data.live.lastUpdatedAt} />
      }
    >
      <ReaderState
        state={{ ...data, loading: data.loading || !ready }}
        loadingLabel="Loading your matches"
      >
        {followed ? (
          <div className="space-y-5">
            <OtherCalls calls={calls} data={data} playerId={followed.id} />
            <PlayerView playerId={followed.id} data={data} calls={calls} />
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              Following {followed.name} in this browser.
              <Button size="sm" variant="ghost" onClick={() => choose(null)}>
                Not you? Choose again
              </Button>
            </p>
          </div>
        ) : (
          <ChoosePlayer
            players={data.players}
            suggested={suggestedFromCalls(calls, data)}
            onChoose={choose}
            signedIn={!!session}
            tournamentId={tournamentId}
          />
        )}
      </ReaderState>
    </Page>
  );
}

type ReaderData = ReturnType<typeof useReaderMatches>;

/** The players of the matches this account was called for: the likeliest answers to "who are you". */
function suggestedFromCalls(calls: readonly MatchNotification[], data: ReaderData): Player[] {
  const ids = new Set<string>();
  for (const call of calls) {
    const match = data.matches.find((m) => m.id === call.match_id);
    for (const id of match?.playerIds ?? []) ids.add(id);
  }
  return [...ids].flatMap((id) => {
    const player = data.playerMap.get(id);
    return player ? [player] : [];
  });
}

/** A call for a match the followed player is not in: worth saying, because the pick may be wrong. */
function OtherCalls({
  calls,
  data,
  playerId,
}: {
  calls: readonly MatchNotification[];
  data: ReaderData;
  playerId: string;
}) {
  const stray = calls.filter((call) => {
    if (call.outdated || call.read_at) return false;
    const match = data.matches.find((m) => m.id === call.match_id);
    return match ? !match.playerIds.includes(playerId) : false;
  });
  if (!stray.length) return null;
  return (
    <Notice tone="warn">
      You were called to Court {stray[0]!.court_number} for a match the player you follow is not in.
      Check that you picked yourself.
    </Notice>
  );
}

function ChoosePlayer({
  players,
  suggested,
  onChoose,
  signedIn,
  tournamentId,
}: {
  players: readonly Player[];
  suggested: readonly Player[];
  onChoose: (id: string) => void;
  signedIn: boolean;
  tournamentId: string;
}) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const found = term
    ? players
        .filter((p) => p.name.toLowerCase().includes(term))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 12)
    : [];

  if (!players.length) {
    return (
      <Panel>
        <EmptyState
          title="No players yet"
          hint="Entries appear here once the organiser has added them."
        />
      </Panel>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-5">
      {suggested.length ? (
        <Panel title="You were called for a match">
          <div className="space-y-3 p-4">
            <p className="text-sm text-muted-foreground">Which of these players is you?</p>
            <ul className="flex flex-wrap gap-2">
              {suggested.map((p) => (
                <li key={p.id}>
                  <Button variant="outline" onClick={() => onChoose(p.id)}>
                    {p.name}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      ) : null}

      <Panel title="Find yourself">
        <div className="space-y-3 p-4">
          <label htmlFor="me-search" className="block text-sm font-semibold">
            Your name
          </label>
          <Input
            id="me-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Start typing your name"
            autoComplete="off"
            className="h-11"
          />
          {term && !found.length ? (
            <p className="text-sm text-muted-foreground">
              No player in this tournament matches that name.
            </p>
          ) : null}
          {found.length ? (
            <ul className="divide-y divide-hairline rounded-lg border border-hairline">
              {found.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 break-words font-semibold">{p.name}</span>
                  <Button size="sm" onClick={() => onChoose(p.id)}>
                    This is me
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Saved in this browser only. It shows your matches and changes nothing in the tournament.
            {signedIn ? null : " Sign in to get a notification when you are called to a court."}
          </p>
        </div>
      </Panel>

      <p className="text-center text-sm">
        <Link
          to="/tournaments/$tournamentId/players"
          params={{ tournamentId }}
          className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-4 hover:underline"
        >
          Browse all players
        </Link>
      </p>
    </div>
  );
}
