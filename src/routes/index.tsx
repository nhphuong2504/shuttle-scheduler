import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell, Panel, StatusPill } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSession } from "@/hooks/useSession";
import { reportDrawMatch, reportPoolMatch, resetMatch, startMatch } from "@/lib/tournament/actions";
import {
  indexBy,
  teamLabel,
  teamPlayerIds,
  useCategories,
  useCourts,
  useDrawMatches,
  useDraws,
  usePlayers,
  usePoolEntries,
  usePoolMatches,
  usePools,
  useRealtimeRefresh,
  useSettings,
  useTeams,
  type Player,
} from "@/lib/tournament/data";
import { gamesLabel, minutesSince, parseGames, timeLabel } from "@/lib/tournament/format";
import {
  checkStartConstraints,
  restGapForKind,
  type StartConstraints,
} from "@/lib/tournament/scheduler";
import { poolIsComplete } from "@/lib/tournament/standings";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ShuttleNet Control Desk | Live Badminton Tournament Ops" },
      {
        name: "description",
        content:
          "Live control desk for a two-day, four-category badminton tournament: court board, pool progress, draw readiness and alerts.",
      },
      { property: "og:title", content: "ShuttleNet Control Desk | Live Badminton Tournament Ops" },
      {
        property: "og:description",
        content:
          "Live control desk for a two-day, four-category badminton tournament: court board, pool progress, draw readiness and alerts.",
      },
    ],
  }),
  component: Desk,
});

type DeskMatch = {
  id: string;
  kind: "pool" | "draw";
  courtId: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  scheduled: string | null;
  teams: [string | null, string | null];
  tag: string;
  score: string | null;
};

