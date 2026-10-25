import { useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

import { Page, Panel } from "@/components/app-shell";
import { ConnectionBadge } from "@/components/connection-badge";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/info-note";
import {
  useAutoSchedule,
  useAutoScheduleProblem,
  useAutoScheduleReconciler,
} from "@/hooks/useAutoSchedule";
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
  fetchPlacementMatches,
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
  usePoolMatches,
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
  type TierDrawMatch,
  type TournamentDay,
} from "@/lib/tournament/data";
import {
  dayDateLabel,
  gamesLabel,
  gamesWinnerFor,
  minutesSince,
  parseGames,
  timeLabel,
  type GameScore,
} from "@/lib/tournament/format";
import { parseScoreInput, readScoreEntry, scorePasteRefusal } from "@/lib/tournament/score-entry";
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
  isPlacementKind,
  playerStatus,
  type DeskMatchModel,
  type MatchReadiness,
} from "@/lib/tournament/desk";
import {
  COURT_STATE_CHIP,
  COURT_STATE_LABEL,
  COURT_STATE_TILE,
  type CourtState,
} from "@/lib/tournament/court-state";
import { buildDeskMatches, type DeskMatch } from "@/lib/tournament/desk-matches";
import { MatchIdentity } from "@/components/match-identity";
import { placementMatchExplanation } from "@/lib/tournament/placement-presentation";
import {
  conflictedMatchCount,
  conflictKindLabels,
  groupConflictsByMatch,
} from "@/lib/tournament/schedule-conflicts";
import { nextPausedSince } from "@/lib/tournament/desk-paused";
import {
  callNextAvailability,
  callNextPlayersFree,
  callNextContext,
  callNextMessage,
} from "@/lib/tournament/call-next";
import {
  CallNextButton,
  CallNextDialog,
} from "@/components/desk/call-next";
import { useMatchCalls } from "@/hooks/useMatchCalls";
import { DayScheduleStatus } from "@/components/schedule-status";
import {
  attributeMatchesToDays,
  dayOperationalCounts,
  resolveSelectedDay,
} from "@/lib/tournament/day-scope";
import { courtsForDay, dayWindowBounds } from "@/lib/tournament/scheduling/day-plan";

/** How long a ready match may sit without a time before the Desk says so on its own. */
const STRANDED_NOTICE_MS = 60_000;

