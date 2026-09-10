import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell, EmptyState, Panel, StatTile } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { useSession } from "@/hooks/useSession";
import {
  reportDrawMatch,
  reportPoolMatch,
  rescheduleMatch,
  resetMatch,
  resolveMatchException,
  startMatch,
  type ScheduleImpact,
} from "@/lib/tournament/actions";
import {
  indexBy,
  teamLabel,
  teamPlayerIds,
  useCategories,
  useCourts,
  useDeskActivity,
  useDrawMatches,
  useDraws,
  usePlayers,
  usePoolEntries,
  usePoolMatches,
  usePools,
  useRealtimeRefresh,
  useSettings,
  useTeams,
  type Court,
  type Player,
} from "@/lib/tournament/data";
import {
  gamesLabel,
  gamesWinner,
  isLegalGameScore,
  minutesSince,
  parseGames,
  timeLabel,
} from "@/lib/tournament/format";
import {
  checkStartConstraints,
  restGapForKind,
  type StartConstraints,
} from "@/lib/tournament/scheduler";
import {
  deriveCourtState,
  getMatchReadiness,
  getOperationalKpis,
  upcomingMatches,
  type DeskMatchModel,
  type MatchReadiness,
} from "@/lib/tournament/desk";
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

export type DeskMatch = DeskMatchModel & {
  teams: [string | null, string | null];
  tag: string;
  score: string | null;
};

