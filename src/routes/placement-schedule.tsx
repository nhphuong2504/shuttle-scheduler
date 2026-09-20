import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell, EmptyState, Panel, StatusPill } from "@/components/app-shell";
import { MatchFormatCard } from "@/components/match-format";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/hooks/useSession";
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
import { dayDateLabel, timeLabel } from "@/lib/tournament/format";
import { dayIdForTime } from "@/lib/tournament/day-scope";
import { projectedFinishFromRemainingMatches } from "@/lib/tournament/schedule-diff";
import { roundName } from "@/lib/tournament/draws";
import { ruleForStage, type ScoringRule } from "@/lib/tournament/scoring";
import { buildStageProgress } from "@/lib/tournament/stage-progress";
import { StageProgressList } from "@/components/stage-progress";
import {
  applyPlacementSchedulePlan,
  courtsForDay,
  dayWindowBounds,
  placementMatchLabel,
  planPlacementSchedule,
  sliceRowsByDay,
  type PlacementDayFill,
  type PlacementSchedulePlan,
} from "@/lib/tournament/placement-schedule";
import {
  generateMissingStages,
  resetPlacementStage,
  stageGenerationChanged,
  stageResetNote,
  type StageGenerationOutcome,
} from "@/lib/tournament/placement-actions";

export const Route = createFileRoute("/placement-schedule")({
  head: () => ({
    meta: [
      { title: "Court Schedule | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content:
          "Lay out the placement rounds and the A/B/C/D knockouts across the courts as one queue, filling each day's slots in turn.",
      },
      { property: "og:title", content: "Court Schedule | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content:
          "Lay out the placement rounds and the A/B/C/D knockouts across the courts as one queue, filling each day's slots in turn.",
      },
    ],
  }),
  component: PlacementSchedulePage,
});

