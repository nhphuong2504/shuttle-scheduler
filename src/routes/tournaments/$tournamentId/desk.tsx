import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Page, EmptyState, Panel } from "@/components/app-shell";
import { ConnectionBadge } from "@/components/connection-badge";
import { Button } from "@/components/ui/button";
import { useAutoSchedule, useAutoScheduleReconciler } from "@/hooks/useAutoSchedule";
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
import { PickerInput } from "@/components/ui/picker-input";
import {
  assertMatchUnchanged,
  reportDrawMatch,
  reportPoolMatch,
  rescheduleMatch,
  resolveMatchException,
  startMatch,
  type ScheduleImpact,
} from "@/lib/tournament/actions";
import {
  MAX_ENDED_MINUTES_AGO,
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
  useScopedAccess,
  useScopedTournament,
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
  useScheduleConflicts,
  useTeams,
  useTierDrawMatches,
  useTierDraws,
  useTournamentDayCourts,
  useTournamentDays,
  type Court,
  type PlacementMatch,
  type Player,
  type ScheduleConflict,
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
import { clockFromMinutesAgo, minutesAgoFromClock } from "@/lib/tournament/finish-time";
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
import {
  conflictedMatchCount,
  conflictKindLabels,
  groupConflictsByMatch,
} from "@/lib/tournament/schedule-conflicts";
import {
  COURT_TRANSITION_LABEL,
  nextCourtTransitions,
  transitionCountdown,
  transitionOverdueBy,
  type CourtTransition,
} from "@/lib/tournament/desk-transitions";
import { DayScheduleStatus } from "@/components/schedule-status";
import {
  attributeMatchesToDays,
  dayIdForTime,
  dayOperationalCounts,
  resolveSelectedDay,
} from "@/lib/tournament/day-scope";
import { courtsForDay, dayWindowBounds } from "@/lib/tournament/scheduling/day-plan";

export const Route = createFileRoute("/tournaments/$tournamentId/desk")({
  head: () => ({
    meta: [
      { title: "Tournova Control Desk | Live Badminton Tournament Ops" },
      {
        name: "description",
        content:
          "Live control desk for one tournament day: its court board, its matches, and the operational alerts that need someone chasing.",
      },
      { property: "og:title", content: "Tournova Control Desk | Live Badminton Tournament Ops" },
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
  // A ready match with no time keeps being looked at until it has one, with no button to press.
  useAutoScheduleReconciler();
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
  const tournament = useScopedTournament();
  /**
   * Whether this user may change anything in this tournament.
   *
   * The desk is the busiest screen and the one a viewer most often lands on, so the
   * answer is fetched once here and passed down as a single prop. Anything that would
   * write gets it, and anything that would not is hidden rather than disabled.
   */
  const access = useScopedAccess();
  const canEdit = access.can_edit;
  /**
   * The conflicts the schedule itself reports, as a read-only overlay.
   *
   * Deliberately *not* folded into `getMatchReadiness`: that function answers "can this
   * match physically start", and it stays the one answer for a player on court or a court
   * in use. These are planning discrepancies the organiser resolves by rebuilding, which
   * the desk only surfaces and can acknowledge. The hook is editor-gated and reads an
   * error as "nothing known", so a viewer never asks and a failed read never breaks the
   * board.
   */
  const conflictsQuery = useScheduleConflicts();
  const conflicts = conflictsQuery.data ?? [];
  const conflictsByMatch = useMemo(() => groupConflictsByMatch(conflicts), [conflicts]);
  // Every alert below links to another page of *this* tournament, so the desk takes the
  // id from the route rather than from a global - the same id the layout resolved.
  const { tournamentId } = Route.useParams();
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
        format: tournament?.format,
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
      tournament?.format,
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

  /** The matches on screen, so a conflict count stays scoped to the day the desk shows. */
  const dayMatchIdSet = useMemo(() => new Set(dayMatches.map((match) => match.id)), [dayMatches]);

  /**
   * Re-reads the conflicts after a result and counts those still on this day.
   *
   * The reflow runs server-side, so the number is asked for rather than predicted. Scoped
   * to the day on screen so the toast counts the board the moderator is actually looking
   * at rather than the whole tournament.
   */
  const conflictsAfterReportInDay = async () => {
    const { data } = await conflictsQuery.refetch();
    return conflictedMatchCount(data ?? [], dayMatchIdSet);
  };

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

  /**
   * What happens next on each court, venue-wide and read-only.
   *
   * Derived from the board's own court states and the same slot rule the board measures with,
   * so the panel cannot disagree with the tiles above it, and so it introduces no second
   * schedule or readiness rule. The instants come from `expectedEndMs` - the projection the
   * overdue detection already uses - and from each match's scheduled time.
   */
  const transitions = nextCourtTransitions(
    courtStates.map(({ state }) => state),
    slotMinutesFor,
    now,
  );

  /**
   * How many of those transitions are already late.
   *
   * Used for one summary on the panel's header rather than to change any row. Three courts
   * all showing "6 min overdue" is one fact repeated three times, and a moderator scanning
   * the hall wants the count first and the court list second - so the aggregate is stated
   * once where the eye lands on entering the panel, and each row keeps its own figure
   * because that is the only place the per-court duration exists.
   *
   * Below two late rows there is nothing to aggregate, and the single pill already says it.
   */
  const overdueTransitions = transitions.filter((transition) => transition.overdue).length;

  /**
   * Pools past their scheduled finish with results still missing.
   *
   * Deliberately left ungated while the row lists are not: this alert names no result, it
   * chases one that is missing, and it is the only destructive treatment the Act-now panel
   * defines. Gating it on the format removed the destructive tier from the format this app
   * runs, which `states.spec.ts` caught by driving that treatment through a pool planted
   * inside a placement tournament. Whether the placement stage should raise an overdue-result
   * alert of its own is a design question rather than a rendering one, so the alert stays.
   */
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
  // A ready match that has no time at all (a result unlocked it and nothing has placed it yet) is on
  // no day, so it is added from the neutral untimed pool: the desk can still dispatch it, and it
  // sorts last because it has no scheduled time.
  const readyUnassigned = [...dayMatches, ...attribution.untimed]
    .filter((match) => match.status === "scheduled" && !match.courtId)
    .filter(
      (match) => getMatchReadiness(match, dayMatches, restMinutesFor(match), now).state === "ready",
    )
    .sort((a, b) => {
      // A match with no time sorts after every timed one, never ahead of it.
      const at = (match: typeof a) =>
        match.scheduled ? new Date(match.scheduled).getTime() : Number.POSITIVE_INFINITY;
      return at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1;
    });

  /** The pairing the idle courts offer, named once so the card cannot drift. */
  const nextReadyLabel = readyUnassigned[0]
    ? `${label(readyUnassigned[0].teams[0])} vs ${label(readyUnassigned[0].teams[1])}`
    : null;

  /**
   * Matches with no usable time at all.
   *
   * They cannot be attributed to a day without a guess, so the desk reports them as a neutral
   * plan-level fact instead of filing them under one. This is the only tournament-wide number
   * on the page, and it is deliberately not an operational metric.
   */
  const untimedCount = attribution.untimed.length;

  return (
    <Page
      title="Control desk"
      subtitle={
        canEdit
          ? "Live operations for one tournament day: its courts, its matches and the alerts that need someone chasing."
          : "A live view of one tournament day: what is on each court."
      }
      actions={
        <>
          <ConnectionBadge status={live.status} lastUpdatedAt={live.lastUpdatedAt} />
          <Button
            size="sm"
            variant="outline"
            className="h-11 px-4 text-sm"
            onClick={() => void qc.invalidateQueries()}
          >
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
                  className={`min-h-11 rounded-md px-4 font-score text-sm font-semibold tabular-nums transition-colors ${
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

        {/*
          The operator's alerts and the next-transition table are for whoever runs the day.
          A reader gets the board and the progress, which answer "what is on court" without
          asking them to chase anything they cannot act on. Hidden rather than disabled,
          and hidden while the access read is still in flight, so nothing that can start a
          match is ever drawn for someone who may not.
        */}
        {canEdit ? (
        <Panel
          title="Needs action"
          right={
            <span className="text-sm text-muted-foreground">
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
              <ul className="space-y-2 text-base">
                {courtStates
                  .filter(({ state }) => state.state === "free-ready" && state.next)
                  .map(({ court, state }) => (
                    <ActionRow
                      key={`ready-${court.id}`}
                      tone="go"
                      title={`Court ${court.number} is ready`}
                      detail={
                        state.next
                          ? `${label(state.next.teams[0])} vs ${label(state.next.teams[1])}`
                          : "Next match is ready"
                      }
                      action={
                        <Button
                          size="sm"
                          className="h-11 px-4 text-sm"
                          onClick={() => {
                            setOperationCourtId(court.id);
                            setOpenMatch(state.next);
                          }}
                        >
                          Start
                        </Button>
                      }
                    />
                  ))}
                {overCap.map((m) => (
                  <ActionRow
                    key={m.id}
                    tone="warn"
                    title={`${label(m.teams[0])} vs ${label(m.teams[1])} · ${minutesSince(m.startedAt, now)} min on court`}
                    detail={`Court ${courtMap.get(m.courtId ?? "")?.number ?? "?"} · past the expected finish`}
                    action={
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-11 px-4 text-sm"
                        onClick={() => {
                          setOperationCourtId(m.courtId);
                          setOpenMatch(m);
                        }}
                      >
                        Open score desk
                      </Button>
                    }
                  />
                ))}
                {latePools.map((p) => (
                  <ActionRow
                    key={p.id}
                    tone="warn"
                    title={`${p.name} · ${catMap.get(p.category_id)?.code} — results incomplete`}
                    detail="Over 15 min past scheduled finish"
                    action={
                      <Button asChild size="sm" variant="outline" className="h-11 px-4 text-sm">
                        <Link to="/tournaments/$tournamentId/scores" params={{ tournamentId }}>
                          Enter results
                        </Link>
                      </Button>
                    }
                  />
                ))}
                {readyUnassigned.length ? (
                  <ActionRow
                    tone="info"
                    title={`${readyUnassigned.length} match${
                      readyUnassigned.length === 1 ? " needs" : "es need"
                    } a court`}
                    detail="Not placed on the schedule yet"
                    action={
                      /*
                        One link, not two. The old pair pointed at `/placement-schedule` and
                        `/schedule` because those were two routes; they are one route now, and
                        it reads the format itself. Asking the desk to choose would be the desk
                        re-deciding something the route already knows.
                      */
                      <Button asChild size="sm" variant="outline" className="h-11 px-4 text-sm">
                        <Link to="/tournaments/$tournamentId/schedule" params={{ tournamentId }}>
                          Open Schedule
                        </Link>
                      </Button>
                    }
                  />
                ) : null}
              </ul>
            ) : (
              <EmptyState title="All clear" hint="Nothing needs action right now." />
            )}
          </div>
        </Panel>
        ) : null}

        <Panel
          title="Court board"
          right={
            selectedDay ? (
              <span className="text-sm text-muted-foreground">
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
                  className={`rounded-xl border p-4 text-left shadow-panel transition-all enabled:hover:-translate-y-0.5 enabled:hover:border-primary/60 enabled:hover:shadow-raise disabled:cursor-default disabled:opacity-80 ${COURT_STATE_TILE[state.state]}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 font-display text-lg font-bold">
                      {/*
                        The badge is `foreground`-tinted rather than `primary`-tinted, and
                        that is a correctness fix rather than a style preference.

                        `--primary-ink` is solved against `bg-primary/10` over a *surface*.
                        This badge sits on a court tile, whose background is not a surface -
                        it is `COURT_STATE_TILE[state]`, so it is a green live wash, an
                        amber tint, a primary wash or a plain surface depending on the state. An
                        ink solved against a *surface* therefore has no fixed pair to clear
                        here: the same badge sits on five different fills, so whether it
                        passes or not is decided by the tile underneath it - a fact that was
                        only visible at all once the fixture put a real match on a court.

                        An ink is only valid against the fill it was solved for, so an
                        element that can sit on five different backgrounds cannot use one.
                        `foreground` on a `foreground/10` wash is backdrop-agnostic and
                        clears the requirement on every tile, and it also
                        respects the system's own rule that hue is reserved for state -
                        a violet chip inside a state-coloured tile was already the one
                        place that broke it.
                      */}
                      <span className="grid size-9 place-items-center rounded-lg bg-foreground/10 font-score text-lg font-bold text-foreground">
                        {court.number}
                      </span>
                      Court {court.number}
                    </span>
                    <CourtStatePill state={state.state} />
                  </div>

                  {/* The names of the match on court are the tile's primary
                      content, so they take the read tier. The tag above is a
                      reference code and the timer below is the value that needs to
                      be comparable across courts. */}
                  <p className="mt-3 text-base font-semibold leading-snug">
                    {state.playing ? (
                      <>
                        <span className="font-score text-sm font-medium text-muted-foreground">
                          {state.playing.tag}
                        </span>
                        <br />
                        {label(state.playing.teams[0])} vs {label(state.playing.teams[1])}
                        <br />
                        <span
                          className={`font-score text-base tabular-nums ${
                            state.state === "overrun"
                              ? "font-semibold text-warn-foreground"
                              : "text-muted-foreground"
                          }`}
                        >
                          {state.elapsedMinutes}′ on court
                          {state.state === "overrun" &&
                          state.elapsedMinutes != null &&
                          state.elapsedMinutes > slotMinutesFor(state.playing)
                            ? ` · +${state.elapsedMinutes - slotMinutesFor(state.playing)} over slot`
                            : ""}
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
                          ? "Free · next match ready"
                          : state.state === "free-blocked"
                            ? "Free · next match not ready"
                            : "Idle"}
                      </span>
                    )}
                  </p>
                  {/* The queued pairing is a name, so it takes the identify tier;
                      the readiness detail under it is reference text. They were one
                      12px line before, which put the next players' names below the
                      playing names at the same size as the detail. */}
                  <div className="mt-2 border-t border-hairline pt-2 text-muted-foreground">
                    {state.next ? (
                      <>
                        <p className="text-t2">
                          Next: {timeLabel(state.next.scheduled)} · {label(state.next.teams[0])} vs{" "}
                          {label(state.next.teams[1])}
                        </p>
                        {/*
                          A court with a match on it names its next pairing and nothing
                          more - no "Ready now", no reason it is not ready yet.

                          The readiness line answers "can the queued match start", which is
                          the question a *free* court is asked: free-ready is exactly "yes",
                          free-blocked is exactly "not yet, and here is why". While a match is
                          in progress the question is premature - the court cannot take it
                          until the current match ends, whatever the clock says about rest -
                          so the line would be an answer to a question nobody has asked yet.
                          It also goes stale in a way that reads as a fault: a two-minute
                          countdown on a court with twenty minutes left is noise, not a plan.
                        */}
                        {state.playing ? null : (
                          <ReadinessText
                            readiness={state.readiness}
                            courts={courtMap}
                            players={playerMap}
                          />
                        )}
                      </>
                    ) : nextReadyLabel ? (
                      <p className="text-t2">
                        No match scheduled · ready to place: {nextReadyLabel}
                        {readyUnassigned.length > 1
                          ? ` · ${readyUnassigned.length - 1} more waiting`
                          : ""}
                      </p>
                    ) : (
                      <p className="text-sm">Nothing queued</p>
                    )}
                  </div>
                  <p className="mt-3 text-sm font-semibold text-primary-ink">
                    {state.playing
                      ? canEdit
                        ? "Open score desk"
                        : "View match"
                      : target
                        ? canEdit
                          ? "Open next match"
                          : "View next match"
                        : ""}
                  </p>
                </button>
              );
            })}
          </div>
        </Panel>

        {/*
          `items-stretch`, not `items-start`: these two panels are one band, and the shorter
          one used to end well above the other, leaving a ragged bottom edge across the middle
          of the page. Stretched, they share a height and the band reads as one unit.

          The two are the same list length by construction. Court progress draws one row per
          court, and Next transitions draws at most one row per court - a court yields its
          finish or the start queued behind it, never both - at the same `--row-height`. So
          the rows line up and only the courts that are neither playing nor followed by a
          queued match leave a gap, which is the residual empty space and not a cap. That is
          why the list is not truncated to a smaller number: a fixed cap smaller than the
          court count spent the panel's height on nothing while the rows to fill it were
          already derived.
        */}
        {canEdit ? (
        <div className="grid items-stretch gap-4 lg:grid-cols-2">
          <Panel
            title="Next transitions"
            /**
             * One statement of the late count, in place of reading it off three pills. The
             * rows keep their own figures: this is the aggregate, not a replacement for the
             * per-court detail, and it stays away when there is only one late row to count.
             */
            right={
              overdueTransitions >= 2 ? (
                <span className="shrink-0 rounded-md bg-warn-surface px-1.5 py-0.5 font-score text-sm font-semibold tabular-nums text-warn-foreground">
                  {overdueTransitions} overdue
                </span>
              ) : null
            }
          >
            {transitions.length ? (
              <TransitionTable transitions={transitions} courtMap={courtMap} />
            ) : (
              <EmptyState
                title="Nothing transitioning"
                hint="No match on these courts is near its expected finish, and none is due to start."
              />
            )}
          </Panel>

          <Panel
            title="Court progress"
            right={
              <span className="text-sm text-muted-foreground">
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
                    className="flex min-h-[var(--row-height)] items-center gap-3 py-1 text-base"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 font-score text-sm font-bold text-primary-ink">
                      {row.court.number}
                    </span>
                    <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${row.percent}%` }}
                      />
                    </span>
                    <span className="w-20 text-right font-score text-sm tabular-nums text-muted-foreground">
                      {row.done}/{row.total}
                    </span>
                    <span className="w-24 text-right font-score text-sm tabular-nums text-muted-foreground">
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
              canEdit={canEdit}
              startCheck={startCheck}
              blockStartOnShortRest={tournament?.block_start_on_short_rest ?? false}
              conflicts={conflictsByMatch.get(current.id) ?? []}
              onConflictsAfterReport={conflictsAfterReportInDay}
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
    </Page>
  );
}

export function MatchOperationsDialog({
  match,
  nameA,
  nameB,
  courtId,
  courtNumber,
  courts,
  canEdit,
  startCheck,
  blockStartOnShortRest = false,
  conflicts,
  onConflictsAfterReport,
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
  /**
   * Whether the caller may change this match: score it, start it, move it, or record an
   * exception. One flag rather than the old signed-in/scorer/scheduler trio, because
   * the database has one answer for all of them - the caller either has edit rights on
   * the tournament or does not.
   */
  canEdit: boolean;
  startCheck: StartConstraints | null;
  /** The tournament's start policy: when on, the server refuses a start on short rest. */
  blockStartOnShortRest?: boolean;
  /**
   * The schedule's own conflicts for this match, from `schedule_conflicts`.
   *
   * Not part of `startCheck`: that check owns the physical (a player on court, a court in
   * use) and this is the planning overlay. They are shown in the same confirmation dialog
   * but they are distinct facts, and only the physical ones disable the Start button.
   */
  conflicts: ScheduleConflict[];
  /** Re-reads the conflicts after a reported result and returns how many remain, day-scoped. */
  onConflictsAfterReport: () => Promise<number>;
  playerMap: Map<string, Player>;
  /** The tournament's rule for this match's stage, so scoring follows config. */
  scoringRule: ScoringRule;
  /** Needed by the placement path, which snapshots the day to report its ripple. */
  tournamentId: string | null;
  timezone?: string | undefined;
  onDone: () => void;
}) {
  /** After a result: draw what it unlocked and slot newly ready matches, never moving a time. */
  const autoSchedule = useAutoSchedule();
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
  /**
   * When the match finished: just now, a fixed number of minutes ago, or a clock time.
   *
   * Only meaningful for the placement and knockout tables, whose RPCs accept the offset;
   * it stays "now" and is never sent for the round-robin ones. The RPCs still take minutes,
   * so a clock time is converted on the way out (`minutesAgoFromClock`).
   */
  const [finishChoice, setFinishChoice] = useState<"now" | "5" | "10" | "other">("now");
  const [finishClock, setFinishClock] = useState("");
  const finishClockFieldId = useId();
  const [moveTime, setMoveTime] = useState(() => localDateTimeValue(match.scheduled));
  const table = deskKindTable(match.kind) as
    "pool_matches" | "draw_matches" | "placement_matches" | "tier_draw_matches";
  const isPlacement = isPlacementKind(match.kind);
  const isReported = match.status === "reported";
  const notStarted = match.status !== "in-progress" && !isReported;
  const canEditScores = canEdit && (match.status === "in-progress" || isReported);

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
  const canClearResult = isReported && isPlacement && canEdit;

  /**
   * The schedule's conflicts for this match, reduced to their distinct reasons.
   *
   * A soft gate, unlike `startCheck.conflicts`: it opens the confirmation dialog rather
   * than disabling Start, because the desk can still put the match on court and the
   * organiser resolves the schedule afterwards. `allConflictReasons` is what the dialog
   * lists.
   */
  const allConflictReasons = conflictKindLabels(conflicts);
  const hasScheduleConflict = allConflictReasons.length > 0;
  const restWarningCount = startCheck?.warnings.length ?? 0;
  /**
   * Short rest the server will refuse, as opposed to short rest it will allow.
   *
   * When the tournament turns the refusal on, `assert_can_start_match` rejects the start
   * whatever `p_ignore_rest` says, so offering "Start anyway" would invite a click that can
   * only fail. The rest warning is then a block, drawn and disabled like a player on court.
   */
  const restBlocked = blockStartOnShortRest && restWarningCount > 0;
  /** Whether this start needs an acknowledgement; a block never reaches the dialog. */
  const needsConfirm = !restBlocked && (restWarningCount > 0 || hasScheduleConflict);

  /**
   * The confirmation dialog's heading, which names the reason it opened.
   *
   * It only opens for things the desk may override: a schedule conflict, or short rest in a
   * tournament that allows it. A physical impossibility never gets here - Start is disabled -
   * so the wording says what can be overridden rather than that the match "can't run".
   */
  const confirmTitle =
    hasScheduleConflict && restWarningCount === 0
      ? "Schedule conflict"
      : hasScheduleConflict
        ? "Start this match anyway?"
        : "Players haven't had full rest";
  const confirmDescription =
    hasScheduleConflict && restWarningCount > 0
      ? "The schedule flags this match and some players haven't had full rest. You can start it now; the schedule stays flagged until it is fixed."
      : hasScheduleConflict
        ? "The schedule flags this match, but nothing stops it from starting now. It stays flagged until the schedule is fixed."
        : "This tournament lets you start before the full rest. Check that the players are ready.";

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
    // The offset only exists on the placement and knockout paths. A blank field reads
    // as 0, which is "reported live" and is exactly the old behaviour.
    let endedMinutes = 0;
    if (isPlacement) {
      if (finishChoice === "other") {
        const fromClock = minutesAgoFromClock(finishClock, new Date(), timezone);
        if (fromClock === null) {
          toast.error("Enter the time the match finished.");
          return;
        }
        endedMinutes = fromClock;
      } else {
        endedMinutes = finishChoice === "now" ? 0 : Number(finishChoice);
      }
    }
    if (endedMinutes > MAX_ENDED_MINUTES_AGO) {
      toast.error(`The match can't have finished more than ${MAX_ENDED_MINUTES_AGO} minutes ago.`);
      return;
    }
    if (
      !isReported &&
      match.status !== "in-progress" &&
      !window.confirm("This match hasn't been started. Record the result anyway?")
    ) {
      return;
    }
    setBusy(true);
    try {
      await assertMatchUnchanged(table, match.id, match.status);
      if (match.kind === "placement" || match.kind === "tier") {
        if (!tournamentId) throw new Error("No active tournament.");
        const report = match.kind === "placement" ? reportPlacementMatch : reportTierDrawMatch;
        const impact = await report(match.id, games, tournamentId, endedMinutes);
        // The placement path reports its ripple in minutes rather than as a plan
        // diff, so it gets its own note rather than `impactMessage`.
        const note = scheduleImpactNote(impact);
        // The reflow can leave matches contradicting each other; the number is asked for
        // rather than predicted, because it is written server-side. Only added when there
        // is one, so an ordinary score entry reads exactly as it did before.
        const needingAttention = await onConflictsAfterReport();
        const attentionNote =
          needingAttention > 0
            ? `${needingAttention} match${needingAttention === 1 ? " needs" : "es need"} schedule review`
            : null;
        toast.success(
          `${[isReported ? "Result corrected" : "Result recorded", note, attentionNote]
            .filter(Boolean)
            .join(". ")}.`,
        );
        // The result is saved and announced; scheduling what it unlocked is best-effort.
        autoSchedule();
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
        <DialogTitle className="pr-8 font-display text-2xl leading-tight">
          {nameA} <span className="text-muted-foreground">vs</span> {nameB}
        </DialogTitle>
        <DialogDescription className="text-sm">
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
            className={`rounded-full px-3.5 py-1.5 text-sm font-semibold uppercase tracking-wide ${
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
            <span className="truncate text-base font-semibold">{nameA}</span>
            <span aria-hidden className="w-6" />
            <span className="truncate text-base font-semibold">{nameB}</span>
          </div>
          <div className="mt-2 space-y-2">
            {Array.from({ length: rows }).map((_, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <Input
                  className="h-14 w-full text-center font-score text-3xl font-bold tabular-nums"
                  inputMode="numeric"
                  placeholder="—"
                  autoFocus={i === 0 && canEditScores}
                  value={values[i]?.[0] ?? ""}
                  disabled={!canEditScores}
                  onChange={(e) => set(i, 0, e.target.value)}
                  aria-label={`Game ${i + 1} ${nameA}`}
                />
                <span className="w-6 text-center font-score text-2xl text-muted-foreground">:</span>
                <Input
                  className="h-14 w-full text-center font-score text-3xl font-bold tabular-nums"
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
            <p className="mt-2 text-center text-sm text-muted-foreground">
              Games 1–{rows}, top to bottom. {gamesNeededToWin(scoringRule)} wins take the match.
            </p>
          ) : null}
        </div>
        {/*
          The late-entry correction, kept to one quiet row under the score box so it
          never competes with entering the score itself. Only the placement and
          knockout tables accept the offset, so it is not drawn for the rest.
        */}
        {canEditScores && isPlacement ? (
          <fieldset
            className="rounded-lg border border-hairline bg-muted/20 px-3 py-2.5"
            disabled={!canEdit || busy}
          >
            <legend className="px-1 text-sm font-semibold">When did it finish?</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["now", "Just now"],
                  ["5", "5 min ago"],
                  ["10", "10 min ago"],
                  ["other", "Other time…"],
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={finishChoice === value}
                  onClick={() => setFinishChoice(value)}
                  className={`min-h-11 rounded-full border px-4 text-sm ${
                    finishChoice === value
                      ? "border-primary bg-primary font-semibold text-primary-foreground"
                      : "border-hairline bg-surface"
                  }`}
                >
                  {text}
                </button>
              ))}
            </div>
            {finishChoice === "other" ? (
              <div className="mt-2 flex items-center gap-2">
                <label htmlFor={finishClockFieldId} className="text-sm text-muted-foreground">
                  Finish time
                </label>
                <Input
                  id={finishClockFieldId}
                  type="time"
                  className="h-11 w-36"
                  value={finishClock}
                  onChange={(e) => setFinishClock(e.target.value)}
                />
              </div>
            ) : null}
            <p className="mt-1.5 text-xs text-muted-foreground">
              {finishChoice === "now"
                ? "Choose an earlier time if you are entering the result late, so the rest of the day isn't pushed back."
                : finishChoice === "other"
                  ? "Use the venue clock. Later matches shift by what actually happened."
                  : `Finished at ${clockFromMinutesAgo(Number(finishChoice), new Date(), timezone)}. Later matches shift by what actually happened.`}
            </p>
          </fieldset>
        ) : null}
        {!isReported &&
        match.status !== "in-progress" &&
        (startCheck?.conflicts.length || startCheck?.warnings.length) ? (
          <ul className="space-y-1.5 text-sm">
            {(startCheck?.conflicts ?? []).map((c, i) => (
              <li
                key={`conflict-${i}`}
                className="rounded-md bg-danger-surface px-3 py-1.5 text-danger-foreground"
              >
                {playerMap.get(c.playerId)?.name ?? "A player"} is playing
                {c.courtNumber ? ` on Court ${c.courtNumber}` : " another match"} right now. This
                match can start once they finish.
              </li>
            ))}
            {(startCheck?.warnings ?? []).map((w, i) => (
              <li
                key={`warning-${i}`}
                className={`rounded-md px-3 py-1.5 ${
                  restBlocked
                    ? "bg-danger-surface text-danger-foreground"
                    : "bg-warn-surface text-warn-foreground"
                }`}
              >
                {playerMap.get(w.playerId)?.name ?? "A player"} has rested {w.restMinutes} of{" "}
                {w.requiredMinutes} min since their last match.
                {restBlocked ? " This tournament doesn't allow starting before the full rest." : ""}
              </li>
            ))}
          </ul>
        ) : null}
        {/* A reader sees the match and its score, not buttons they cannot press. */}
        <div className={canEdit ? "flex gap-2" : "hidden"}>
          {isReported ? (
            <Button
              className="h-12 flex-1 text-lg font-semibold shadow-md"
              disabled={!canEdit || busy || !canSubmit}
              onClick={submit}
            >
              Save correction
            </Button>
          ) : notStarted ? (
            <Button
              className="h-12 flex-1 text-lg font-semibold shadow-md"
              disabled={!canEdit || busy || !!startCheck?.conflicts.length || restBlocked}
              onClick={() => {
                // Both are acknowledgement gates, not blocks: a hard physical conflict
                // has already disabled this button above, and the server still refuses
                // one. The rest warning and the schedule conflict are asked about in one
                // dialog rather than two, so the desk stays one click deep.
                if (needsConfirm) {
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
              className="h-12 flex-1 text-lg font-semibold shadow-md"
              disabled={!canEdit || busy || !canSubmit}
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
              <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
              <AlertDialogDescription>{confirmDescription}</AlertDialogDescription>
            </AlertDialogHeader>
            {hasScheduleConflict ? (
              <ul className="space-y-2">
                {allConflictReasons.map((reason) => (
                  <li
                    key={reason}
                    className="rounded-lg border border-warn-border bg-warn-surface/60 px-3 py-2 text-sm font-medium text-warn-foreground"
                  >
                    {reason}
                  </li>
                ))}
              </ul>
            ) : null}
            {restWarningCount > 0 ? (
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
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Don't start</AlertDialogCancel>
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
        {!isReported && canEdit ? (
          <div className="border-t border-hairline pt-3">
            <p className="mb-2 text-sm font-semibold text-muted-foreground">
              More actions
            </p>
            <div className="grid grid-cols-3 gap-2">
              {!isPlacement ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-11 w-full text-sm"
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
                    className="h-11 w-full text-sm"
                    disabled={busy}
                    onClick={() => setExceptionMode(exceptionMode === "void" ? null : "void")}
                  >
                    Void
                  </Button>
                </>
              ) : null}
              {match.status === "scheduled" && canEdit ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 w-full text-sm"
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
                  <label className="block text-sm font-medium">
                    Winner
                    <select
                      className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base"
                      value={winnerId}
                      onChange={(event) => setWinnerId(event.target.value)}
                    >
                      <option value={match.teams[0] ?? ""}>{nameA}</option>
                      <option value={match.teams[1] ?? ""}>{nameB}</option>
                    </select>
                  </label>
                ) : null}
                <label className="block text-sm font-medium">
                  Operator note
                  <Input
                    className="mt-1 h-11 text-base"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder={
                      exceptionMode === "walkover"
                        ? "Example: Team B did not arrive"
                        : "Reason for voiding this match"
                    }
                  />
                </label>
                <Button size="sm" className="h-11 text-sm" disabled={busy || !note.trim()} onClick={resolveException}>
                  Confirm {exceptionMode}
                </Button>
              </div>
            ) : null}

            {exceptionMode === "move" ? (
              <div className="mt-3 grid gap-2 rounded-lg bg-muted/50 p-3 sm:grid-cols-2">
                <label className="block text-sm font-medium">
                  Court
                  <select
                    className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base"
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
                <div className="block text-sm font-medium">
                  {/* Not wrapped around the field: the picker button inside would become
                      part of the label's text. */}
                  <label htmlFor="desk-move-time">Start time</label>
                  <PickerInput
                    id="desk-move-time"
                    className="mt-1 h-11"
                    inputClassName="text-base"
                    type="datetime-local"
                    pickerLabel="Open the calendar and time picker for the start time"
                    value={moveTime}
                    onChange={(event) => setMoveTime(event.target.value)}
                  />
                </div>
                <Button
                  className="h-11 text-sm sm:col-span-2"
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
              className="h-11 w-full text-sm"
              disabled={busy}
              onClick={() => setClearOpen(true)}
            >
              Clear result
            </Button>
            <p className="mt-1.5 text-sm text-muted-foreground">
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
        {!canEdit ? (
          <p className="text-xs text-muted-foreground">
            You can read this match but not change it.
          </p>
        ) : null}
      </div>
    </>
  );
}

const ACTION_TONE = {
  // The one thing the desk wants done: the accent, and always a button.
  go: { row: "bg-primary/10 text-foreground", icon: "bg-primary text-primary-foreground", glyph: "▶" },
  // Allowed, but someone should look. Amber, never red: a delay is not a danger.
  warn: {
    row: "border border-warn-border bg-warn-surface text-warn-foreground",
    icon: "bg-warn-foreground text-warn-surface",
    glyph: "!",
  },
  // State of the plan that the desk cannot fix itself.
  info: { row: "bg-muted text-foreground", icon: "bg-muted-foreground text-surface", glyph: "i" },
} as const;

/**
 * One row of "Needs action": a short title, one line of detail, and the button that clears it.
 *
 * The glyph and the title are the channels besides colour; the button means the row's text
 * never has to explain how to act. `aria-hidden` on the glyph because the title already says it.
 */
function ActionRow({
  tone,
  title,
  detail,
  action,
}: {
  tone: keyof typeof ACTION_TONE;
  title: string;
  detail: string;
  action: React.ReactNode;
}) {
  const style = ACTION_TONE[tone];
  return (
    <li className={`flex min-h-12 items-center gap-3 rounded-lg px-3 py-2 ${style.row}`}>
      <span
        aria-hidden="true"
        className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-extrabold ${style.icon}`}
      >
        {style.glyph}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold leading-snug">{title}</span>
        <span className="block text-sm">{detail}</span>
      </span>
      {action}
    </li>
  );
}

function CourtStatePill({ state }: { state: CourtState }) {
  // The label, the fill and the ink all come from `court-state.ts`, so the sweep in
  // `e2e/states.spec.ts` and this component read one vocabulary rather than two.
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 font-score text-sm font-semibold uppercase tracking-wide ${COURT_STATE_CHIP[state]}`}
    >
      {COURT_STATE_LABEL[state]}
    </span>
  );
}

/**
 * One court transition, as a row of the panel's table.

 *
 * Not a button, and that is the requirement rather than an omission: the panel reports the
 * order things are about to happen in and must not become a way to move a match, reorder a
 * queue or start something early. The board above is where a court is acted on.
 *
 * ## Why the row is a table row at all
 *
 * This panel answers one question with five parallel facts - which court, which match, what
 * kind of change, when, and whether it is late - and that is the shape a table is for. A list
 * of rows was the wrong one: each row re-declared the same field order in its own flexible
 * layout, so the reader compared entries by moving their eye down a ragged edge rather than
 * down an aligned column. Columns put each fact in one place, put the comparanda in a vertical
 * line, and let the eye do what it is good at.
 *
 * Something concrete came with it: `table`, `td` and `th` are given tabular numerals by the
 * design system already, so the times and durations in the Due and Status columns align on the
 * digit without a utility being applied for it. That is the reason "09:00" over "12:20" reads
 * as a column instead of as two strings.
 *
 * ## Five weights, and only two of them loud
 *
 *   court   `font-score` semibold - an identifier, narrow, aligned on its digits
 *   match   semibold foreground - the subject, and the row's anchor
 *   kind    caption size, muted - reference detail
 *   due     caption size, muted, right-aligned - reference detail
 *   status  semibold, right-aligned - the one cell that carries a varying state
 *
 * Court and Match are the two the eye lands on, which is what makes a row identifiable in a
 * scan. Kind and Due are deliberately the same size and the same ink as each other, so neither
 * can be mistaken for the row's subject.
 *
 * ## What replaced what
 *
 * The court used to be a bare digit in a badge. A digit in a badge reads as a rank or an
 * ordinal, and this was the only place in the app a court number appeared with no word beside
 * it - the board draws the same badge and then spells out "Court 1" next to it. Saying "Court"
 * once, as a column header, over a column of `C4` is the thing a table is for: name it once
 * rather than once per row.
 *
 * The kind used to be a leading pill, the loudest treatment on the row, spent on the panel's
 * least useful fact - that a start is a start - and it was what made the rows two lines tall.
 * It is now words in a column, with no fill and no glyph.
 *
 * ## The row height is the band's, not the table's
 *
 * The rows take `--row-height`, the same token Court progress uses in the panel beside them,
 * so the two step down the band in one rhythm instead of two. The single line is what made a
 * table this dense possible in the first place; the token is what stops it drifting away from
 * its neighbour, which is a thing it had already done once.
 *
 * ## Colour: one hue, one cell, and never alone
 *
 * The only hue left in the panel is `--warn-foreground` on a late Status, and the redundancy
 * rule is intact: the status is written out as words - "6h 2m overdue" - so the colour is the
 * second channel rather than the only one, and nothing here is conveyed by hue alone.
 *
 * What was dropped is the per-row warning chip, which put a filled amber surface on every late
 * row at once. Five identical filled chips down one column is not emphasis, it is wallpaper;
 * the place that count is genuinely emphatic is the panel header, which states it once.
 *
 * The other two chip fills went with it, which is why `COURT_TRANSITION_CHIP` no longer exists:
 * the kind's fill had no other consumer, and a token kept after its only renderer is deleted is
 * a standing claim that something still paints it. The estimate marker survives as the `~` on
 * the Due cell. The footnote that used to gloss that `~` is gone as well, which leaves the Kind
 * column's words as the channel that names a projection - and leaves the panel's header as the
 * panel's name and its one summary, with nothing beneath the table.
 *
 * The pairings are still absent on purpose - the board is already showing them at a size meant
 * for reading them.
 */
function TransitionRow({
  transition,
  courtNumber,
}: {
  transition: CourtTransition<DeskMatch>;
  courtNumber: number | null;
}) {
  const { kind, estimated, overdue, minutesAway, minutesOverdue } = transition;
  const clock = timeLabel(new Date(transition.atMs));

  return (
    <tr data-transition-row className="h-[var(--row-height)]">
      <td
        data-transition-cell="court"
        className="py-1 pr-3 align-middle font-score tabular-nums text-base font-semibold text-foreground"
      >
        C{courtNumber ?? "?"}
      </td>
      <td
        data-transition-cell="match"
        className="py-1 pr-3 align-middle text-base font-semibold text-foreground"
      >
        {transition.match.tag || "Match"}
      </td>
      {/* Supporting detail: the kind of change, and the instant it was read from. These two
          columns are the ones dropped at narrow widths, since both are secondary to the
          match and to its status. */}
      <td
        data-transition-cell="kind"
        className="hidden py-1 pr-3 align-middle text-sm text-muted-foreground sm:table-cell"
      >
        {COURT_TRANSITION_LABEL[kind]}
      </td>
      <td
        data-transition-cell="due"
        className="hidden whitespace-nowrap py-1 pr-3 text-right align-middle font-score tabular-nums text-sm text-muted-foreground sm:table-cell"
      >
        {/* The leading "~" is the marker for a projected value. It carries this cell alone -
            there is no footnote under the table explaining it, so the Kind column's own words
            ("Expected finish" against "Scheduled start") are what state the distinction. */}
        {estimated ? `~${clock}` : clock}
      </td>
      <td
        data-transition-cell="status"
        className="whitespace-nowrap py-1 pl-3 text-right align-middle font-score tabular-nums text-base font-semibold"
      >
        {overdue ? (
          <span className="text-warn-foreground">
            {transitionOverdueBy(minutesOverdue ?? 0)}
          </span>
        ) : (
          <span className="text-foreground">{transitionCountdown(minutesAway ?? 0)}</span>
        )}
      </td>
    </tr>
  );
}

/** The column headers, one weight and one case, so the row of them reads as a rail. */
const TRANSITION_HEAD = "py-2 pr-3 text-sm font-semibold text-muted-foreground";

/**
 * The panel's contents as one table.
 *
 * A real `<table>` rather than a grid of divs, for the reason it exists: the header cells are
 * associated with the data cells, so a screen reader announces "Due, 09:00" rather than
 * reading five unlabelled strings in sequence. `scope="col"` is what carries that, and it is
 * the part a div grid cannot reproduce.
 *
 * ## The columns step, rather than the table scrolling
 *
 * Five columns do not fit the 311px of usable width at 390px, and a horizontally scrolling
 * operations table is a worse answer than a shorter one - reaching the status would mean
 * scrolling, and the status is the column the panel exists for. So Kind and Due are dropped
 * below `sm`, and Court, Match and Status keep the full width. That is also the order of
 * importance, so the columns that leave are the ones the design already made quietest, and
 * nothing is hidden that is not simply restated in a cell that stays.
 */
function TransitionTable({
  transitions,
  courtMap,
}: {
  transitions: readonly CourtTransition<DeskMatch>[];
  courtMap: ReadonlyMap<string, { number: number }>;
}) {
  return (
    <>
      <table className="w-full border-collapse text-left text-base">
        <thead>
          <tr className="border-b border-hairline">
            <th scope="col" className={TRANSITION_HEAD}>
              Court
            </th>
            <th scope="col" className={TRANSITION_HEAD}>
              Match
            </th>
            <th scope="col" className={`${TRANSITION_HEAD} hidden sm:table-cell`}>
              Transition
            </th>
            <th scope="col" className={`${TRANSITION_HEAD} hidden text-right sm:table-cell`}>
              Due
            </th>
            {/* The one header that stays at every width: it is the column being scanned. */}
            <th scope="col" className={`${TRANSITION_HEAD} pl-3 text-right`}>
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {transitions.map((transition) => (
            <TransitionRow
              key={`${transition.courtId}-${transition.kind}`}
              transition={transition}
              courtNumber={courtMap.get(transition.courtId)?.number ?? null}
            />
          ))}
        </tbody>
      </table>
    </>
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
    return <span className="text-base font-semibold text-primary-ink">Ready now</span>;
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
  const count = `${impact.shiftedMatches} later match${impact.shiftedMatches === 1 ? "" : "es"}`;
  const distance = `by up to ${impact.largestShiftMinutes} min`;
  if (impact.direction === "mixed") return `${prefix}. ${count} rescheduled ${distance}.`;
  if (impact.direction === "later") return `${prefix}. ${count} delayed ${distance}.`;
  return `${prefix}. ${count} moved ${impact.direction} ${distance}.`;
}

function localDateTimeValue(value: string | null): string {
  const date = value ? new Date(value) : new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}