function Desk() {
  const qc = useQueryClient();
  const { canScore, canSchedule, signedIn } = useSession();
  const live = useRealtimeRefresh();
  const [openMatch, setOpenMatch] = useState<DeskMatch | null>(null);
  const [operationCourtId, setOperationCourtId] = useState<string | null>(null);
  const [queueSearch, setQueueSearch] = useState("");
  const [now, setNow] = useState(() => Date.now());
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
  const { data: activity } = useDeskActivity(signedIn);

  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const playerMap = useMemo(() => indexBy(players), [players]);
  const catMap = useMemo(() => indexBy(categories), [categories]);
  const courtMap = useMemo(() => indexBy(courts), [courts]);
  const label = (id: string | null) => teamLabel(id ? teamMap.get(id) : undefined, playerMap);

  const matchPlayerIds = (m: Pick<DeskMatch, "teams">) =>
    m.teams.flatMap((id) => (id ? teamPlayerIds(teamMap.get(id)) : []));

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

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
        playerIds: [m.team_a_id, m.team_b_id].flatMap((id) =>
          id ? teamPlayerIds(teamMap.get(id)) : [],
        ),
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
        playerIds: [m.team_a_id, m.team_b_id].flatMap((id) =>
          id ? teamPlayerIds(teamMap.get(id)) : [],
        ),
        tag: `Draw ${(draws ?? []).find((d) => d.id === m.draw_id)?.tier ?? ""}`,
        score: m.status === "reported" ? gamesLabel(parseGames(m.games)) : null,
      })),
    ],
    [poolMatches, drawMatches, draws, catMap, teamMap],
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
    return (pools ?? []).filter((pool) => {
      if (!pool.scheduled_end) return false;
      const matches = (poolMatches ?? []).filter((m) => m.pool_id === pool.id);
      const teamIds = (poolEntries ?? [])
        .filter((e) => e.pool_id === pool.id)
        .map((e) => e.team_id);
      if (poolIsComplete(teamIds, matches)) return false;
      return now > new Date(pool.scheduled_end).getTime() + 15 * 60000;
    });
  }, [pools, poolMatches, poolEntries, now]);

  const overCap = allMatches.filter((m) => {
    const cap =
      m.kind === "pool"
        ? (settings?.group_slot_minutes ?? 20)
        : (settings?.knockout_slot_minutes ?? 25);
    return m.status === "in-progress" && (minutesSince(m.startedAt, now) ?? 0) > cap;
  });

  const slotMinutesFor = (match: DeskMatch) =>
    match.kind === "pool"
      ? (settings?.group_slot_minutes ?? 20)
      : (settings?.knockout_slot_minutes ?? 25);
  const restMinutesFor = (match: DeskMatch) =>
    match.kind === "pool"
      ? (settings?.group_rest_gap_minutes ?? 10)
      : (settings?.knockout_rest_gap_minutes ?? 30);
  const courtStates = (courts ?? []).map((court) => ({
    court,
    state: deriveCourtState(court.id, allMatches, slotMinutesFor, restMinutesFor, now),
  }));
  const kpis = getOperationalKpis(
    courtStates.map(({ state }) => state),
    allMatches,
    slotMinutesFor,
  );
  const upcoming = upcomingMatches(allMatches, now, 60);
  const visibleUpcoming = upcoming.filter((match) => {
    const query = queueSearch.trim().toLocaleLowerCase();
    if (!query) return true;
    return `${label(match.teams[0])} ${label(match.teams[1])} ${match.tag}`
      .toLocaleLowerCase()
      .includes(query);
  });
  const currentDelay = Math.max(
    0,
    ...courtStates.map(({ state }) => state.varianceMinutes ?? 0),
  );
  const readyUnassigned = allMatches
    .filter((match) => match.status === "scheduled" && !match.courtId)
    .filter(
      (match) =>
        getMatchReadiness(match, allMatches, restMinutesFor(match), now).state === "ready",
    )
    .sort(
      (a, b) =>
        new Date(a.scheduled ?? 0).getTime() - new Date(b.scheduled ?? 0).getTime(),
    );

  return (
    <AppShell
      title="Control desk"
      subtitle="Live court board, pool progress and the alerts that need someone chasing."
      actions={
        <>
          <ConnectionBadge status={live.status} lastUpdatedAt={live.lastUpdatedAt} now={now} />
          <Button size="sm" variant="outline" onClick={() => void qc.invalidateQueries()}>
            Refresh
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <DeskKpi label="Courts active" value={`${kpis.activeCourts}/${(courts ?? []).length}`} />
          <DeskKpi label="Ready courts" value={courtStates.filter(({ state }) => state.state === "free-ready").length} />
          <DeskKpi label="Waiting courts" value={kpis.waitingCourts} tone={kpis.waitingCourts ? "warn" : "normal"} />
          <DeskKpi label="Current delay" value={`${currentDelay}m`} tone={currentDelay ? "warn" : "normal"} />
          <DeskKpi label="Matches left" value={kpis.remainingMatches} />
          <DeskKpi label="Projected finish" value={timeLabel(kpis.projectedFinish ? new Date(kpis.projectedFinish) : null)} />
        </div>

        <Panel
          title="Act now"
          right={
            <span className="text-[11px] text-muted-foreground">
              {timeLabel(new Date(now))} · updates every 30s
            </span>
          }
        >
          <div aria-live="polite">
          {latePools.length || overCap.length || courtStates.some(({ state }) => state.state === "free-ready") ? (
            <ul className="space-y-1.5 text-sm">
              {courtStates
                .filter(({ state }) => state.state === "free-ready" && state.next)
                .map(({ court, state }) => (
                  <li key={`ready-${court.id}`}>
                    <button
                      type="button"
                      className="w-full rounded-md bg-mint/15 px-2.5 py-2 text-left font-medium hover:bg-mint/25"
                      onClick={() => {
                        setOperationCourtId(court.id);
                        setOpenMatch(state.next);
                      }}
                    >
                      Court {court.number} is free — start {state.next ? `${label(state.next.teams[0])} vs ${label(state.next.teams[1])}` : "the next match"}
                    </button>
                  </li>
                ))}
              {latePools.map((p) => (
                <li
                  key={p.id}
                  className="rounded-md bg-danger-surface px-2.5 py-1.5 text-danger-foreground"
                >
                  {p.name} ({catMap.get(p.category_id)?.code}) is more than 15 minutes past its
                  scheduled finish with results still missing —{" "}
                  <Link to="/matches" className="font-semibold underline">
                    enter results
                  </Link>
                  .
                </li>
              ))}
              {overCap.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="w-full rounded-md bg-warn-surface px-2.5 py-2 text-left text-warn-foreground hover:brightness-95"
                    onClick={() => {
                      setOperationCourtId(m.courtId);
                      setOpenMatch(m);
                    }}
                  >
                    {label(m.teams[0])} vs {label(m.teams[1])} has been on court{" "}
                    {minutesSince(m.startedAt, now)} minutes — open the score desk.
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="All clear" hint="No urgent desk actions right now." />
          )}

          </div>
        </Panel>

        <Panel title="Court board">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {courtStates.map(({ court, state }) => {
              const target = state.playing ?? state.next ?? readyUnassigned[0];
              return (
                <button
                  key={court.id}
                  type="button"
                  disabled={!target}
                  aria-label={`Court ${court.number}: ${state.state.replace("-", " ")}`}
                  onClick={() => {
                    if (!target) return;
                    setOperationCourtId(court.id);
                    setOpenMatch(target);
                  }}
                  className={`rounded-xl border p-3.5 text-left shadow-panel transition-all enabled:hover:-translate-y-0.5 enabled:hover:border-primary/60 enabled:hover:shadow-raise disabled:cursor-default disabled:opacity-80 ${
                    state.state === "overrun"
                      ? "border-danger-border bg-danger-surface/40"
                      : state.state === "free-ready"
                        ? "border-primary/40 bg-primary/5"
                        : state.state === "playing"
                          ? "border-amber/40 bg-amber/5"
                          : "border-hairline bg-surface"
                  }`}

                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 font-display text-sm font-bold">
                      <span className="grid size-6 place-items-center rounded-md bg-primary/10 font-score text-[11px] text-primary">
                        {court.number}
                      </span>
                      Court {court.number}
                    </span>
                    <CourtStatePill state={state.state} />
                  </div>

                  <p className="mt-2 text-sm">
                    {state.playing ? (
                      <>
                        <span className="font-score text-[11px] text-muted-foreground">
                          {state.playing.tag}
                        </span>
                        <br />
                        {label(state.playing.teams[0])} vs {label(state.playing.teams[1])}
                        <br />
                        <span
                          className={`font-score text-[11px] ${
                            state.state === "overrun"
                              ? "font-semibold text-danger-foreground"
                              : "text-muted-foreground"
                          }`}
                        >
                          {state.elapsedMinutes}′ on court
                          {state.varianceMinutes
                            ? ` · started ${Math.abs(state.varianceMinutes)} min ${
                                state.varianceMinutes > 0 ? "late" : "early"
                              }`
                            : ""}
                        </span>
                      </>
                    ) : (
                      <span className="font-medium">
                        {state.state === "free-ready"
                          ? "Free — next match ready"
                          : state.state === "free-blocked"
                            ? "Free — waiting for players"
                            : "Idle"}
                      </span>
                    )}
                  </p>
                  <p className="mt-2 border-t border-hairline pt-2 text-xs text-muted-foreground">
                    Next:{" "}
                    {state.next ? (
                      <>
                        {timeLabel(state.next.scheduled)} · {label(state.next.teams[0])} vs{" "}
                        {label(state.next.teams[1])}
                        <br />
                        <ReadinessText
                          readiness={state.readiness}
                          courts={courtMap}
                          players={playerMap}
                        />
                      </>
                    ) : readyUnassigned[0] ? (
                      <>Ready unassigned: {label(readyUnassigned[0].teams[0])} vs {label(readyUnassigned[0].teams[1])}</>
                    ) : (
                      "nothing queued"
                    )}
                  </p>
                  <p className="mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                    {state.playing
                      ? "Open score desk"
                      : target
                        ? "Open next match"
                        : ""}
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
                const done = catMatches.filter((m) =>
                  ["reported", "walkover"].includes(m.status),
                ).length;
                const catDrawIds = (draws ?? [])
                  .filter((draw) => draw.category_id === c.id)
                  .map((draw) => draw.id);
                const catDrawMatches = (drawMatches ?? []).filter((match) =>
                  catDrawIds.includes(match.draw_id),
                );
                const knockoutDone = catDrawMatches.filter((match) =>
                  ["reported", "walkover"].includes(match.status),
                ).length;
                const bottleneck = catPools
                  .map((pool) => {
                    const matches = catMatches.filter((match) => match.pool_id === pool.id);
                    return {
                      pool,
                      missing: matches.filter(
                        (match) => !["reported", "walkover", "void"].includes(match.status),
                      ).length,
                    };
                  })
                  .sort((a, b) => b.missing - a.missing)[0];
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
                        {catDrawMatches.length
                          ? ` · ${knockoutDone}/${catDrawMatches.length} knockout`
                          : bottleneck?.missing
                            ? ` · ${bottleneck.pool.name} needs ${bottleneck.missing}${
                                bottleneck.pool.scheduled_end
                                  ? ` · due ${timeLabel(bottleneck.pool.scheduled_end)}`
                                  : ""
                              }`
                            : ""}
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

          <Panel
            title="Next 60 minutes"
            right={
              <Input
                className="h-8 w-40"
                value={queueSearch}
                onChange={(event) => setQueueSearch(event.target.value)}
                placeholder="Find player or team"
                aria-label="Search upcoming matches"
              />
            }
          >
            {visibleUpcoming.length ? (
              <ul className="divide-y divide-hairline">
                {visibleUpcoming.slice(0, 10).map((match) => {
                  const readiness = getMatchReadiness(
                    match,
                    allMatches,
                    restMinutesFor(match),
                    now,
                  );
                  return (
                    <li key={match.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 py-2 text-left text-sm hover:text-primary"
                        onClick={() => {
                          setOperationCourtId(match.courtId);
                          setOpenMatch(match);
                        }}
                      >
                        <span className="w-12 font-score text-xs">{timeLabel(match.scheduled)}</span>
                        <span className="min-w-0 flex-1 truncate">
                          {label(match.teams[0])} vs {label(match.teams[1])}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {match.courtId ? `C${courtMap.get(match.courtId)?.number ?? "?"}` : "Unassigned"}
                          {" · "}
                          {readiness.state === "ready"
                            ? "Ready"
                            : readiness.state === "resting"
                              ? `${readiness.remainingMinutes}m rest`
                              : readiness.state === "player-busy"
                                ? "Player busy"
                                : "TBC"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {queueSearch ? "No upcoming match matches that search." : "Nothing scheduled in the next hour."}
              </p>
            )}
          </Panel>
        </div>

        {signedIn ? (
          <Panel title="Recent desk activity">
            {(activity ?? []).length ? (
              <ul className="grid gap-x-5 gap-y-2 text-sm sm:grid-cols-2">
                {(activity ?? []).slice(0, 8).map((entry) => {
                  const changed = allMatches.find((match) => match.id === entry.match_id);
                  return (
                    <li key={entry.id} className="flex items-center gap-2">
                      <span className="w-12 shrink-0 font-score text-xs text-muted-foreground">
                        {timeLabel(entry.occurred_at)}
                      </span>
                      <span className="font-medium capitalize">
                        {entry.action.replaceAll("-", " ")}
                      </span>
                      <span className="min-w-0 truncate text-muted-foreground">
                        {changed
                          ? `${label(changed.teams[0])} vs ${label(changed.teams[1])}`
                          : entry.match_id.slice(0, 8)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No desk changes recorded yet.</p>
            )}
          </Panel>
        ) : null}
      </div>

      <Dialog open={!!current} onOpenChange={(o) => !o && setOpenMatch(null)}>
        <DialogContent className="sm:max-w-md">
          {current ? (
            <MatchOperationsDialog
              key={current.id}
              match={current}
              nameA={label(current.teams[0])}
              nameB={label(current.teams[1])}
              courtId={operationCourtId ?? current.courtId}
              courtNumber={
                operationCourtId || current.courtId
                  ? (courtMap.get(operationCourtId ?? current.courtId ?? "")?.number ?? null)
                  : null
              }
              courts={courts ?? []}
              signedIn={canScore}
              canSchedule={canSchedule}
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

export function MatchOperationsDialog({
  match,
  nameA,
  nameB,
  courtId,
  courtNumber,
  courts,
  signedIn,
  canSchedule,
  startCheck,
  playerMap,
  onDone,
  onRefresh,
}: {
  match: DeskMatch;
  nameA: string;
  nameB: string;
  courtId: string | null;
  courtNumber: number | null;
  courts: Court[];
  signedIn: boolean;
  canSchedule: boolean;
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
  const [exceptionMode, setExceptionMode] = useState<"walkover" | "void" | "move" | null>(
    null,
  );
  const [note, setNote] = useState("");
  const [winnerId, setWinnerId] = useState(match.teams[0] ?? "");
  const [moveCourtId, setMoveCourtId] = useState(courtId ?? "");
  const [moveTime, setMoveTime] = useState(() => localDateTimeValue(match.scheduled));
  const table = match.kind === "pool" ? "pool_matches" : "draw_matches";
  const rows = match.kind === "pool" ? 1 : 3;

  const set = (row: number, col: number, v: string) =>
    setValues((prev) => prev.map((r, i) => (i === row ? r.map((c, j) => (j === col ? v : c)) : r)));

  const games = values
    .slice(0, rows)
    .filter((r) => r[0] !== "" && r[1] !== "")
    .map((r) => ({ a: Number(r[0]), b: Number(r[1]) }));
  const canSubmit =
    match.kind === "pool"
      ? !!games[0] && isLegalGameScore(games[0].a, games[0].b)
      : !!gamesWinner(games);

  const submit = async () => {
    if (
      match.status !== "in-progress" &&
      !window.confirm("This match has not been started. Report the result anyway?")
    ) {
      return;
    }
    setBusy(true);
    try {
      let impact: ScheduleImpact;
      if (match.kind === "pool") {
        const g = games[0];
        if (!g) throw new Error("Enter both scores.");
        impact = await reportPoolMatch(match.id, g.a, g.b);
      } else {
        impact = await reportDrawMatch(match.id, games);
      }
      toast.success(impactMessage("Result recorded", impact));
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save result");
    } finally {
      setBusy(false);
    }
  };

  const resolveException = async () => {
    if (exceptionMode !== "walkover" && exceptionMode !== "void") return;
    if (!note.trim()) {
      toast.error("Add a note explaining this exception.");
      return;
    }
    if (exceptionMode === "walkover" && !winnerId) {
      toast.error("Select the walkover winner.");
      return;
    }
    if (
      !window.confirm(
        exceptionMode === "walkover"
          ? "Record this match as a walkover?"
          : "Void this match? It will no longer count toward the tournament.",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const impact = await resolveMatchException(
        table,
        match.id,
        exceptionMode,
        exceptionMode === "walkover" ? winnerId : null,
        note.trim(),
      );
      toast.success(
        impactMessage(exceptionMode === "walkover" ? "Walkover recorded" : "Match voided", impact),
      );
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not resolve the match");
    } finally {
      setBusy(false);
    }
  };

  const moveMatch = async () => {
    if (!moveCourtId || !moveTime) {
      toast.error("Select a court and time.");
      return;
    }
    setBusy(true);
    try {
      await rescheduleMatch(table, match.id, moveCourtId, new Date(moveTime).toISOString());
      toast.success("Match court and time updated");
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not move the match");
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
          {match.tag} · {match.kind === "pool" ? "single game to 21" : "best of three"}
          {courtNumber ? ` · Court ${courtNumber}` : ""} ·{" "}
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
                const correctionNote = window.prompt("Why is this result being corrected?");
                if (!correctionNote?.trim()) return;
                try {
                  await resetMatch(table, match.id, correctionNote.trim());
                  toast.success("Result reopened for correction");
                  onRefresh();
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : "Could not reopen the result",
                  );
                }
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
                autoFocus={i === 0}
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
            <Button disabled={!signedIn || busy || !canSubmit} onClick={submit}>
              Report result
            </Button>
            {match.status !== "in-progress" ? (
              <Button
                variant="outline"
                disabled={!signedIn || busy || !!startCheck?.conflicts.length}
                onClick={async () => {
                  const restWarnings = startCheck?.warnings ?? [];
                  if (
                    restWarnings.length &&
                    !window.confirm(
                      `${restWarnings
                        .map(
                          (w) =>
                            `${playerMap.get(w.playerId)?.name ?? "A player"} has rested only ${w.restMinutes} of ${w.requiredMinutes} min.`,
                        )
                        .join("\n")}\n\nStart this match anyway?`,
                    )
                  ) {
                    return;
                  }
                  try {
                    setBusy(true);
                    await startMatch(table, match.id, courtId, restWarnings.length > 0);
                    toast.success("Match started");
                    onDone();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Could not start the match");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Start match
              </Button>
            ) : null}
          </div>
          {signedIn || canSchedule ? (
            <div className="border-t border-hairline pt-3">
              <div className="flex flex-wrap gap-2">
                {signedIn ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        setExceptionMode(exceptionMode === "walkover" ? null : "walkover")
                      }
                    >
                      Walkover
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setExceptionMode(exceptionMode === "void" ? null : "void")}
                    >
                      Void
                    </Button>
                  </>
                ) : null}
                {match.status === "scheduled" && (signedIn || canSchedule) ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setExceptionMode(exceptionMode === "move" ? null : "move")}
                  >
                    Move / delay
                  </Button>
                ) : null}
              </div>

              {exceptionMode === "walkover" || exceptionMode === "void" ? (
                <div className="mt-3 space-y-2 rounded-lg bg-muted/50 p-3">
                  {exceptionMode === "walkover" ? (
                    <label className="block text-xs font-medium">
                      Winner
                      <select
                        className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                        value={winnerId}
                        onChange={(event) => setWinnerId(event.target.value)}
                      >
                        <option value={match.teams[0] ?? ""}>{nameA}</option>
                        <option value={match.teams[1] ?? ""}>{nameB}</option>
                      </select>
                    </label>
                  ) : null}
                  <label className="block text-xs font-medium">
                    Operator note
                    <Input
                      className="mt-1"
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder={
                        exceptionMode === "walkover"
                          ? "Example: Team B did not arrive"
                          : "Reason for voiding this match"
                      }
                    />
                  </label>
                  <Button size="sm" disabled={busy || !note.trim()} onClick={resolveException}>
                    Confirm {exceptionMode}
                  </Button>
                </div>
              ) : null}

              {exceptionMode === "move" ? (
                <div className="mt-3 grid gap-2 rounded-lg bg-muted/50 p-3 sm:grid-cols-2">
                  <label className="block text-xs font-medium">
                    Court
                    <select
                      className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={moveCourtId}
                      onChange={(event) => setMoveCourtId(event.target.value)}
                    >
                      <option value="">Select court</option>
                      {courts.map((court) => (
                        <option key={court.id} value={court.id}>
                          Court {court.number}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs font-medium">
                    Start time
                    <Input
                      className="mt-1"
                      type="datetime-local"
                      value={moveTime}
                      onChange={(event) => setMoveTime(event.target.value)}
                    />
                  </label>
                  <Button
                    className="sm:col-span-2"
                    size="sm"
                    disabled={busy || !moveCourtId || !moveTime}
                    onClick={moveMatch}
                  >
                    Check constraints and update
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {!signedIn ? (
            <p className="text-xs text-muted-foreground">Sign in at the desk to enter scores.</p>
          ) : null}
        </div>
      )}
    </>
  );
}

function DeskKpi({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: string | number;
  tone?: "normal" | "warn" | "danger";
}) {
  return <StatTile label={label} value={value} tone={tone} />;
}


function CourtStatePill({
  state,
}: {
  state: "playing" | "overrun" | "free-ready" | "free-blocked" | "idle";
}) {
  const labels = {
    playing: "Playing",
    overrun: "Overrun",
    "free-ready": "Ready",
    "free-blocked": "Waiting",
    idle: "Idle",
  };
  const classes = {
    playing: "bg-amber/25 text-foreground",
    overrun: "bg-danger-surface text-danger-foreground",
    "free-ready": "bg-mint/20 text-foreground",
    "free-blocked": "bg-warn-surface text-warn-foreground",
    idle: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 font-score text-[10px] uppercase tracking-wider ${classes[state]}`}
    >
      {labels[state]}
    </span>
  );
}

function ReadinessText({
  readiness,
  courts,
  players,
}: {
  readiness: MatchReadiness | null;
  courts: ReadonlyMap<string, { number: number }>;
  players: ReadonlyMap<string, Player>;
}) {
  if (!readiness) return null;
  if (readiness.state === "ready") return <span className="font-medium text-primary">Ready now</span>;
  if (readiness.state === "resting") {
    return (
      <span className="text-warn-foreground">
        {readiness.playerId ? `${players.get(readiness.playerId)?.name ?? "Player"} · ` : ""}
        ready in {readiness.remainingMinutes} min
      </span>
    );
  }
  if (readiness.state === "player-busy") {
    return (
      <span className="text-danger-foreground">
        {readiness.playerId ? `${players.get(readiness.playerId)?.name ?? "Player"} · ` : ""}
        on Court {readiness.blockingCourtId ? (courts.get(readiness.blockingCourtId)?.number ?? "?") : "?"}
      </span>
    );
  }
  return <span>Teams not assigned</span>;
}

function impactMessage(prefix: string, impact: ScheduleImpact): string {
  if (!impact.shiftedMatches) return prefix;
  const direction =
    impact.direction === "mixed" ? "in both directions" : `${impact.direction}`;
  return `${prefix}. ${impact.shiftedMatches} later match${
    impact.shiftedMatches === 1 ? "" : "es"
  } shifted ${direction} by up to ${impact.largestShiftMinutes} min.`;
}

function localDateTimeValue(value: string | null): string {
  const date = value ? new Date(value) : new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function ConnectionBadge({
  status,
  lastUpdatedAt,
  now,
}: {
  status: "connecting" | "live" | "offline" | "error";
  lastUpdatedAt: number;
  now: number;
}) {
  const ageMinutes = Math.max(0, Math.floor((now - lastUpdatedAt) / 60_000));
  const label =
    status === "live"
      ? ageMinutes > 1
        ? `Live · last change ${ageMinutes}m ago`
        : "Live"
      : status === "offline"
        ? "Offline · changes unavailable"
        : status === "error"
          ? "Connection error"
          : "Connecting";
  return (
    <span
      role="status"
      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
        status === "live"
          ? "bg-mint/20 text-foreground"
          : status === "offline" || status === "error"
            ? "bg-danger-surface text-danger-foreground"
            : "bg-warn-surface text-warn-foreground"
      }`}
    >
      {label}
    </span>
  );
}
