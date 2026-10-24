import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Page, EmptyState, Panel, StatusPill } from "@/components/app-shell";
import { CapacityEstimate } from "@/components/capacity-estimate";
import { ConnectionBadge } from "@/components/connection-badge";
import { MatchFormatCard } from "@/components/match-format";
import { PlayingDayPicker } from "@/components/schedule/playing-day-picker";
import { ScheduledFinish } from "@/components/schedule-status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/info-note";
import { Input } from "@/components/ui/input";
import { useAutoScheduleReconciler } from "@/hooks/useAutoSchedule";
import { PickerInput } from "@/components/ui/picker-input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useScopedAccess } from "@/lib/tournament/data";
import {
  addTournamentDay,
  removeTournamentDay,
  setTournamentCourts,
  setTournamentDayBreaks,
  setTournamentDayCourts,
  updateTournamentDay,
  updateTournamentMatchSettings,
  updateTournamentTimings,
  type ScheduleSummary,
} from "@/lib/tournament/actions";
import {
  fetchCourts,
  fetchPlacementEntrants,
  fetchPlacementMatches,
  fetchTierDrawMatches,
  fetchTierDraws,
  indexBy,
  keys,
  scopedKey,
  teamLabel,
  useCategories,
  useCourts,
  usePlacementEntrants,
  usePlacementMatches,
  usePlayers,
  useRealtimeRefresh,
  useScheduleConflicts,
  useTeams,
  useTierDrawMatches,
  useTierDraws,
  useTournamentDayBreaks,
  useTournamentDayCourts,
  useTournamentScope,
  type PlacementMatch,
  type TierDraw,
  type TierDrawMatch,
  type TournamentDay,
} from "@/lib/tournament/data";
import { courtHoursOffered } from "@/lib/tournament/capacity-estimate";
import { describeUnplaced } from "@/lib/tournament/auto-schedule";
import { buildRebuildSuggestion, type RebuildSuggestion } from "@/lib/tournament/rebuild-suggestion";
import { dayDateLabel, timeLabel } from "@/lib/tournament/format";
import {
  conflictedMatchCount,
  groupConflictsByKind,
  type ConflictKindGroup,
} from "@/lib/tournament/schedule-conflicts";
import { dayIdForTime } from "@/lib/tournament/day-scope";
import { projectedFinishFromRemainingMatches } from "@/lib/tournament/schedule-diff";
import { roundName } from "@/lib/tournament/draws";
import { ruleForStage, type ScoringRule } from "@/lib/tournament/scoring";
import { buildStageProgress } from "@/lib/tournament/stage-progress";
import { cn } from "@/lib/utils";
import { StageProgressList } from "@/components/stage-progress";
import {
  applyPlacementSchedulePlan,
  readyUnplacedCount,
  type UnplacedMatch,
  courtsAddedToDays,
  courtsForDay,
  dayWindowBounds,
  placementMatchLabel,
  planPlacementSchedule,
  projectSlotsOntoMatches,
  sliceRowsByDay,
  type PlacementDayFill,
  type PlacementSchedulePlan,
} from "@/lib/tournament/placement-schedule";
import {
  generateMissingStages,
  resetPlacementSchedule,
  scheduleResetNote,
  stageGenerationChanged,
  type StageGenerationOutcome,
} from "@/lib/tournament/placement-actions";

/**
 * The two-round placement format's scheduling surface.
 *
 * One of the two views the single `schedule` route renders, chosen by the
 * tournament's format — see `src/routes/tournaments/$tournamentId/schedule.tsx`.
 * It is not a route of its own, because a route needs one identity, and this page
 * reads `pool_matches` and `draw_matches` by name while the day planner reads the
 * round-robin tables. Giving them separate files and one format-aware route keeps
 * each page honest about the tables it owns.
 *
 * The layout: the tournament's scheduling inputs, then a day's own window, courts
 * and breaks, then one Build button.
 *
 * Days are capacity rather than build units. The scheduler treats the whole
 * tournament as a single queue — the placement stage and then the knockouts — and
 * fills day one first, spilling into day two. So a day's stage mix is an outcome,
 * not something the desk picks here, and there is nothing to build per day or per
 * stage. The days below exist to say how much court time each one offers.
 */

interface DayWindow {
  date: string;
  start: string;
  end: string;
}

/** One editable break row. Times are `HH:MM`, which is what the time inputs give. */
interface DayBreakRow {
  label: string;
  start: string;
  end: string;
}

function normalizeTime(value: string) {
  if (!value) return value;
  return value.length === 5 ? `${value}:00` : value;
}

/**
 * The organiser's block: every match that cannot run as published, and the one way to fix it.
 *
 * Read-only, and deliberately so. It names the matches, groups them by reason, and points at
 * the existing "Rebuild schedule" control rather than offering a second button - the page has
 * one way to replan, and a block that re-applied a plan itself would be a second, hidden one.
 * It says plainly that nothing has changed yet, because a warning that looks like an action
 * already taken is the reading that costs a host a round.
 *
 * Hidden entirely when the schedule is clean: it is rendered only when the count is above
 * zero, so seeing it at all means there is work to do rather than "no conflicts today".
 *
 * It folds away rather than printing a long list over the running order. The headline is the
 * count and the reasons are one keystroke behind it, so a host who has read it once is not
 * made to scroll past it on every later visit.
 */
