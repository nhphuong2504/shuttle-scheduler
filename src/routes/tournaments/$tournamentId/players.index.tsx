import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { EmptyState, Page, Panel } from "@/components/app-shell";
import { ReaderState } from "@/components/reader/reader-match";
import { Input } from "@/components/ui/input";
import { useMyPlayer } from "@/hooks/useMyPlayer";
import { useReaderMatches } from "@/hooks/useReaderMatches";
import { compareEventOrder } from "@/lib/tournament/event-order";

export const Route = createFileRoute("/tournaments/$tournamentId/players/")({
  head: () => ({
    meta: [
      { title: "Players | Tournova" },
      {
        name: "description",
        content: "Everyone in the tournament. Open a player for their matches and results.",
      },
      { property: "og:title", content: "Players | Tournova" },
      {
        property: "og:description",
        content: "Everyone in the tournament. Open a player for their matches and results.",
      },
    ],
  }),
  /** The search is in the address, so a filtered list is a link someone can send. */
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = search["q"];
    return typeof q === "string" && q.trim().length > 0 ? { q } : {};
  },
  component: PlayersPage,
});

/**
 * Everyone playing, by name: the reader's way to "find someone I know".
 *
 * A player opens their own page, which is the same view as My matches, so following a friend
 * and following yourself are one layout. The operator's roster (`…/entries`) stays the place
 * entries are managed.
 */
function PlayersPage() {
  const { tournamentId } = Route.useParams();
  const { q } = Route.useSearch();
  const navigate = useNavigate();
  const [query, setQueryState] = useState(q ?? "");
  const setQuery = (value: string) => {
    setQueryState(value);
    const term = value.trim();
    void navigate({
      to: "/tournaments/$tournamentId/players",
      params: { tournamentId },
      search: term ? { q: term } : {},
      replace: true,
    });
  };
  const data = useReaderMatches();
  const { playerId: me } = useMyPlayer(tournamentId);

  const rows = useMemo(() => {
    const eventsOf = new Map<string, string[]>();
    const sortedTeams = [...data.teams].sort((a, b) => {
      const x = data.catMap.get(a.category_id);
      const y = data.catMap.get(b.category_id);
      return x && y ? compareEventOrder(x, y) : 0;
    });
    for (const team of sortedTeams) {
      const code = data.catMap.get(team.category_id)?.code;
      if (!code) continue;
      for (const id of [team.player_1_id, team.player_2_id]) {
        if (!id) continue;
        const list = eventsOf.get(id) ?? [];
        if (!list.includes(code)) list.push(code);
        eventsOf.set(id, list);
      }
    }
    return [...data.players]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((player) => ({ player, events: eventsOf.get(player.id) ?? [] }));
  }, [data.players, data.teams, data.catMap]);

  const term = query.trim().toLowerCase();
  const visible = term
    ? rows.filter(({ player }) => player.name.toLowerCase().includes(term))
    : rows;

  return (
    <Page
      title="Players"
      subtitle="Open a player for their matches, results and path through the draws."
    >
      <div className="space-y-4">
        <div className="max-w-md">
          <label htmlFor="players-search" className="mb-1.5 block text-sm font-semibold">
            Search by name
          </label>
          <Input
            id="players-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="A player's name"
            autoComplete="off"
            className="h-11"
          />
        </div>

        <ReaderState state={data} loadingLabel="Loading the players">
          {!rows.length ? (
            <Panel>
              <EmptyState
                title="No players yet"
                hint="Entries appear here once the organiser adds them."
              />
            </Panel>
          ) : !visible.length ? (
            <Panel>
              <EmptyState
                title="No player matches that name"
                hint="Check the spelling, or search part of the name."
              />
            </Panel>
          ) : (
            <>
              <p className="text-sm text-muted-foreground" role="status">
                {visible.length === rows.length
                  ? `${rows.length} players`
                  : `${visible.length} of ${rows.length} players`}
              </p>
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {visible.map(({ player, events }) => (
                  <li key={player.id}>
                    <Link
                      to="/tournaments/$tournamentId/players/$playerId"
                      params={{ tournamentId, playerId: player.id }}
                      className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-hairline bg-surface px-4 py-3 shadow-panel transition-colors hover:bg-muted/50"
                    >
                      <span className="min-w-0 break-words font-semibold">{player.name}</span>
                      <span className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
                        {player.id === me ? (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-primary-ink">
                            You
                          </span>
                        ) : null}
                        <span className="font-score">{events.join(", ")}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </ReaderState>
      </div>
    </Page>
  );
}