function Desk() {
  const qc = useQueryClient();
  const { canScore } = useSession();
  useRealtimeRefresh();
  const [openMatch, setOpenMatch] = useState<DeskMatch | null>(null);
  const { data: categories } = useCategories();
  const { data: courts } = useCourts();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: pools } = usePools();
  const { data: poolMatches } = usePoolMatches();
  const { data: draws } = useDraws();
  const { data: drawMatches } = useDrawMatches();
  const { data: settings } = useSettings();
  const { data: poolEntries } = usePoolEntries();

  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const playerMap = useMemo(() => indexBy(players), [players]);
  const catMap = useMemo(() => indexBy(categories), [categories]);
  const courtMap = useMemo(() => indexBy(courts), [courts]);
  const label = (id: string | null) => teamLabel(id ? teamMap.get(id) : undefined, playerMap);

  const matchPlayerIds = (m: Pick<DeskMatch, "teams">) =>
    m.teams.flatMap((id) => (id ? teamPlayerIds(teamMap.get(id)) : []));

  const allMatches = useMemo<DeskMatch[]>(
    () => [
      ...(poolMatches ?? []).map((m) => ({
        id: m.id,
        kind: "pool" as const,
        courtId: m.court_id,
        status: m.status,
        startedAt: m.started_at,
        endedAt: m.ended_at,
        scheduled: m.scheduled_time,
        teams: [m.team_a_id, m.team_b_id] as [string | null, string | null],
        tag: catMap.get(m.category_id)?.code ?? "",
        score: m.status === "reported" ? `${m.score_a}-${m.score_b}` : null,
      })),
      ...(drawMatches ?? []).map((m) => ({
        id: m.id,
        kind: "draw" as const,
        courtId: m.court_id,
        status: m.status,
        startedAt: m.started_at,
        endedAt: m.ended_at,
        scheduled: m.scheduled_time,
        teams: [m.team_a_id, m.team_b_id] as [string | null, string | null],
        tag: `Draw ${(draws ?? []).find((d) => d.id === m.draw_id)?.tier ?? ""}`,
        score: m.status === "reported" ? gamesLabel(parseGames(m.games)) : null,
      })),
    ],
    [poolMatches, drawMatches, draws, catMap],
  );

  const refresh = () => qc.invalidateQueries();
  const current = openMatch ? (allMatches.find((m) => m.id === openMatch.id) ?? openMatch) : null;

  const startCheck = useMemo<StartConstraints | null>(() => {
    if (!current || current.status === "in-progress") return null;
    const targetPlayerIds = matchPlayerIds(current);
    if (!targetPlayerIds.length) return null;

    const others = allMatches
      .filter((m) => m.id !== current.id)
      .map((m) => ({
        id: m.id,
        playerIds: matchPlayerIds(m),
        status: m.status,
        courtNumber: m.courtId ? (courtMap.get(m.courtId)?.number ?? null) : null,
        endedAt: m.endedAt,
      }));

    const requiredRestMinutes = restGapForKind(
      current.kind === "pool" ? "group" : "knockout",
      settings?.group_rest_gap_minutes ?? 10,
      settings?.knockout_rest_gap_minutes ?? 30,
    );

    return checkStartConstraints(targetPlayerIds, requiredRestMinutes, others);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, allMatches, teamMap, courtMap, settings]);

  const latePools = useMemo(() => {
    const now = Date.now();
    return (pools ?? []).filter((pool) => {
      if (!pool.scheduled_end) return false;
      const matches = (poolMatches ?? []).filter((m) => m.pool_id === pool.id);
      const teamIds = (poolEntries ?? [])
        .filter((e) => e.pool_id === pool.id)
        .map((e) => e.team_id);
      if (poolIsComplete(teamIds, matches)) return false;
      return now > new Date(pool.scheduled_end).getTime() + 15 * 60000;
    });
  }, [pools, poolMatches, poolEntries]);

  const overCap = allMatches.filter((m) => {
    const cap =
      m.kind === "pool"
        ? (settings?.group_slot_minutes ?? 20)
        : (settings?.knockout_slot_minutes ?? 25);
    return m.status === "in-progress" && (minutesSince(m.startedAt) ?? 0) > cap;
  });

  return (
    <AppShell
      title="Control desk"
      subtitle="Live court board, pool progress and the alerts that need someone chasing."
    >
      <div className="space-y-5">
        {latePools.length || overCap.length ? (
          <Panel title="Alerts">
            <ul className="space-y-1.5 text-sm">
              {latePools.map((p) => (
                <li
                  key={p.id}
                  className="rounded-md bg-danger-surface px-2.5 py-1.5 text-danger-foreground"
                >
                  {p.name} ({catMap.get(p.category_id)?.code}) is more than 15 minutes past its
                  scheduled finish with results still missing — this blocks draw generation.
                </li>
              ))}
              {overCap.map((m) => (
                <li
                  key={m.id}
                  className="rounded-md bg-warn-surface px-2.5 py-1.5 text-warn-foreground"
                >
                  {label(m.teams[0])} vs {label(m.teams[1])} has been on court{" "}
                  {minutesSince(m.startedAt)} minutes — past the planned slot.
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        <Panel title="Court board">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(courts ?? []).map((court) => {
              const playing = allMatches.find(
                (m) => m.courtId === court.id && m.status === "in-progress",
              );
              const next = allMatches
                .filter((m) => m.courtId === court.id && m.status === "scheduled" && m.scheduled)
                .sort(
                  (a, b) =>
                    new Date(a.scheduled as string).getTime() -
                    new Date(b.scheduled as string).getTime(),
                )[0];
              const target = playing ?? next;
              return (
                <button
                  key={court.id}
                  type="button"
                  disabled={!target}
                  onClick={() => target && setOpenMatch(target)}
                  className="rounded-lg border border-hairline p-3 text-left transition-colors enabled:hover:border-primary enabled:hover:bg-muted/40 disabled:cursor-default"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-display text-sm font-bold">Court {court.number}</span>
                    <StatusPill status={playing ? "in-progress" : "scheduled"} />
                  </div>
                  <p className="mt-2 text-sm">
                    {playing ? (
                      <>
                        <span className="font-score text-[11px] text-muted-foreground">
                          {playing.tag}
                        </span>
                        <br />
                        {label(playing.teams[0])} vs {label(playing.teams[1])}
                        <br />
                        <span className="font-score text-[11px] text-muted-foreground">
                          {minutesSince(playing.startedAt)}′ on court
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Free</span>
                    )}
                  </p>
                  <p className="mt-2 border-t border-hairline pt-2 text-xs text-muted-foreground">
                    Next:{" "}
                    {next ? (
                      <>
                        {timeLabel(next.scheduled)} · {label(next.teams[0])} vs{" "}
                        {label(next.teams[1])}
                      </>
                    ) : (
                      "nothing queued"
                    )}
                  </p>
                  <p className="mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                    {target ? "Tap to enter score" : ""}
                  </p>
                </button>
              );
            })}
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Category progress">
            <ul className="divide-y divide-hairline">
              {(categories ?? []).map((c) => {
                const catPools = (pools ?? []).filter((p) => p.category_id === c.id);
                const catMatches = (poolMatches ?? []).filter((m) => m.category_id === c.id);
                const done = catMatches.filter((m) => m.status === "reported").length;
                const ready =
                  catPools.length > 0 &&
                  catPools.every((p) =>
                    poolIsComplete(
                      (poolEntries ?? []).filter((e) => e.pool_id === p.id).map((e) => e.team_id),
                      catMatches.filter((m) => m.pool_id === p.id),
                    ),
                  );
                return (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span>
                      <span className="font-semibold">{c.code}</span>{" "}
                      <span className="text-muted-foreground">
                        {(teams ?? []).filter((t) => t.category_id === c.id).length} entries ·{" "}
                        {catPools.length} pools
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="font-score text-xs">
                        {done}/{catMatches.length} group results
                      </span>
                      {ready ? (
                        <Link to="/draws" className="text-xs font-semibold text-primary">
                          Draws ready
                        </Link>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel title="Tournament totals">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Players" value={(players ?? []).length} />
              <Stat label="Entries" value={(teams ?? []).length} />
              <Stat label="Group matches" value={(poolMatches ?? []).length} />
              <Stat label="Knockout matches" value={(drawMatches ?? []).length} />
            </dl>
          </Panel>
        </div>
      </div>

      <Dialog open={!!current} onOpenChange={(o) => !o && setOpenMatch(null)}>
        <DialogContent className="sm:max-w-md">
          {current ? (
            <CourtScoreDialog
              key={current.id}
              match={current}
              nameA={label(current.teams[0])}
              nameB={label(current.teams[1])}
              signedIn={canScore}
              startCheck={startCheck}
              playerMap={playerMap}
              onDone={() => {
                refresh();
                setOpenMatch(null);
              }}
              onRefresh={refresh}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

function CourtScoreDialog({
  match,
  nameA,
  nameB,
  signedIn,
  startCheck,
  playerMap,
  onDone,
  onRefresh,
}: {
  match: DeskMatch;
  nameA: string;
  nameB: string;
  signedIn: boolean;
  startCheck: StartConstraints | null;
  playerMap: Map<string, Player>;
  onDone: () => void;
  onRefresh: () => void;
}) {
  const [values, setValues] = useState<string[][]>([
    ["", ""],
    ["", ""],
    ["", ""],
  ]);
  const [busy, setBusy] = useState(false);
  const table = match.kind === "pool" ? "pool_matches" : "draw_matches";
  const rows = match.kind === "pool" ? 1 : 3;

  const set = (row: number, col: number, v: string) =>
    setValues((prev) => prev.map((r, i) => (i === row ? r.map((c, j) => (j === col ? v : c)) : r)));

  const games = values
    .slice(0, rows)
    .filter((r) => r[0] !== "" && r[1] !== "")
    .map((r) => ({ a: Number(r[0]), b: Number(r[1]) }));

  const submit = async () => {
    setBusy(true);
    try {
      if (match.kind === "pool") {
        const g = games[0];
        if (!g) throw new Error("Enter both scores.");
        await reportPoolMatch(match.id, g.a, g.b);
      } else {
        await reportDrawMatch(match.id, games);
      }
      toast.success("Result recorded");
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save result");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-display">
          {nameA} vs {nameB}
        </DialogTitle>
        <DialogDescription>
          {match.tag} · {match.kind === "pool" ? "single game to 21" : "best of three"} ·{" "}
          {match.status === "in-progress"
            ? `${minutesSince(match.startedAt)}′ on court`
            : timeLabel(match.scheduled)}
        </DialogDescription>
      </DialogHeader>

      {match.status === "reported" ? (
        <div className="space-y-3">
          <p className="font-score text-2xl">{match.score}</p>
          {signedIn ? (
            <Button
              variant="outline"
              onClick={async () => {
                await resetMatch(table, match.id);
                onRefresh();
              }}
            >
              Correct this result
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              {rows > 1 ? (
                <span className="w-14 text-xs text-muted-foreground">Game {i + 1}</span>
              ) : null}
              <Input
                className="h-10 w-20 font-score"
                inputMode="numeric"
                value={values[i]?.[0] ?? ""}
                disabled={!signedIn}
                onChange={(e) => set(i, 0, e.target.value)}
                aria-label={`Game ${i + 1} ${nameA}`}
              />
              <span className="text-muted-foreground">–</span>
              <Input
                className="h-10 w-20 font-score"
                inputMode="numeric"
                value={values[i]?.[1] ?? ""}
                disabled={!signedIn}
                onChange={(e) => set(i, 1, e.target.value)}
                aria-label={`Game ${i + 1} ${nameB}`}
              />
            </div>
          ))}
          {match.status !== "in-progress" &&
          (startCheck?.conflicts.length || startCheck?.warnings.length) ? (
            <ul className="space-y-1 text-xs">
              {(startCheck?.conflicts ?? []).map((c, i) => (
                <li
                  key={`conflict-${i}`}
                  className="rounded-md bg-danger-surface px-2 py-1 text-danger-foreground"
                >
                  {playerMap.get(c.playerId)?.name ?? "A player"} is currently playing
                  {c.courtNumber ? ` on Court ${c.courtNumber}` : " another match"} — this match
                  can't start until they finish.
                </li>
              ))}
              {(startCheck?.warnings ?? []).map((w, i) => (
                <li
                  key={`warning-${i}`}
                  className="rounded-md bg-warn-surface px-2 py-1 text-warn-foreground"
                >
                  {playerMap.get(w.playerId)?.name ?? "A player"} has only rested {w.restMinutes} of{" "}
                  {w.requiredMinutes} min since their last match.
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex gap-2">
            <Button disabled={!signedIn || busy || games.length === 0} onClick={submit}>
              Report result
            </Button>
            {match.status !== "in-progress" ? (
              <Button
                variant="outline"
                disabled={!signedIn || busy || !!startCheck?.conflicts.length}
                onClick={async () => {
                  try {
                    await startMatch(table, match.id, match.courtId);
                    toast.success("Match started");
                    onRefresh();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Could not start the match");
                  }
                }}
              >
                Start match
              </Button>
            ) : null}
          </div>
          {!signedIn ? (
            <p className="text-xs text-muted-foreground">Sign in at the desk to enter scores.</p>
          ) : null}
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-hairline p-3">
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="font-score text-2xl font-semibold">{value}</dd>
    </div>
  );
}