export const Route = createFileRoute("/tournaments/$tournamentId/desk")({
  head: () => ({
    meta: [
      { title: "Tournova Control Desk | Live Badminton Tournament Ops" },
      {
        name: "description",
        content:
          "Live control desk for one tournament day: its court board and its matches.",
      },
      { property: "og:title", content: "Tournova Control Desk | Live Badminton Tournament Ops" },
      {
        property: "og:description",
        content:
          "Live control desk for one tournament day: its court board and its matches.",
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
  /**
   * The match the Call next dialog is open for, and its court. Held as the match, not the
   * court: if that match starts or moves while the dialog is open, the court's next match
   * changes, and the dialog closes rather than quietly showing another match's players.
   */
  const [callTarget, setCallTarget] = useState<{ courtId: string; matchId: string; scheduled: string | null; players: string; ready: boolean } | null>(null);
  const callOpener = useRef<HTMLElement | null>(null);
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
  const { data: tournamentDays } = useTournamentDays();
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

  /**
   * When live updates stopped, and the instant everything below is derived at.
   *
   * While paused, the data is as old as the moment the connection dropped, so lateness,
   * overruns and when a court frees are computed at that moment rather than now: a match that
   * has started since would otherwise read as later and later. The clock in the bar keeps
   * running; the panels say "as of" and grey their minutes. See `desk-paused.ts`.
   */
  const [pausedSince, setPausedSince] = useState<number | null>(null);
  useEffect(() => {
    setPausedSince((previous) => nextPausedSince(previous, live.status, Date.now()));
  }, [live.status]);
  const paused = pausedSince != null;
  const viewNow = pausedSince ?? now;

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
  const [refreshing, setRefreshing] = useState(false);
  const refreshDesk = async () => {
    if (refreshing) return;
    if (!navigator.onLine) {
      toast.error("You are offline. Reconnect to refresh the desk.");
      return;
    }
    setRefreshing(true);
    try {
      await qc.invalidateQueries({}, { throwOnError: true });
      setNow(Date.now());
      toast.success("Desk updated.");
    } catch {
      toast.error("Could not refresh the desk. Try again.");
    } finally {
      setRefreshing(false);
    }
  };
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
    () => dayOperationalCounts(dayMatches, slotMinutesFor, viewNow),
    // slotMinutesFor reads only the tournament's timings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dayMatches, tournament, viewNow],
  );

  const dayCloseMs = selectedDay ? dayWindowBounds(selectedDay).end : null;

  const courtStates = courtsOnSelectedDay.map((court) => ({
    court,
    state: deriveCourtState(court.id, dayMatches, slotMinutesFor, restMinutesFor, viewNow),
  }));

  /**
   * The tab reads "Control desk" while the Desk is open, rather than the route's long head
   * title; leaving the Desk gives the route its own title back.
   */
  const baseTitle = useRef<string | null>(null);
  useEffect(() => {
    baseTitle.current ??= document.title;
    const base = baseTitle.current ?? "";
    const title = "Control desk";
    document.title = title;
    return () => {
      // Only take our own title back. A route change may already have set the next page's,
      // and restoring ours on top of it would leave the tab naming a page you have left.
      if (base && document.title === title) document.title = base;
    };
  }, []);


  /**
   * Matches the schedule has not placed: both sides known, no court. They are not offered on any
   * tile - the desk starts only the court's own match - so this list exists for the stranded
   * notice below. A ready match with no time at all is on no day, so it comes from the neutral
   * untimed pool.
   */
  const unplaced = [...dayMatches, ...attribution.untimed].filter(
    (match) => match.status === "scheduled" && !match.courtId,
  );

  /**
   * Ready matches that automatic scheduling has left without a time, said out loud.
   *
   * A pass that fails is silent by design (the result it followed is already saved), so an idle
   * tile's "Ready to place" offer used to be the only trace: on Viet Nam Open 2026's second
   * morning five knockout matches sat there for eleven minutes while every pass threw, and it
   * read as an ordinary offer. The
   * notice appears as soon as a pass reports a problem, or once the same set has waited a minute.
   */
  const autoProblem = useAutoScheduleProblem();
  const strandedKey = unplaced
    .map((match) => match.id)
    .sort()
    .join(",");
  const [stranded, setStranded] = useState<{ key: string; since: number }>({ key: "", since: 0 });
  useEffect(() => {
    setStranded((previous) =>
      previous.key === strandedKey ? previous : { key: strandedKey, since: Date.now() },
    );
  }, [strandedKey]);
  const showStranded =
    canEdit &&
    unplaced.length > 0 &&
    (autoProblem != null || viewNow - stranded.since >= STRANDED_NOTICE_MS);

  /**
   * Call next is available to anyone who may edit this tournament.
   */
  const offerCallNext = canEdit;
  const calls = useMatchCalls(tournament?.id ?? null, offerCallNext);
  const playerReach = calls.reach;
  const notifiedAtFor = calls.notifiedAtFor;
  const callCourt = callTarget
    ? (courtStates.find(({ court }) => court.id === callTarget.courtId) ?? null)
    : null;
  const callMatch =
    callCourt?.state.next && callCourt.state.next.id === callTarget?.matchId
      && callCourt.state.next.scheduled === callTarget.scheduled
      && [...callCourt.state.next.playerIds].sort().join(",") === callTarget.players
      && (!callTarget.ready || callCourt.state.state === "free-ready")
      ? callCourt.state.next
      : null;
  // The match moved on while the dialog was open: let the target go too, so it cannot come back.
  useEffect(() => {
    if (callTarget && !callMatch) setCallTarget(null);
  }, [callTarget, callMatch]);

  const [boardScrollRef, boardCue] = useScrollCue();
  const hiddenCourts = boardCue.hidden;

  /*
    The venue's time, once this browser's clock has been adopted - never in the server render,
    for the reason `clockAdopted` gives - then the connection and Refresh. They belong to the
    whole page, not one panel.
  */
  const controls = (
    <span className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-hairline bg-surface px-2 py-1">
      {clockAdopted ? (
        <time data-desk-clock className="font-score text-sm font-semibold tabular-nums text-foreground">
          {timeLabel(new Date(now))}
        </time>
      ) : null}
      <ConnectionBadge status={live.status} lastUpdatedAt={live.lastUpdatedAt} />
      {/* While paused, Refresh is the one thing to do here, so it is the primary button. */}
      <Button
        size="sm"
        variant={paused ? "default" : "ghost"}
        className="h-11 gap-1.5 px-3 text-sm"
        disabled={refreshing}
        aria-busy={refreshing}
        onClick={() => void refreshDesk()}
      >
        <RefreshCw aria-hidden="true" className={refreshing ? "motion-safe:animate-spin" : undefined} />
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
    </span>
  );
  /** On each panel while paused: the moment its numbers are from. */
  const asOf = paused ? (
    <span className="rounded bg-danger-surface px-1.5 py-0.5 text-xs font-semibold text-danger-foreground">
      as of {timeLabel(new Date(pausedSince))}
    </span>
  ) : null;

  /** Whether the day bar doubles as the console's bar, carrying `controls`. */
  const consoleBar = canEdit && orderedDays.length > 0;

  return (
    <Page
      title="Control desk"
      subtitle={
        canEdit
          ? "Live operations for one tournament day: its courts and its matches."
          : "A live view of one tournament day: what is on each court."
      }
      actions={
        /*
          On the console the page header scrolls away, so these move into the console's own bar
          (below) and are hidden here - `display: none`, so the badge's live region is never
          announced twice.
        */
        <span className={consoleBar ? "contents desk-console:hidden" : "contents"}>{controls}</span>
      }
    >
      {/*
        The console. For an operator on a laptop or larger it is exactly one viewport tall and
        sits under the workspace header, which scrolls away: one scroll and the window is the
        Desk. The board takes the height left under the day bar and scrolls inside itself.
        Narrower or shorter, the page scrolls. A reader gets the board in the page's own flow.
      */}
      <div
        data-desk-paused={paused ? "" : undefined}
        className={
          canEdit
            ? "space-y-5 desk-console:flex desk-console:h-dvh desk-console:flex-col desk-console:gap-4 desk-console:space-y-0 desk-console:py-3"
            : "space-y-5"
        }
      >
        {orderedDays.length ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-hairline bg-surface px-3 py-2 text-xs desk-console:flex-none desk-console-short:py-1">
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
                      ? "bg-foreground text-surface"
                      : "bg-muted text-muted-foreground hover:bg-muted/70"
                  }`}
                >
                  {dayDateLabel(day.date)}
                </button>
              ))}
            </div>
            <span className="ml-auto flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <DayScheduleStatus latestFinishMs={dayCounts.latestFinishMs} closeMs={dayCloseMs} />
              {/*
                The day's pace as one count, in place of the per-court progress bars: those led
                to no action, and the moderator only needs to read how far through the day is.

                The count is the *scheduled* work, which is not the same as the whole field: a
                match that has been generated but not yet given a court and time is attributed
                to no day, so it is neither counted nor expected here. The note says so, because
                a moderator reading "12 of 16" mid-afternoon and then finding a fifth of the
                field unplaced would otherwise be reading a number that never mentioned it.
              */}
              <span className="text-muted-foreground">
                <b className="font-semibold tabular-nums text-foreground">
                  {dayCounts.completed} of {dayCounts.completed + dayCounts.remaining}
                </b>{" "}
                matches done
                <InfoNote label="What this count includes" className="ml-1 align-middle">
                  <p>
                    Only matches already placed on this day&apos;s courts. A match that has been
                    generated but not yet given a court and time is not counted here, and a void
                    match is left out of both numbers.
                  </p>
                  <p>
                    A walkover counts as done: it is decided, and nothing more is owed on it.
                  </p>
                </InfoNote>
              </span>
            </span>
            {consoleBar ? (
              <span className="hidden items-center gap-2 desk-console:flex">{controls}</span>
            ) : null}
          </div>
        ) : null}

        {/*
          While updates are paused: since when, what that means for the numbers below, and that
          it is retrying. The badge says "Offline" and is the live region; this bar is the detail,
          so it is not announced a second time.
        */}
        {paused ? (
          <p className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-foreground desk-console:flex-none">
            <span className="font-semibold">No updates since {timeLabel(new Date(pausedSince))}.</span>{" "}
            Minutes and times below are as of then and may be out of date
            {canEdit ? ", and starting, scoring and moving matches is paused" : ""}. Retrying on its
            own; Refresh tries now.
          </p>
        ) : showStranded ? (
          <p
            role="status"
            data-testid="desk-stranded-notice"
            className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-foreground desk-console:flex-none"
          >
            <span className="font-semibold">
              {unplaced.length} ready match{unplaced.length === 1 ? " has" : "es have"} no
              time yet.
            </span>{" "}
            {autoProblem?.detail ?? "Automatic scheduling has not placed them."}{" "}
            {tournament ? (
              <Link
                to="/tournaments/$tournamentId/schedule"
                params={{ tournamentId: tournament.id }}
                className="font-semibold underline underline-offset-2"
              >
                Review the schedule
              </Link>
            ) : null}
          </p>
        ) : null}

        <Panel
          title="Court board"
          className={canEdit ? "flex min-h-0 flex-col desk-console:flex-1" : ""}
          bodyClassName={canEdit ? "flex min-h-0 flex-1 flex-col p-0" : ""}
          right={
            selectedDay ? (
              <span className="flex flex-wrap items-center justify-end gap-x-2 text-sm text-muted-foreground">
                {asOf}
                {/* The day is the day bar's to say; this names only what the board holds. */}
                <span>
                {courtsOnSelectedDay.length} court
                {courtsOnSelectedDay.length === 1 ? "" : "s"}
                {/*
                  Courts never move, so the ones out of view are named, not counted: "Courts
                  9–14 below" says exactly where to look.
                */}
                {hiddenCourts.length ? (
                  <span className="font-semibold text-foreground">
                    {", "}
                    {hiddenCourts.length === 1
                      ? `Court ${hiddenCourts[0]} below`
                      : `Courts ${Math.min(...hiddenCourts)}–${Math.max(...hiddenCourts)} below`}
                  </span>
                ) : null}
                </span>
              </span>
            ) : null
          }
        >
          <div
            ref={boardScrollRef}
            tabIndex={boardCue.scrollable ? 0 : undefined}
            role={boardCue.scrollable ? "region" : undefined}
            aria-label={boardCue.scrollable ? "Court board" : undefined}
            className={
              canEdit
                ? `min-h-0 flex-1 overflow-auto p-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary ${
                    boardCue.more ? SCROLL_FADE : ""
                  }`
                : ""
            }
          >
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-3">
            {courtStates.map(({ court, state }) => {
              // Only the court's own match: the one on it, or the one the schedule placed next. An
              // idle court used to offer the first ready match with no time and start it here, which
              // is how a match the plan had not placed was started on Viet Nam Open 2026's day two
              // and took a player from another court's published match. A match with no time is now
              // the stranded notice's to report, and the Schedule's to place.
              const target = state.playing ?? state.next;
              // The button is about the court's queued match, never `target`: on a busy court
              // that is the match being played.
              const callNext = offerCallNext
                ? callNextAvailability(state.next, dayMatches)
                : ({ kind: "none" } as const);
              return (
                /*
                  The tile is two controls side by side, not one inside the other: the button that
                  opens the match fills the tile, and Call next sits over its bottom-right corner.
                */
                <div
                  key={court.id}
                  data-court-number={court.number}
                  className={`relative flex flex-col ${
                    target ? "transition-transform hover:-translate-y-0.5" : ""
                  }`}
                >
                <button
                  type="button"
                  disabled={!target}
                  aria-label={`Court ${court.number}: ${state.state.replace("-", " ")}`}
                  onClick={() => {
                    if (!target) return;
                    setOperationCourtId(court.id);
                    setOpenMatch(target);
                  }}
                  className={`flex flex-1 flex-col rounded-xl border p-4 text-left shadow-panel transition-all enabled:hover:border-primary/60 enabled:hover:shadow-raise disabled:cursor-default ${COURT_STATE_TILE[state.state]}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 font-display text-lg font-bold">
                      Court {court.number}
                    </span>
                    <CourtStatePill state={state.state} />
                  </div>

                  {/*
                    The tile answers one question per state, in the same three lines: what the
                    match is (its tag, and on a free court when it is due), who plays it, and the
                    one number or reason a moderator acts on. The chip above already says the
                    state, so the body does not say it a second time in words.

                    Names are clamped. A doubles pairing with long names ran to six lines and
                    pushed the timer or the readiness line below the fold of a 720px console; the
                    full names are one click away in the match's own dialog, and on hover here.
                  */}
                  {state.playing ? (
                    <div className="mt-3 leading-snug">
                      <p className="font-score text-sm font-medium text-muted-foreground">
                        <MatchIdentity match={state.playing} />
                      </p>
                      <p
                        className="line-clamp-3 text-base font-semibold"
                        title={`${label(state.playing.teams[0])} vs ${label(state.playing.teams[1])}`}
                      >
                        {label(state.playing.teams[0])} vs {label(state.playing.teams[1])}
                      </p>
                      <p
                        className={`font-score text-base tabular-nums ${
                          state.state === "overrun"
                            ? "font-semibold text-warn-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {/*
                          Playing gives the elapsed minutes against the slot, so a moderator reads
                          how far through the match is - and roughly when the court frees - without
                          arithmetic. Overrun gives only how long the court has been held: the
                          amber tile already says it is past its slot, and "48′ of 15′" would be a
                          second statement of that. Neither says how the match started.
                        */}
                        {state.state === "overrun" ? (
                          <span data-desk-derived>{state.elapsedMinutes} min on court</span>
                        ) : (
                          <>
                            <span data-desk-derived>{state.elapsedMinutes}</span> of{" "}
                            {slotMinutesFor(state.playing)} min on court
                          </>
                        )}
                      </p>
                    </div>
                  ) : state.next ? (
                    /*
                      A free court's queued match is the thing it is about, so it takes the place
                      the playing match has on a busy tile: due time and tag, the names, and the
                      readiness line - which answers "can it start", the question a free court is
                      asked. Free-ready is exactly "yes"; Waiting is "not yet, and here is why".
                    */
                    <div className="mt-3 leading-snug">
                      <div className="mb-1 space-y-1 font-score text-sm font-medium text-muted-foreground">
                        <span className="block whitespace-nowrap">Next {timeLabel(state.next.scheduled)}</span>
                        <MatchIdentity match={state.next} />
                      </div>
                      <p
                        className="line-clamp-3 text-base font-semibold"
                        title={`${label(state.next.teams[0])} vs ${label(state.next.teams[1])}`}
                      >
                        {label(state.next.teams[0])} vs {label(state.next.teams[1])}
                      </p>
                      <p className="mt-1 line-clamp-2">
                        <ReadinessText
                          readiness={state.readiness}
                          courts={courtMap}
                          players={playerMap}
                        />
                      </p>
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">Nothing queued</p>
                  )}

                  {/*
                    A busy court names its next pairing and nothing more - no "Ready now", no
                    reason it is not ready yet. While a match is in progress the question is
                    premature: the court cannot take it until the current match ends, whatever
                    the clock says about rest, and a two-minute countdown on a court with twenty
                    minutes left is noise, not a plan. Its time is the published one, which can
                    already have passed: the match waits for the court to clear.
                  */}
                  {state.playing ? (
                    <p className="mt-2 border-t border-hairline pt-2 text-t2 text-muted-foreground">
                      {state.next ? (
                        <span
                          className="line-clamp-2"
                          title={`${label(state.next.teams[0])} vs ${label(state.next.teams[1])}`}
                        >
                          <span className="mb-0.5 block font-medium">Next {timeLabel(state.next.scheduled)}</span>
                          <span>{label(state.next.teams[0])} vs {label(state.next.teams[1])}</span>
                        </span>
                      ) : (
                        "Nothing queued"
                      )}
                    </p>
                  ) : null}
                  {/*
                    Pinned to the tile's foot, so it lines up across a row. The spacer sits above the
                    44px line rather than inside it, so the words are level with Call next, which
                    sits over the right of this line.
                  */}
                  <div className="mt-auto pt-3">
                    <p
                      className={`flex min-h-11 items-center text-sm font-semibold text-primary-ink ${
                        callNext.kind === "none" ? "" : "pr-28"
                      }`}
                    >
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
                  </div>
                </button>
                {callNext.kind !== "none" && state.next ? (
                  <span className="absolute bottom-4 right-1 z-10">
                    <CallNextButton
                      availability={callNext}
                      playersFree={callNextPlayersFree(state.next, dayMatches, state.next ? restMinutesFor(state.next) : 0, viewNow)}
                      courtNumber={court.number}
                      notifiedAt={notifiedAtFor(state.next.id)}
                      paused={paused || calls.sending}
                      onOpen={(opener) => {
                        callOpener.current = opener;
                        if (state.next) setCallTarget({ courtId: court.id, matchId: state.next.id,
                          scheduled: state.next.scheduled, players: [...state.next.playerIds].sort().join(","),
                          ready: state.state === "free-ready" });
                      }}
                    />
                  </span>
                ) : null}
                </div>
              );
            })}
          </div>
          </div>
        </Panel>
      </div>

      {offerCallNext ? (
        <CallNextDialog
          open={callMatch != null}
          onOpenChange={(open) => !open && setCallTarget(null)}
          matchId={callMatch?.id ?? null}
          courtNumber={callCourt?.court.number ?? "?"}
          courtId={callMatch?.courtId ?? null}
          context={
            callMatch && callCourt
              ? callNextContext({
                  tag: callMatch.tag,
                  courtNumber: callCourt.court.number,
                  scheduledMs: callMatch.scheduled ? new Date(callMatch.scheduled).getTime() : null,
                  scheduledLabel: callMatch.scheduled ? timeLabel(callMatch.scheduled) : null,
                  court: callCourt.state.playing
                    ? { kind: "busy", elapsedMinutes: callCourt.state.elapsedMinutes }
                    : { kind: "free" },
                  now: viewNow,
                })
              : ""
          }
          players={(callMatch?.playerIds ?? []).map((id) => ({
            id,
            name: playerMap.get(id)?.name ?? "A player",
            status: playerStatus(id, callMatch!, dayMatches, restMinutesFor(callMatch!), viewNow),
          }))}
          courtNumberFor={(id) => (id ? (courtMap.get(id)?.number ?? "?") : "?")}
          explanation={callMatch ? placementMatchExplanation(callMatch.placementContext, label(callMatch.teams[0]), label(callMatch.teams[1])) : null}
          identity={callMatch}
          scheduledLabel={callMatch?.scheduled ? timeLabel(callMatch.scheduled) : null}
          courtContext={callMatch && callCourt ? callNextContext({ tag: "", courtNumber: callCourt.court.number,
            scheduledMs: null, scheduledLabel: null, court: callCourt.state.playing
              ? { kind: "busy", elapsedMinutes: callCourt.state.elapsedMinutes } : { kind: "free" }, now: viewNow }) : null}
          reach={playerReach}
          notifiedAt={callMatch ? notifiedAtFor(callMatch.id) : null}
          initialMessage={
            callMatch && callCourt
              ? callNextMessage({
                  tag: callMatch.tag,
                  courtNumber: callCourt.court.number,
                  scheduledLabel: callMatch.scheduled ? timeLabel(callMatch.scheduled) : null,
                  // Only a Ready court asks players to come now; a busy or Waiting one asks
                  // them to be ready, since its match cannot start yet.
                  courtReady: callCourt.state.state === "free-ready",
                })
              : ""
          }
          paused={paused}
          sending={calls.sending}
          sendError={calls.sendError}
          onSend={async (message) => {
            if (!callMatch || paused) return;
            const result = await calls.send(callMatch, message);
            if (result) {
              toast.success(`Sent in Tournova to ${result.count} account${result.count === 1 ? "" : "s"}.`);
              setCallTarget(null);
            }
          }}
          returnFocusTo={callOpener.current}
        />
      ) : null}

      <Dialog open={!!current} onOpenChange={(o) => !o && setOpenMatch(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
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
              pausedSince={pausedSince}
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
  pausedSince = null,
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
  /**
   * When live updates stopped, or null while they arrive. While set, every control that writes
   * is locked and the dialog says why: a write made against data that may be out of date could
   * start a match that has already started, or score one twice.
   */
  pausedSince?: number | null;
  onDone: () => void;
}) {
  /** After a result: draw what it unlocked and slot newly ready matches, never moving a time. */
  const autoSchedule = useAutoSchedule();
  const { data: allPlacementMatches } = usePlacementMatches();
  const { data: tierDrawMatches } = useTierDrawMatches();
  const dependentMatches = (allPlacementMatches ?? []).filter((m) =>
    m.prerequisite_ids.includes(match.id),
  );
  const dependentLabel = (m: PlacementMatch) =>
    `Round 2 match ${m.generation_key.replace("r2-", "")}${m.scheduled_time ? ` — ${timeLabel(new Date(m.scheduled_time), timezone)}` : " — no time assigned"}${m.court_id ? `, Court ${courts.find((c) => c.id === m.court_id)?.number ?? "TBC"}` : ""}`;
  /**
   * The knockout match this result feeds.
   *
   * A bracket match names its two feeders, so the child of a result is a direct lookup rather
   * than a slot calculation, and there is at most one: a parent fills exactly one slot of
   * exactly one later match. What a corrected winner *does* to that child is decided in the
   * database - it is repaired in place while it is unplayed, and refused once it has started -
   * so the dialog asks before the attempt and says which match it is about.
   */
  const knockoutChild = (tierDrawMatches ?? []).find(
    (m) => m.parent_a_id === match.id || m.parent_b_id === match.id,
  );
  const knockoutChildLabel = (m: TierDrawMatch) =>
    `Round ${m.round} match ${m.slot}${m.scheduled_time ? ` — ${timeLabel(new Date(m.scheduled_time), timezone)}` : " — no time assigned"}${m.court_id ? `, Court ${courts.find((c) => c.id === m.court_id)?.number ?? "TBC"}` : ""}`;
  const rows = scoringRule.bestOf;
  const [values, setValues] = useState(() =>
    scoreFormValues(rows, match.status, match.initialGames),
  );
  /**
   * Why the last paste into a score box was refused, in words.
   *
   * Kept apart from `entry.problem` because it is about the edit, not the result: a refused
   * paste leaves a value the rule may well accept, and the desk still needs to know why the
   * number it copied did not appear.
   */
  const [inputNotice, setInputNotice] = useState<string | null>(null);
  const [working, setBusy] = useState(false);
  /** Every write is off while one is in flight, and while live updates are paused. */
  const busy = working || pausedSince != null;
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
  // Nearly every result is reported live, so the picker stays folded until asked for.
  const [finishOpen, setFinishOpen] = useState(false);
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
   * Whether this result can say when it finished.
   *
   * Only the placement and knockout tables take the offset, and both RPCs have had the
   * parameter since `20261011000000_report_ended_minutes_ago.sql`. The dialog drew the
   * field for placement alone, so a knockout result entered twenty minutes late reflowed
   * the rest of the day from the entry time - the exact case the offset was added for.
   */
  const canBackdateFinish = isPlacement || match.kind === "tier";

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

  /**
   * The match as it was when this dialog opened, for the conflict check at submit.
   *
   * `match` is a live prop: the desk refetches on realtime, so another person's correction
   * arrives here as a new `match` object while this dialog is open. Reading the token from
   * the prop at submit time would then move the baseline along with the very change the
   * check exists to catch, and the typed score would overwrite the correction silently.
   * Captured once instead - which is what "the dialog holds a snapshot" was supposed to
   * mean. Both call sites key this component by match id, so a mount is an open.
   */
  const openedAs = useRef({ status: match.status, reportedAt: match.reportedAt ?? null });

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

  /**
   * A score box's edit handlers, identical for both sides of every game.
   *
   * Typing is filtered a character at a time, so a stray keypress disappears and the digits
   * that were meant are still there - what a typo deserves. A paste is a whole value at
   * once, and filtering *that* would rewrite it: a copied `21-19` would become `21`, a score
   * nobody copied. So a paste the box cannot hold is refused whole, the box keeps what it
   * had, and the notice says why.
   *
   * The paste is judged against the box as it stands - its digits and the selection the paste
   * would replace - not against the clipboard alone: `21` is a score and still does not fit a
   * box that already reads `1`, where letting it through would leave `maxLength` to produce
   * `12`. `maxLength` is the same ceiling for the keyboard, and for the paste that passes.
   */
  const scoreBoxProps = (row: number, side: 0 | 1) => ({
    maxLength: 2,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setInputNotice(null);
      set(row, side, parseScoreInput(e.target.value));
    },
    onPaste: (e: ClipboardEvent<HTMLInputElement>) => {
      const refusal = scorePasteRefusal(e.clipboardData.getData("text"), {
        value: e.currentTarget.value,
        selectionStart: e.currentTarget.selectionStart ?? 0,
        selectionEnd: e.currentTarget.selectionEnd ?? 0,
      });
      if (!refusal) {
        setInputNotice(null);
        return;
      }
      e.preventDefault();
      setInputNotice(refusal);
    },
  });

  /**
   * What the box would send, and why it cannot be sent.
   *
   * The refusal is read from the same `gamesWinnerFor` the report path is built on, so the
   * button and the server never disagree; `readScoreEntry` only says it in words. It also
   * refuses a blank row between games, which used to be filtered away and silently turned
   * `21-19, (blank), 21-19` into a legal 2-0.
   */
  const entry = useMemo(
    () =>
      readScoreEntry(
        values.slice(0, rows).map((r) => ({ a: r[0] ?? "", b: r[1] ?? "" })),
        scoringRule,
      ),
    [values, rows, scoringRule],
  );
  const games = entry.games;
  const canSubmit = entry.winner !== null;
  /**
   * The refusal is shown once something has been typed, never on a fresh dialog: greeting
   * the desk with "Enter the score." for a match it has not started is noise, not help.
   */
  const touched = values
    .slice(0, rows)
    .some((r) => (r[0] ?? "") !== "" || (r[1] ?? "") !== "");

  /**
   * A synchronous lock for the save, which `busy` cannot be.
   *
   * `busy` is React state: it is written when the component re-renders, so two clicks that
   * arrive in the same tick both read the value from before the first of them. At a live desk
   * a double tap on a large button is ordinary, and a Save that fires twice corrects the same
   * result twice and reflows the day twice. The ref is written before the first await, so the
   * second click sees it immediately; the disabled state remains the visible half.
   */
  const saving = useRef(false);

  const saveResult = async () => {
    // The offset only exists on the placement and knockout paths. A blank field reads
    // as 0, which is "reported live" and is exactly the old behaviour.
    let endedMinutes = 0;
    if (canBackdateFinish) {
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
      await assertMatchUnchanged(
        table,
        match.id,
        openedAs.current.status,
        openedAs.current.reportedAt,
      );
      /**
       * Whether this save changes who won, as opposed to only the score.
       *
       * Both dependents care about exactly this and nothing else: a score correction that
       * keeps the same winner changes no later match, so warning about one would train the
       * desk to click through the warning that matters.
       */
      const winnerChanged =
        isReported &&
        gamesWinnerFor(games, scoringRule) !==
          gamesWinnerFor(parseGames(match.initialGames), scoringRule);
      if (match.kind === "placement" && winnerChanged && tournamentId) {
        const affected = (await fetchPlacementMatches(tournamentId)).filter((m) =>
          m.prerequisite_ids.includes(match.id),
        );
        if (
          affected.length &&
          !window.confirm(
            `Changing the winner withdraws these dependent matches and their published times:\n${affected.map(dependentLabel).join("\n")}\nThey will be recreated from the corrected result. Continue?`,
          )
        )
          return;
      }
      /**
       * A corrected knockout winner moves the next round's entrant.
       *
       * The database settles what happens to that child - repaired in place while it is still
       * unplayed, refused once it has started - so this only asks before the attempt, and
       * refuses early in the case the server would refuse anyway. Saying it here is the
       * difference between "the Save button failed" and knowing which match is affected.
       */
      if (match.kind === "tier" && winnerChanged && knockoutChild) {
        if (knockoutChild.status !== "scheduled") {
          toast.error(
            "The next round has already started from this result, so the winner cannot be changed.",
          );
          return;
        }
        if (
          !window.confirm(
            `Changing the winner changes who fills a slot in ${knockoutChildLabel(knockoutChild)}. Its court and time stay as published. Continue?`,
          )
        )
          return;
      }
      if (match.kind === "placement" || match.kind === "tier") {
        if (!tournamentId) throw new Error("No active tournament.");
        const report = match.kind === "placement" ? reportPlacementMatch : reportTierDrawMatch;
        const impact = await report(match.id, games, tournamentId, endedMinutes, openedAs.current);
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
        const impact = await reportDrawMatch(match.id, games, scoringRule);
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
   * The save, entered at most once per click burst.
   *
   * The lock is taken before anything is awaited and released in `finally`, so the confirm
   * prompts and the round trips in `saveResult` are all inside it - a second click during a
   * prompt cannot start a second save.
   */
  const submit = async () => {
    if (saving.current) return;
    saving.current = true;
    try {
      await saveResult();
    } finally {
      saving.current = false;
    }
  };

  /**
   * Puts a reported placement or bracket match back to unplayed.
   *
   * The database refuses once a dependent has started; unplayed fixed-feeder
   * children are withdrawn, while adaptive round twos retain their reset gate.
   */
  const clearResult = async () => {
    setBusy(true);
    try {
      if (match.kind === "placement" && tournamentId) {
        const fresh = (await fetchPlacementMatches(tournamentId)).filter((m) =>
          m.prerequisite_ids.includes(match.id),
        );
        const signature = (rows: PlacementMatch[]) =>
          rows
            .map((m) => `${m.id}:${m.scheduled_time}:${m.court_id}`)
            .sort()
            .join("|");
        if (
          fresh.length &&
          signature(fresh) !== signature(dependentMatches) &&
          !window.confirm(
            `Dependent matches changed since this dialog opened. Clearing the result withdraws:\n${fresh.map(dependentLabel).join("\n")}\nContinue?`,
          )
        )
          return;
      }
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

  const placementExplanation = placementMatchExplanation(match.placementContext, nameA, nameB);

  return (
    <>
      <DialogHeader className="space-y-1 border-b border-hairline pb-3 text-left">
        <DialogTitle className="pr-8 font-display text-2xl leading-tight">
          {nameA} <span className="text-muted-foreground">vs</span> {nameB}
        </DialogTitle>
        <DialogDescription className="space-y-1 text-sm">
          <MatchIdentity match={match} />
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            <span>{courtNumber ? `Court ${courtNumber}` : "Court not assigned"}</span>
            <span>{match.status === "in-progress"
              ? `${minutesSince(match.startedAt)} min on court`
              : isReported ? `Finished ${timeLabel(match.endedAt)}`
                : match.scheduled ? `Scheduled ${timeLabel(match.scheduled, timezone)}` : "Time not assigned"}</span>
          </span>
          <span className="block">{scoringRuleLabel(scoringRule)}</span>
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {placementExplanation ? <p className="text-sm text-muted-foreground">{placementExplanation}</p> : null}
        {pausedSince != null && canEdit ? (
          <p className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-foreground">
            <span className="font-semibold">No connection since {timeLabel(new Date(pausedSince))}.</span>{" "}
            Starting, scoring and moving matches is paused until it is back, so nothing is written
            against data that may be out of date.
          </p>
        ) : null}
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
                  aria-label={`Game ${i + 1} ${nameA}`}
                  aria-invalid={touched && entry.problemRow === i}
                  {...scoreBoxProps(i, 0)}
                />
                <span className="w-6 text-center font-score text-2xl text-muted-foreground">:</span>
                <Input
                  className="h-14 w-full text-center font-score text-3xl font-bold tabular-nums"
                  inputMode="numeric"
                  placeholder="—"
                  value={values[i]?.[1] ?? ""}
                  disabled={!canEditScores}
                  aria-label={`Game ${i + 1} ${nameB}`}
                  aria-invalid={touched && entry.problemRow === i}
                  {...scoreBoxProps(i, 1)}
                />
              </div>
            ))}
          </div>
          {rows > 1 ? (
            <p className="mt-2 text-center text-sm text-muted-foreground">
              Games 1–{rows}, top to bottom. {gamesNeededToWin(scoringRule)} wins take the match.
            </p>
          ) : null}
          {/*
            The side the result decides, stated before it is saved. The operator used to
            have to count the games themselves, which is where a mis-entry survives review.
          */}
          {entry.winner && rows > 1 ? (
            <p className="mt-1.5 text-center text-sm font-semibold">
              {`${entry.winner === "a" ? nameA : nameB} wins ${Math.max(entry.winsA, entry.winsB)}–${Math.min(entry.winsA, entry.winsB)}.`}
            </p>
          ) : null}        </div>
        {/*
          Why the result cannot be saved, in words. A disabled button alone reads as a broken
          app at a live desk, and a score the desk believes it entered is then entered twice.
          `role="status"` announces it without stealing focus from the box being typed in.

          One region, two reasons: a refused paste is about the edit and takes precedence,
          because it is the most recent thing that happened and the value on screen is still
          the one the moderator had before it.
        */}
        {inputNotice || (touched && entry.problem) ? (
          <p
            role="status"
            className="rounded-lg border border-warn-border bg-warn-surface px-3 py-2 text-sm font-medium text-warn-foreground"
          >
            {inputNotice ?? entry.problem}
          </p>
        ) : null}
        {/*
          The late-entry correction: one quiet row, so it never competes with entering the
          score. Only the placement and knockout tables accept the offset.
        */}
        {canEditScores && canBackdateFinish ? (
          <fieldset className="min-w-0 space-y-2" disabled={!canEdit || busy}>
            <legend className="sr-only">When did it finish?</legend>
            <div className="flex min-h-11 items-center justify-between gap-3">
              <p className="text-sm">
                <span className="text-muted-foreground">Finished </span>
                <span className="font-semibold">
                  {finishChoice === "now"
                    ? "just now"
                    : finishChoice === "other"
                      ? `at ${finishClock || "…"}`
                      : `${finishChoice} min ago (${clockFromMinutesAgo(Number(finishChoice), new Date(), timezone)})`}
                </span>
              </p>
              <button
                type="button"
                aria-expanded={finishOpen}
                onClick={() => setFinishOpen((open) => !open)}
                className="min-h-11 rounded-md px-3 text-sm font-semibold text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {finishOpen ? "Done" : "Change"}
              </button>
            </div>
            {finishOpen ? (
              <div className="flex flex-wrap items-center gap-1.5">
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
                    onClick={() => {
                      setFinishChoice(value);
                      if (value !== "other") setFinishOpen(false);
                    }}
                    className={`min-h-11 rounded-full border px-3.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
                      finishChoice === value
                        ? "border-primary bg-primary font-semibold text-primary-foreground"
                        : "border-hairline bg-surface"
                    }`}
                  >
                    {text}
                  </button>
                ))}
                {finishChoice === "other" ? (
                  <>
                    <label htmlFor={finishClockFieldId} className="sr-only">
                      Finish time
                    </label>
                    <Input
                      id={finishClockFieldId}
                      type="time"
                      className="h-11 w-32"
                      value={finishClock}
                      onChange={(e) => setFinishClock(e.target.value)}
                    />
                  </>
                ) : null}
              </div>
            ) : null}
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
              <AlertDialogCancel disabled={working}>Don't start</AlertDialogCancel>
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
            <p className="mt-1.5 flex items-center gap-1 text-sm text-muted-foreground">
              Sends this match back to unplayed so the score can be entered again.
              <InfoNote label="What clearing a result affects">
                <p>
                  For fixed round-two pairings, unplayed matches fed by this result are also
                  withdrawn.
                </p>
                <p>A dependent match that has started prevents clearing the result.</p>
                <p>Adaptive round-two pairings still require a placement reset.</p>
              </InfoNote>
            </p>
          </div>
        ) : null}
        <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
          <AlertDialogContent className="max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle>Clear this result?</AlertDialogTitle>
              <AlertDialogDescription>
                {nameA} vs {nameB} goes back to unplayed and the score is discarded. You can enter
                it again afterwards. Any unplayed round-two matches fed by this result in a fixed
                pairing are withdrawn with their court and time.
              </AlertDialogDescription>
              {dependentMatches.length > 0 ? (
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {dependentMatches.map((m) => (
                    <li key={m.id}>{dependentLabel(m)}</li>
                  ))}
                </ul>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={working}>Keep the result</AlertDialogCancel>
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

/**
 * The words for why a queued match can or cannot start, as the tile's readiness line says them.
 */
function readinessReason(
  readiness: MatchReadiness,
  courts: ReadonlyMap<string, { number: number }>,
  players: ReadonlyMap<string, Player>,
): string {
  const who = readiness.playerId ? `${players.get(readiness.playerId)?.name ?? "Player"}, ` : "";
  switch (readiness.state) {
    case "ready":
      return "Ready now";
    case "resting":
      return `${who}ready in ${readiness.remainingMinutes} min`;
    case "player-busy":
      return `${who}on Court ${
        readiness.blockingCourtId ? (courts.get(readiness.blockingCourtId)?.number ?? "?") : "?"
      }`;
    case "teams-missing":
      return "Teams not assigned";
  }
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

/** The bottom fade a scroll region carries while it has more below. */
const SCROLL_FADE = "[mask-image:linear-gradient(to_bottom,#000_calc(100%-40px),transparent)]";

/**
 * What a scroll region is hiding, measured from the region itself.
 *
 * `scrollable` makes it focusable - a region that scrolls must be reachable from the keyboard -
 * and `more` fades its bottom edge while there is content below. `hidden` lists the court
 * numbers of tiles (`data-court-number`) whose top is out of view, so the board can name them.
 * Re-measured on scroll, on a size change of the region or its content, when its content is
 * replaced, and on window resize.
 *
 * It hands back a callback ref rather than reading a ref object, because the board's scroll
 * region only becomes one once the access read says the caller may edit: a ref read on the first
 * render would be empty and the region never measured.
 */
function useScrollCue() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [cue, setCue] = useState<{
    scrollable: boolean;
    more: boolean;
    hidden: number[];
  }>({ scrollable: false, more: false, hidden: [] });
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const scrollable = el.scrollHeight > el.clientHeight + 1;
      const more = el.scrollHeight - el.scrollTop - el.clientHeight > 4;
      const edge = el.getBoundingClientRect().bottom;
      const hidden = more
        ? [...el.querySelectorAll<HTMLElement>("[data-court-number]")]
            // Out of view means its top is below the fold, or all but a sliver of it is: a
            // tile whose name and state show is on screen, even if its foot is cut off.
            .filter((item) => item.getBoundingClientRect().top > edge - 48)
            .map((item) => Number(item.dataset["courtNumber"]))
        : [];
      setCue((prev) =>
        prev.scrollable === scrollable &&
        prev.more === more &&
        prev.hidden.length === hidden.length &&
        prev.hidden.every((n, i) => n === hidden[i])
          ? prev
          : { scrollable, more, hidden },
      );
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    // Rows come and go as the day moves; a new list replaces the empty line inside the region.
    const mutations = new MutationObserver(measure);
    mutations.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [el]);
  return [setEl, cue] as const;
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
  const text = readinessReason(readiness, courts, players);
  if (readiness.state === "ready")
    return <span className="text-base font-semibold text-primary-ink">{text}</span>;
  if (readiness.state === "resting") return <span className="text-warn-foreground">{text}</span>;
  if (readiness.state === "player-busy")
    return <span className="text-warn-foreground">{text}</span>;
  return <span>{text}</span>;
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