/**
 * The two-round placement format's scheduling surface.
 *
 * A separate route from `/schedule` rather than a mode inside it. That page is
 * built around `pool_matches` and `draw_matches` — it reads them by name, labels
 * its stages "groups" and "knockouts", and its rebuild button is wired to the
 * round-robin persistence call. Making it format-aware would mean a page that has
 * to know which format it is looking at, which is the coupling the separate tables
 * exist to avoid.
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

function PlacementSchedulePage() {
  const qc = useQueryClient();
  const { canSchedule, isAdmin } = useSession();
  const { tournament, days, loading } = useTournamentScope();
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
  /** The date typed into "Add a day", or null while it still shows the suggested one. */
  const [newDayDate, setNewDayDate] = useState<string | null>(null);

  const tournamentDays = useMemo(() => days ?? [], [days]);
  const dayCount = tournament?.day_count ?? tournamentDays.length;

  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const playerMap = useMemo(() => indexBy(players), [players]);
  const courtMap = useMemo(() => indexBy(courts), [courts]);
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
    if (settingsOpenedForFirstBuild.current) return;
    if (!planInputsReady) return;
    settingsOpenedForFirstBuild.current = true;
    if (!hasSchedule) setShowSettings(true);
  }, [planInputsReady, hasSchedule]);

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
      toast.success("Timing updated. Rebuild a day to apply it.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the timing");
    }
  };

  /**
   * Grows or shrinks the venue's court pool from a day card.
   *
   * Courts are shared by every day, so these are venue-level actions that happen to
   * be reachable from where the courts are chosen. A day that plays on every court
   * picks a new court up straight away, because "every court" is stored as no rows at
   * all; a day with an explicit subset keeps its subset and its card shows "n of m".
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
    // A day with no `tournament_day_courts` rows means "every court", so removing a
    // day's last remaining court would silently widen that day to the whole venue
    // rather than leave it with none. Refuse instead, and name the day.
    if (next < (courts ?? []).length) {
      const removing = new Set(
        (courts ?? []).filter((court) => court.number > next).map((court) => court.id),
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
      toast.success("Match settings updated. Rebuild a day to apply it.");
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
      toast.success(`Day ${day.day_number} breaks saved. Rebuild a day to apply them.`);
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
          // The round is named from the bracket size, not from how many rounds the
          // draw has rows for: later rounds are only created once the round before
          // is decided, so counting them would call the opening round of a
          // half-played draw "Final". Falls back to the raw round number if the
          // draw has not loaded, since the size is what the name is derived from.
          stage: `Draw ${draw?.tier ?? "?"} · ${
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
   * The date offered for a new day: the one after the last, which is the overrun case.
   *
   * Built from the day's own `YYYY-MM-DD` rather than a UTC parse, so it cannot land
   * a day early west of Greenwich the way `new Date(dateString)` would.
   */
  const suggestedNewDayDate = useMemo(() => {
    const last = tournamentDays[tournamentDays.length - 1];
    if (!last) return "";
    const date = new Date(`${last.date}T00:00:00`);
    date.setDate(date.getDate() + 1);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }, [tournamentDays]);

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
      setNewDayDate("");
      await qc.invalidateQueries();
      toast.success(`Day added for ${date}. Rebuild to place matches on it.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add the day");
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

  const computePlan = async (fresh: Awaited<ReturnType<typeof freshSchedulingData>>) => {
    if (!tournament) throw new Error("No active tournament is configured.");
    return planPlacementSchedule({
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the schedule");
    } finally {
      setBusy(false);
    }
  };

  const previewRebuild = async () => {
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
   * Discards the whole placement stage and returns it to a registered field.
   *
   * Everything unplayed and everything played goes, plus the seed order and the
   * waivers, so the stage is back to the state it is in after entrants are synced
   * and the next action is "Shuffle & lock seeds" on the Placement tab. Nothing
   * here can be undone, hence the explicit confirmation and the admin check.
   */
  const resetStage = async () => {
    if (!tournament) return;
    const confirmed = window.confirm(
      "Delete every placement result and the whole schedule?\n\n" +
        "This removes both placement rounds, the A/B/C/D draws, every result and every " +
        "scheduled time, and it also clears the seed order and the waivers. The field goes " +
        "back to a registered field with nothing played, ready to shuffle and lock seeds " +
        "again. It cannot be undone.",
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      const reset = await resetPlacementStage(tournament.id);
      // The local summaries describe a schedule that no longer exists, so they are
      // cleared rather than refreshed: "not built yet" is the truth now.
      setResult(null);
      setPreview(null);
      await qc.invalidateQueries();
      toast.success(stageResetNote(reset));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reset the placement stage");
    } finally {
      setBusy(false);
    }
  };

  if (!loading && !tournamentDays.length) {
    return (
      <AppShell title="Court schedule">
        <Panel title="No tournament configured">
          <EmptyState
            title="Set up a tournament first"
            hint="A tournament defines its days, courts and the durations each stage is scheduled with."
            action={
              <Link
                to="/setup"
                className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
              >
                Open tournament setup
              </Link>
            }
          />
        </Panel>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Court schedule"
      subtitle="One running order for the whole tournament. Matches already played or on court never move."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSettings((value) => !value)}
            aria-expanded={showSettings}
          >
            {showSettings ? "Hide settings" : "Settings"}
          </Button>
          <Button
            disabled={
              !canSchedule || busy || !planInputsReady || !tournament || !(courts ?? []).length
            }
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
        </div>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-hairline bg-surface px-3 py-2.5 text-xs text-muted-foreground">
          <span className="font-score font-semibold text-foreground">
            {rows.length} match{rows.length === 1 ? "" : "es"} scheduled
          </span>
          <span>
            {tournamentDays.length} day{tournamentDays.length === 1 ? "" : "s"} ·{" "}
            {(courts ?? []).length} court{(courts ?? []).length === 1 ? "" : "s"}
          </span>
          <ScheduledFinish finishMs={scheduledFinishMs} closeMs={officialCloseMs} />
          {result && result.summary.unscheduled > 0 ? (
            <span className="text-danger-foreground">
              {result.summary.unscheduled} could not be placed
            </span>
          ) : null}
          <span className="ml-auto">
            {realtime.status === "live"
              ? "Live"
              : realtime.status === "connecting"
                ? "Connecting…"
                : "Offline"}
          </span>
        </div>

        {!(courts ?? []).length ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-danger-surface px-3 py-2 text-xs text-danger-foreground">
            <span>
              No courts yet — set how many courts the venue has before building the schedule.
            </span>
            <Button size="sm" variant="outline" onClick={() => setShowSettings(true)}>
              Set courts
            </Button>
          </div>
        ) : null}

        {result && result.skipped.length > 0 ? (
          <div className="rounded-lg bg-warn-surface px-3 py-2 text-xs text-warn-foreground">
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

        {showSettings ? (
          <Panel
            title="Settings"
            bodyClassName="p-0"
            right={
              <span className="font-score text-t4 text-muted-foreground">saved as you go</span>
            }
          >
            <div className="divide-y divide-hairline">
              <SettingsSection
                title="Playing days"
                hint="When the tournament runs and which of the venue's courts each day uses. Days can be added or removed after activation; dates save as you leave the field."
              >
                <div className="space-y-3">
                  <div className="flex flex-wrap items-end justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      {tournamentDays.length} day{tournamentDays.length === 1 ? "" : "s"}
                      {tournamentDays.length >= 7
                        ? " · 7 is the maximum"
                        : " · add one if the tournament overruns"}
                    </p>
                    {tournamentDays.length < 7 ? (
                      <div className="flex items-end gap-2">
                        <div>
                          <Label htmlFor="new-day-date" className="text-xs text-muted-foreground">
                            New day
                          </Label>
                          <Input
                            id="new-day-date"
                            type="date"
                            className="mt-1 h-9 w-36"
                            disabled={!canSchedule || busy}
                            value={newDayDate ?? suggestedNewDayDate}
                            onChange={(event) => setNewDayDate(event.target.value)}
                          />
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canSchedule || busy}
                          onClick={() => void addDay(newDayDate ?? suggestedNewDayDate)}
                        >
                          Add day
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {tournamentDays.map((day) => {
                      const window = windowFor(day);
                      return (
                        <div
                          key={day.id}
                          className="space-y-3 rounded-lg border border-hairline bg-surface p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-display text-sm font-semibold">
                              Day {day.day_number}
                            </p>
                            <div className="flex items-center gap-1.5">
                              <span className="font-score text-t4 text-muted-foreground">
                                {savingDayId === day.id
                                  ? "Saving…"
                                  : `${courtsFor(day).length} of ${(courts ?? []).length} courts`}
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-t4"
                                disabled={
                                  !canSchedule ||
                                  busy ||
                                  tournamentDays.length <= 1 ||
                                  daysWithMatches.has(day.id)
                                }
                                title={
                                  tournamentDays.length <= 1
                                    ? "A tournament needs at least one day."
                                    : daysWithMatches.has(day.id)
                                      ? "This day has matches on it. Clear or move them first."
                                      : undefined
                                }
                                onClick={() => void removeDay(day)}
                              >
                                Remove
                              </Button>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-end gap-2">
                            <div>
                              <Label
                                htmlFor={`day-${day.id}-date`}
                                className="text-xs text-muted-foreground"
                              >
                                Date
                              </Label>
                              <Input
                                id={`day-${day.id}-date`}
                                type="date"
                                className="mt-1 h-9 w-36"
                                value={window.date}
                                disabled={!canSchedule || busy}
                                onChange={(event) => setWindow(day, { date: event.target.value })}
                                onBlur={() => void commitDayWindow(day)}
                              />
                            </div>
                            <div>
                              <Label
                                htmlFor={`day-${day.id}-start`}
                                className="text-xs text-muted-foreground"
                              >
                                Start
                              </Label>
                              <Input
                                id={`day-${day.id}-start`}
                                type="time"
                                className="mt-1 h-9 w-28"
                                value={window.start}
                                disabled={!canSchedule || busy}
                                onChange={(event) => setWindow(day, { start: event.target.value })}
                                onBlur={() => void commitDayWindow(day)}
                              />
                            </div>
                            <div>
                              <Label
                                htmlFor={`day-${day.id}-end`}
                                className="text-xs text-muted-foreground"
                              >
                                End
                              </Label>
                              <Input
                                id={`day-${day.id}-end`}
                                type="time"
                                className="mt-1 h-9 w-28"
                                value={window.end}
                                disabled={!canSchedule || busy}
                                onChange={(event) => setWindow(day, { end: event.target.value })}
                                onBlur={() => void commitDayWindow(day)}
                              />
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs text-muted-foreground">Courts this day</p>
                              <div className="flex gap-1.5">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={!canSchedule || busy}
                                  onClick={() => void setCourtCount((courts ?? []).length + 1)}
                                >
                                  Add a court
                                </Button>
                                {(courts ?? []).length > 1 ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={!canSchedule || busy}
                                    onClick={() => void setCourtCount((courts ?? []).length - 1)}
                                  >
                                    Remove court {(courts ?? []).length}
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {(courts ?? []).map((court) => {
                                const on = courtsFor(day).some((entry) => entry.id === court.id);
                                const lastOn = on && courtsFor(day).length === 1;
                                return (
                                  <Button
                                    key={court.id}
                                    size="sm"
                                    variant={on ? "default" : "outline"}
                                    className="font-score h-7 w-11 px-0"
                                    disabled={!canSchedule || busy || lastOn}
                                    title={
                                      lastOn
                                        ? "A day has to play on at least one court."
                                        : undefined
                                    }
                                    aria-pressed={on}
                                    onClick={() => void toggleDayCourt(day, court.id)}
                                  >
                                    C{court.number}
                                  </Button>
                                );
                              })}
                            </div>
                            <p className="text-t4 text-muted-foreground">
                              A court added here joins the venue, so any day playing on every court
                              gets it too.
                            </p>
                          </div>

                          <div className="space-y-2">
                            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                              <p className="min-w-0 text-xs text-muted-foreground">Breaks</p>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="shrink-0"
                                disabled={!canSchedule || busy}
                                onClick={() =>
                                  updateBreakRows(day.id, [
                                    ...breakRows(day),
                                    { label: "", start: "12:00", end: "13:00" },
                                  ])
                                }
                              >
                                Add break
                              </Button>
                            </div>
                            {breakRows(day).length === 0 ? (
                              <p className="text-t4 text-muted-foreground">
                                No breaks — play runs straight through.
                              </p>
                            ) : (
                              <div className="divide-y divide-border rounded-lg border border-border">
                                {breakRows(day).map((row, index) => (
                                  <div
                                    key={index}
                                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-2 sm:flex sm:flex-wrap"
                                  >
                                    <Input
                                      className="h-8 min-w-0 sm:w-32"
                                      placeholder="Lunch"
                                      value={row.label}
                                      disabled={!canSchedule || busy}
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
                                    <div className="col-span-2 flex items-center gap-1.5">
                                      <Input
                                        type="time"
                                        className="h-8 w-[7.5rem] shrink-0"
                                        value={row.start}
                                        disabled={!canSchedule || busy}
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
                                      <span className="shrink-0 text-xs text-muted-foreground">
                                        to
                                      </span>
                                      <Input
                                        type="time"
                                        className="h-8 w-[7.5rem] shrink-0"
                                        value={row.end}
                                        disabled={!canSchedule || busy}
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
                                        disabled={!canSchedule || busy}
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
                            )}
                            {breaksDirty(day) ? (
                              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 px-2.5 py-2">
                                <p className="text-t4 text-muted-foreground">
                                  Unsaved break changes for this day.
                                </p>
                                <Button
                                  size="sm"
                                  disabled={!canSchedule || busy}
                                  onClick={() => void saveBreaks(day)}
                                >
                                  Save breaks
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </SettingsSection>

              <SettingsSection
                title="Match format"
                hint="One card per stage. A scoring rule is checked the moment a result is reported; the length and rest gap are read at the next build."
              >
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
                      disabled={!canSchedule || busy}
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
                      disabled={!canSchedule || busy}
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

        <Panel
          title="Stage progress"
          right={
            <span className="text-t4 text-muted-foreground">
              completed / created · advance readiness
            </span>
          }
        >
          <StageProgressList rows={stageProgress} />
        </Panel>

        <Panel
          title="Running order"
          right={
            <span className="font-score text-t4 text-muted-foreground">
              {result
                ? `${result.summary.placed} placed this session`
                : `${rows.length} scheduled · ${daySlices.length} day${daySlices.length === 1 ? "" : "s"}`}
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
                    <div className="overflow-x-auto">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th className="w-16">Time</th>
                            <th className="w-16">Court</th>
                            <th className="w-14">Cat</th>
                            <th className="w-40">Stage</th>
                            <th className="w-28">Status</th>
                            <th>Match</th>
                          </tr>
                        </thead>
                        <tbody>
                          {slice.rows.map((row) => (
                            <tr key={row.id}>
                              <td className="font-score text-xs font-semibold">
                                {timeLabel(row.start)}
                              </td>
                              <td>
                                <span className="inline-flex rounded-md bg-primary/10 px-1.5 py-0.5 font-score text-t2 font-semibold text-primary">
                                  C{row.courtNumber || "—"}
                                </span>
                              </td>
                              <td className="font-score text-xs">{row.categoryCode}</td>
                              <td className="text-xs text-muted-foreground">{row.stage}</td>
                              <td>
                                <StatusPill status={row.status} />
                              </td>
                              <td>{row.label}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </TabsContent>
              ))}
            </Tabs>
          )}
        </Panel>

        {isAdmin ? (
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
                <p className="max-w-lg text-xs text-muted-foreground">
                  Clears every placement and knockout match, every reported result, the seed order
                  and any waivers, so the placement stage starts over. The days, courts and match
                  settings above are kept. This cannot be undone.
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
              <p className="p-4 text-xs text-muted-foreground">
                Clear results and schedule, and start the placement stage over.
              </p>
            )}
          </Panel>
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
                    {preview.plan.summary.anchorCount} anchors kept · {preview.plan.summary.placed}{" "}
                    matches replanned · {preview.plan.diff.movedCount} moving
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
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
                                <span className="ml-2 text-xs text-warn-foreground">
                                  {row.overrunMinutes} min past close
                                </span>
                              ) : null}
                            </td>
                            <td className="font-score text-xs">{row.placed}</td>
                            <td className="font-score text-xs">
                              {row.lastFinish ? timeLabel(row.lastFinish) : "—"}
                            </td>
                            <td className="font-score text-xs">{row.moving}</td>
                            <td className="font-score text-xs">
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
                      <p className="mt-1 text-xs">{preview.plan.blockedReason}</p>
                    ) : preview.plan.summary.diagnostics?.deadlockReason ? (
                      <p className="mt-1 text-xs">
                        {preview.plan.summary.diagnostics.deadlockReason}
                      </p>
                    ) : null}
                    <ul className="mt-2 space-y-1 text-xs">
                      {preview.plan.blocked.map((matchId) => (
                        <li key={matchId}>{matchLabel(matchId)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {preview.plan.awaitingTeams.length > 0 ? (
                  <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
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
                            <th className="w-20">Court</th>
                            <th className="w-16">Shift</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleChanges.map((change) => (
                            <tr key={change.matchId}>
                              <td className="text-sm">{matchLabel(change.matchId)}</td>
                              <td className="font-score text-xs">
                                {change.fromStart ? timeLabel(change.fromStart) : "—"} →{" "}
                                {timeLabel(change.toStart)}
                              </td>
                              <td className="font-score text-xs">
                                {change.fromCourtNumber != null
                                  ? `C${change.fromCourtNumber}`
                                  : "—"}{" "}
                                → C{change.toCourtNumber}
                              </td>
                              <td className="font-score text-xs">
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
    </AppShell>
  );
}

/**
 * One labelled block inside the Settings panel: a sticky-feeling title column
 * with its explanation, and the controls beside it on wide screens.
 */
function SettingsSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-3 px-4 py-4 md:grid-cols-[13rem_1fr] md:gap-6">
      <div>
        <h3 className="font-display text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-t4 leading-snug text-muted-foreground">{hint}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
