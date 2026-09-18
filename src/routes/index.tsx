import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  resolveMatchException,
  startMatch,
  type ScheduleImpact,
} from "@/lib/tournament/actions";
import {
  reportPlacementMatch,
  reportTierDrawMatch,
  reschedulePlacementMatch,
  resetPlacementResult,
  resetTierDrawResult,
  scheduleImpactNote,
  startPlacementMatch,
  startTierDrawMatch,
} from "@/lib/tournament/placement-actions";
import {
  indexBy,
  teamLabel,
  teamPlayerIds,
  useActiveTournament,
  useCategories,
  useCourts,
  useDeskActivity,
  useDrawMatches,
  useDraws,
  usePlacementEntrants,
  usePlacementMatches,
  usePlayers,
  usePoolEntries,
  usePoolMatches,
  usePools,
  useRealtimeRefresh,
  useTeams,
  useTierDrawMatches,
  useTierDraws,
  useTournamentDayBreaks,
  useTournamentDayCourts,
  useTournamentDays,
  type Court,
  type PlacementMatch,
  type Player,
  type TournamentDayBreak,
} from "@/lib/tournament/data";
import {
  gamesLabel,
  gamesWinnerFor,
  isLegalGameScoreFor,
  minutesSince,
  parseGames,
  timeLabel,
  type GameScore,
} from "@/lib/tournament/format";
import {
  DEFAULT_KNOCKOUT_RULE,
  DEFAULT_PLACEMENT_RULE,
  gamesNeededToWin,
  LEGACY_GAME_RULE,
  ruleForStage,
  scoringRuleLabel,
  type ScoringRule,
} from "@/lib/tournament/scoring";
import {
  checkStartConstraints,
  restGapForKind,
  type StartConstraints,
} from "@/lib/tournament/scheduling/live-constraints";
import {
  deriveCourtState,
  deskKindPhase,
  deskKindScoringStage,
  deskKindTable,
  finishStatusLabel,
  getMatchReadiness,
  getOperationalKpis,
  isPlacementKind,
  type DeskMatchModel,
  type MatchReadiness,
} from "@/lib/tournament/desk";
import { poolIsComplete } from "@/lib/tournament/standings";
import { buildDeskMatches, type DeskMatch } from "@/lib/tournament/desk-matches";
import { estimateFinish } from "@/lib/tournament/finish-estimate";
import { FinishEstimate } from "@/components/finish-estimate";

const MINUTE = 60_000;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ShuttleNet Control Desk | Live Badminton Tournament Ops" },
      {
        name: "description",
        content:
          "Live control desk for a badminton tournament: court board, pool progress, draw readiness and alerts.",
      },
      { property: "og:title", content: "ShuttleNet Control Desk | Live Badminton Tournament Ops" },
      {
        property: "og:description",
        content:
          "Live control desk for a badminton tournament: court board, pool progress, draw readiness and alerts.",
      },
    ],
  }),
  component: Desk,
});

export type { DeskMatch };

function scoreFormValues(rows: number, status: string, initialGames?: GameScore[]) {
  if (status !== "reported" || !initialGames?.length) {
    return Array.from({ length: rows }, () => ["", ""]);
  }
  return Array.from({ length: rows }, (_, i) => {
    const game = initialGames[i];
    return game ? [String(game.a), String(game.b)] : ["", ""];
  });
}

