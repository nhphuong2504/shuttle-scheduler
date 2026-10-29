import { Link, createFileRoute } from "@tanstack/react-router";

import { EmptyState } from "@/components/app-shell";
import { PlayerView, eventNames } from "@/components/reader/player-view";
import { ReaderConnection, ReaderPage, ReaderState } from "@/components/reader/reader-match";
import { Button } from "@/components/ui/button";
import { useMyMatchNotifications } from "@/hooks/useMyMatchNotifications";
import { useMyPlayer } from "@/hooks/useMyPlayer";
import { useReaderMatches } from "@/hooks/useReaderMatches";

export const Route = createFileRoute("/tournaments/$tournamentId/players/$playerId")({
  head: () => ({
    meta: [
      { title: "Player | Tournova" },
      { name: "description", content: "One player's matches, results and path through the draws." },
      { property: "og:title", content: "Player | Tournova" },
      {
        property: "og:description",
        content: "One player's matches, results and path through the draws.",
      },
    ],
  }),
  component: PlayerPage,
});

/** One player, in the same view as My matches, with the one act a reader has: follow them as yourself. */
function PlayerPage() {
  const { tournamentId, playerId } = Route.useParams();
  const data = useReaderMatches();
  const { playerId: me, canChoose, choose } = useMyPlayer(tournamentId);
  const { query: callsQuery } = useMyMatchNotifications();
  const isMe = me === playerId;
  const calls = isMe
    ? (callsQuery.data ?? []).filter((call) => call.tournament_id === tournamentId)
    : [];

  const known = data.playerMap.has(playerId);
  const name = data.playerMap.get(playerId)?.name;

  return (
    <ReaderPage
      title={name ?? (data.loading || data.error ? "Player" : "Player not found")}
      meta={known ? eventNames(data, playerId) || undefined : undefined}
      actions={
        <>
          <Link
            to="/tournaments/$tournamentId/players"
            params={{ tournamentId }}
            className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-primary underline-offset-4 hover:underline"
          >
            All players
          </Link>
          <ReaderConnection live={data.live} />
          {known ? (
            isMe ? (
              <Button size="sm" variant="outline" asChild>
                <Link to="/tournaments/$tournamentId/me" params={{ tournamentId }}>
                  Open My matches
                </Link>
              </Button>
            ) : canChoose ? (
              <Button size="sm" variant="outline" onClick={() => choose(playerId)}>
                This is me
              </Button>
            ) : null
          ) : null}
        </>
      }
    >
      <ReaderState state={data} loadingLabel="Loading this player">
        {known ? (
          <PlayerView playerId={playerId} data={data} calls={calls} showName={false} />
        ) : (
          <EmptyState
            title="This player is not in the tournament"
            hint="They may have withdrawn, or the link is out of date."
          />
        )}
      </ReaderState>
    </ReaderPage>
  );
}
