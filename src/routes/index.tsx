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
  useTournamentDayCourts,
  useTournamentDays,
  type Court,
  type PlacementMatch,
  type Player,
  type TournamentDay,
} from "@/lib/tournament/data";
import {
  dayDateLabel,
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
  getMatchReadiness,
  getOperationalKpis,
  isPlacementKind,
  type DeskMatchModel,
  type MatchReadiness,
} from "@/lib/tournament/desk";
import {
  COURT_STATE_CHIP,
  COURT_STATE_LABEL,
  COURT_STATE_TILE,
  type CourtState,
} from "@/lib/tournament/court-state";
import { poolIsComplete } from "@/lib/tournament/standings";
import { buildDeskMatches, type DeskMatch } from "@/lib/tournament/desk-matches";
import { DayScheduleStatus } from "@/components/schedule-status";
import {
  attributeMatchesToDays,
  awaitingResultMatches,
  dayIdForTime,
  dayOperationalCounts,
  expectedEndMs,
  resolveSelectedDay,
} from "@/lib/tournament/day-scope";
import { courtsForDay, dayWindowBounds } from "@/lib/tournament/scheduling/day-plan";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ShuttleNet Control Desk | Live Badminton Tournament Ops" },
      {
        name: "description",
        content:
          "Live control desk for one tournament day: its court board, its matches, and the operational alerts that need someone chasing.",
      },
      { property: "og:title", content: "ShuttleNet Control Desk | Live Badminton Tournament Ops" },
      {
        property: "og:description",
        content:
          "Live control desk for one tournament day: its court board, its matches, and the operational alerts that need someone chasing.",
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
  /**
   * Whether the displayed clock has been adopted from this browser yet.
   *
   * `now` itself cannot be nullable: it drives overdue detection, court state and match
   * readiness, and those have to be computed on the server too. The problem is not that
   * the value exists, it is that rendering it as text is guaranteed to disagree with the
   * client - the server can only ever render the instant *it* rendered, and the client
   * hydrates some milliseconds or a whole minute later.
   *
   * The consequence was worse than a console warning. React treats the mismatch as fatal
   * for that subtree, discards the server HTML for the whole Desk and regenerates it on
   * the client - so a live event's busiest screen silently threw away its server render
   * whenever a minute boundary fell inside the load. It is intermittent by construction,
   * which is exactly why it survived: it only fires when the clock ticks mid-load.
   *
   * The fix is to keep the clock out of the server render entirely. Server and first
   * client render agree on the neutral label, the mount effect adopts the browser's
   * clock, and the time appears on the next paint. Nothing derived from `now` changes.
   */
  const [clockAdopted, setClockAdopted] = useState(false);
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
  // The two-round placement format keeps its own tables, so the desk reads them
  // alongside the round-robin ones rather than instead of them.
  const { data: placementEntrants } = usePlacementEntrants();
  const { data: placementMatches } = usePlacementMatches();
  const { data: tierDraws } = useTierDraws();
  const { data: tierDrawMatches } = useTierDrawMatches();
  // Which day the desk is showing, so the whole board can be scoped to it. Held as null
  // until a day is clicked, so the opening view is derived rather than stored — the
  // derived value survives days loading late, and a click wins from then on.
  const { data: dayCourts } = useTournamentDayCourts(tournament?.id);
  const [pickedDayId, setPickedDayId] = useState<string | null>(null);

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
    // Adopt this browser's clock, then keep it ticking.
    //
    // The `setNow` on mount is not redundant with the initial state. That state is
    // `Date.now()` evaluated wherever the render ran - on the server that is the
    // server's clock, which is a different instant and, in production, a different
    // timezone. Adopting the browser's value here is what makes the displayed time the
    // reader's time rather than the server's.
    setNow(Date.now());
    setClockAdopted(true);
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

  const slotMinutesFor = (match: DeskMatch) =>
    deskKindPhase(match.kind) === "group"
      ? (tournament?.group_slot_minutes ?? 20)
      : (tournament?.knockout_slot_minutes ?? 25);
  const restMinutesFor = (match: DeskMatch) =>
    deskKindPhase(match.kind) === "group"
      ? (tournament?.group_rest_gap_minutes ?? 10)
      : (tournament?.knockout_rest_gap_minutes ?? 30);

  const orderedDays = useMemo(
    () => [...(tournamentDays ?? [])].sort((a, b) => a.day_number - b.day_number),
    [tournamentDays],
  );

  /**
   * Which day every match belongs to, and which matches belong to no day at all.
   *
   * Attribution follows the planner's own rule — the last day that had already opened — so a
   * match that overruns past midnight stays on its own day instead of appearing on the next
   * calendar date. Court plays no part: a match with a time but no court still belongs to its
   * day. A match with no usable time is reported separately and never assigned on a guess.
   */
  const attribution = useMemo(
    () => attributeMatchesToDays(orderedDays, allMatches),
    [orderedDays, allMatches],
  );

  /**
   * The day the whole desk is showing.
   *
   * A moderator's pick always wins and is never reset by a realtime update; otherwise the
   * active day is derived, which is what keeps the desk on the right day after midnight when
   * no configured window contains `now`.
   */
  const selectedDayId = useMemo(
    () => resolveSelectedDay({ days: orderedDays, attribution, now, pickedDayId }),
    [orderedDays, attribution, now, pickedDayId],
  );
  const selectedDay = useMemo(
    () => orderedDays.find((day) => day.id === selectedDayId) ?? null,
    [orderedDays, selectedDayId],
  );

  /** Every metric, court, queue and alert below is derived from this day's rows alone. */
  const dayMatches = useMemo(
    () => (selectedDayId ? (attribution.byDayId.get(selectedDayId) ?? []) : []),
    [attribution, selectedDayId],
  );

  /** The courts this day plays on. An empty set means every court, as the planner reads it. */
  const dayCourtIdSet = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedDayId) return ids;
    for (const row of dayCourts ?? []) {
      if (row.day_id === selectedDayId) ids.add(row.court_id);
    }
    return ids;
  }, [dayCourts, selectedDayId]);

  const courtsOnSelectedDay = useMemo(
    () => courtsForDay(courts ?? [], dayCourtIdSet),
    [courts, dayCourtIdSet],
  );

  const dayCounts = useMemo(
    () => dayOperationalCounts(dayMatches, slotMinutesFor, now),
    // slotMinutesFor reads only the tournament's timings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dayMatches, tournament, now],
  );

  const dayCloseMs = selectedDay ? dayWindowBounds(selectedDay).end : null;

  const courtStates = courtsOnSelectedDay.map((court) => ({
    court,
    state: deriveCourtState(court.id, dayMatches, slotMinutesFor, restMinutesFor, now),
  }));

  // No forecast is passed in: the desk reports the day, so the only finish it knows is the
  // latest end among the day's own scheduled matches.
  const kpis = getOperationalKpis(
    courtStates.map(({ state }) => state),
    dayMatches,
    slotMinutesFor,
    now,
  );

  const latePools = useMemo(() => {
    return (pools ?? []).filter((pool) => {
      if (!pool.scheduled_end) return false;
      // A pool belongs to the day its scheduled end falls on, by the same rule as a match.
      if (dayIdForTime(orderedDays, new Date(pool.scheduled_end).getTime()) !== selectedDayId) {
        return false;
      }
      const matches = (poolMatches ?? []).filter((m) => m.pool_id === pool.id);
      const teamIds = (poolEntries ?? [])
        .filter((e) => e.pool_id === pool.id)
        .map((e) => e.team_id);
      if (poolIsComplete(teamIds, matches)) return false;
      return now > new Date(pool.scheduled_end).getTime() + 15 * 60000;
    });
  }, [pools, poolMatches, poolEntries, orderedDays, selectedDayId, now]);

  const overCap = dayMatches.filter(
    (m) => m.status === "in-progress" && (minutesSince(m.startedAt, now) ?? 0) > slotMinutesFor(m),
  );

  const courtProgress = courtStates.map(({ court, state }) => {
    const courtMatches = dayMatches.filter((match) => match.courtId === court.id);
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
   * Matches on this day that are ready to play but hold no court: generated by a build that
   * has not placed them yet. This is one shared pool, not a fixture reserved for any court —
   * the same suggestion therefore appears on every idle court, and only the first is offered
   * because the desk starts one match at a time. Rebuilding the schedule clears it.
   *
   * Readiness is evaluated over this day's matches, because the desk is only responsible for
   * this day. "Scheduled for the selected day" and "ready to dispatch now" stay separate: the
   * first is attribution, the second is the shared readiness rule.
   */
  const readyUnassigned = dayMatches
    .filter((match) => match.status === "scheduled" && !match.courtId)
    .filter(
      (match) => getMatchReadiness(match, dayMatches, restMinutesFor(match), now).state === "ready",
    )
    .sort((a, b) => new Date(a.scheduled ?? 0).getTime() - new Date(b.scheduled ?? 0).getTime());

  /** The pairing the idle courts offer, named once so the card cannot drift. */
  const nextReadyLabel = readyUnassigned[0]
    ? `${label(readyUnassigned[0].teams[0])} vs ${label(readyUnassigned[0].teams[1])}`
    : null;

  /** The day's undecided matches that are already past their expected end. */
  const awaitingResults = useMemo(
    () => awaitingResultMatches(dayMatches, slotMinutesFor, now),
    // slotMinutesFor reads only the tournament's timings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dayMatches, tournament, now],
  );

  /**
   * Matches with no usable time at all.
   *
   * They cannot be attributed to a day without a guess, so the desk reports them as a neutral
   * plan-level fact instead of filing them under one. This is the only tournament-wide number
   * on the page, and it is deliberately not an operational metric.
   */
  const untimedCount = attribution.untimed.length;

  return (
    <AppShell
      title="Control desk"
      subtitle="Live operations for one tournament day: its courts, its matches and the alerts that need someone chasing."
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
        {orderedDays.length ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-hairline bg-surface px-3 py-2 text-xs">
            <span className="font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Day
            </span>
            <div className="flex flex-wrap items-center gap-1">
              {orderedDays.map((day) => (
                <button
                  key={day.id}
                  type="button"
                  onClick={() => setPickedDayId(day.id)}
                  aria-pressed={day.id === selectedDayId}
                  className={`rounded-md px-2 py-1 font-score text-t2 transition-colors ${
                    day.id === selectedDayId
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/70"
                  }`}
                >
                  {dayDateLabel(day.date)}
                </button>
              ))}
            </div>
            <span className="ml-auto">
              <DayScheduleStatus latestFinishMs={dayCounts.latestFinishMs} closeMs={dayCloseMs} />
            </span>
          </div>
        ) : null}

        {untimedCount ? (
          <p className="text-xs text-muted-foreground">
            {untimedCount} match{untimedCount === 1 ? " has" : "es have"} no scheduled time, so
            {untimedCount === 1 ? " it is" : " they are"} not counted on any day.
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
          <DeskKpi
            label="Courts active"
            value={`${kpis.activeCourts}/${courtsOnSelectedDay.length}`}
          />
          <DeskKpi
            label="Courts waiting"
            value={kpis.waitingCourts}
            tone={kpis.waitingCourts ? "warn" : "normal"}
          />
          <DeskKpi label="In progress" value={dayCounts.inProgress} />
          <DeskKpi label="Completed" value={dayCounts.completed} />
          <DeskKpi label="Matches left" value={dayCounts.remaining} />
          <DeskKpi
            label="Ready, no court"
            value={readyUnassigned.length}
            tone={readyUnassigned.length ? "warn" : "normal"}
          />
          <DeskKpi
            label="Awaiting results"
            value={dayCounts.awaitingResults}
            tone={dayCounts.awaitingResults ? "warn" : "normal"}
          />
        </div>

        <Panel
          title="Act now"
          right={
            <span className="text-t4 text-muted-foreground">
              {clockAdopted
                ? `${timeLabel(new Date(now))} · updates every 30s`
                : "updates every 30s"}
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
                        className="w-full rounded-md bg-primary/15 px-2.5 py-2 text-left font-medium hover:bg-primary/25"
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

        <Panel
          title="Court board"
          right={
            selectedDay ? (
              <span className="text-t4 text-muted-foreground">
                {dayDateLabel(selectedDay.date)} · {courtsOnSelectedDay.length} court
                {courtsOnSelectedDay.length === 1 ? "" : "s"}
              </span>
            ) : null
          }
        >
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
                  className={`rounded-xl border p-3.5 text-left shadow-panel transition-all enabled:hover:-translate-y-0.5 enabled:hover:border-primary/60 enabled:hover:shadow-raise disabled:cursor-default disabled:opacity-80 ${COURT_STATE_TILE[state.state]}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 font-display text-sm font-bold">
                      {/*
                        The badge is `foreground`-tinted rather than `primary`-tinted, and
                        that is a correctness fix rather than a style preference.

                        `--primary-ink` is solved against `bg-primary/10` over a *surface*.
                        This badge sits on a court tile, whose background is not a surface -
                        it is `COURT_STATE_TILE[state]`, so it is a green live chip, a danger
                        tint, a primary wash or a plain surface depending on the state. On
                        the dark live chip the pair measured 4.53:1 against the 4.5:1 that
                        14px needs: technically passing, with no headroom at all, and only
                        visible at all once the fixture put a real match on a court.

                        An ink is only valid against the fill it was solved for, so an
                        element that can sit on five different backgrounds cannot use one.
                        `foreground` on a `foreground/10` wash is backdrop-agnostic and
                        clears the requirement on every tile in both themes, and it also
                        respects the system's own rule that hue is reserved for state -
                        a brand-blue chip inside a state-coloured tile was already the one
                        place that broke it.
                      */}
                      <span className="grid size-6 place-items-center rounded-md bg-foreground/10 font-score text-t2 text-foreground">
                        {court.number}
                      </span>
                      Court {court.number}
                    </span>
                    <CourtStatePill state={state.state} />
                  </div>

                  {/* The names of the match on court are the tile's primary
                      content, so they take the read tier and hold 14px in both
                      densities rather than dropping to 13px in Compact. The tag
                      above is a reference code and the timer below is the value
                      that needs to be comparable across courts. */}
                  <p className="mt-2 text-t3">
                    {state.playing ? (
                      <>
                        <span className="font-score text-t4 text-muted-foreground">
                          {state.playing.tag}
                        </span>
                        <br />
                        {label(state.playing.teams[0])} vs {label(state.playing.teams[1])}
                        <br />
                        <span
                          className={`font-score text-t2 ${
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
                  {/* The queued pairing is a name, so it takes the identify tier
                      and scales with density; the readiness detail under it is
                      reference text. They were one 12px line before, which put
                      the next players' names below the playing names and left
                      them unresponsive to density. */}
                  <div className="mt-2 border-t border-hairline pt-2 text-muted-foreground">
                    {state.next ? (
                      <>
                        <p className="text-t2">
                          Next: {timeLabel(state.next.scheduled)} · {label(state.next.teams[0])} vs{" "}
                          {label(state.next.teams[1])}
                        </p>
                        <ReadinessText
                          readiness={state.readiness}
                          courts={courtMap}
                          players={playerMap}
                        />
                      </>
                    ) : nextReadyLabel ? (
                      <p className="text-t2">
                        No match scheduled · ready to place: {nextReadyLabel}
                        {readyUnassigned.length > 1
                          ? ` · ${readyUnassigned.length - 1} more waiting`
                          : ""}
                      </p>
                    ) : (
                      <p className="text-t4">nothing queued</p>
                    )}
                  </div>
                  <p className="mt-2 text-t4 uppercase tracking-widest text-muted-foreground">
                    {state.playing ? "Open score desk" : target ? "Open next match" : ""}
                  </p>
                </button>
              );
            })}
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel
            title="Awaiting results"
            right={
              <span className="text-t4 text-muted-foreground">
                {dayCounts.remaining} still to play today
              </span>
            }
          >
            {awaitingResults.length ? (
              <ul className="space-y-1.5 text-sm">
                {awaitingResults.map((match) => (
                  <li key={match.id}>
                    <button
                      type="button"
                      className="w-full rounded-md bg-warn-surface px-2.5 py-2 text-left text-warn-foreground hover:brightness-95"
                      onClick={() => {
                        setOperationCourtId(match.courtId);
                        setOpenMatch(match);
                      }}
                    >
                      {label(match.teams[0])} vs {label(match.teams[1])} — expected to finish by{" "}
                      {timeLabel(
                        expectedEndMs(match, slotMinutesFor)
                          ? new Date(expectedEndMs(match, slotMinutesFor)!)
                          : null,
                      )}
                      {match.startedAt
                        ? ` · ${minutesSince(match.startedAt, now) ?? 0}′ on court`
                        : " · not started yet"}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="Nothing outstanding"
                hint="Every match on this day is either played or still inside its slot."
              />
            )}
          </Panel>

          <Panel
            title="Court progress"
            right={
              <span className="text-t4 text-muted-foreground">
                {courtProgress.reduce((sum, row) => sum + row.done, 0)}/
                {courtProgress.reduce((sum, row) => sum + row.total, 0)} matches done
              </span>
            }
          >
            {courtProgress.length ? (
              <ul className="divide-y divide-hairline">
                {courtProgress.map((row) => (
                  <li
                    key={row.court.id}
                    className="flex min-h-[var(--row-height)] items-center gap-3 py-1 text-t3"
                  >
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/10 font-score text-t2 text-primary-ink">
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
                    <span className="w-20 text-right font-score text-t2 text-muted-foreground">
                      {row.remaining ? `${row.remaining} left` : "complete"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No courts on this day"
                hint="Give this day courts in the schedule to see progress here."
              />
            )}
          </Panel>
        </div>
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
                ? "text-state-completed-ink"
                : notStarted
                  ? "bg-state-scheduled-chip text-state-scheduled-ink"
                  : "bg-state-live-chip text-state-live-ink"
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
                  className="h-12 w-full text-center font-score text-t1"
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
                  className="h-12 w-full text-center font-score text-t1"
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
            <p className="mt-2 text-center text-t4 text-muted-foreground">
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
            <p className="mt-1.5 text-t4 text-muted-foreground">
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

function CourtStatePill({ state }: { state: CourtState }) {
  // The label, the fill and the ink all come from `court-state.ts`, so the sweep in
  // `e2e/states.spec.ts` and this component read one vocabulary rather than two.
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 font-score text-t2 uppercase tracking-wider ${COURT_STATE_CHIP[state]}`}
    >
      {COURT_STATE_LABEL[state]}
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
          ? "bg-state-live-chip text-state-live-ink"
          : status === "offline" || status === "error"
            ? "bg-danger-surface text-danger-foreground"
            : "bg-warn-surface text-warn-foreground"
      }`}
    >
      {label}
    </span>
  );
}