function Desk() {
  const qc = useQueryClient();
  const { canScore, canSchedule, signedIn } = useSession();
  const live = useRealtimeRefresh();
  const [openMatch, setOpenMatch] = useState<DeskMatch | null>(null);
  const [operationCourtId, setOperationCourtId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { data: categories } = useCategories();
  const { data: courts } = useCourts();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: pools } = usePools();
  const { data: poolMatches } = usePoolMatches();
  const { data: draws } = useDraws();
  const { data: drawMatches } = useDrawMatches();
  const { data: tournament } = useActiveTournament();
  const { data: tournamentDays } = useTournamentDays();
  const { data: poolEntries } = usePoolEntries();
  const { data: activity } = useDeskActivity(signedIn);
  // The two-round placement format keeps its own tables, so the desk reads them
  // alongside the round-robin ones rather than instead of them.
  const { data: placementEntrants } = usePlacementEntrants();
  const { data: placementMatches } = usePlacementMatches();
  const { data: tierDraws } = useTierDraws();
  const { data: tierDrawMatches } = useTierDrawMatches();
  // The finish forecast runs the same problem the schedule page does, so it needs the
  // same per-day court sets and breaks. Omitting them would forecast a day playing on
  // every court in the venue, which is optimistic about capacity, not conservative.
  const { data: dayCourts } = useTournamentDayCourts(tournament?.id);
  const { data: dayBreaks } = useTournamentDayBreaks(tournament?.id);

  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const playerMap = useMemo(() => indexBy(players), [players]);
  const catMap = useMemo(() => indexBy(categories), [categories]);
  const courtMap = useMemo(() => indexBy(courts), [courts]);
  const entrantMap = useMemo(() => indexBy(placementEntrants), [placementEntrants]);

  /**
   * A placement match holds entrant ids, and an entrant is what points at a team.
   * Everything downstream — court readiness, rest gaps, the card label — speaks in
   * teams, so this is the one place that hop is made.
   */
  const entrantTeam = useCallback(
    (entrantId: string | null) => (entrantId ? (entrantMap.get(entrantId)?.team_id ?? null) : null),
    [entrantMap],
  );

  /**
   * What round a placement match belongs to, which the desk needs on the card: a
   * make-up match is why one player appears twice in round two, and a crossover is
   * an official part of tiering rather than a spare qualifier.
   */
  const placementTag = useCallback(
    (match: PlacementMatch) => {
      const code = catMap.get(match.category_id)?.code;
      const round =
        match.stage === "round1"
          ? "R1"
          : match.is_makeup
            ? "R2 make-up"
            : match.is_crossover
              ? "R2 crossover"
              : "R2";
      return [code, round].filter(Boolean).join(" ");
    },
    [catMap],
  );

  /**
   * The scoring rule a match is played under. Three stages, three rules: pool
   * matches are the legacy single game to 21, the placement rounds use the
   * tournament's placement rule, and both knockout brackets use the knockout rule.
   */
  const ruleFor = useCallback(
    (kind: DeskMatch["kind"]) => {
      const stage = deskKindScoringStage(kind);
      if (stage === "legacy") return LEGACY_GAME_RULE;
      if (tournament) return ruleForStage(tournament, stage);
      return stage === "placement" ? DEFAULT_PLACEMENT_RULE : DEFAULT_KNOCKOUT_RULE;
    },
    [tournament],
  );
  const label = (id: string | null) => teamLabel(id ? teamMap.get(id) : undefined, playerMap);

  const matchPlayerIds = (m: Pick<DeskMatch, "teams">) =>
    m.teams.flatMap((id) => (id ? teamPlayerIds(teamMap.get(id)) : []));

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  const allMatches = useMemo<DeskMatch[]>(
    () =>
      buildDeskMatches({
        poolMatches,
        drawMatches,
        draws,
        placementMatches,
        tierMatches: tierDrawMatches,
        tierDraws,
        teams,
        categories,
        entrantTeam,
      }),
    [
      poolMatches,
      drawMatches,
      draws,
      placementMatches,
      tierDrawMatches,
      tierDraws,
      teams,
      categories,
      entrantTeam,
    ],
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
      deskKindPhase(current.kind),
      tournament?.group_rest_gap_minutes ?? 10,
      tournament?.knockout_rest_gap_minutes ?? 30,
    );

    return checkStartConstraints(targetPlayerIds, requiredRestMinutes, others);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, allMatches, teamMap, courtMap, tournament]);

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
      deskKindPhase(m.kind) === "group"
        ? (tournament?.group_slot_minutes ?? 20)
        : (tournament?.knockout_slot_minutes ?? 25);
    return m.status === "in-progress" && (minutesSince(m.startedAt, now) ?? 0) > cap;
  });

  const slotMinutesFor = (match: DeskMatch) =>
    deskKindPhase(match.kind) === "group"
      ? (tournament?.group_slot_minutes ?? 20)
      : (tournament?.knockout_slot_minutes ?? 25);
  const restMinutesFor = (match: DeskMatch) =>
    deskKindPhase(match.kind) === "group"
      ? (tournament?.group_rest_gap_minutes ?? 10)
      : (tournament?.knockout_rest_gap_minutes ?? 30);
  const courtStates = (courts ?? []).map((court) => ({
    court,
    state: deriveCourtState(court.id, allMatches, slotMinutesFor, restMinutesFor, now),
  }));

  /**
   * The tournament-wide finish forecast for the Desk.
   *
   * `projectedFinishFromRemaining` only sees rows that already have a time, so an unplaced match
   * could not move it: it was a floor wearing a forecast's label. The estimator folds in unplaced
   * matches, unavoidable Placement Round 2 and not-yet-created knockout rounds, so the
   * on-target/behind label compares like with like.
   *
   * Rounded to a five-minute bucket so a 30-second clock tick does not re-run the solved problem
   * for a number that has not changed, and guarded so a malformed state degrades to the floor
   * rather than taking the whole desk down.
   */
  const estimateNow = Math.floor(now / (5 * MINUTE)) * 5 * MINUTE;
  const finishEstimate = useMemo(() => {
    if (!tournament || tournament.format !== "two_round_placement") return null;
    if (!(tournamentDays ?? []).length || !(courts ?? []).length) return null;
    const dayCourtIds = new Map<string, Set<string>>();
    for (const row of dayCourts ?? []) {
      const set = dayCourtIds.get(row.day_id) ?? new Set<string>();
      set.add(row.court_id);
      dayCourtIds.set(row.day_id, set);
    }
    const breaksByDayId = new Map<string, TournamentDayBreak[]>();
    for (const brk of dayBreaks ?? []) {
      const list = breaksByDayId.get(brk.day_id) ?? [];
      list.push(brk);
      breaksByDayId.set(brk.day_id, list);
    }
    try {
      return estimateFinish({
        tournament,
        days: tournamentDays ?? [],
        allCourts: courts ?? [],
        dayCourtIds,
        breaksByDayId,
        teams: teams ?? [],
        entrants: placementEntrants ?? [],
        draws: tierDraws ?? [],
        placementMatches: placementMatches ?? [],
        tierMatches: tierDrawMatches ?? [],
        categoryOrder: new Map((categories ?? []).map((c) => [c.id, c.sort_order])),
        now: estimateNow,
      });
    } catch {
      // A forecast is a nicety; the desk's job is results. Fall back to the floor.
      return null;
    }
  }, [
    tournament,
    tournamentDays,
    courts,
    dayCourts,
    dayBreaks,
    teams,
    placementEntrants,
    tierDraws,
    placementMatches,
    tierDrawMatches,
    categories,
    estimateNow,
  ]);

  const kpis = getOperationalKpis(
    courtStates.map(({ state }) => state),
    allMatches,
    slotMinutesFor,
    now,
    finishEstimate === null
      ? undefined
      : finishEstimate.finish
        ? Date.parse(finishEstimate.finish)
        : null,
  );
  const targetFinishMs = useMemo(() => {
    const days = tournamentDays ?? [];
    if (!days.length) return null;
    const hasRemainingGroups = allMatches.some(
      (match) =>
        deskKindPhase(match.kind) === "group" &&
        (match.status === "scheduled" || match.status === "in-progress"),
    );
    // Chase the day that still has group work, otherwise the final day's window.
    const day = hasRemainingGroups ? days[0] : days[days.length - 1];
    if (!day) return null;
    const target = new Date(`${day.date}T${day.end_time}`);
    return Number.isFinite(target.getTime()) ? target.getTime() : null;
  }, [tournamentDays, allMatches]);
  const finishStatus = finishStatusLabel(kpis.projectedFinish, targetFinishMs);
  const finishStatusTone =
    kpis.projectedFinish != null && targetFinishMs != null && kpis.projectedFinish > targetFinishMs
      ? "warn"
      : "normal";
  const courtProgress = courtStates.map(({ court, state }) => {
    const courtMatches = allMatches.filter((match) => match.courtId === court.id);
    const total = courtMatches.length;
    const done = courtMatches.filter((match) =>
      ["reported", "walkover"].includes(match.status),
    ).length;
    return {
      court,
      state,
      total,
      done,
      remaining: total - done,
      percent: total ? Math.round((done / total) * 100) : 0,
    };
  });

  /**
   * Matches that are ready to play but hold no court: generated by a build that has
   * not placed them yet. This is one shared pool, not a fixture reserved for any
   * court — the same suggestion therefore appears on every idle court, and only the
   * first is offered because the desk starts one match at a time. Rebuilding the
   * schedule clears it.
   */
  const readyUnassigned = allMatches
    .filter((match) => match.status === "scheduled" && !match.courtId)
    .filter(
      (match) => getMatchReadiness(match, allMatches, restMinutesFor(match), now).state === "ready",
    )
    .sort((a, b) => new Date(a.scheduled ?? 0).getTime() - new Date(b.scheduled ?? 0).getTime());

  /** The pairing the idle courts offer, named once so the card cannot drift. */
  const nextReadyLabel = readyUnassigned[0]
    ? `${label(readyUnassigned[0].teams[0])} vs ${label(readyUnassigned[0].teams[1])}`
    : null;

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
          <DeskKpi
            label="Ready courts"
            value={courtStates.filter(({ state }) => state.state === "free-ready").length}
          />
          <DeskKpi
            label="Waiting courts"
            value={kpis.waitingCourts}
            tone={kpis.waitingCourts ? "warn" : "normal"}
          />
          <DeskKpi label="Matches left" value={kpis.remainingMatches} />
          {finishEstimate ? (
            <FinishEstimate estimate={finishEstimate} variant="tile" />
          ) : (
            <DeskKpi
              label="Projected finish"
              value={timeLabel(kpis.projectedFinish ? new Date(kpis.projectedFinish) : null)}
            />
          )}
          <DeskKpi label="Finish status" value={finishStatus} tone={finishStatusTone} />
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
            {latePools.length ||
            overCap.length ||
            readyUnassigned.length ||
            courtStates.some(({ state }) => state.state === "free-ready") ? (
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
                        Court {court.number} is free — start{" "}
                        {state.next
                          ? `${label(state.next.teams[0])} vs ${label(state.next.teams[1])}`
                          : "the next match"}
                      </button>
                    </li>
                  ))}
                {readyUnassigned.length ? (
                  <li className="rounded-md bg-warn-surface px-2.5 py-2 text-warn-foreground">
                    {readyUnassigned.length} match
                    {readyUnassigned.length === 1 ? " is" : "es are"} ready with no court yet —
                    build or rebuild the schedule to lay them across the days.{" "}
                    {tournament?.format === "two_round_placement" ? (
                      <Link to="/placement-schedule" className="font-semibold underline">
                        open the schedule
                      </Link>
                    ) : (
                      <Link to="/schedule" className="font-semibold underline">
                        open the schedule
                      </Link>
                    )}
                    .
                  </li>
                ) : null}
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
                    {state.next ? (
                      <>
                        Next: {timeLabel(state.next.scheduled)} · {label(state.next.teams[0])} vs{" "}
                        {label(state.next.teams[1])}
                        <br />
                        <ReadinessText
                          readiness={state.readiness}
                          courts={courtMap}
                          players={playerMap}
                        />
                      </>
                    ) : nextReadyLabel ? (
                      <>
                        No match scheduled · ready to place: {nextReadyLabel}
                        {readyUnassigned.length > 1
                          ? ` · ${readyUnassigned.length - 1} more waiting`
                          : ""}
                      </>
                    ) : (
                      "nothing queued"
                    )}
                  </p>
                  <p className="mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                    {state.playing ? "Open score desk" : target ? "Open next match" : ""}
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
            title="Court progress"
            right={
              <span className="text-[11px] text-muted-foreground">
                {courtProgress.reduce((sum, row) => sum + row.done, 0)}/
                {courtProgress.reduce((sum, row) => sum + row.total, 0)} matches done
              </span>
            }
          >
            {courtProgress.length ? (
              <ul className="divide-y divide-hairline">
                {courtProgress.map((row) => (
                  <li key={row.court.id} className="flex items-center gap-3 py-2 text-sm">
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/10 font-score text-[11px] text-primary">
                      {row.court.number}
                    </span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${row.percent}%` }}
                      />
                    </span>
                    <span className="w-16 text-right font-score text-xs text-muted-foreground">
                      {row.done}/{row.total}
                    </span>
                    <span className="w-16 text-right font-score text-[11px] text-muted-foreground">
                      {row.remaining ? `${row.remaining} left` : "complete"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No courts" hint="Add courts to see progress here." />
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
              scoringRule={ruleFor(current.kind)}
              tournamentId={tournament?.id ?? null}
              timezone={tournament?.venue_timezone}
              onDone={() => {
                refresh();
                setOpenMatch(null);
              }}
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
  scoringRule,
  tournamentId,
  timezone,
  onDone,
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
  /** The tournament's rule for this match's stage, so scoring follows config. */
  scoringRule: ScoringRule;
  /** Needed by the placement path, which snapshots the day to report its ripple. */
  tournamentId: string | null;
  timezone?: string | undefined;
  onDone: () => void;
}) {
  const rows = scoringRule.bestOf;
  const [values, setValues] = useState(() =>
    scoreFormValues(rows, match.status, match.initialGames),
  );
  const [busy, setBusy] = useState(false);
  const [confirmRestOpen, setConfirmRestOpen] = useState(false);
  const [exceptionMode, setExceptionMode] = useState<"walkover" | "void" | "move" | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [note, setNote] = useState("");
  const [winnerId, setWinnerId] = useState(match.teams[0] ?? "");
  const [moveCourtId, setMoveCourtId] = useState(courtId ?? "");
  const [moveTime, setMoveTime] = useState(() => localDateTimeValue(match.scheduled));
  const table = deskKindTable(match.kind) as
    "pool_matches" | "draw_matches" | "placement_matches" | "tier_draw_matches";
  const isPlacement = isPlacementKind(match.kind);
  const isReported = match.status === "reported";
  const notStarted = match.status !== "in-progress" && !isReported;
  const canEditScores = signedIn && (match.status === "in-progress" || isReported);

  /**
   * Clearing a result, offered for the placement tables.
   *
   * This lived on the placement page, which no longer enters scores at all, so
   * without it here a mis-reported placement or bracket result could be corrected
   * but never taken back. Scoped to those two kinds because they are the ability
   * being moved; the pool and draw tables are untouched.
   *
   * The database still has the final say: it refuses a round-one result once round
   * two was built from it, which the wording under the button says up front rather
   * than letting the desk find out from a failure.
   */
  const canClearResult = isReported && isPlacement && signedIn;

  const runStart = async () => {
    const restWarnings = startCheck?.warnings ?? [];
    try {
      setBusy(true);
      // The placement tables have their own start RPCs. They take no rest override:
      // a placement match is never blocked by the rest rule, because the stage's
      // ordering is already guaranteed by generation rather than by a start check.
      if (match.kind === "placement") await startPlacementMatch(match.id, courtId);
      else if (match.kind === "tier") await startTierDrawMatch(match.id, courtId);
      else
        await startMatch(
          table as "pool_matches" | "draw_matches",
          match.id,
          courtId,
          restWarnings.length > 0,
        );
      toast.success("Match started");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the match");
    } finally {
      setBusy(false);
    }
  };
  const set = (row: number, col: number, v: string) =>
    setValues((prev) => prev.map((r, i) => (i === row ? r.map((c, j) => (j === col ? v : c)) : r)));

  const games = values
    .slice(0, rows)
    .filter((r) => r[0] !== "" && r[1] !== "")
    .map((r) => ({ a: Number(r[0]), b: Number(r[1]) }));
  const canSubmit =
    match.kind === "pool"
      ? !!games[0] && isLegalGameScoreFor(games[0].a, games[0].b, scoringRule)
      : !!gamesWinnerFor(games, scoringRule);

  const submit = async () => {
    if (
      !isReported &&
      match.status !== "in-progress" &&
      !window.confirm("This match has not been started. Report the result anyway?")
    ) {
      return;
    }
    setBusy(true);
    try {
      if (match.kind === "placement" || match.kind === "tier") {
        if (!tournamentId) throw new Error("No active tournament.");
        const report = match.kind === "placement" ? reportPlacementMatch : reportTierDrawMatch;
        const impact = await report(match.id, games, tournamentId);
        // The placement path reports its ripple in minutes rather than as a plan
        // diff, so it gets its own note rather than `impactMessage`.
        const note = scheduleImpactNote(impact);
        toast.success(
          [isReported ? "Result corrected" : "Result recorded", note].filter(Boolean).join(" — "),
        );
      } else if (match.kind === "pool") {
        const g = games[0];
        if (!g) throw new Error("Enter both scores.");
        const impact = await reportPoolMatch(match.id, g.a, g.b);
        toast.success(impactMessage(isReported ? "Result corrected" : "Result recorded", impact));
      } else {
        const impact = await reportDrawMatch(match.id, games);
        toast.success(impactMessage(isReported ? "Result corrected" : "Result recorded", impact));
      }
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save result");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Puts a reported placement or bracket match back to unplayed.
   *
   * The database decides whether it is allowed — a round-one result is refused once
   * round two exists — so this reports whatever it says rather than pre-judging it.
   */
  const clearResult = async () => {
    setBusy(true);
    try {
      if (match.kind === "placement") await resetPlacementResult(match.id);
      else await resetTierDrawResult(match.id);
      toast.success("Result cleared");
      setClearOpen(false);
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not clear the result");
    } finally {
      setBusy(false);
    }
  };

  const resolveException = async () => {
    if (exceptionMode !== "walkover" && exceptionMode !== "void") return;
    // The placement tables have no exception path yet: `resolve_match_exception` only
    // accepts the round-robin tables. The buttons are hidden for those kinds, so this
    // is a guard against a stale dialog rather than a reachable state.
    if (isPlacement) {
      toast.error("Walkovers and voids are not available for the placement format yet.");
      return;
    }
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
        table as "pool_matches" | "draw_matches",
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
      if (isPlacement) {
        await reschedulePlacementMatch(
          table as "placement_matches" | "tier_draw_matches",
          match.id,
          moveCourtId,
          new Date(moveTime).toISOString(),
        );
      } else {
        await rescheduleMatch(
          table as "pool_matches" | "draw_matches",
          match.id,
          moveCourtId,
          new Date(moveTime).toISOString(),
        );
      }
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
      <DialogHeader className="space-y-1 border-b border-hairline pb-3 text-left">
        <DialogTitle className="pr-8 font-display text-lg leading-tight">
          {nameA} <span className="text-muted-foreground">vs</span> {nameB}
        </DialogTitle>
        <DialogDescription className="text-xs uppercase tracking-wide">
          {match.tag} · {scoringRuleLabel(scoringRule)}
          {courtNumber ? ` · Court ${courtNumber}` : ""} ·{" "}
          {match.status === "in-progress"
            ? `${minutesSince(match.startedAt)}′ on court`
            : isReported
              ? `Finished ${timeLabel(match.endedAt)}`
              : timeLabel(match.scheduled, timezone)}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="flex justify-center pt-1">
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${
              isReported
                ? "bg-mint/20 text-foreground"
                : notStarted
                  ? "bg-muted text-muted-foreground"
                  : "bg-info-surface text-info-foreground"
            }`}
          >
            {isReported ? "Reported" : notStarted ? "Not started" : "Live"}
          </span>
        </div>

        <div className="rounded-xl border border-hairline bg-muted/30 px-4 py-4">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-center">
            <span className="truncate text-sm font-medium">{nameA}</span>
            <span aria-hidden className="w-6" />
            <span className="truncate text-sm font-medium">{nameB}</span>
          </div>
          <div className="mt-2 space-y-2">
            {Array.from({ length: rows }).map((_, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <Input
                  className="h-12 w-full text-center font-score text-xl"
                  inputMode="numeric"
                  placeholder="—"
                  autoFocus={i === 0 && canEditScores}
                  value={values[i]?.[0] ?? ""}
                  disabled={!canEditScores}
                  onChange={(e) => set(i, 0, e.target.value)}
                  aria-label={`Game ${i + 1} ${nameA}`}
                />
                <span className="w-6 text-center font-score text-lg text-muted-foreground">:</span>
                <Input
                  className="h-12 w-full text-center font-score text-xl"
                  inputMode="numeric"
                  placeholder="—"
                  value={values[i]?.[1] ?? ""}
                  disabled={!canEditScores}
                  onChange={(e) => set(i, 1, e.target.value)}
                  aria-label={`Game ${i + 1} ${nameB}`}
                />
              </div>
            ))}
          </div>
          {rows > 1 ? (
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              Games 1–{rows}, top to bottom. {gamesNeededToWin(scoringRule)} wins take the match.
            </p>
          ) : null}
        </div>
        {!isReported &&
        match.status !== "in-progress" &&
        (startCheck?.conflicts.length || startCheck?.warnings.length) ? (
          <ul className="space-y-1 text-xs">
            {(startCheck?.conflicts ?? []).map((c, i) => (
              <li
                key={`conflict-${i}`}
                className="rounded-md bg-danger-surface px-2 py-1 text-danger-foreground"
              >
                {playerMap.get(c.playerId)?.name ?? "A player"} is currently playing
                {c.courtNumber ? ` on Court ${c.courtNumber}` : " another match"} — this match can't
                start until they finish.
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
          {isReported ? (
            <Button
              className="h-11 flex-1 text-base font-semibold shadow-md"
              disabled={!signedIn || busy || !canSubmit}
              onClick={submit}
            >
              Save correction
            </Button>
          ) : notStarted ? (
            <Button
              className="h-11 flex-1 text-base font-semibold shadow-md"
              disabled={!signedIn || busy || !!startCheck?.conflicts.length}
              onClick={() => {
                if ((startCheck?.warnings ?? []).length) {
                  setConfirmRestOpen(true);
                  return;
                }
                void runStart();
              }}
            >
              ▶ Start match
            </Button>
          ) : (
            <Button
              className="h-11 flex-1 text-base font-semibold shadow-md"
              disabled={!signedIn || busy || !canSubmit}
              onClick={submit}
            >
              Report result
            </Button>
          )}
        </div>
        <AlertDialog open={confirmRestOpen} onOpenChange={setConfirmRestOpen}>
          <AlertDialogContent className="max-w-md">
            <AlertDialogHeader>
              <div className="flex size-11 items-center justify-center rounded-full bg-warn-surface text-warn-foreground">
                <span className="text-lg font-semibold">!</span>
              </div>
              <AlertDialogTitle>Short rest between matches</AlertDialogTitle>
              <AlertDialogDescription>
                These players haven&apos;t had their full rest yet. You can still start the match.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="space-y-2">
              {(startCheck?.warnings ?? []).map((w, i) => (
                <li
                  key={`confirm-warning-${i}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-warn-surface/60 px-3 py-2"
                >
                  <span className="text-sm font-medium">
                    {playerMap.get(w.playerId)?.name ?? "A player"}
                  </span>
                  <span className="font-score text-sm text-warn-foreground">
                    {w.restMinutes} / {w.requiredMinutes} min
                  </span>
                </li>
              ))}
            </ul>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Keep waiting</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  setConfirmRestOpen(false);
                  void runStart();
                }}
              >
                Start anyway
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {!isReported && (signedIn || canSchedule) ? (
          <div className="border-t border-hairline pt-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              More actions
            </p>
            <div className="grid grid-cols-3 gap-2">
              {signedIn && !isPlacement ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
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
                    className="w-full"
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
                  className="w-full"
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
        {canClearResult ? (
          <div className="border-t border-hairline pt-3">
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => setClearOpen(true)}
            >
              Clear result
            </Button>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Sends this match back to unplayed so the score can be entered again. A round-one
              result cannot be cleared once round two was built from it — regenerate round two
              instead.
            </p>
          </div>
        ) : null}
        <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
          <AlertDialogContent className="max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle>Clear this result?</AlertDialogTitle>
              <AlertDialogDescription>
                {nameA} vs {nameB} goes back to unplayed and the score is discarded. You can enter
                it again afterwards.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Keep the result</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void clearResult();
                }}
              >
                Clear result
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {!signedIn ? (
          <p className="text-xs text-muted-foreground">Sign in at the desk to enter scores.</p>
        ) : null}
      </div>
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
  if (readiness.state === "ready")
    return <span className="font-medium text-primary">Ready now</span>;
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
        on Court{" "}
        {readiness.blockingCourtId ? (courts.get(readiness.blockingCourtId)?.number ?? "?") : "?"}
      </span>
    );
  }
  return <span>Teams not assigned</span>;
}

function impactMessage(prefix: string, impact: ScheduleImpact): string {
  if (!impact.shiftedMatches) return prefix;
  const direction = impact.direction === "mixed" ? "in both directions" : `${impact.direction}`;
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
