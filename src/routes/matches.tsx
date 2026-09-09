import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell, Panel, StatusPill } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/hooks/useSession";
import { reportDrawMatch, reportPoolMatch, resetMatch, startMatch } from "@/lib/tournament/actions";
import {
  indexBy,
  teamLabel,
  useCategories,
  useCourts,
  useDrawMatches,
  useDraws,
  usePlayers,
  usePoolMatches,
  usePools,
  useTeams,
} from "@/lib/tournament/data";
import { gamesLabel, minutesSince, parseGames, timeLabel } from "@/lib/tournament/format";

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
  const { signedIn } = useSession();
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
                    <li key={m.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                      <span className="w-14 font-score text-[11px] text-muted-foreground">R{m.round}</span>
                      <span className="min-w-[220px] flex-1">
                        {label(m.team_a_id)} <span className="text-muted-foreground">vs</span> {label(m.team_b_id)}
                      </span>
                      <span className="font-score text-[11px] text-muted-foreground">
                        {timeLabel(m.scheduled_time)}
                        {m.court_id ? ` · C${courtMap.get(m.court_id)?.number ?? "?"}` : ""}
                      </span>
                      <StatusPill status={m.status} />
                      {m.status === "reported" ? (
                        <span className="flex items-center gap-2">
                          <span className="font-score text-sm">
                            {m.score_a}-{m.score_b}
                          </span>
                          {signedIn ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={async () => {
                                await resetMatch("pool_matches", m.id);
                                refresh();
                              }}
                            >
                              Correct
                            </Button>
                          ) : null}
                        </span>
                      ) : (
                        <GroupScoreEntry
                          disabled={!signedIn}
                          inProgress={m.status === "in-progress"}
                          startedAt={m.started_at}
                          onStart={async () => {
                            await startMatch("pool_matches", m.id, m.court_id);
                            refresh();
                          }}
                          onSubmit={async (a, b) => {
                            try {
                              await reportPoolMatch(m.id, a, b);
                              toast.success("Result recorded");
                              refresh();
                            } catch (error) {
                              toast.error(error instanceof Error ? error.message : "Could not save result");
                            }
                          }}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </Panel>
            );
          })}
          {(pools ?? []).length === 0 ? (
            <Panel>
              <p className="text-sm text-muted-foreground">No pools generated yet.</p>
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
                    <li key={m.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                      <span className="w-14 font-score text-[11px] text-muted-foreground">
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
                        <span className="flex items-center gap-2">
                          <span className="font-score text-sm">
                            {m.note === "Bye" ? "Bye" : gamesLabel(parseGames(m.games))}
                          </span>
                          {signedIn && m.note !== "Bye" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={async () => {
                                await resetMatch("draw_matches", m.id);
                                refresh();
                              }}
                            >
                              Correct
                            </Button>
                          ) : null}
                        </span>
                      ) : (
                        <KnockoutScoreEntry
                          disabled={!signedIn || !m.team_a_id || !m.team_b_id}
                          inProgress={m.status === "in-progress"}
                          startedAt={m.started_at}
                          onStart={async () => {
                            await startMatch("draw_matches", m.id, m.court_id);
                            refresh();
                          }}
                          onSubmit={async (games) => {
                            try {
                              await reportDrawMatch(m.id, games);
                              toast.success("Result recorded");
                              refresh();
                            } catch (error) {
                              toast.error(error instanceof Error ? error.message : "Could not save result");
                            }
                          }}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </Panel>
            );
          })}
          {(draws ?? []).length === 0 ? (
            <Panel>
              <p className="text-sm text-muted-foreground">No draws generated yet.</p>
            </Panel>
          ) : null}
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}

function Clock({ startedAt }: { startedAt: string | null }) {
  const mins = minutesSince(startedAt);
  if (mins == null) return null;
  const late = mins > 20;
  return (
    <span
      className={`font-score text-[11px] ${late ? "rounded bg-danger-surface px-1.5 py-0.5 text-danger-foreground" : "text-muted-foreground"}`}
    >
      {mins}′{late ? " over cap" : ""}
    </span>
  );
}

function GroupScoreEntry({
  disabled,
  inProgress,
  startedAt,
  onStart,
  onSubmit,
}: {
  disabled: boolean;
  inProgress: boolean;
  startedAt: string | null;
  onStart: () => void;
  onSubmit: (a: number, b: number) => void;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  return (
    <span className="flex items-center gap-2">
      {inProgress ? <Clock startedAt={startedAt} /> : null}
      <Input
        className="h-8 w-14 font-score"
        inputMode="numeric"
        value={a}
        disabled={disabled}
        onChange={(e) => setA(e.target.value)}
        aria-label="Score A"
      />
      <Input
        className="h-8 w-14 font-score"
        inputMode="numeric"
        value={b}
        disabled={disabled}
        onChange={(e) => setB(e.target.value)}
        aria-label="Score B"
      />
      <Button size="sm" disabled={disabled || a === "" || b === ""} onClick={() => onSubmit(Number(a), Number(b))}>
        Report
      </Button>
      {!inProgress ? (
        <Button size="sm" variant="outline" disabled={disabled} onClick={onStart}>
          Start
        </Button>
      ) : null}
    </span>
  );
}

function KnockoutScoreEntry({
  disabled,
  inProgress,
  startedAt,
  onStart,
  onSubmit,
}: {
  disabled: boolean;
  inProgress: boolean;
  startedAt: string | null;
  onStart: () => void;
  onSubmit: (games: { a: number; b: number }[]) => void;
}) {
  const [values, setValues] = useState<string[][]>([
    ["", ""],
    ["", ""],
    ["", ""],
  ]);

  const set = (row: number, col: number, v: string) =>
    setValues((prev) => prev.map((r, i) => (i === row ? r.map((c, j) => (j === col ? v : c)) : r)));

  const games = values
    .filter((r) => r[0] !== "" && r[1] !== "")
    .map((r) => ({ a: Number(r[0]), b: Number(r[1]) }));

  return (
    <span className="flex flex-wrap items-center gap-2">
      {inProgress ? <Clock startedAt={startedAt} /> : null}
      {values.map((row, i) => (
        <span key={i} className="flex items-center gap-1">
          <Input
            className="h-8 w-12 font-score"
            inputMode="numeric"
            value={row[0] ?? ""}
            disabled={disabled}
            onChange={(e) => set(i, 0, e.target.value)}
            aria-label={`Game ${i + 1} A`}
          />
          <Input
            className="h-8 w-12 font-score"
            inputMode="numeric"
            value={row[1] ?? ""}
            disabled={disabled}
            onChange={(e) => set(i, 1, e.target.value)}
            aria-label={`Game ${i + 1} B`}
          />
        </span>
      ))}
      <Button size="sm" disabled={disabled || games.length === 0} onClick={() => onSubmit(games)}>
        Report
      </Button>
      {!inProgress ? (
        <Button size="sm" variant="outline" disabled={disabled} onClick={onStart}>
          Start
        </Button>
      ) : null}
    </span>
  );
}
