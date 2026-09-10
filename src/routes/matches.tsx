import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { AppShell, EmptyState, Panel, StatusPill } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/hooks/useSession";
import {
  indexBy,
  teamLabel,
  teamPlayerIds,
  useCategories,
  useCourts,
  useDrawMatches,
  useDraws,
  usePlayers,
  usePoolMatches,
  usePools,
  useRealtimeRefresh,
  useTeams,
} from "@/lib/tournament/data";
import { gamesLabel, parseGames, timeLabel } from "@/lib/tournament/format";
import { MatchOperationsDialog, type DeskMatch } from "./index";

export const Route = createFileRoute("/matches")({
  head: () => ({
    meta: [
      { title: "Score Entry | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content: "Enter live badminton results so pool standings and knockout draws update immediately.",
      },
      { property: "og:title", content: "Score Entry | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content: "Enter live badminton results so pool standings and knockout draws update immediately.",
      },
    ],
  }),
  component: MatchesPage,
});

function MatchesPage() {
  const qc = useQueryClient();
  const { canScore, canSchedule } = useSession();
  useRealtimeRefresh();
  const [selected, setSelected] = useState<{ id: string; kind: "pool" | "draw" } | null>(
    null,
  );
  const { data: categories } = useCategories();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: pools } = usePools();
  const { data: poolMatches } = usePoolMatches();
  const { data: draws } = useDraws();
  const { data: drawMatches } = useDrawMatches();
  const { data: courts } = useCourts();

  const playerMap = useMemo(() => indexBy(players), [players]);
  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const poolMap = useMemo(() => indexBy(pools), [pools]);
  const drawMap = useMemo(() => indexBy(draws), [draws]);
  const courtMap = useMemo(() => indexBy(courts), [courts]);
  const catMap = useMemo(() => indexBy(categories), [categories]);

  const label = (id: string | null) => teamLabel(id ? teamMap.get(id) : undefined, playerMap);
  const refresh = () => qc.invalidateQueries();
  const selectedMatch = useMemo<DeskMatch | null>(() => {
    if (!selected) return null;
    if (selected.kind === "pool") {
      const match = (poolMatches ?? []).find((row) => row.id === selected.id);
      if (!match) return null;
      return {
        id: match.id,
        kind: "pool",
        courtId: match.court_id,
        status: match.status,
        startedAt: match.started_at,
        endedAt: match.ended_at,
        scheduled: match.scheduled_time,
        teams: [match.team_a_id, match.team_b_id],
        playerIds: [match.team_a_id, match.team_b_id].flatMap((id) =>
          id ? teamPlayerIds(teamMap.get(id)) : [],
        ),
        tag: catMap.get(match.category_id)?.code ?? "",
        score: match.status === "reported" ? `${match.score_a}-${match.score_b}` : null,
        initialGames:
          match.status === "reported" && match.score_a != null && match.score_b != null
            ? [{ a: match.score_a, b: match.score_b }]
            : undefined,
      };
    }
    const match = (drawMatches ?? []).find((row) => row.id === selected.id);
    if (!match) return null;
    const draw = drawMap.get(match.draw_id);
    return {
      id: match.id,
      kind: "draw",
      courtId: match.court_id,
      status: match.status,
      startedAt: match.started_at,
      endedAt: match.ended_at,
      scheduled: match.scheduled_time,
      teams: [match.team_a_id, match.team_b_id],
      playerIds: [match.team_a_id, match.team_b_id].flatMap((id) =>
        id ? teamPlayerIds(teamMap.get(id)) : [],
      ),
      tag: `${catMap.get(draw?.category_id ?? "")?.code ?? ""} · Draw ${draw?.tier ?? ""}`,
      score: match.status === "reported" ? gamesLabel(parseGames(match.games)) : null,
      initialGames: match.status === "reported" ? parseGames(match.games) : undefined,
    };
  }, [selected, poolMatches, drawMatches, teamMap, catMap, drawMap]);

  return (
    <AppShell title="Score entry" subtitle="Group stage is a single game to 21. Knockouts are best of three.">
      <Tabs defaultValue="group">
        <TabsList>
          <TabsTrigger value="group">Group stage</TabsTrigger>
          <TabsTrigger value="knockout">Knockout</TabsTrigger>
        </TabsList>

        <TabsContent value="group" className="mt-4 space-y-4">
          {(pools ?? []).map((pool) => {
            const list = (poolMatches ?? [])
              .filter((m) => m.pool_id === pool.id)
              .sort((a, b) => a.round - b.round);
            if (!list.length) return null;
            return (
              <Panel
                key={pool.id}
                title={`${catMap.get(pool.category_id)?.code ?? ""} · ${pool.name}`}
                right={
                  <span className="font-score text-[11px] text-muted-foreground">
                    {list.filter((m) => m.status === "reported").length}/{list.length} reported
                  </span>
                }
              >
                <ul className="divide-y divide-hairline">
                  {list.map((m) => (
                    <li
                      key={m.id}
                      className="-mx-2 flex flex-wrap items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/50"
                    >
                      <span className="w-10 font-score text-[11px] font-semibold text-primary">R{m.round}</span>

                      <span className="min-w-[220px] flex-1">
                        {label(m.team_a_id)} <span className="text-muted-foreground">vs</span> {label(m.team_b_id)}
                      </span>
                      <span className="font-score text-[11px] text-muted-foreground">
                        {timeLabel(m.scheduled_time)}
                        {m.court_id ? ` · C${courtMap.get(m.court_id)?.number ?? "?"}` : ""}
                      </span>
                      <StatusPill status={m.status} />
                      {m.status === "reported" ? (
                        <span className="font-score text-sm">
                          {m.score_a}-{m.score_b}
                        </span>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelected({ id: m.id, kind: "pool" })}
                      >
                        Open
                      </Button>
                    </li>
                  ))}
                </ul>
              </Panel>
            );
          })}
          {(pools ?? []).length === 0 ? (
            <Panel>
              <EmptyState
                title="No pools generated yet"
                hint="Draw the pools first and the group matches will appear here."
              />
            </Panel>
          ) : null}

        </TabsContent>

        <TabsContent value="knockout" className="mt-4 space-y-4">
          {(draws ?? []).map((draw) => {
            const list = (drawMatches ?? [])
              .filter((m) => m.draw_id === draw.id)
              .sort((a, b) => a.round - b.round || a.slot - b.slot);
            if (!list.length) return null;
            return (
              <Panel
                key={draw.id}
                title={`${catMap.get(draw.category_id)?.code ?? ""} · Draw ${draw.tier}`}
                right={
                  <span className="font-score text-[11px] text-muted-foreground">
                    {draw.entrant_count} entrants · bracket {draw.bracket_size}
                  </span>
                }
              >
                <ul className="divide-y divide-hairline">
                  {list.map((m) => (
                    <li
                      key={m.id}
                      className="-mx-2 flex flex-wrap items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/50"
                    >
                      <span className="w-12 font-score text-[11px] font-semibold text-primary">
                        R{m.round}.{m.slot}
                      </span>

                      <span className="min-w-[220px] flex-1">
                        {label(m.team_a_id)} <span className="text-muted-foreground">vs</span> {label(m.team_b_id)}
                      </span>
                      <span className="font-score text-[11px] text-muted-foreground">
                        {timeLabel(m.scheduled_time)}
                        {m.court_id ? ` · C${courtMap.get(m.court_id)?.number ?? "?"}` : ""}
                      </span>
                      <StatusPill status={m.note === "Bye" ? "walkover" : m.status} />
                      {m.status === "reported" ? (
                        <span className="font-score text-sm">
                          {m.note === "Bye" ? "Bye" : gamesLabel(parseGames(m.games))}
                        </span>
                      ) : null}
                      {m.note !== "Bye" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setSelected({ id: m.id, kind: "draw" })}
                        >
                          Open
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Panel>
            );
          })}
          {(draws ?? []).length === 0 ? (
            <Panel>
              <EmptyState
                title="No draws generated yet"
                hint="Knockout matches appear once every pool in a category is complete."
              />
            </Panel>
          ) : null}

        </TabsContent>
      </Tabs>
      <Dialog open={!!selectedMatch} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-md">
          {selectedMatch ? (
            <MatchOperationsDialog
              key={selectedMatch.id}
              match={selectedMatch}
              nameA={label(selectedMatch.teams[0])}
              nameB={label(selectedMatch.teams[1])}
              courtId={selectedMatch.courtId}
              courtNumber={
                selectedMatch.courtId
                  ? (courtMap.get(selectedMatch.courtId)?.number ?? null)
                  : null
              }
              courts={courts ?? []}
              signedIn={canScore}
              canSchedule={canSchedule}
              startCheck={null}
              playerMap={playerMap}
              onDone={() => {
                refresh();
                setSelected(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
