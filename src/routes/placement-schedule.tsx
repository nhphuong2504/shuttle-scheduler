import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell, EmptyState, Panel, StatusPill } from "@/components/app-shell";
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
import { useSession } from "@/hooks/useSession";
import {
  setTournamentDayBreaks,
  setTournamentDayCourts,
  updateTournamentDay,
  updateTournamentTimings,
  type ScheduleSummary,
} from "@/lib/tournament/actions";
import {
  indexBy,
  keys,
  scopedKey,
  teamLabel,
  useCategories,
  useCourts,
  usePlacementEntrants,
  usePlacementMatches,
  usePlayers,
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
import { timeLabel } from "@/lib/tournament/format";
import {
  applyPlacementSchedulePlan,
  courtsForDay,
  placementMatchLabel,
  planPlacementSchedule,
  type PlacementDayFill,
  type PlacementSchedulePlan,
} from "@/lib/tournament/placement-schedule";
import { formatProjectedFinishDelta } from "@/lib/tournament/schedule-diff";
import {
  generateMissingStages,
  stageGenerationChanged,
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
  const { canSchedule } = useSession();
  const { tournament, days, loading } = useTournamentScope();
  const tournamentId = tournament?.id ?? null;
  const { data: courts } = useCourts();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: categories } = useCategories();
  const { data: entrants } = usePlacementEntrants();
  const { data: placementMatches } = usePlacementMatches();
  const { data: draws } = useTierDraws();
  const { data: tierMatches } = useTierDrawMatches();
  const { data: dayCourts } = useTournamentDayCourts(tournamentId);
  const { data: dayBreaks } = useTournamentDayBreaks(tournamentId);

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
  const [busy, setBusy] = useState(false);
  /** Tournament-wide timing overrides, held as text so a half-typed number is not clobbered. */
  const [timingDrafts, setTimingDrafts] = useState<Record<string, string>>({});
  /** Per-day break edits, held locally until saved so a bad row cannot wipe the day. */
  const [breakDrafts, setBreakDrafts] = useState<Record<string, DayBreakRow[]>>({});

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
          stage: `Draw ${draw?.tier ?? "?"} R${match.round}`,
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
    const placementKey = scopedKey(keys.placementMatches, tournamentId);
    const tierKey = scopedKey(keys.tierDrawMatches, tournamentId);
    const drawKey = scopedKey(keys.tierDraws, tournamentId);
    for (const key of [placementKey, tierKey, drawKey]) {
      await qc.invalidateQueries({ queryKey: key });
      await qc.refetchQueries({ queryKey: key });
    }
    return {
      placementMatches: qc.getQueryData<PlacementMatch[]>(placementKey) ?? [],
      tierMatches: qc.getQueryData<TierDrawMatch[]>(tierKey) ?? [],
      draws: qc.getQueryData<TierDraw[]>(drawKey) ?? [],
    };
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
      entrants: entrants ?? [],
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
      entrants: entrants ?? [],
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
      subtitle="Place the two placement rounds and the A/B/C/D knockouts across the courts. Reported and in-progress matches are anchors, so a rebuild can only move what has not been played."
      actions={
        <span className="text-xs text-muted-foreground">
          {tournament
            ? `${tournament.name} · ${dayCount} day${dayCount === 1 ? "" : "s"} · ` +
              `${tournament.group_slot_minutes}/${tournament.knockout_slot_minutes} min slots`
            : ""}
        </span>
      }
    >
      <div className="space-y-6">
        <div
          className={`rounded-lg border px-3 py-2.5 text-sm ${
            hasSchedule
              ? "border-warn-border bg-warn-surface text-warn-foreground"
              : "border-hairline bg-surface text-muted-foreground"
          }`}
        >
          <p className="font-semibold text-foreground">
            {hasSchedule ? "Rebuild mode" : "Before the first build"}
          </p>
          <p className="mt-0.5 text-xs">
            {hasSchedule
              ? "A rebuild plans from the current time and keeps reported, walkover and in-progress matches exactly where they are."
              : "One build fills every day in order. Round two is only generated once every round one result is in, so build again after a round completes and the queue picks up where it left off."}
          </p>
        </div>

        <Panel
          title="Scheduling inputs"
          right={
            <span className="font-score text-[11px] text-muted-foreground">
              {tournamentDays.length} day{tournamentDays.length === 1 ? "" : "s"} ·{" "}
              {(courts ?? []).length} court{(courts ?? []).length === 1 ? "" : "s"}
            </span>
          }
        >
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Everything the build is measured against. An override applies to the next build or
              rebuild — matches already on court or already reported are never moved to suit it.
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              {timingFields.map((timing) => (
                <div key={timing.key}>
                  <Label htmlFor={`timing-${timing.key}`} className="text-xs text-muted-foreground">
                    {timing.label}
                  </Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      id={`timing-${timing.key}`}
                      type="number"
                      min={timing.min}
                      className="h-9 w-24"
                      disabled={!canSchedule || busy}
                      value={timingText(timing.key, timing.value)}
                      onChange={(event) =>
                        setTimingDrafts((prev) => ({ ...prev, [timing.key]: event.target.value }))
                      }
                      onBlur={(event) =>
                        void saveTiming(
                          timing.field,
                          timing.key,
                          timing.value,
                          timing.min,
                          event.target.value,
                        )
                      }
                    />
                    <span className="text-xs text-muted-foreground">min</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{timing.hint}</p>
                </div>
              ))}
            </div>

            <div>
              <p className="text-xs font-semibold text-foreground">Per day</p>
              <div className="mt-2 overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="w-14">Day</th>
                      <th className="w-40">Window</th>
                      <th className="w-28">Courts</th>
                      <th className="w-52">Breaks</th>
                      <th>Last build</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tournamentDays.map((day) => {
                      const window = windowFor(day);
                      const dayBreaks_ = breaksForDay(day.id);
                      const fill = result?.days.find((entry) => entry.day === day.day_number);
                      return (
                        <tr key={day.id}>
                          <td className="font-score text-xs font-semibold">D{day.day_number}</td>
                          <td className="font-score text-xs">
                            {window.start}–{window.end}
                          </td>
                          <td className="font-score text-xs">
                            {courtsFor(day).length} of {(courts ?? []).length}
                          </td>
                          <td className="text-xs text-muted-foreground">
                            {dayBreaks_.length
                              ? dayBreaks_
                                  .map(
                                    (brk) =>
                                      `${brk.start_time.slice(0, 5)}–${brk.end_time.slice(0, 5)}`,
                                  )
                                  .join(", ")
                              : "none"}
                            {breaksDirty(day) ? " · unsaved" : ""}
                          </td>
                          <td className="text-xs text-muted-foreground">
                            {fill
                              ? `${fill.placed} placed${fill.lastFinish ? ` · to ${timeLabel(fill.lastFinish)}` : ""}`
                              : "not built in this session"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Days are capacity: the queue fills D1 first and spills on. Edit a day's window,
                courts and breaks on its panel below.
              </p>
            </div>
          </div>
        </Panel>

        <div className="grid gap-3 sm:grid-cols-2">
          {tournamentDays.map((day) => {
            const window = windowFor(day);
            const fill = result?.days.find((entry) => entry.day === day.day_number);
            return (
              <Panel
                key={day.id}
                title={`Day ${day.day_number}`}
                right={
                  fill ? (
                    <span className="font-score text-[11px] text-muted-foreground">
                      {fill.placed} placed
                      {fill.overrunMinutes > 0 ? ` · ${fill.overrunMinutes} min over` : ""}
                    </span>
                  ) : (
                    <span className="font-score text-[11px] text-muted-foreground">
                      {courtsFor(day).length} courts · {window.start}–{window.end}
                    </span>
                  )
                }
              >
                <div className="space-y-3">
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
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Courts — {courtsFor(day).length} of {(courts ?? []).length} switched on
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {(courts ?? []).map((court) => {
                        const on = courtsFor(day).some((entry) => entry.id === court.id);
                        return (
                          <Button
                            key={court.id}
                            size="sm"
                            variant={on ? "default" : "outline"}
                            className="font-score h-7 w-11 px-0"
                            disabled={!canSchedule || busy}
                            aria-pressed={on}
                            onClick={() => void toggleDayCourt(day, court.id)}
                          >
                            C{court.number}
                          </Button>
                        );
                      })}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Matches are only ever placed on the courts a day has switched on.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">Breaks</p>
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
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
                        {breaksDirty(day) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canSchedule || busy}
                            onClick={() => void saveBreaks(day)}
                          >
                            Save breaks
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {breakRows(day).length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">
                        No breaks — play runs straight through the window.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {breakRows(day).map((row, index) => (
                          <div key={index} className="flex flex-wrap items-center gap-1.5">
                            <Input
                              className="h-8 w-28"
                              placeholder="Lunch"
                              value={row.label}
                              disabled={!canSchedule || busy}
                              onChange={(event) =>
                                updateBreakRows(
                                  day.id,
                                  breakRows(day).map((entry, i) =>
                                    i === index ? { ...entry, label: event.target.value } : entry,
                                  ),
                                )
                              }
                            />
                            <Input
                              type="time"
                              className="h-8 w-24"
                              value={row.start}
                              disabled={!canSchedule || busy}
                              onChange={(event) =>
                                updateBreakRows(
                                  day.id,
                                  breakRows(day).map((entry, i) =>
                                    i === index ? { ...entry, start: event.target.value } : entry,
                                  ),
                                )
                              }
                            />
                            <span className="text-xs text-muted-foreground">to</span>
                            <Input
                              type="time"
                              className="h-8 w-24"
                              value={row.end}
                              disabled={!canSchedule || busy}
                              onChange={(event) =>
                                updateBreakRows(
                                  day.id,
                                  breakRows(day).map((entry, i) =>
                                    i === index ? { ...entry, end: event.target.value } : entry,
                                  ),
                                )
                              }
                            />
                            <Button
                              size="sm"
                              variant="ghost"
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
                        ))}
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      A match that would run through a break moves wholly after it.
                    </p>
                  </div>

                  {(courts ?? []).length ? null : (
                    <p className="rounded-md bg-danger-surface px-2 py-1 text-xs text-danger-foreground">
                      No courts are configured, so there is nothing to schedule onto.
                    </p>
                  )}
                </div>
              </Panel>
            );
          })}
        </div>

        <Panel
          title="Build the schedule"
          right={
            <span className="font-score text-[11px] text-muted-foreground">
              one queue · {result ? `${result.summary.placed} placed` : "not built yet"}
            </span>
          }
        >
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              One button. It creates whatever stage is next — round one from the locked seeds, round
              two once every round one result is in, then the A/B/C/D draws — and lays the queue out
              across the days. It fills D1 first and spills into the following days, so a day can
              hold the tail of one stage and the head of the next. Because a stage only exists once
              the previous one is decided, the stages cannot be scheduled out of order.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={!canSchedule || busy || !tournament || !(courts ?? []).length}
                onClick={() => void (hasSchedule ? previewRebuild() : build())}
              >
                {busy ? "Planning…" : hasSchedule ? "Rebuild schedule" : "Build schedule"}
              </Button>
              {!(courts ?? []).length ? (
                <span className="text-xs text-danger-foreground">Load the court list first.</span>
              ) : null}
            </div>

            {result ? (
              <div className="space-y-2 border-t border-hairline pt-3">
                {result.generated.roundOne + result.generated.roundTwo + result.generated.draws >
                0 ? (
                  <p className="text-xs text-muted-foreground">
                    Generated for this build:{" "}
                    {[
                      result.generated.roundOne > 0
                        ? `${result.generated.roundOne} round one match${
                            result.generated.roundOne === 1 ? "" : "es"
                          }`
                        : null,
                      result.generated.roundTwo > 0
                        ? `${result.generated.roundTwo} round two match${
                            result.generated.roundTwo === 1 ? "" : "es"
                          }`
                        : null,
                      result.generated.draws > 0
                        ? `${result.generated.draws} draw bracket${result.generated.draws === 1 ? "" : "s"}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                ) : null}
                {result.skipped.length > 0 ? (
                  <div className="rounded-md bg-warn-surface px-2 py-1.5 text-xs text-warn-foreground">
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
                <p className="font-score text-sm">
                  {result.summary.placed} match{result.summary.placed === 1 ? "" : "es"} placed ·{" "}
                  {result.summary.anchorCount} anchors kept ·{" "}
                  {Math.round(
                    (result.summary.remainingUtilization ?? result.summary.utilization) * 100,
                  )}
                  % of all court time used
                </p>
                <p className="text-xs text-muted-foreground">
                  {result.summary.movedCount > 0
                    ? `${result.summary.movedCount} match${result.summary.movedCount === 1 ? "" : "es"} moved · `
                    : ""}
                  {result.summary.projectedFinish
                    ? `projected finish ${timeLabel(result.summary.projectedFinish)}`
                    : "nothing scheduled"}
                  {result.summary.overrunMinutes > 0
                    ? ` · ${result.summary.overrunMinutes} min past the final close`
                    : ""}
                  {result.summary.projectedFinishDeltaMinutes != null
                    ? ` · ${formatProjectedFinishDelta(result.summary.projectedFinishDeltaMinutes)}`
                    : ""}
                </p>
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th className="w-14">Day</th>
                        <th className="w-24">Placed</th>
                        <th className="w-32">Last finish</th>
                        <th className="w-32">Overrun</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.days.map((fill) => (
                        <tr key={fill.day}>
                          <td className="font-score text-xs font-semibold">D{fill.day}</td>
                          <td className="font-score text-xs">{fill.placed}</td>
                          <td className="font-score text-xs">
                            {fill.lastFinish ? timeLabel(fill.lastFinish) : "—"}
                          </td>
                          <td className="font-score text-xs">
                            {fill.overrunMinutes > 0 ? `${fill.overrunMinutes} min` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {result.summary.awaitingTeams > 0 ? (
                  <p className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                    {result.summary.awaitingTeams} match
                    {result.summary.awaitingTeams === 1 ? "" : "es"} waiting on a bracket that has
                    not been decided yet.
                  </p>
                ) : null}
                {result.summary.unscheduled > 0 ? (
                  <p className="rounded-md bg-danger-surface px-2 py-1 text-xs text-danger-foreground">
                    {result.summary.unscheduled} match
                    {result.summary.unscheduled === 1 ? "" : "es"} could not be placed — desk
                    intervention needed.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Not built in this session. The running order below shows whatever is already
                scheduled.
              </p>
            )}
          </div>
        </Panel>

        <Panel
          title="Running order"
          right={
            <span className="font-score text-[11px] text-muted-foreground">
              {rows.length} scheduled
            </span>
          }
          bodyClassName={rows.length ? "p-0" : "p-4"}
        >
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing scheduled yet"
              hint="Build the placement stage to place the first day's matches across the courts."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-16">Time</th>
                    <th className="w-16">Court</th>
                    <th className="w-14">Cat</th>
                    <th className="w-28">Stage</th>
                    <th className="w-28">Status</th>
                    <th>Match</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="font-score text-xs font-semibold">{timeLabel(row.start)}</td>
                      <td>
                        <span className="inline-flex rounded-md bg-primary/10 px-1.5 py-0.5 font-score text-[11px] font-semibold text-primary">
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
        </Panel>
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
                  {preview.plan.summary.projectedFinish ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Projected finish {timeLabel(preview.plan.summary.projectedFinish)}
                      {preview.plan.summary.overrunMinutes > 0
                        ? ` · ${preview.plan.summary.overrunMinutes} min past the final close`
                        : ""}
                      {preview.plan.summary.remainingUtilization != null
                        ? ` · ${Math.round(preview.plan.summary.remainingUtilization * 100)}% of remaining window`
                        : ""}
                      {preview.plan.summary.projectedFinishDeltaMinutes != null ? (
                        <>
                          {" · "}
                          {formatProjectedFinishDelta(
                            preview.plan.summary.projectedFinishDeltaMinutes,
                          )}
                          {preview.plan.summary.currentProjectedFinish
                            ? ` (current ${timeLabel(preview.plan.summary.currentProjectedFinish)})`
                            : ""}
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </div>

                {preview.plan.blocked.length > 0 ? (
                  <div className="rounded-md bg-danger-surface px-3 py-2 text-sm text-danger-foreground">
                    <p className="font-semibold">
                      {preview.plan.blocked.length} match
                      {preview.plan.blocked.length === 1 ? "" : "es"} could not be placed.
                    </p>
                    {preview.plan.summary.diagnostics?.deadlockReason ? (
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