function ConflictOverview({
  count,
  groups,
  matchLabel,
  courtNumberLabel,
}: {
  count: number;
  groups: ConflictKindGroup[];
  matchLabel: (matchId: string) => string;
  courtNumberLabel: (courtId: string | null) => string | null;
}) {
  const [open, setOpen] = useState(false);

  /**
   * Move to the existing control, and put focus on it.
   *
   * `scrollIntoView` alone leaves a keyboard user where they were; focusing the button means
   * the next Tab or Enter lands on the thing this block just told them to use. Nothing is
   * clicked - the host still decides whether to replan.
   */
  const goToBuild = () => {
    const target = document.getElementById("build-schedule");
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.focus();
    }
  };

  return (
    <Panel className="border-warn-border bg-warn-surface" bodyClassName="py-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="flex items-center gap-2">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-warn-foreground" />
          <span className="font-display text-base font-bold text-warn-foreground">
            {count === 1
              ? "1 match needs schedule review"
              : `${count} matches need schedule review`}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-warn-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="mt-3 border-t border-warn-border pt-3">
          <ul className="space-y-3">
            {groups.map((group) => (
              <li key={group.kind}>
                <p className="text-t4 font-semibold uppercase tracking-wide text-warn-foreground">
                  {group.label}
                </p>
                <ul className="mt-1 space-y-1">
                  {group.conflicts.map((conflict) => {
                    const court = courtNumberLabel(conflict.court_id);
                    return (
                      <li
                        key={`${conflict.match_table}:${conflict.match_id}:${conflict.conflict_kind}:${conflict.detail}`}
                        className="text-sm text-warn-foreground"
                      >
                        <span className="font-medium">{matchLabel(conflict.match_id)}</span>
                        {court ? <span>, {court}</span> : null}
                        {conflict.scheduled_time ? (
                          <span>, {timeLabel(conflict.scheduled_time)}</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-warn-foreground">
            Rebuild schedule will replan these matches. Nothing changes until you run it.
          </p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={goToBuild}>
            Go to Rebuild schedule
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

interface RunningOrderRow {
  id: string;
  start: Date;
  courtNumber: number;
  categoryCode: string;
  stage: string;
  status: string;
  label: string;
}

const isPlayed = (status: string) => status === "reported" || status === "walkover";

/** The running order on a phone: a card per match, with the played ones folded away. */
function PhoneRunningOrder({ rows }: { rows: RunningOrderRow[] }) {
  const [showPlayed, setShowPlayed] = useState(false);
  const played = rows.filter((row) => isPlayed(row.status)).length;
  const allPlayed = played === rows.length;
  const visible = showPlayed || allPlayed ? rows : rows.filter((row) => !isPlayed(row.status));
  return (
    <div className="lg:hidden">
      {played > 0 && !allPlayed ? (
        <div className="px-3 pb-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 w-full"
            aria-pressed={showPlayed}
            onClick={() => setShowPlayed((was) => !was)}
          >
            {showPlayed ? "Hide played matches" : `Show ${played} played match${played === 1 ? "" : "es"}`}
          </Button>
        </div>
      ) : null}
      <ul className="divide-y divide-hairline border-t border-hairline">
        {visible.map((row) => (
          <li key={row.id} className="flex gap-3 px-3 py-2.5">
            <div className="w-20 shrink-0">
              <p className="font-score text-sm font-semibold tabular-nums">{timeLabel(row.start)}</p>
              <p className="whitespace-nowrap font-score text-t4 text-muted-foreground" title={row.courtNumber ? undefined : "Court not assigned"}>{row.courtNumber ? `Court ${row.courtNumber}` : "Unassigned"}</p>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-snug">{row.label}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-t4 text-muted-foreground">
                <span className="font-medium">{row.categoryCode}</span>
                <span>{row.stage}</span>
                <StatusPill status={row.status} />
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PlacementScheduler() {
  const qc = useQueryClient();
  // Looks again at any ready match without a time, so there is nothing to press for it.
  useAutoScheduleReconciler();
  const { tournament, days, loading } = useTournamentScope();
  // Scheduling and the stage reset are both `can_edit_tournament` in the database, so
  // the page has one flag rather than the two it used to gate on.
  const access = useScopedAccess();
  const canEdit = access.can_edit;
  // The layout owns the id; the setup link below stays inside this tournament.
  const tournamentId = tournament?.id ?? null;
  const { data: courts, isPending: courtsPending } = useCourts();
  const { data: teams, isPending: teamsPending } = useTeams();
  const { data: players } = usePlayers();
  const { data: categories, isPending: categoriesPending } = useCategories();
  const { data: entrants, isPending: entrantsPending } = usePlacementEntrants();
  const { data: placementMatches, isPending: placementMatchesPending } = usePlacementMatches();
  const { data: draws, isPending: drawsPending } = useTierDraws();
  const { data: tierMatches, isPending: tierMatchesPending } = useTierDrawMatches();
  const { data: dayCourts, isPending: dayCourtsPending } = useTournamentDayCourts(tournamentId);
  const { data: dayBreaks, isPending: dayBreaksPending } = useTournamentDayBreaks(tournamentId);
  /**
   * The desk reports results and moves matches while this page is open, and every
   * one of those shifts the times below. Without a subscription the running order
   * silently went stale until the next full reload — which is exactly what a rebuild
   * is supposed to be checking against.
   */
  const realtime = useRealtimeRefresh();

  const [drafts, setDrafts] = useState<Record<string, DayWindow>>({});
  // One result for the whole tournament, because there is now one build. Days are
  // reported inside it rather than each having a summary of its own.
  const [result, setResult] = useState<{
    summary: ScheduleSummary;
    days: PlacementDayFill[];
    generated: StageGenerationOutcome["generated"];
    skipped: StageGenerationOutcome["skipped"];
  } | null>(null);
  const [preview, setPreview] = useState<{
    plan: PlacementSchedulePlan;
    outcome: StageGenerationOutcome | null;
  } | null>(null);
  const [showAllChanges, setShowAllChanges] = useState(false);
  /** Day windows, courts, breaks, timings and scoring are setup, not day-to-day desk work. */
  const [showSettings, setShowSettings] = useState(false);
  /** The one playing day whose own hours, courts and breaks are open for editing. */
  const [openDayId, setOpenDayId] = useState<string | null>(null);
  /** The "every day" hours form, folded away until asked for. */
  const [sharedOpen, setSharedOpen] = useState(false);
  const [sharedDraft, setSharedDraft] = useState<{ start: string; end: string } | null>(null);
  /**
   * The reset action collapsed on first paint.
   *
   * It used to sit inside the settings list directly under the day cards, one stray
   * click from the fields above it. It is the only irreversible action on the page, so
   * it gets its own panel at the bottom and stays folded until it is asked for.
   */
  const [showDanger, setShowDanger] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Tournament-wide timing overrides, held as text so a half-typed number is not clobbered. */
  const [timingDrafts, setTimingDrafts] = useState<Record<string, string>>({});
  /** Per-day break edits, held locally until saved so a bad row cannot wipe the day. */
  const [breakDrafts, setBreakDrafts] = useState<Record<string, DayBreakRow[]>>({});
  /** Day windows whose edits are still in flight, so their card can say "saving". */
  const [savingDayId, setSavingDayId] = useState<string | null>(null);
  const tournamentDays = useMemo(() => days ?? [], [days]);
  const dayCount = tournament?.day_count ?? tournamentDays.length;
  /** The venue's court pool, read once so the settings sections cannot disagree. */
  const courtCount = (courts ?? []).length;

  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const playerMap = useMemo(() => indexBy(players), [players]);
  const courtMap = useMemo(() => indexBy(courts), [courts]);
  /**
   * The published schedule's conflicts, as the organiser's overlay on the running order.
   *
   * This is the same read the desk makes, but the desk sees a chip on one match while the
   * whole set belongs here, beside the single control that can resolve it. Nothing is
   * stored: a conflict is recomputed from the rows on every render and refetch, so a
   * rebuild - or a desk result that clears one - takes it back out of the block with no
   * flag to reset. The query is editor-gated in `useScheduleConflicts`, so a viewer makes
   * no request and this renders an empty overlay rather than an error.
   */
  const scheduleConflicts = useScheduleConflicts();
  const conflicts = scheduleConflicts.data ?? [];
  const conflictMatchCount = conflictedMatchCount(conflicts);
  const conflictGroups = groupConflictsByKind(conflicts);
  const categoryMap = useMemo(() => indexBy(categories), [categories]);
  const entrantTeam = useMemo(
    () => new Map((entrants ?? []).map((entrant) => [entrant.id, entrant.team_id])),
    [entrants],
  );

  /**
   * An entrant is a team, and a team is one or two players. Resolving through the
   * entrant matters: a knockout match before its parents are played has no entrant
   * at all, and showing "TBC" for that is correct rather than an error.
   *
   * Memoised because the running-order table is built from it, and a fresh function
   * each render would rebuild that table on every keystroke in a day window.
   */
  const labelEntrant = useCallback(
    (entrantId: string | null | undefined): string => {
      const teamId = entrantId ? entrantTeam.get(entrantId) : undefined;
      return teamId ? teamLabel(teamMap.get(teamId), playerMap) : "TBC";
    },
    [entrantTeam, teamMap, playerMap],
  );

  const windowFor = (day: TournamentDay): DayWindow =>
    drafts[day.id] ?? {
      date: day.date,
      start: day.start_time.slice(0, 5),
      end: day.end_time.slice(0, 5),
    };

  const setWindow = (day: TournamentDay, patch: Partial<DayWindow>) =>
    setDrafts((prev) => ({ ...prev, [day.id]: { ...windowFor(day), ...patch } }));

  const placementScheduled = (placementMatches ?? []).some(
    (match) => match.status !== "void" && match.scheduled_time,
  );
  const knockoutScheduled = (tierMatches ?? []).some(
    (match) => !match.is_bye && match.status !== "void" && match.scheduled_time,
  );
  /** Any match already has a time, so the next build is a rebuild rather than a first build. */
  const hasSchedule = placementScheduled || knockoutScheduled;
  /** Ready to play but holding no court or time: what a result unlocked and nothing has placed yet. */
  const readyUnplaced = readyUnplacedCount(placementMatches ?? [], tierMatches ?? []);

  /**
   * Whether every list a plan is computed from has actually arrived.
   *
   * The planner reads "no players could be resolved" as "this match is still waiting
   * for its teams". That is the right reading for a knockout whose bracket has not
   * been drawn yet, and the wrong one for a list that has simply not loaded: every
   * match becomes `awaitingTeams`, nothing is `blocked`, the payload comes out empty,
   * and the writer wipes the day and then rejects it as half-built. So a build waits
   * for the lists rather than inferring from their absence.
   */
  const planInputsPending = useMemo(() => {
    const pending: string[] = [];
    if (loading || !tournament) pending.push("the tournament");
    if (courtsPending) pending.push("courts");
    if (categoriesPending) pending.push("events");
    if (entrantsPending) pending.push("entrants");
    if (teamsPending) pending.push("teams");
    if (placementMatchesPending) pending.push("matches");
    if (drawsPending || tierMatchesPending) pending.push("knockout");
    // Not needed to avoid a failed write, but a day's court list and its breaks are
    // read by the planner, and an empty one is not "no restriction" by accident: it
    // would place matches on courts the day was never configured to use.
    if (dayCourtsPending) pending.push("court assignments");
    if (dayBreaksPending) pending.push("breaks");
    return pending;
  }, [
    loading,
    tournament,
    courtsPending,
    categoriesPending,
    entrantsPending,
    teamsPending,
    placementMatchesPending,
    drawsPending,
    tierMatchesPending,
    dayCourtsPending,
    dayBreaksPending,
  ]);

  const planInputsReady = planInputsPending.length === 0;

  /**
   * Opens the Settings panel on a tournament that has never been built.
   *
   * The venue's courts, the day hours and the match settings all live in there, and
   * on a first pass they are the whole job — a collapsed panel would hide the only
   * controls that matter. It only fires once, so a host who closes it is not fought
   * by an effect that keeps reopening it.
   */
  const settingsOpenedForFirstBuild = useRef(false);
  useEffect(() => {
    // Settings is the editor's panel. A read-only reader is never shown it, so the
    // auto-open below must not fire for them either — the ref would otherwise mark
    // the first build as "opened" and the panel would render anyway.
    if (!canEdit) return;
    if (settingsOpenedForFirstBuild.current) return;
    if (!planInputsReady) return;
    settingsOpenedForFirstBuild.current = true;
    if (!hasSchedule) setShowSettings(true);
  }, [canEdit, planInputsReady, hasSchedule]);

  /** Which courts each day plays on, as ids. Empty means "no restriction". */
  const dayCourtIds = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const row of dayCourts ?? []) {
      const set = map.get(row.day_id) ?? new Set<string>();
      set.add(row.court_id);
      map.set(row.day_id, set);
    }
    return map;
  }, [dayCourts]);

  const breaksForDay = useCallback(
    (dayId: string) => (dayBreaks ?? []).filter((brk) => brk.day_id === dayId),
    [dayBreaks],
  );

  /**
   * The courts a day actually builds on.
   *
   * This is what makes the per-day court sets bite: without it the page hands the
   * scheduler every court on the tournament, and a day configured for four courts
   * would happily be given eight.
   */
  const courtsFor = useCallback(
    (day: TournamentDay) => courtsForDay(courts ?? [], dayCourtIds.get(day.id) ?? new Set()),
    [courts, dayCourtIds],
  );

  /**
   * The tournament-wide timings, described once so the panel, the validation and
   * the save call cannot drift apart.
   */
  const timingFields = useMemo(() => {
    if (!tournament) return [];
    return [
      {
        key: "placement-slot",
        field: "groupSlotMinutes" as const,
        label: "Placement match length",
        hint: "How long one placement match holds a court.",
        min: 1,
        value: tournament.group_slot_minutes,
      },
      {
        key: "placement-rest",
        field: "groupRestGapMinutes" as const,
        label: "Placement rest gap",
        hint: "Least rest a player gets between two placement matches.",
        min: 0,
        value: tournament.group_rest_gap_minutes,
      },
      {
        key: "knockout-slot",
        field: "knockoutSlotMinutes" as const,
        label: "Knockout match length",
        hint: "How long one A/B/C/D knockout match holds a court.",
        min: 1,
        value: tournament.knockout_slot_minutes,
      },
      {
        key: "knockout-rest",
        field: "knockoutRestGapMinutes" as const,
        label: "Knockout rest gap",
        hint: "Least rest a player gets between two knockout matches.",
        min: 0,
        value: tournament.knockout_rest_gap_minutes,
      },
    ];
  }, [tournament]);

  /** Text shown in a timing box: the in-progress edit if there is one, else the saved value. */
  const timingText = (key: string, value: number) => timingDrafts[key] ?? String(value);

  /** Looks a timing field up by its draft key, so a match-format card can commit it. */
  const timingByKey = useMemo(
    () => new Map(timingFields.map((timing) => [timing.key, timing])),
    [timingFields],
  );

  const commitTiming = (key: string, raw: string) => {
    const timing = timingByKey.get(key);
    if (!timing) return;
    void saveTiming(timing.field, timing.key, timing.value, timing.min, raw);
  };

  /** Persists one timing override, keeping the box as typed until it is valid. */
  const saveTiming = async (
    field: (typeof timingFields)[number]["field"],
    key: string,
    fallback: number,
    min: number,
    raw: string,
  ) => {
    if (!tournamentId) return;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min) {
      toast.error(`Enter a whole number of minutes (${min} or more).`);
      setTimingDrafts((prev) => ({ ...prev, [key]: String(fallback) }));
      return;
    }
    if (parsed === fallback) {
      setTimingDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    try {
      await updateTournamentTimings(tournamentId, { [field]: parsed });
      setTimingDrafts((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      await qc.invalidateQueries();
      offerRebuild("Timing updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the timing");
    }
  };

  /**
   * Grows or shrinks the venue's court pool — the master list every day draws from.
   *
   * A day on "every court" is stored as no rows at all, so it picks a new court up for
   * free. A day narrowed to an explicit subset is not: left alone it would keep playing
   * on the old courts, and the new court would exist only for the days nobody had
   * touched. That is what made adding a court look like it worked on some days and not
   * others, so a grow adds the new courts to every narrowed day as well.
   *
   * `set_tournament_courts` refuses to shrink below a court that still holds a match
   * and says how many are affected, so a removal can never unassign a live match.
   */
  const setCourtCount = async (next: number) => {
    if (!tournamentId || busy) return;
    if (next < 1 || next > 64) {
      toast.error("A venue needs between 1 and 64 courts.");
      return;
    }
    const current = courts ?? [];
    // A day with no `tournament_day_courts` rows means "every court", so removing a
    // day's last remaining court would silently widen that day to the whole venue
    // rather than leave it with none. Refuse instead, and name the day.
    if (next < current.length) {
      const removing = new Set(
        current.filter((court) => court.number > next).map((court) => court.id),
      );
      const orphaned = tournamentDays.find((day) => {
        const set = dayCourtIds.get(day.id);
        if (!set || !set.size) return false;
        return [...set].every((id) => removing.has(id));
      });
      if (orphaned) {
        toast.error(
          `Day ${orphaned.day_number} only plays on the courts you are removing — give it another court first.`,
        );
        return;
      }
    }
    setBusy(true);
    try {
      await setTournamentCourts(tournamentId, next);
      if (next > current.length) {
        // The new rows are the ones numbered above the old pool, and their ids only
        // exist once the write has committed, so the list is re-read rather than
        // derived from the courts this render was handed.
        const fresh = await fetchCourts(tournamentId);
        const added = fresh
          .filter((court) => court.number > current.length)
          .map((court) => court.id);
        const writes = courtsAddedToDays(
          tournamentDays.map((day) => day.id),
          dayCourtIds,
          added,
          fresh.length,
        );
        for (const write of writes) {
          await setTournamentDayCourts(tournamentId, write.dayId, write.courtIds);
        }
      }
      await qc.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the courts");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Persists a stage's scoring rule, and the slot duration a preset suggests.
   *
   * Both live on the same row but in different columns, so a preset is two updates
   * in one action: choosing "Best of 3 to 21" should also give the match the 45
   * minutes that shape needs, which is what the wizard used to do.
   */
  const saveScoringRule = async (
    stage: "placement" | "knockout",
    rule: ScoringRule,
    slotMinutes?: number,
  ) => {
    if (!tournamentId) return;
    setBusy(true);
    try {
      await updateTournamentMatchSettings(
        tournamentId,
        stage === "placement"
          ? {
              placementGamesTo: rule.gamesTo,
              placementWinBy: rule.winBy,
              placementBestOf: rule.bestOf,
            }
          : {
              knockoutGamesTo: rule.gamesTo,
              knockoutWinBy: rule.winBy,
              knockoutBestOf: rule.bestOf,
            },
      );
      if (slotMinutes !== undefined) {
        await updateTournamentTimings(
          tournamentId,
          stage === "placement"
            ? { groupSlotMinutes: slotMinutes }
            : { knockoutSlotMinutes: slotMinutes },
        );
        // A preset sets the length itself, so any half-typed override box for that
        // stage is dropped rather than left showing the value it replaced.
        const timingKey = stage === "placement" ? "placement-slot" : "knockout-slot";
        setTimingDrafts((prev) => {
          const next = { ...prev };
          delete next[timingKey];
          return next;
        });
      }
      await qc.invalidateQueries();
      offerRebuild("Match settings updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the match settings");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Turns one court on or off for a day.
   *
   * Selecting every court is stored as no rows at all, because that is the same
   * thing to the scheduler and it keeps tracking the pool if a court is added.
   */
  const toggleDayCourt = async (day: TournamentDay, courtId: string) => {
    if (!tournamentId || busy) return;
    const pool = courts ?? [];
    const base = new Set(dayCourtIds.get(day.id) ?? pool.map((court) => court.id));
    if (base.has(courtId)) base.delete(courtId);
    else base.add(courtId);

    if (!base.size) {
      toast.error(`Day ${day.day_number} needs at least one court.`);
      return;
    }
    const ids = [...base];
    try {
      await setTournamentDayCourts(tournamentId, day.id, ids.length === pool.length ? [] : ids);
      await qc.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the courts");
    }
  };

  const updateBreakRows = (dayId: string, rows: DayBreakRow[]) =>
    setBreakDrafts((prev) => ({ ...prev, [dayId]: rows }));

  const breakRows = (day: TournamentDay): DayBreakRow[] =>
    breakDrafts[day.id] ??
    breaksForDay(day.id).map((brk) => ({
      label: brk.label ?? "",
      start: brk.start_time.slice(0, 5),
      end: brk.end_time.slice(0, 5),
    }));

  const breaksDirty = (day: TournamentDay) => breakDrafts[day.id] !== undefined;

  const saveBreaks = async (day: TournamentDay) => {
    if (!tournamentId || busy) return;
    const rows = breakRows(day);
    setBusy(true);
    try {
      await setTournamentDayBreaks(
        tournamentId,
        day.id,
        rows.map((row) => ({ label: row.label, startTime: row.start, endTime: row.end })),
      );
      setBreakDrafts((prev) => {
        const next = { ...prev };
        delete next[day.id];
        return next;
      });
      await qc.invalidateQueries();
      offerRebuild(`Day ${day.day_number} breaks saved.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the breaks");
    } finally {
      setBusy(false);
    }
  };

  /**
   * The days as the planner wants them: each day's window as edited in the drafts,
   * plus which courts it plays on. Kept as one memo so a build and a rebuild cannot
   * disagree about what the desk has typed.
   */
  const plannerDays = useMemo(
    () =>
      tournamentDays.map((day) => {
        const window = windowFor(day);
        return {
          ...day,
          date: window.date,
          start_time: normalizeTime(window.start),
          end_time: normalizeTime(window.end),
        };
      }),
    // windowFor reads only the drafts and the day itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tournamentDays, drafts],
  );

  const dayCourtIdSets = useMemo(() => {
    const map = new Map<string, ReadonlySet<string>>();
    for (const [dayId, ids] of dayCourtIds) map.set(dayId, ids);
    return map;
  }, [dayCourtIds]);

  const breaksByDay = useMemo(() => {
    const map = new Map<string, ReturnType<typeof breaksForDay>>();
    for (const day of tournamentDays) map.set(day.id, breaksForDay(day.id));
    return map;
  }, [tournamentDays, breaksForDay]);

  /**
   * Why ready matches are still without a time, worked out here from the rows already on screen.
   *
   * Computed rather than remembered: it does not depend on which desk ran the automatic pass, so
   * every organiser looking at this page sees the same, and a change to the days or courts
   * re-evaluates it by itself. A dry run of the same planner the automatic pass uses, never
   * written, and only when something is actually missing a time.
   */
  const [unplacedReasons, setUnplacedReasons] = useState<UnplacedMatch[]>([]);
  useEffect(() => {
    if (!canEdit || !tournament || !planInputsReady || readyUnplaced === 0) {
      setUnplacedReasons([]);
      return;
    }
    // A dry run: nothing is generated or written, so the rows already on screen are the right input
    // (a build re-reads them from the network; this only describes what the page shows).
    const dryRunEntrants = entrants ?? [];
    const timer = setTimeout(() => {
      try {
        const plan = planPlacementSchedule({
          mode: "place-ready",
          tournament,
          days: plannerDays,
          allCourts: courts ?? [],
          dayCourtIds: dayCourtIdSets,
          breaksByDayId: breaksByDay,
          teams: teams ?? [],
          entrants: dryRunEntrants,
          draws: draws ?? [],
          placementMatches: placementMatches ?? [],
          tierMatches: tierMatches ?? [],
          categoryOrder: new Map((categories ?? []).map((c) => [c.id, c.sort_order])),
          options: { graspRuns: 1, seed: 1 },
        });
        setUnplacedReasons(plan.unplaced);
      } catch {
        setUnplacedReasons([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [
    canEdit,
    tournament,
    planInputsReady,
    readyUnplaced,
    plannerDays,
    courts,
    dayCourtIdSets,
    breaksByDay,
    teams,
    entrants,
    draws,
    placementMatches,
    tierMatches,
    categories,
  ]);
  const notice = useMemo(() => describeUnplaced(unplacedReasons), [unplacedReasons]);

  /**
   * Whether a full rebuild is worth the organiser's while, worked out from the rows on screen.
   *
   * A dry run of the rebuild that "Rebuild schedule" would show, compared with the schedule as it
   * stands, judged the same way on both sides (the latest end among matches still to play). Only said
   * when it finishes meaningfully sooner and can place every match; the cost, in matches moved and how
   * many start within the hour, is part of the sentence. Nothing is applied. It is the case gap-filling
   * is worst at: a tight day or a large field.
   */
  const [suggestion, setSuggestion] = useState<RebuildSuggestion | null>(null);
  useEffect(() => {
    if (!canEdit || !tournament || !planInputsReady || !hasSchedule || busy || preview) {
      setSuggestion(null);
      return;
    }
    // A dry run, like the one above: nothing is generated or written, so the rows on screen are the input.
    const dryRunEntrants = entrants ?? [];
    const timer = setTimeout(() => {
      try {
        const now = Date.now();
        const plan = planPlacementSchedule({
          tournament,
          days: plannerDays,
          allCourts: courts ?? [],
          dayCourtIds: dayCourtIdSets,
          breaksByDayId: breaksByDay,
          teams: teams ?? [],
          entrants: dryRunEntrants,
          draws: draws ?? [],
          placementMatches: placementMatches ?? [],
          tierMatches: tierMatches ?? [],
          categoryOrder: new Map((categories ?? []).map((c) => [c.id, c.sort_order])),
          now,
        });
        const finishOf = (placement: readonly PlacementMatch[], tier: readonly TierDrawMatch[]) => {
          const a = projectedFinishFromRemainingMatches(placement, tournament.group_slot_minutes, now);
          const b = projectedFinishFromRemainingMatches(
            tier.filter((match) => !match.is_bye),
            tournament.knockout_slot_minutes,
            now,
          );
          return Math.max(a ?? 0, b ?? 0) || null;
        };
        const afterPlacement = projectSlotsOntoMatches(placementMatches ?? [], plan.placementSlotPayload);
        const afterTier = projectSlotsOntoMatches(tierMatches ?? [], plan.knockoutSlotPayload);
        setSuggestion(
          buildRebuildSuggestion({
            currentFinishMs: finishOf(placementMatches ?? [], tierMatches ?? []),
            plannedFinishMs: finishOf(afterPlacement, afterTier),
            blockedCount: plan.blocked.length,
            diff: plan.diff,
            now,
          }),
        );
      } catch {
        setSuggestion(null);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [
    canEdit,
    tournament,
    planInputsReady,
    hasSchedule,
    busy,
    preview,
    plannerDays,
    courts,
    dayCourtIdSets,
    breaksByDay,
    teams,
    entrants,
    draws,
    placementMatches,
    tierMatches,
    categories,
  ]);

  /**
   * The official close: the end of the last configured day that actually has courts.
   *
   * A day with no courts offers no capacity, so its window cannot be what the tournament is
   * measured against — that is why this walks back from the end rather than reading the final
   * day blindly. The forecast's "within window" and "overrun" statuses both refer to this.
   */
  const officialCloseMs = useMemo(() => {
    for (let index = plannerDays.length - 1; index >= 0; index -= 1) {
      const day = plannerDays[index];
      if (!day || courtsFor(day).length === 0) continue;
      return dayWindowBounds(day).end;
    }
    return null;
  }, [plannerDays, courtsFor]);

  /**
   * "Will it fit?": the active field sizes against the court time the configured days offer.
   *
   * Shown while the tournament is still being run — before it starts and all the way through — and
   * dropped only once it is completed. It is a planning line: an organiser mid-event still wants to
   * know whether the remaining field fits the hours on offer, and the schedule's own finish line
   * answers a different question (when the day ends, not whether the work fits in it). Once the
   * tournament is completed there is nothing left to plan, so the line has nothing to say.
   *
   * Withdrawn teams take no court time, and a day with no courts offers none.
   */
  const capacity = useMemo(() => {
    if (tournament?.status === "completed") return null;
    const fields = (categories ?? [])
      .filter((category) => category.active)
      .map((category) => (teams ?? []).filter((t) => t.category_id === category.id && !t.withdrawn).length)
      .filter((n) => n > 0);
    if (fields.length === 0 || plannerDays.length === 0) return null;
    const minutes = (time: string) => {
      const [h = "0", m = "0"] = time.split(":");
      return Number(h) * 60 + Number(m);
    };
    return {
      fields,
      offered: courtHoursOffered(
        plannerDays.map((day) => {
          const { start, end } = dayWindowBounds(day);
          return {
            courts: courtsFor(day).length,
            windowMinutes: Math.max((end - start) / 60000, 0),
            breakMinutes: (breaksByDay.get(day.id) ?? []).reduce(
              (sum, brk) => sum + Math.max(minutes(brk.end_time) - minutes(brk.start_time), 0),
              0,
            ),
          };
        }),
      ),
    };
  }, [tournament?.status, categories, teams, plannerDays, courtsFor, breaksByDay]);

  /**
   * When the already-scheduled matches end.
   *
   * The latest end among matches that have a court and a time, read straight off the rows. This
   * is a fact about the schedule as it stands, not an estimate of when the tournament will
   * finish: matches with no row yet, and matches with no time, contribute nothing. Placement and
   * knockout hold a court for different durations, so each stage is measured with its own slot
   * and the later of the two wins.
   */
  const scheduledFinishMs = useMemo(() => {
    if (!tournament) return null;
    const placementFinish = projectedFinishFromRemainingMatches(
      placementMatches ?? [],
      tournament.group_slot_minutes,
    );
    const knockoutFinish = projectedFinishFromRemainingMatches(
      (tierMatches ?? []).filter((match) => !match.is_bye),
      tournament.knockout_slot_minutes,
    );
    return Math.max(placementFinish ?? 0, knockoutFinish ?? 0) || null;
  }, [tournament, placementMatches, tierMatches]);

  /**
   * Per-day changes for the rebuild preview.
   *
   * Built from the plan's own diff rather than from a second comparison, so the preview cannot
   * disagree with the table below it. Capacity and utilization are deliberately absent: the
   * preview answers "what moves, and does the result fit the window?", not "how full is each
   * day?".
   */
  const previewDayChanges = useMemo(() => {
    const plan = preview?.plan;
    if (!plan) return [];
    const idByNumber = new Map(plannerDays.map((day) => [day.day_number, day.id]));
    return plan.days.map((fill) => {
      // `fill.day` is the day number, so the plan's own numbering identifies the day without
      // re-deriving it from a timestamp.
      const dayId = idByNumber.get(fill.day) ?? String(fill.day);
      const moved = plan.diff.changes.filter(
        (change) =>
          change.kind !== "unchanged" &&
          dayIdForTime(plannerDays, Date.parse(change.toStart)) === dayId,
      );
      return {
        dayId,
        date: fill.date,
        placed: fill.placed,
        lastFinish: fill.lastFinish,
        overrunMinutes: fill.overrunMinutes,
        moving: moved.length,
        largestShift: moved.reduce(
          (max, change) => Math.max(max, Math.abs(change.shiftMinutes)),
          0,
        ),
      };
    });
  }, [preview, plannerDays]);

  /**
   * Tournament progress by event, stage and round.
   *
   * Read-only oversight: what already exists in each stage, how much of it is done, and whether
   * the next stage can be generated. Progress is reported against the rows that exist, so there
   * is no invented total for work nobody has generated yet.
   */
  const stageProgress = useMemo(
    () =>
      buildStageProgress({
        categories,
        categoryOrder: new Map(
          (categories ?? []).map((category) => [category.id, category.sort_order]),
        ),
        entrants,
        placementMatches,
        tierDraws: draws,
        tierMatches,
      }),
    [categories, entrants, placementMatches, draws, tierMatches],
  );

  const rows = useMemo(() => {
    const placementRows = (placementMatches ?? [])
      .filter((match) => match.scheduled_time && match.status !== "void")
      .map((match) => ({
        id: match.id,
        stage: match.stage === "round1" ? "Placement R1" : "Placement R2",
        categoryCode: categoryMap.get(match.category_id)?.code ?? "",
        courtNumber: match.court_id ? (courtMap.get(match.court_id)?.number ?? 0) : 0,
        start: new Date(match.scheduled_time as string),
        status: match.status,
        label: `${labelEntrant(match.entrant_a_id)} vs ${labelEntrant(match.entrant_b_id)}`,
      }));

    // A bye has no court and no time, so it filters out here by construction.
    const knockoutRows = (tierMatches ?? [])
      .filter((match) => match.scheduled_time && !match.is_bye && match.status !== "void")
      .map((match) => {
        const draw = (draws ?? []).find((entry) => entry.id === match.draw_id);
        return {
          id: match.id,
          // The round is named from the bracket size, the one input every view of a draw
          // shares. Falls back to the raw round number if the draw has not loaded, since
          // the size is what the name is derived from.
          stage: `Draw ${draw?.tier ?? "?"}, ${
            draw ? roundName(draw.bracket_size, match.round) : `R${match.round}`
          }`,
          categoryCode: draw ? (categoryMap.get(draw.category_id)?.code ?? "") : "",
          courtNumber: match.court_id ? (courtMap.get(match.court_id)?.number ?? 0) : 0,
          start: new Date(match.scheduled_time as string),
          status: match.status,
          label: `${labelEntrant(match.entrant_a_id)} vs ${labelEntrant(match.entrant_b_id)}`,
        };
      });

    return [...placementRows, ...knockoutRows].sort(
      (a, b) => a.start.getTime() - b.start.getTime(),
    );
  }, [placementMatches, tierMatches, draws, categoryMap, courtMap, labelEntrant]);

  const daySlices = useMemo(
    () => sliceRowsByDay(rows, tournamentDays, (row) => row.start),
    [rows, tournamentDays],
  );

  /**
   * The days that already have something scheduled on them.
   *
   * Used to disable "Remove day" before the click rather than after it. It is the
   * same attribution the running order is built from, so what the host sees on the
   * day is what decides. The database re-checks this in the venue's timezone and
   * remains the authority; this only keeps the button honest.
   */
  const daysWithMatches = useMemo(
    () => new Set(daySlices.filter((slice) => slice.rows.length > 0).map((slice) => slice.day.id)),
    [daySlices],
  );

  /**
   * The playing days as dates, and the ones that cannot be switched off.
   *
   * The picker offers only the tournament window's own dates, so a day outside it cannot be
   * chosen by typing; the database refuses one for every writer too. A day with matches on it
   * stays on, and the reason travels with the date.
   */
  const chosenDates = useMemo(
    () => new Set(tournamentDays.map((day) => day.date.slice(0, 10))),
    [tournamentDays],
  );
  /**
   * What stands between the host and the Build button, in a sentence.
   *
   * The button is off until there is a court to place a match on and a day to place it on, and
   * a button that is merely grey tells nobody which. Courts come first because a new tournament
   * has none: creating one writes no court rows.
   */
  const buildBlocker =
    !(courts ?? []).length && !tournamentDays.length
      ? "Set the courts and choose at least one playing day first."
      : !(courts ?? []).length
        ? "Set how many courts the venue has first."
        : !tournamentDays.length
          ? "Choose at least one playing day first."
          : null;

  /** The hours most playing days share, which is what the "every day" line says. */
  const commonHours = useMemo(() => {
    const counts = new Map<string, number>();
    for (const day of tournamentDays) {
      const key = `${day.start_time.slice(0, 5)}|${day.end_time.slice(0, 5)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const [key, count] of counts) {
      if (best === null || count > (counts.get(best) ?? 0)) best = key;
    }
    if (!best) return null;
    const [start = "", end = ""] = best.split("|");
    return { start, end };
  }, [tournamentDays]);

  const lockedDates = useMemo(() => {
    const locked = new Map<string, string>();
    for (const day of tournamentDays) {
      if (daysWithMatches.has(day.id)) {
        locked.set(day.date.slice(0, 10), "This day has matches on it. Clear or move them first.");
      }
    }
    return locked;
  }, [tournamentDays, daysWithMatches]);

  /**
   * Which day's running order is on screen.
   *
   * Held as `null` until a tab is clicked so the opening view can be derived rather
   * than stored: the derived value is recomputed for free if the days load late or
   * the windows change, and a click still wins from then on. Deliberately not reset
   * by a realtime refresh — a board that jumps to another day while someone is
   * reading it is worse than one showing a day that has just emptied.
   */
  const [pickedDayId, setPickedDayId] = useState<string | null>(null);

  /**
   * The day to open on: whichever window contains now, else the first day with
   * something on it, else the first day.
   *
   * A live event is why "now" comes first — on the second morning the desk wants
   * day two, not the day that finished yesterday. The later fallbacks are what a
   * not-yet-built schedule gets.
   */
  const activeDayId = useMemo(() => {
    if (pickedDayId && daySlices.some((slice) => slice.day.id === pickedDayId)) {
      return pickedDayId;
    }
    const now = Date.now();
    const containing = daySlices.find((slice) => {
      const { start, end } = dayWindowBounds(slice.day);
      return now >= start && now <= end;
    });
    if (containing) return containing.day.id;
    const firstWithRows = daySlices.find((slice) => slice.rows.length > 0);
    return (firstWithRows ?? daySlices[0])?.day.id ?? "";
  }, [daySlices, pickedDayId]);

  const matchLabel = (matchId: string) =>
    placementMatchLabel(matchId, placementMatches ?? [], tierMatches ?? [], labelEntrant);

  /** The venue court's number, for the conflict block's lines; a row may name no court. */
  const courtNumberLabel = (courtId: string | null): string | null => {
    if (!courtId) return null;
    const court = courtMap.get(courtId);
    return court ? `Court ${court.number}` : null;
  };

  const validateWindow = (dayNumber: number, window: DayWindow) => {
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(window.date);
    const validTimes = /^\d{2}:\d{2}$/.test(window.start) && /^\d{2}:\d{2}$/.test(window.end);
    if (!validDate || !validTimes) {
      toast.error(`Choose a valid date, start time, and end time for day ${dayNumber}.`);
      return false;
    }
    if (
      new Date(`${window.date}T${window.end}`).getTime() <=
      new Date(`${window.date}T${window.start}`).getTime()
    ) {
      toast.error(`Day ${dayNumber} end time must be later than its start time.`);
      return false;
    }
    return true;
  };

  /**
   * Every day that will be filled has to be valid before a build starts.
   *
   * One button means one window check covering the whole queue: a bad end time on
   * day three would otherwise surface as a match placed at a nonsense hour rather
   * than as the typo it is.
   */
  const validateAllWindows = () =>
    tournamentDays.every((day) => validateWindow(day.day_number, windowFor(day)));

  /**
   * Persists one day's date and window as soon as a field is left.
   *
   * This used to be written only during a build, which meant an edit made and then
   * navigated away from was silently lost — the box showed the new time, the row held
   * the old one, and nothing said so. Validate before writing, because
   * `updateTournamentDay` writes straight to the row and `tournament_readiness` no
   * longer covers day windows: it runs at activation, long before this is editable.
   *
   * A date that would put this day out of order with its neighbours is rejected by a
   * trigger (`tournament_days_guard_order`), so the message below surfaces from the
   * database and the edit reverts.
   */
  const commitDayWindow = async (day: TournamentDay) => {
    if (!tournamentId || busy) return;
    const window = windowFor(day);
    const normalized = {
      date: window.date,
      start_time: normalizeTime(window.start),
      end_time: normalizeTime(window.end),
    };
    if (
      normalized.date === day.date &&
      normalized.start_time === day.start_time &&
      normalized.end_time === day.end_time
    ) {
      return;
    }
    const revert = () =>
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[day.id];
        return next;
      });
    if (!validateWindow(day.day_number, window)) {
      // Put the rejected edit back to what the row actually holds.
      revert();
      return;
    }
    setSavingDayId(day.id);
    try {
      await updateTournamentDay(day.id, normalized);
      // Await the refetch before dropping the draft, or the box would snap back to
      // the old value for the moment the update is in flight.
      await qc.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the day");
    } finally {
      revert();
      setSavingDayId(null);
    }
  };

  /**
   * Adds a day to a tournament that is already under way.
   *
   * The date defaults to the day after the last one, which is the case that actually
   * comes up: a tournament overruns and needs one more day on the end. Picking a date
   * between two existing days is allowed and the database renumbers to keep
   * `day_number` in date order, so the running order stays chronological either way.
   *
   * A new day plays on every court, because having no `tournament_day_courts` rows is
   * what "every court" is stored as upstream.
   */
  const addDay = async (date: string) => {
    if (!tournamentId || busy) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      toast.error("Choose a date for the new day.");
      return;
    }
    setBusy(true);
    try {
      await addTournamentDay(tournamentId, date);
      await qc.invalidateQueries();
      toast.success(
        hasSchedule
          ? `${dayDateLabel(date)} is a playing day. Update the schedule to place matches on it.`
          : `${dayDateLabel(date)} is a playing day.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add the day");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Sets the same opening and closing time on every playing day.
   *
   * Hours are stored per day and stay that way; this is the one edit that most tournaments
   * want, made once. A day that needs different hours is opened and changed on its own.
   */
  const applyHoursToAll = async (start: string, end: string) => {
    if (busy || !tournamentDays.length) return;
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || end <= start) {
      toast.error("Courts have to close after they open.");
      return;
    }
    setBusy(true);
    try {
      for (const day of tournamentDays) {
        if (day.start_time.slice(0, 5) === start && day.end_time.slice(0, 5) === end) continue;
        await updateTournamentDay(day.id, {
          date: day.date,
          start_time: normalizeTime(start),
          end_time: normalizeTime(end),
        });
      }
      await qc.invalidateQueries();
      setSharedOpen(false);
      setSharedDraft(null);
      toast.success("Hours set for every day.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not set the hours");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Removes a playing day.
   *
   * The button is already disabled for the cases below, so reaching one of these is a
   * race rather than a mistake; the database refuses them too, and wording the toast
   * from its message keeps the two in agreement instead of drifting.
   */
  const removeDay = async (day: TournamentDay) => {
    if (!tournamentId || busy) return;
    setBusy(true);
    try {
      await removeTournamentDay(tournamentId, day.id);
      // Drop any draft for the row that no longer exists, or `windowFor` keeps
      // returning an edit for a day that is gone.
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[day.id];
        return next;
      });
      await qc.invalidateQueries();
      toast.success(`Day ${day.day_number} removed.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the day");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Planning always re-reads the match tables and the draws first.
   *
   * A plan is only safe against current rows: the anchors are the reported and
   * in-progress matches, so planning from a cached copy would happily move a match
   * that has just been finished on court. The draws are here because generating
   * them is part of a build, and a freshly created draw is what a newly created
   * knockout row refers to. The refetch is scoped to this tournament, so it is
   * three small queries.
   */
  const freshSchedulingData = async () => {
    if (!tournamentId) throw new Error("No active tournament is configured.");
    // Fetched rather than read from the cache, and awaited as data rather than as a
    // cache write: see `fetchPlacementMatches`. The entrants come along because a
    // build's generation step reads their seeds, and a seed lock that has not landed
    // in the cache yet would make every event look unseeded and quietly build nothing.
    const [placementMatches, tierMatches, draws, entrants] = await Promise.all([
      fetchPlacementMatches(tournamentId),
      fetchTierDrawMatches(tournamentId),
      fetchTierDraws(tournamentId),
      fetchPlacementEntrants(tournamentId),
    ]);
    // Keep the cache in step, so the running order cannot disagree with the plan that
    // was just computed from these rows.
    qc.setQueryData(scopedKey(keys.placementMatches, tournamentId), placementMatches);
    qc.setQueryData(scopedKey(keys.tierDrawMatches, tournamentId), tierMatches);
    qc.setQueryData(scopedKey(keys.tierDraws, tournamentId), draws);
    qc.setQueryData(scopedKey(keys.placementEntrants, tournamentId), entrants);
    return { placementMatches, tierMatches, draws, entrants };
  };

  const computePlan = async (
    fresh: Awaited<ReturnType<typeof freshSchedulingData>>,
    mode: "rebuild" | "place-ready" = "rebuild",
  ) => {
    if (!tournament) throw new Error("No active tournament is configured.");
    return planPlacementSchedule({
      mode,
      tournament,
      days: plannerDays,
      allCourts: courts ?? [],
      dayCourtIds: dayCourtIdSets,
      breaksByDayId: breaksByDay,
      teams: teams ?? [],
      entrants: fresh.entrants,
      draws: fresh.draws,
      placementMatches: fresh.placementMatches,
      tierMatches: fresh.tierMatches,
      categoryOrder: new Map((categories ?? []).map((c) => [c.id, c.sort_order])),
    });
  };

  /**
   * Generates whatever stage the queue is waiting on, then returns fresh rows.
   *
   * Retried data is only refetched when something was actually created, because a
   * build that changed nothing should not pay for three extra queries.
   */
  const generateWhatIsMissing = async (before: Awaited<ReturnType<typeof freshSchedulingData>>) => {
    const outcome = await generateMissingStages({
      categories: categories ?? [],
      entrants: before.entrants,
      matches: before.placementMatches,
      draws: before.draws,
    });
    const fresh = stageGenerationChanged(outcome) ? await freshSchedulingData() : before;
    return { outcome, fresh };
  };

  /**
   * Mirrors a plan that has just been applied into the two match caches.
   *
   * The running order is built from those caches, and a refetch is not a guarantee — a
   * request can be dropped, and `invalidateQueries` resolves whether or not it lands. So
   * the plan the writer just accepted is written in first: the table shows what was
   * scheduled the moment the toast says it was, and the refetch that follows is only a
   * correction from the server rather than the thing the desk is waiting on.
   */
  const projectAppliedPlan = (plan: PlacementSchedulePlan) => {
    if (!tournamentId) return;
    const placementKey = scopedKey(keys.placementMatches, tournamentId);
    const placement = qc.getQueryData<PlacementMatch[]>(placementKey);
    if (placement) {
      qc.setQueryData(placementKey, projectSlotsOntoMatches(placement, plan.placementSlotPayload));
    }
    const tierKey = scopedKey(keys.tierDrawMatches, tournamentId);
    const tier = qc.getQueryData<TierDrawMatch[]>(tierKey);
    if (tier) {
      qc.setQueryData(tierKey, projectSlotsOntoMatches(tier, plan.knockoutSlotPayload));
    }
  };

  const finishApply = async (
    plan: PlacementSchedulePlan,
    outcome: StageGenerationOutcome | null,
  ) => {
    // The schedule page owns the day windows, so persist any edit before applying.
    // Without this the plan would be computed against a window the database has not
    // been told about, and a rebuild would silently undo the edit.
    for (const day of tournamentDays) {
      const window = windowFor(day);
      const normalized = {
        date: window.date,
        start_time: normalizeTime(window.start),
        end_time: normalizeTime(window.end),
      };
      if (
        normalized.date !== day.date ||
        normalized.start_time !== day.start_time ||
        normalized.end_time !== day.end_time
      ) {
        await updateTournamentDay(day.id, normalized);
      }
    }
    await applyPlacementSchedulePlan(plan);
    // Show the rows the writer just set before anything is refetched, so a build that
    // reports success cannot leave the running order on the rows from before it. See
    // `projectSlotsOntoMatches` for why the plan is safe to project.
    projectAppliedPlan(plan);
    // The outcome is a parameter rather than state on purpose: a build generates and
    // applies inside one handler, so reading it back from state here would read the
    // value captured at render time and always report "generated nothing".
    setResult({
      summary: plan.summary,
      days: plan.days,
      generated: outcome?.generated ?? { roundOne: 0, roundTwo: 0, draws: 0 },
      skipped: outcome?.skipped ?? [],
    });
    toast.success(
      `${plan.summary.placed} match${plan.summary.placed === 1 ? "" : "es"} placed across ` +
        `${plan.days.length} day${plan.days.length === 1 ? "" : "s"} — ` +
        `${plan.summary.anchorCount} anchors kept`,
    );
    await qc.invalidateQueries();
  };

  const build = async () => {
    if (!tournamentDays.length) {
      toast.error("Choose the days you play first.");
      return;
    }
    if (!validateAllWindows()) return;
    if (!planInputsReady) {
      toast.error(`Still loading ${planInputsPending.join(", ")} — try again in a moment.`);
      return;
    }
    setBusy(true);
    try {
      const { outcome, fresh } = await generateWhatIsMissing(await freshSchedulingData());
      const plan = await computePlan(fresh);
      // A plan that could not place everything is shown rather than written: the
      // desk needs to see which match is stuck before anything moves.
      if (plan.blocked.length > 0) {
        setPreview({ plan, outcome });
        setShowAllChanges(false);
        return;
      }
      await finishApply(plan, outcome);
      setPreview(null);
      /**
       * The first build ends the setup the panel exists for.
       *
       * The days, the per-day courts, the hours, the breaks and the match settings have all
       * been read and written by the time this returns, and what the host needs next is the
       * running order the build just produced - which the panel, drawn above it, was covering.
       * Closing it is the page's own way of saying the setup is done.
       *
       * Only on success: a plan with blocked matches returned above with the preview open, and
       * a thrown error leaves the panel where the host left it. A rebuild never reaches here,
       * because a tournament that already has a schedule edits through `previewRebuild`.
       */
      setShowSettings(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the schedule");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Saved timings, breaks and match settings only change the next plan. Once a schedule exists,
   * say so and put the way to apply them in the toast, rather than telling the host to go and find it.
   */
  const offerRebuild = (saved: string) => {
    if (!hasSchedule) {
      toast.success(saved);
      return;
    }
    toast.success(`${saved} The current schedule still uses the old values.`, {
      action: { label: "Review & apply", onClick: () => void previewRebuild() },
    });
  };

  const previewRebuild = async () => {
    if (!tournamentDays.length) {
      toast.error("Choose the days you play first.");
      return;
    }
    if (!validateAllWindows()) return;
    if (!planInputsReady) {
      toast.error(`Still loading ${planInputsPending.join(", ")} — try again in a moment.`);
      return;
    }
    setBusy(true);
    try {
      const { outcome, fresh } = await generateWhatIsMissing(await freshSchedulingData());
      const plan = await computePlan(fresh);
      setPreview({ plan, outcome });
      setShowAllChanges(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not plan the rebuild");
    } finally {
      setBusy(false);
    }
  };

  const applyPreview = async () => {
    if (!preview || preview.plan.blocked.length > 0) return;
    setBusy(true);
    try {
      await finishApply(preview.plan, preview.outcome);
      setPreview(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not apply the rebuild");
    } finally {
      setBusy(false);
    }
  };

  const visibleChanges = preview
    ? showAllChanges
      ? preview.plan.diff.changes
      : preview.plan.diff.changes.filter((change) => change.kind !== "unchanged")
    : [];

  /**
   * Discards the placement and knockout schedule, and keeps the seed order.
   *
   * Scheduling is a later decision than seeding: the host locks seeds on the Placement
   * tab and builds days here, so a rebuild must not take the seeding with it. Every
   * match, draw and result goes, plus the derived tier; the seed order, the lock and
   * the waivers stay, so the stage returns to the start of round one and "Build the
   * schedule" regenerates from the same order. Starting the tournament over is the
   * Placement tab's reset, which is the only one that clears the seeds. Nothing here
   * can be undone, hence the explicit confirmation and the admin check.
   */
  const resetStage = async () => {
    if (!tournament) return;
    const confirmed = window.confirm(
      "Delete every placement and knockout match, and every result and scheduled time?\n\n" +
        "This removes both placement rounds, the A/B/C/D draws, every result and every " +
        "scheduled time. The seed order and any waivers are kept, so the stage returns to the " +
        "start of round one and can be rebuilt on the same seeding. The days, courts and match " +
        "settings above are kept too. It cannot be undone.",
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      const reset = await resetPlacementSchedule(tournament.id);
      // The local summaries describe a schedule that no longer exists, so they are
      // cleared rather than refreshed: "not built yet" is the truth now.
      setResult(null);
      setPreview(null);
      await qc.invalidateQueries();
      toast.success(scheduleResetNote(reset));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reset the schedule");
    } finally {
      setBusy(false);
    }
  };

  const buildButton = (
    <Button
      id="build-schedule"
      // A rebuild is for deliberate re-optimising. It only takes the primary place when something
      // needs the organiser's decision: matches that could not be placed, or a schedule that
      // contradicts itself. Before the first build it is the one thing to do, so it stays primary.
      variant={hasSchedule && !notice && conflictMatchCount === 0 ? "outline" : "default"}
      disabled={busy || !planInputsReady || !tournament || Boolean(buildBlocker)}
      aria-describedby={buildBlocker ? "build-blocker" : undefined}
      onClick={() => void (hasSchedule ? previewRebuild() : build())}
    >
      {!planInputsReady
        ? "Loading…"
        : busy
          ? "Planning…"
          : hasSchedule
            ? "Rebuild schedule"
            : "Build schedule"}
    </Button>
  );

  return (
    <Page
      title="Court schedule"
      subtitle={
        canEdit
          ? "One running order for the whole tournament."
          : "When and where every match is played."
      }
      actions={
        canEdit ? (
          <div className="flex flex-col items-end gap-1">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSettings((value) => !value)}
                aria-expanded={showSettings}
              >
                {showSettings ? "Hide settings" : "Tournament settings"}
              </Button>
              {/* With the settings open the build lives in the bar at the foot of the page,
                  beside what it builds from; one button, in one place at a time. */}
              {showSettings ? null : buildButton}
            </div>
            {showSettings || !buildBlocker ? null : (
              <span id="build-blocker" className="text-sm text-muted-foreground">
                {buildBlocker}
              </span>
            )}
          </div>
        ) : null
      }
    >
      <div className="space-y-5">
        {/*
          What the published schedule cannot run, and where to fix it.

          At the top because it is a caveat on everything below it: the running order the
          page is about to show has matches that contradict each other. It renders only for
          an editor - a viewer makes no conflict request at all (see `useScheduleConflicts`)
          - and only when there is something to say, so its presence is itself the signal.
        */}
        {canEdit && conflictMatchCount > 0 ? (
          <ConflictOverview
            count={conflictMatchCount}
            groups={conflictGroups}
            matchLabel={matchLabel}
            courtNumberLabel={courtNumberLabel}
          />
        ) : null}
        {canEdit && hasSchedule && notice ? (
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm"
            role="status"
          >
            <span className="font-semibold text-warn-foreground">{notice.headline}</span>
            <span className="text-muted-foreground">{notice.detail}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void (notice.action === "settings" ? setShowSettings(true) : previewRebuild())}
            >
              {notice.actionLabel}
            </Button>
          </div>
        ) : null}
        {canEdit && hasSchedule && !notice && suggestion ? (
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-hairline bg-surface px-3 py-2.5 text-sm"
            role="status"
          >
            <span className="font-semibold text-foreground">{suggestion.headline}</span>
            <span className="text-muted-foreground">{suggestion.detail}</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void previewRebuild()}>
              Review rebuild
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-hairline bg-surface px-3 py-2.5 text-sm text-muted-foreground">
          <span className="font-score font-semibold text-foreground">
            {rows.length} match{rows.length === 1 ? "" : "es"} scheduled
          </span>
          <span>
            {tournamentDays.length} day{tournamentDays.length === 1 ? "" : "s"},{" "}
            {(courts ?? []).length} court{(courts ?? []).length === 1 ? "" : "s"}
          </span>
          <span className="inline-flex flex-wrap items-center gap-x-1 gap-y-1">
            <ScheduledFinish finishMs={scheduledFinishMs} closeMs={officialCloseMs} />
            {result && result.summary.unscheduled > 0 ? (
              <span className="text-danger-foreground">
                {result.summary.unscheduled} could not be placed
              </span>
            ) : null}
            {canEdit ? (
              <InfoNote label="About the running order">
                <p>Matches already played or on court never move when the schedule is rebuilt.</p>
              </InfoNote>
            ) : null}
          </span>
          {tournament?.status === "completed" ? null : (
            <span className="ml-auto flex items-center">
              <ConnectionBadge status={realtime.status} lastUpdatedAt={realtime.lastUpdatedAt} />
            </span>
          )}
          {canEdit && capacity ? (
            <CapacityEstimate
              inline
              entrantsPerEvent={capacity.fields}
              courtHoursOffered={capacity.offered}
            />
          ) : null}
        </div>

        {result && result.skipped.length > 0 ? (
          <div className="rounded-lg bg-warn-surface px-3 py-2 text-sm text-warn-foreground">
            <p className="font-semibold">Left alone</p>
            <ul className="mt-0.5 space-y-0.5">
              {result.skipped.map((entry) => (
                <li key={entry.categoryId}>
                  {entry.code}: {entry.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {canEdit && showSettings ? (
          <Panel
            title="Tournament settings"
            bodyClassName="p-0"
            right={
              <span className="font-score text-t4 text-muted-foreground">saved as you go</span>
            }
          >
            <div className="divide-y divide-hairline">
              <SettingsSection
                title="Venue courts"
                summary={`${courtCount} court${courtCount === 1 ? "" : "s"}`}
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div
                    role="group"
                    aria-label="Number of courts at the venue"
                    className="inline-flex items-center rounded-lg border border-input bg-surface"
                  >
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-9 rounded-r-none px-2.5 font-score text-t2"
                      aria-label="Remove the last court"
                      disabled={!canEdit || busy || courtCount <= 1}
                      onClick={() => void setCourtCount(courtCount - 1)}
                    >
                      −
                    </Button>
                    <span
                      className="min-w-9 border-x border-hairline px-2 text-center font-score text-t2 font-semibold"
                      aria-live="polite"
                    >
                      {courtCount}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-9 rounded-l-none px-2.5 font-score text-t2"
                      aria-label="Add a court"
                      disabled={!canEdit || busy || courtCount >= 64}
                      onClick={() => void setCourtCount(courtCount + 1)}
                    >
                      +
                    </Button>
                  </div>
                  <p className="text-t4 text-muted-foreground">
                    Every playing day uses all of them unless it is narrowed below.
                  </p>
                </div>
              </SettingsSection>

              <SettingsSection
                title="Playing days"
                summary={`${tournamentDays.length} day${tournamentDays.length === 1 ? "" : "s"}`}
              >
                {tournament ? (
                  <PlayingDayPicker
                    startsOn={String(tournament.starts_on).slice(0, 10)}
                    endsOn={String(tournament.ends_on).slice(0, 10)}
                    chosen={chosenDates}
                    locked={lockedDates}
                    disabled={!canEdit || busy}
                    onAdd={(date) => void addDay(date)}
                    onRemove={(date) => {
                      const day = tournamentDays.find((entry) => entry.date.slice(0, 10) === date);
                      if (day) void removeDay(day);
                    }}
                  />
                ) : null}
                {tournamentDays.length > 0 && commonHours ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/50 px-3 py-2.5">
                      <p className="text-sm">
                        <span className="font-semibold">Every day:</span> courts open{" "}
                        <span className="font-score">{commonHours.start}</span> –{" "}
                        <span className="font-score">{commonHours.end}</span>
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto text-primary-ink"
                        disabled={!canEdit || busy}
                        aria-expanded={sharedOpen}
                        onClick={() => {
                          setSharedOpen((value) => !value);
                          setSharedDraft({ start: commonHours.start, end: commonHours.end });
                        }}
                      >
                        Change for all days
                      </Button>
                    </div>
                    {sharedOpen && sharedDraft ? (
                      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-hairline px-3 py-3">
                        <div>
                          <Label htmlFor="all-days-start" className="text-t4 text-muted-foreground">
                            Courts open
                          </Label>
                          <PickerInput
                            id="all-days-start"
                            type="time"
                            pickerLabel="Open the start time picker for every day"
                            className="mt-1 w-33 md:w-32"
                            value={sharedDraft.start}
                            disabled={!canEdit || busy}
                            onChange={(event) =>
                              setSharedDraft({ ...sharedDraft, start: event.target.value })
                            }
                          />
                        </div>
                        <div>
                          <Label htmlFor="all-days-end" className="text-t4 text-muted-foreground">
                            Courts close
                          </Label>
                          <PickerInput
                            id="all-days-end"
                            type="time"
                            pickerLabel="Open the end time picker for every day"
                            className="mt-1 w-33 md:w-32"
                            value={sharedDraft.end}
                            disabled={!canEdit || busy}
                            onChange={(event) =>
                              setSharedDraft({ ...sharedDraft, end: event.target.value })
                            }
                          />
                        </div>
                        <Button
                          size="sm"
                          disabled={!canEdit || busy}
                          onClick={() => void applyHoursToAll(sharedDraft.start, sharedDraft.end)}
                        >
                          Apply to every day
                        </Button>
                      </div>
                    ) : null}
                    <p className="text-t4 text-muted-foreground">
                      Each chosen day follows the line above. Open a day only to make it different.
                    </p>
                  </div>
                ) : null}
                <div className="divide-y divide-hairline rounded-lg border border-hairline">
                  {tournamentDays.map((day) => {
                    const window = windowFor(day);
                    const breakCount = breakRows(day).length;
                    const dayOpen = openDayId === day.id;
                    const differs =
                      (commonHours !== null &&
                        (day.start_time.slice(0, 5) !== commonHours.start ||
                          day.end_time.slice(0, 5) !== commonHours.end)) ||
                      courtsFor(day).length !== courtCount;
                    return (
                      <div key={day.id}>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                          <h4 className="min-w-[8.5rem] font-display text-sm font-semibold">
                            Day {day.day_number} — {dayDateLabel(day.date.slice(0, 10))}
                          </h4>
                          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                            <span className="font-score">
                              {day.start_time.slice(0, 5)} – {day.end_time.slice(0, 5)}
                            </span>, {courtsFor(day).length} of {courtCount} court
                            {courtCount === 1 ? "" : "s"}, {breakCount} break
                            {breakCount === 1 ? "" : "s"}
                          </p>
                          {differs ? (
                            <span className="rounded-full bg-warn-surface px-2.5 py-0.5 text-t4 font-semibold text-warn-foreground">
                              Different
                            </span>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-primary-ink"
                            aria-expanded={dayOpen}
                            aria-label={`${dayOpen ? "Close" : "Edit"} day ${day.day_number}`}
                            onClick={() => setOpenDayId(dayOpen ? null : day.id)}
                          >
                            {dayOpen ? "Done" : "Edit"}
                          </Button>
                        </div>
                        {dayOpen ? (
                      <div className="px-3 pb-3 pt-1">
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                          <h4 className="font-display text-sm font-semibold">
                            Day {day.day_number}
                          </h4>
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="font-score text-t4 text-muted-foreground">
                              {savingDayId === day.id
                                ? "Saving…"
                                : `${courtsFor(day).length} of ${courtCount} courts`}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-t4"
                              aria-label={`Remove day ${day.day_number}`}
                              disabled={!canEdit || busy || daysWithMatches.has(day.id)}
                              title={
                                daysWithMatches.has(day.id)
                                  ? "This day has matches on it. Clear or move them first."
                                  : undefined
                              }
                              onClick={() => void removeDay(day)}
                            >
                              Remove
                            </Button>
                          </div>
                        </div>

                        <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2">
                          <div className="flex flex-wrap items-end gap-2">
                            <div>
                              <Label
                                htmlFor={`day-${day.id}-date`}
                                className="text-t4 text-muted-foreground"
                              >
                                Date
                              </Label>
                                <PickerInput
                                  id={`day-${day.id}-date`}
                                  type="date"
                                  pickerLabel={`Open the calendar for day ${day.day_number}`}
                                  className="mt-1 w-38 md:w-36"
                                  value={window.date}
                                  disabled={!canEdit || busy}
                                  onChange={(event) => setWindow(day, { date: event.target.value })}
                                  onBlur={() => void commitDayWindow(day)}
                                />
                            </div>
                            <div>
                              <Label
                                htmlFor={`day-${day.id}-start`}
                                className="text-t4 text-muted-foreground"
                              >
                                Start
                              </Label>
                                <PickerInput
                                  id={`day-${day.id}-start`}
                                  type="time"
                                  pickerLabel={`Open the start time picker for day ${day.day_number}`}
                                  className="mt-1 w-33 md:w-32"
                                  value={window.start}
                                  disabled={!canEdit || busy}
                                  onChange={(event) => setWindow(day, { start: event.target.value })}
                                  onBlur={() => void commitDayWindow(day)}
                                />
                            </div>
                            <div>
                              <Label
                                htmlFor={`day-${day.id}-end`}
                                className="text-t4 text-muted-foreground"
                              >
                                End
                              </Label>
                                <PickerInput
                                  id={`day-${day.id}-end`}
                                  type="time"
                                  pickerLabel={`Open the end time picker for day ${day.day_number}`}
                                  className="mt-1 w-33 md:w-32"
                                  value={window.end}
                                  disabled={!canEdit || busy}
                                  onChange={(event) => setWindow(day, { end: event.target.value })}
                                  onBlur={() => void commitDayWindow(day)}
                                />
                            </div>
                          </div>

                          <div
                            role="group"
                            aria-label={`Courts used on day ${day.day_number}`}
                            className="min-w-0"
                          >
                            <p className="text-t4 text-muted-foreground">Courts</p>
                            <div className="mt-1 flex min-h-9 flex-wrap items-center gap-1.5">
                              {(courts ?? []).map((court) => {
                                const on = courtsFor(day).some((entry) => entry.id === court.id);
                                const lastOn = on && courtsFor(day).length === 1;
                                return (
                                  <Button
                                    key={court.id}
                                    size="sm"
                                    variant={on ? "default" : "outline"}
                                    className="font-score h-9 min-w-16 px-2"
                                    disabled={!canEdit || busy || lastOn}
                                    title={
                                      lastOn
                                        ? "A day has to play on at least one court."
                                        : undefined
                                    }
                                    aria-pressed={on}
                                    onClick={() => void toggleDayCourt(day, court.id)}
                                  >
                                    Court {court.number}
                                  </Button>
                                );
                              })}
                            </div>
                          </div>
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                          <p className="text-t4 text-muted-foreground">Breaks</p>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-t4"
                            disabled={!canEdit || busy}
                            onClick={() =>
                              updateBreakRows(day.id, [
                                ...breakRows(day),
                                { label: "", start: "12:00", end: "13:00" },
                              ])
                            }
                          >
                            Add break
                          </Button>
                          {breakCount === 0 ? (
                            <p className="text-t4 text-muted-foreground">
                              None — play runs straight through.
                            </p>
                          ) : null}
                        </div>

                        {breakCount > 0 ? (
                          <div className="mt-2 divide-y divide-hairline rounded-lg border border-hairline">
                            {breakRows(day).map((row, index) => (
                              <div
                                key={index}
                                role="group"
                                aria-label={`Break ${index + 1}`}
                                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-2 sm:flex sm:flex-wrap"
                              >
                                {/*
                                 * The row carries its own group name and every field inside it is
                                 * named, because a placeholder is not an accessible name - the two
                                 * time inputs had none at all, which the panel scan now catches.
                                 */}
                                <Input
                                  aria-label="Name"
                                  className="h-8 min-w-0 sm:w-32"
                                  placeholder="Lunch"
                                  value={row.label}
                                  disabled={!canEdit || busy}
                                  onChange={(event) =>
                                    updateBreakRows(
                                      day.id,
                                      breakRows(day).map((entry, i) =>
                                        i === index
                                          ? { ...entry, label: event.target.value }
                                          : entry,
                                      ),
                                    )
                                  }
                                />
                                <div className="col-span-2 flex flex-wrap items-center gap-1.5">
                                  <PickerInput
                                    aria-label="Start"
                                    type="time"
                                    pickerLabel={`Open the start time picker for break ${index + 1}`}
                                    className="h-8 w-33 shrink-0 md:w-32"
                                    value={row.start}
                                    disabled={!canEdit || busy}
                                    onChange={(event) =>
                                      updateBreakRows(
                                        day.id,
                                        breakRows(day).map((entry, i) =>
                                          i === index
                                            ? { ...entry, start: event.target.value }
                                            : entry,
                                        ),
                                      )
                                    }
                                  />
                                  <span className="shrink-0 text-t4 text-muted-foreground">
                                    to
                                  </span>
                                  <PickerInput
                                    aria-label="End"
                                    type="time"
                                    pickerLabel={`Open the end time picker for break ${index + 1}`}
                                    className="h-8 w-33 shrink-0 md:w-32"
                                    value={row.end}
                                    disabled={!canEdit || busy}
                                    onChange={(event) =>
                                      updateBreakRows(
                                        day.id,
                                        breakRows(day).map((entry, i) =>
                                          i === index
                                            ? { ...entry, end: event.target.value }
                                            : entry,
                                        ),
                                      )
                                    }
                                  />
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="ml-auto shrink-0 text-muted-foreground"
                                    aria-label={`Remove break ${index + 1}`}
                                    disabled={!canEdit || busy}
                                    onClick={() =>
                                      updateBreakRows(
                                        day.id,
                                        breakRows(day).filter((_, i) => i !== index),
                                      )
                                    }
                                  >
                                    Remove
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {breaksDirty(day) ? (
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 px-2.5 py-2">
                            <p className="text-t4 text-muted-foreground">
                              Unsaved break changes for this day.
                            </p>
                            <Button
                              size="sm"
                              disabled={!canEdit || busy}
                              onClick={() => void saveBreaks(day)}
                            >
                              Save breaks
                            </Button>
                          </div>
                        ) : null}
                      </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </SettingsSection>

              <SettingsSection title="Match format" summary="2 stages">
                {tournament ? (
                  <div className="grid gap-3 lg:grid-cols-2">
                    <MatchFormatCard
                      title="Placement"
                      detail="The two rounds that sort entrants into draws."
                      rule={ruleForStage(tournament, "placement")}
                      slotMinutes={tournament.group_slot_minutes}
                      restMinutes={tournament.group_rest_gap_minutes}
                      slotMin={1}
                      restMin={0}
                      slotText={timingText("placement-slot", tournament.group_slot_minutes)}
                      restText={timingText("placement-rest", tournament.group_rest_gap_minutes)}
                      disabled={!canEdit || busy}
                      onRule={(rule) => void saveScoringRule("placement", rule)}
                      onPreset={(rule, minutes) => void saveScoringRule("placement", rule, minutes)}
                      onSlotChange={(raw) =>
                        setTimingDrafts((prev) => ({ ...prev, "placement-slot": raw }))
                      }
                      onRestChange={(raw) =>
                        setTimingDrafts((prev) => ({ ...prev, "placement-rest": raw }))
                      }
                      onSlotCommit={(raw) => commitTiming("placement-slot", raw)}
                      onRestCommit={(raw) => commitTiming("placement-rest", raw)}
                    />
                    <MatchFormatCard
                      title="Knockout"
                      detail="The A/B/C/D single-elimination draws."
                      rule={ruleForStage(tournament, "knockout")}
                      slotMinutes={tournament.knockout_slot_minutes}
                      restMinutes={tournament.knockout_rest_gap_minutes}
                      slotMin={1}
                      restMin={0}
                      slotText={timingText("knockout-slot", tournament.knockout_slot_minutes)}
                      restText={timingText("knockout-rest", tournament.knockout_rest_gap_minutes)}
                      disabled={!canEdit || busy}
                      onRule={(rule) => void saveScoringRule("knockout", rule)}
                      onPreset={(rule, minutes) => void saveScoringRule("knockout", rule, minutes)}
                      onSlotChange={(raw) =>
                        setTimingDrafts((prev) => ({ ...prev, "knockout-slot": raw }))
                      }
                      onRestChange={(raw) =>
                        setTimingDrafts((prev) => ({ ...prev, "knockout-rest": raw }))
                      }
                      onSlotCommit={(raw) => commitTiming("knockout-slot", raw)}
                      onRestCommit={(raw) => commitTiming("knockout-rest", raw)}
                    />
                  </div>
                ) : null}
              </SettingsSection>
            </div>
          </Panel>
        ) : null}

        {canEdit ? (
          <Panel
            title="Stage progress"
            right={
              <span className="text-t4 text-muted-foreground">
                matches completed / total, next step
              </span>
            }
          >
            <StageProgressList rows={stageProgress} />
          </Panel>
        ) : null}

        <Panel
          title="Running order"
          right={
            <span className="font-score text-t4 text-muted-foreground">
              {result
                ? `${result.summary.placed} placed this session`
                : `${rows.length} scheduled, ${daySlices.length} day${daySlices.length === 1 ? "" : "s"}`}
            </span>
          }
          bodyClassName={rows.length || daySlices.length ? "p-0" : "p-4"}
        >
          {rows.length === 0 && daySlices.length === 0 ? (
            <EmptyState
              title="Nothing scheduled yet"
              hint="Build the schedule to place the first day's matches across the courts."
            />
          ) : (
            <Tabs value={activeDayId} onValueChange={setPickedDayId}>
              {/* One tab per tournament day, so a two-day event reads as two days
                  rather than one list running past midnight. Days are never hidden:
                  a day that has nothing on it yet still gets a tab, which is what
                  makes the second day visible before it is built. */}
              <div className="border-b border-hairline px-3 py-2">
                <TabsList className="h-auto flex-wrap justify-start">
                  {daySlices.map((slice) => (
                    <TabsTrigger key={slice.day.id} value={slice.day.id}>
                      Day {slice.day.day_number}
                      <span className="ml-1.5 font-score text-t4 text-muted-foreground">
                        {slice.rows.length}
                      </span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>

              {daySlices.map((slice) => (
                <TabsContent key={slice.day.id} value={slice.day.id} className="mt-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-t4 text-muted-foreground">
                    <span className="font-semibold text-foreground">
                      {dayDateLabel(slice.day.date)}
                    </span>
                    <span>
                      {windowFor(slice.day).start}–{windowFor(slice.day).end}
                    </span>
                    <span>
                      {slice.rows.length} match{slice.rows.length === 1 ? "" : "es"}
                    </span>
                    <span>{courtsFor(slice.day).length} courts</span>
                  </div>

                  {slice.rows.length === 0 ? (
                    // Padded, because the panel body is full-bleed for the table and
                    // the empty state's own border would otherwise sit on the edge.
                    <div className="p-3">
                      <EmptyState
                        title="Nothing on this day yet"
                        hint="Build or rebuild the schedule to place matches here."
                      />
                    </div>
                  ) : (
                    <>
                    {/*
                      A phone or tablet gets one card per match instead of the six-column table, which it
                      squeezed until the status read "COMPLE" and the day ran to 23,000px. A
                      match already played is folded away while some are still to come, since
                      a reader on a phone is looking for what is next; when none are left the
                      played ones are the day, so they show.
                    */}
                    <PhoneRunningOrder rows={slice.rows} />
                    <div className="hidden overflow-x-auto lg:block">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th className="w-16">Time</th>
                            <th className="w-28">Court</th>
                            <th className="w-14">Cat</th>
                            <th className="w-40">Stage</th>
                            <th className="w-28">Status</th>
                            <th>Match</th>
                          </tr>
                        </thead>
                        <tbody>
                          {slice.rows.map((row) => (
                            <tr key={row.id}>
                              <td className="font-score text-sm font-semibold">
                                {timeLabel(row.start)}
                              </td>
                              <td>
                                {/* Neutral: violet is for what can be pressed, and this chip cannot. */}
                                <span className="inline-flex whitespace-nowrap rounded-md bg-muted px-1.5 py-0.5 font-score text-t2 font-semibold text-foreground" title={row.courtNumber ? undefined : "Court not assigned"}>
                                  {row.courtNumber ? `Court ${row.courtNumber}` : "Unassigned"}
                                </span>
                              </td>
                              <td className="font-score text-sm">{row.categoryCode}</td>
                              <td className="text-sm text-muted-foreground">{row.stage}</td>
                              <td>
                                <StatusPill status={row.status} />
                              </td>
                              <td>{row.label}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    </>
                  )}
                </TabsContent>
              ))}
            </Tabs>
          )}
        </Panel>

        {canEdit ? (
          <Panel
            title="Reset"
            bodyClassName="p-0"
            right={
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={showDanger}
                onClick={() => setShowDanger((value) => !value)}
              >
                {showDanger ? "Hide" : "Show"}
              </Button>
            }
          >
            {showDanger ? (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                <p className="max-w-lg text-sm text-muted-foreground">
                  Clears every placement and knockout match, every reported result and every
                  scheduled time, returning the stage to the start of round one. The seed order
                  and any waivers are kept, so the schedule can be rebuilt on the same seeding.
                  The days, courts and match settings above are also kept. This cannot be undone.
                </p>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy || !tournament}
                  onClick={() => void resetStage()}
                >
                  Delete results &amp; schedule
                </Button>
              </div>
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                Clear results and schedule, keeping the seed order.
              </p>
            )}
          </Panel>
        ) : null}

        {canEdit && showSettings ? (
          <div className="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline bg-surface px-4 py-3 sm:mx-0 sm:rounded-2xl sm:border">
            {buildButton}
            <span id="build-blocker" className="text-sm text-muted-foreground">
              {buildBlocker ??
                (hasSchedule
                  ? "Matches already played or on court never move."
                  : `${tournamentDays.length} day${tournamentDays.length === 1 ? "" : "s"}. Places every match; nothing already played is ever moved.`)}
            </span>
          </div>
        ) : null}
      </div>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-2xl">
          {preview ? (
            <>
              <DialogHeader>
                <DialogTitle>Rebuild preview</DialogTitle>
                <DialogDescription>
                  Nothing is written until you apply. Anchors stay fixed; only matches still to be
                  played may move.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 overflow-y-auto pr-1">
                <div className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm">
                  <p className="font-score">
                    {preview.plan.summary.anchorCount} anchors kept, {preview.plan.summary.placed}{" "}
                    matches replanned, {preview.plan.diff.movedCount} moving
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    The table below shows how each day's finish changes.
                  </p>
                </div>

                {previewDayChanges.length ? (
                  <div className="overflow-hidden rounded-md border border-hairline">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Day</th>
                          <th className="w-20">Placed</th>
                          <th className="w-24">Last finish</th>
                          <th className="w-20">Moving</th>
                          <th className="w-20">Largest</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewDayChanges.map((row) => (
                          <tr key={row.dayId}>
                            <td className="text-sm">
                              {dayDateLabel(row.date)}
                              {row.overrunMinutes > 0 ? (
                                <span className="ml-2 text-sm text-warn-foreground">
                                  {row.overrunMinutes} min past close
                                </span>
                              ) : null}
                            </td>
                            <td className="font-score text-sm">{row.placed}</td>
                            <td className="font-score text-sm">
                              {row.lastFinish ? timeLabel(row.lastFinish) : "—"}
                            </td>
                            <td className="font-score text-sm">{row.moving}</td>
                            <td className="font-score text-sm">
                              {row.largestShift ? `${row.largestShift} min` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                {preview.plan.blocked.length > 0 ? (
                  <div className="rounded-md bg-danger-surface px-3 py-2 text-sm text-danger-foreground">
                    <p className="font-semibold">
                      {preview.plan.blocked.length} match
                      {preview.plan.blocked.length === 1 ? "" : "es"} could not be placed.
                    </p>
                    {preview.plan.blockedReason ? (
                      <p className="mt-1 text-sm">{preview.plan.blockedReason}</p>
                    ) : preview.plan.summary.diagnostics?.deadlockReason ? (
                      <p className="mt-1 text-sm">
                        {preview.plan.summary.diagnostics.deadlockReason}
                      </p>
                    ) : null}
                    <ul className="mt-2 space-y-1 text-sm">
                      {preview.plan.blocked.map((matchId) => (
                        <li key={matchId}>{matchLabel(matchId)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {preview.plan.awaitingTeams.length > 0 ? (
                  <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                    {preview.plan.awaitingTeams.length} match
                    {preview.plan.awaitingTeams.length === 1 ? "" : "es"} waiting on a bracket and
                    will stay unscheduled.
                  </div>
                ) : null}

                {preview.plan.blocked.length === 0 ? (
                  <>
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">
                        {showAllChanges ? "Full plan" : "Changes only"} ({visibleChanges.length})
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setShowAllChanges((value) => !value)}
                      >
                        {showAllChanges ? "Show changes only" : "Show full plan"}
                      </Button>
                    </div>
                    <div className="max-h-64 overflow-y-auto rounded-md border border-hairline">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Match</th>
                            <th className="w-28">Time</th>
                            <th className="w-40">Court</th>
                            <th className="w-16">Shift</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleChanges.map((change) => (
                            <tr key={change.matchId}>
                              <td className="text-sm">{matchLabel(change.matchId)}</td>
                              <td className="font-score text-sm">
                                {change.fromStart ? timeLabel(change.fromStart) : "—"} →{" "}
                                {timeLabel(change.toStart)}
                              </td>
                              <td className="whitespace-nowrap font-score text-sm">
                                {change.fromCourtNumber != null
                                  ? `Court ${change.fromCourtNumber}`
                                  : "—"}{" "}
                                → Court {change.toCourtNumber}
                              </td>
                              <td className="font-score text-sm">
                                {change.shiftMinutes > 0 ? "+" : ""}
                                {change.shiftMinutes || "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : null}
              </div>

              <DialogFooter>
                <Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>
                  Keep current schedule
                </Button>
                <Button
                  disabled={busy || preview.plan.blocked.length > 0}
                  onClick={() => void applyPreview()}
                >
                  Apply rebuild
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </Page>
  );
}

/**
 * One labelled block inside the settings panel: a header row with the section's own
 * summary on the right, then its controls across the full width.
 *
 * The header used to be a fixed 13rem column beside the content, which reserved that
 * width for a section that only holds a title - the venue's court count was three
 * words of label and thirteen rem of empty space - and squeezed every control into
 * what was left. Putting the heading above the body, with the count in its own
 * right-aligned slot, keeps one rhythm across all three sections and gives the day
 * rows and the match-format cards the panel's whole width.
 *
 * The summary is the section's own headline number or state ("8 courts", "2 days",
 * "2 stages"), so the panel can be scanned without reading the controls underneath.
 */
function SettingsSection({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="px-4 py-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-display text-sm font-semibold">{title}</h3>
        {summary ? (
          <span className="font-score text-t4 text-muted-foreground">{summary}</span>
        ) : null}
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  );
}
