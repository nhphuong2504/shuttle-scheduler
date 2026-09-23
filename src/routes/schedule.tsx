import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
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
import { PickerInput } from "@/components/ui/picker-input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/hooks/useSession";
import {
  applyDayPlan,
  planDay,
  updateTournamentDay,
  type DayPlan,
  type ScheduleSummary,
} from "@/lib/tournament/actions";
import {
  indexBy,
  keys,
  scopedKey,
  stagesForDay,
  teamLabel,
  useActiveTournament,
  useCategories,
  useCourts,
  useDrawMatches,
  useDraws,
  usePlayers,
  usePoolMatches,
  useTeams,
  useTournamentDays,
  type StageName,
  type TournamentDay,
} from "@/lib/tournament/data";
import { formatProjectedFinishDelta } from "@/lib/tournament/schedule-diff";
import { timeLabel } from "@/lib/tournament/format";

export const Route = createFileRoute("/schedule")({
  head: () => ({
    meta: [
      { title: "Court Schedule | Tournova Tournament Ops" },
      {
        name: "description",
        content:
          "Build the court schedule day by day with stage-specific rest gaps and overrun forecasts.",
      },
      { property: "og:title", content: "Court Schedule | Tournova Tournament Ops" },
      {
        property: "og:description",
        content:
          "Build the court schedule day by day with stage-specific rest gaps and overrun forecasts.",
      },
    ],
  }),
  component: SchedulePage,
});

interface DayWindow {
  date: string;
  start: string;
  end: string;
}

interface BuildTarget {
  key: string;
  day: TournamentDay;
  dayNumber: number;
  stage: StageName;
}

function stageLabel(stage: StageName) {
  return stage === "group" ? "groups" : "knockouts";
}

function stageTitle(dayNumber: number, dayCount: number) {
  const stages = stagesForDay(dayNumber, dayCount);
  if (!stages.length) return "buffer day";
  return stages.map(stageLabel).join(" + ");
}

function normalizeTime(value: string) {
  if (!value) return value;
  return value.length === 5 ? `${value}:00` : value;
}

function SchedulePage() {
  const qc = useQueryClient();
  const { canSchedule } = useSession();
  const { data: tournament } = useActiveTournament();
  const { data: days } = useTournamentDays();
  const { data: courts } = useCourts();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: poolMatches } = usePoolMatches();
  const { data: draws } = useDraws();
  const { data: drawMatches } = useDrawMatches();
  const { data: categories } = useCategories();

  const [summary, setSummary] = useState<Record<string, ScheduleSummary>>({});
  const [busy, setBusy] = useState(false);
  const [buildingKey, setBuildingKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DayWindow>>({});
  const [windowUnlocked, setWindowUnlocked] = useState(false);
  const [previewPlan, setPreviewPlan] = useState<{ plan: DayPlan; key: string } | null>(null);
  const [showAllChanges, setShowAllChanges] = useState(false);

  const tournamentDays = useMemo(() => days ?? [], [days]);
  const dayCount = tournament?.day_count ?? tournamentDays.length;
  const tournamentId = tournament?.id ?? null;

  /** A day's window is a local draft until it is applied. */
  const windowFor = (day: TournamentDay): DayWindow =>
    drafts[day.id] ?? {
      date: day.date,
      start: day.start_time.slice(0, 5),
      end: day.end_time.slice(0, 5),
    };

  const setWindow = (day: TournamentDay, patch: Partial<DayWindow>) =>
    setDrafts((prev) => ({ ...prev, [day.id]: { ...windowFor(day), ...patch } }));

  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const playerMap = useMemo(() => indexBy(players), [players]);
  const courtMap = useMemo(() => indexBy(courts), [courts]);
  const catMap = useMemo(() => indexBy(categories), [categories]);
  const drawCategory = useMemo(
    () => new Map((draws ?? []).map((d) => [d.id, d.category_id])),
    [draws],
  );
  const poolMatchMap = useMemo(() => indexBy(poolMatches), [poolMatches]);

  const label = (id: string | null) => teamLabel(id ? teamMap.get(id) : undefined, playerMap);

  const hasGroupSchedule = (poolMatches ?? []).some(
    (match) => match.status !== "void" && match.scheduled_time,
  );
  const hasKnockoutSchedule = (drawMatches ?? []).some(
    (match) => !match.is_bye && match.status !== "void" && match.scheduled_time,
  );

  const targets = useMemo<BuildTarget[]>(() => {
    const list: BuildTarget[] = [];
    for (const day of tournamentDays) {
      for (const stage of stagesForDay(day.day_number, dayCount)) {
        list.push({ key: `${day.day_number}:${stage}`, day, dayNumber: day.day_number, stage });
      }
    }
    return list;
  }, [tournamentDays, dayCount]);

  const rows = useMemo(() => {
    const groupRows = (poolMatches ?? [])
      .filter((m) => m.scheduled_time)
      .map((m) => ({
        id: m.id,
        kind: "group" as const,
        categoryCode: catMap.get(m.category_id)?.code ?? "",
        courtNumber: m.court_id ? (courtMap.get(m.court_id)?.number ?? 0) : 0,
        start: new Date(m.scheduled_time as string),
        status: m.status,
        teams: [m.team_a_id, m.team_b_id] as [string | null, string | null],
      }));
    const knockoutRows = (drawMatches ?? [])
      .filter((m) => m.scheduled_time)
      .map((m) => ({
        id: m.id,
        kind: "knockout" as const,
        categoryCode: catMap.get(drawCategory.get(m.draw_id) ?? "")?.code ?? "",
        courtNumber: m.court_id ? (courtMap.get(m.court_id)?.number ?? 0) : 0,
        start: new Date(m.scheduled_time as string),
        status: m.status,
        teams: [m.team_a_id, m.team_b_id] as [string | null, string | null],
      }));
    return [...groupRows, ...knockoutRows].sort((a, b) => a.start.getTime() - b.start.getTime());
  }, [poolMatches, drawMatches, catMap, courtMap, drawCategory]);

  const matchLabel = (matchId: string) => {
    const pool = poolMatchMap.get(matchId);
    if (pool) {
      return `${label(pool.team_a_id)} vs ${label(pool.team_b_id)}`;
    }
    const draw = (drawMatches ?? []).find((m) => m.id === matchId);
    if (draw) return `${label(draw.team_a_id)} vs ${label(draw.team_b_id)}`;
    return matchId.slice(0, 8);
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

  const refetchScheduleData = async () => {
    await qc.invalidateQueries({ queryKey: scopedKey(keys.poolMatches, tournamentId) });
    await qc.invalidateQueries({ queryKey: scopedKey(keys.drawMatches, tournamentId) });
    await qc.refetchQueries({ queryKey: scopedKey(keys.poolMatches, tournamentId) });
    await qc.refetchQueries({ queryKey: scopedKey(keys.drawMatches, tournamentId) });
    return {
      poolMatches: (qc.getQueryData<typeof poolMatches>(
        scopedKey(keys.poolMatches, tournamentId),
      ) ?? []) as NonNullable<typeof poolMatches>,
      drawMatches: (qc.getQueryData<typeof drawMatches>(
        scopedKey(keys.drawMatches, tournamentId),
      ) ?? []) as NonNullable<typeof drawMatches>,
    };
  };

  const computePlan = async (target: BuildTarget) => {
    if (!tournament) throw new Error("No active tournament is configured.");
    const window = windowFor(target.day);
    const effectiveDay: TournamentDay = {
      ...target.day,
      date: window.date,
      start_time: normalizeTime(window.start),
      end_time: normalizeTime(window.end),
    };
    const fresh = await refetchScheduleData();
    return planDay(
      target.dayNumber,
      target.stage,
      tournament,
      effectiveDay,
      courts ?? [],
      teams ?? [],
      fresh.poolMatches,
      fresh.drawMatches,
      drawCategory,
      new Map((categories ?? []).map((c) => [c.id, c.sort_order])),
    );
  };

  const finishApply = async (day: TournamentDay, plan: DayPlan) => {
    const window = windowFor(day);
    const normalized = {
      date: window.date,
      start_time: normalizeTime(window.start),
      end_time: normalizeTime(window.end),
    };
    // The schedule page owns the day window; persist edits before applying.
    if (
      normalized.date !== day.date ||
      normalized.start_time !== day.start_time ||
      normalized.end_time !== day.end_time
    ) {
      await updateTournamentDay(day.id, normalized);
    }

    const impact = await applyDayPlan(plan);
    setSummary((prev) => ({ ...prev, [`${plan.day}:${plan.stage}`]: plan.summary }));

    if (plan.stage === "group" && hasGroupSchedule) {
      toast.success(
        `Groups rebuilt — ${plan.summary.placed} matches replanned, ${plan.summary.anchorCount} anchors kept${
          impact.shiftedMatches
            ? `; ${impact.shiftedMatches} moved by up to ${impact.largestShiftMinutes} min`
            : ""
        }`,
      );
    } else {
      toast.success(
        `${plan.stage === "group" ? "Group" : "Knockout"} schedule built — ${
          plan.summary.placed
        } matches placed, ${plan.summary.anchorCount} anchors kept`,
      );
    }
    qc.invalidateQueries();
  };

  const build = async (target: BuildTarget) => {
    if (!validateWindow(target.dayNumber, windowFor(target.day))) return;
    setBusy(true);
    setBuildingKey(target.key);
    try {
      const plan = await computePlan(target);
      if (plan.blocked.length > 0) {
        setPreviewPlan({ plan, key: target.key });
        setShowAllChanges(false);
        return;
      }
      await finishApply(target.day, plan);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the schedule");
    } finally {
      setBusy(false);
      setBuildingKey(null);
    }
  };

  const previewRebuild = async (target: BuildTarget) => {
    if (!validateWindow(target.dayNumber, windowFor(target.day))) return;
    setBusy(true);
    setBuildingKey(target.key);
    try {
      const plan = await computePlan(target);
      setPreviewPlan({ plan, key: target.key });
      setShowAllChanges(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not plan the rebuild");
    } finally {
      setBusy(false);
      setBuildingKey(null);
    }
  };

  const applyPreview = async () => {
    if (!previewPlan || previewPlan.plan.blocked.length > 0) return;
    setBusy(true);
    try {
      const day = tournamentDays.find((d) => d.day_number === previewPlan.plan.day);
      if (day) await finishApply(day, previewPlan.plan);
      setPreviewPlan(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not apply the rebuild");
    } finally {
      setBusy(false);
    }
  };

  const visibleChanges = previewPlan
    ? showAllChanges
      ? previewPlan.plan.diff.changes
      : previewPlan.plan.diff.changes.filter((change) => change.kind !== "unchanged")
    : [];

  const previewDay = previewPlan
    ? tournamentDays.find((d) => d.day_number === previewPlan.plan.day)
    : undefined;
  const previewWindow = previewDay ? windowFor(previewDay) : null;

  return (
    <AppShell
      title="Court schedule"
      subtitle="Build each day of the running order, or safely rebuild the remaining group matches from the current time."
      actions={
        <span className="text-xs text-muted-foreground">
          {tournament ? `${tournament.name} · ${dayCount} day${dayCount === 1 ? "" : "s"}` : ""}
        </span>
      }
    >
      <div className="space-y-4">
        {!tournamentDays.length ? (
          <Panel title="No tournament configured">
            <EmptyState
              title="Set up a tournament first"
              hint="A tournament defines its day count, court count, and which categories are open for registration."
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
        ) : null}

        {tournamentDays.length ? (
          <div
            className={`rounded-lg border px-3 py-2.5 text-sm ${
              hasGroupSchedule
                ? "border-warn-border bg-warn-surface text-warn-foreground"
                : "border-hairline bg-surface text-muted-foreground"
            }`}
          >
            <p className="font-semibold text-foreground">
              {hasGroupSchedule ? "Group rebuild mode" : "Before the first group build"}
            </p>
            <p className="mt-0.5 text-xs">
              {hasGroupSchedule
                ? windowUnlocked
                  ? "Window editing is unlocked. Rebuilding keeps reported, walkover, and in-progress matches fixed."
                  : "Rebuilding keeps reported, walkover, and in-progress matches fixed. Day 1's window is locked once play starts; unlock only for a deliberate correction."
                : "Choose each day's window, then build. The full day window is used for schedule scoring, utilization, and overrun calculations."}
            </p>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          {tournamentDays.map((day) => {
            const window = windowFor(day);
            const dayTargets = targets.filter((target) => target.day.id === day.id);
            const locked = day.day_number === 1 && hasGroupSchedule && !windowUnlocked;
            return (
              <Panel
                key={day.id}
                title={`Day ${day.day_number} · ${stageTitle(day.day_number, dayCount)}`}
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
                      <PickerInput
                        id={`day-${day.id}-date`}
                        type="date"
                        pickerLabel={`Open the calendar for day ${day.day_number}`}
                        className="mt-1 w-36"
                        value={window.date}
                        disabled={!canSchedule || busy || locked}
                        onChange={(e) => setWindow(day, { date: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label
                        htmlFor={`day-${day.id}-start`}
                        className="text-xs text-muted-foreground"
                      >
                        Start
                      </Label>
                      <PickerInput
                        id={`day-${day.id}-start`}
                        type="time"
                        pickerLabel={`Open the start time picker for day ${day.day_number}`}
                        className="mt-1 w-28"
                        value={window.start}
                        disabled={!canSchedule || busy || locked}
                        onChange={(e) => setWindow(day, { start: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label
                        htmlFor={`day-${day.id}-end`}
                        className="text-xs text-muted-foreground"
                      >
                        End
                      </Label>
                      <PickerInput
                        id={`day-${day.id}-end`}
                        type="time"
                        pickerLabel={`Open the end time picker for day ${day.day_number}`}
                        className="mt-1 w-28"
                        value={window.end}
                        disabled={!canSchedule || busy || locked}
                        onChange={(e) => setWindow(day, { end: e.target.value })}
                      />
                    </div>
                    {locked ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setWindowUnlocked(true)}
                      >
                        Unlock window
                      </Button>
                    ) : null}
                  </div>

                  {dayTargets.length ? (
                    <div className="flex flex-wrap gap-2">
                      {dayTargets.map((target) => {
                        const isRebuild = target.stage === "group" && hasGroupSchedule;
                        const alreadyPlaced =
                          target.stage === "group" ? hasGroupSchedule : hasKnockoutSchedule;
                        return (
                          <Button
                            key={target.key}
                            size="sm"
                            variant={isRebuild ? "default" : "outline"}
                            disabled={!canSchedule || busy || !tournament || !(courts ?? []).length}
                            onClick={() =>
                              isRebuild ? void previewRebuild(target) : void build(target)
                            }
                          >
                            {buildingKey === target.key
                              ? `Building ${stageLabel(target.stage)}…`
                              : isRebuild
                                ? "Rebuild remaining groups"
                                : `${alreadyPlaced ? "Rebuild" : "Build"} ${stageLabel(target.stage)}`}
                          </Button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                      Groups run on day 1 and knockouts on the final day, so this day only gets a
                      window. Spilling the group stage across extra days is not supported yet.
                    </p>
                  )}

                  {dayTargets.map((target) => {
                    const s = summary[target.key];
                    if (!s) return null;
                    const util = Math.round(
                      (hasGroupSchedule &&
                      target.stage === "group" &&
                      s.remainingUtilization != null
                        ? s.remainingUtilization
                        : s.utilization) * 100,
                    );
                    const utilLabel =
                      hasGroupSchedule && target.stage === "group" && s.remainingUtilization != null
                        ? "remaining window"
                        : `${window.start}–${window.end} window`;
                    return (
                      <div key={target.key} className="space-y-1 text-sm">
                        <p className="font-score">
                          <span className="capitalize">{stageLabel(target.stage)}</span>: {s.placed}{" "}
                          matches placed · {s.anchorCount} anchors kept · {util}% of the {utilLabel}
                        </p>
                        {s.movedCount > 0 ? (
                          <p className="text-xs text-muted-foreground">
                            {s.movedCount} match{s.movedCount === 1 ? "" : "es"} moved
                          </p>
                        ) : null}
                        {s.projectedFinish ? (
                          <p className="text-xs text-muted-foreground">
                            Projected finish {timeLabel(s.projectedFinish)}
                            {s.overrunMinutes > 0
                              ? ` · ${s.overrunMinutes} min past ${window.end}`
                              : ""}
                          </p>
                        ) : null}
                        {util > 90 ? (
                          <p className="rounded-md bg-warn-surface px-2 py-1 text-xs text-warn-foreground">
                            Above 90% utilisation — very little buffer for overruns.
                          </p>
                        ) : null}
                        {s.unscheduled > 0 ? (
                          <p className="rounded-md bg-danger-surface px-2 py-1 text-xs text-danger-foreground">
                            {s.unscheduled} matches could not be placed — desk intervention needed.
                          </p>
                        ) : null}
                        {s.awaitingTeams > 0 ? (
                          <p className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                            {s.awaitingTeams} match{s.awaitingTeams === 1 ? "" : "es"} awaiting team
                            assignment.
                          </p>
                        ) : null}
                        {s.overrun ? (
                          <p className="rounded-md bg-danger-surface px-2 py-1 text-xs text-danger-foreground">
                            Some matches run past the planned day end.
                          </p>
                        ) : null}
                      </div>
                    );
                  })}

                  {dayTargets.length && !dayTargets.some((target) => summary[target.key]) ? (
                    <p className="text-sm text-muted-foreground">Not built in this session.</p>
                  ) : null}
                </div>
              </Panel>
            );
          })}
        </div>

        <Panel
          title="Running order"
          right={
            <span className="font-score text-t4 text-muted-foreground">
              {rows.length} scheduled
            </span>
          }
          bodyClassName={rows.length ? "p-0" : "p-4"}
        >
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing scheduled yet"
              hint="Build the group stage to place the first day's matches across the courts."
            />
          ) : (
            <div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-16">Time</th>
                    <th className="w-16">Court</th>
                    <th className="w-14">Cat</th>
                    <th className="w-24">Stage</th>
                    <th className="w-28">Status</th>
                    <th>Match</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="font-score text-xs font-semibold">{timeLabel(r.start)}</td>
                      <td>
                        <span className="inline-flex rounded-md bg-primary/10 px-1.5 py-0.5 font-score text-t4 font-semibold text-primary-ink">
                          C{r.courtNumber || "—"}
                        </span>
                      </td>
                      <td className="font-score text-xs">{r.categoryCode}</td>
                      <td className="text-xs capitalize text-muted-foreground">{r.kind}</td>
                      <td>
                        <StatusPill status={r.status} />
                      </td>
                      <td>
                        {label(r.teams[0])} <span className="text-muted-foreground">vs</span>{" "}
                        {label(r.teams[1])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Dialog open={!!previewPlan} onOpenChange={(open) => !open && setPreviewPlan(null)}>
        <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-2xl">
          {previewPlan ? (
            <>
              <DialogHeader>
                <DialogTitle>Rebuild preview</DialogTitle>
                <DialogDescription>
                  Nothing is written until you apply. Anchors stay fixed; only scheduled matches may
                  move.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 overflow-y-auto pr-1">
                <div className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm">
                  <p className="font-score">
                    {previewPlan.plan.summary.anchorCount} anchors kept ·{" "}
                    {previewPlan.plan.summary.placed} matches replanned ·{" "}
                    {previewPlan.plan.diff.movedCount} moving
                  </p>
                  {previewPlan.plan.summary.projectedFinish ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Projected finish {timeLabel(previewPlan.plan.summary.projectedFinish)}
                      {previewPlan.plan.summary.overrunMinutes > 0
                        ? ` · ${previewPlan.plan.summary.overrunMinutes} min past ${previewWindow?.end ?? "day end"}`
                        : ""}
                      {previewPlan.plan.summary.remainingUtilization != null
                        ? ` · ${Math.round(previewPlan.plan.summary.remainingUtilization * 100)}% of remaining window`
                        : ""}
                      {previewPlan.plan.summary.projectedFinishDeltaMinutes != null ? (
                        <>
                          {" · "}
                          {formatProjectedFinishDelta(
                            previewPlan.plan.summary.projectedFinishDeltaMinutes,
                          )}
                          {previewPlan.plan.summary.currentProjectedFinish
                            ? ` (current ${timeLabel(previewPlan.plan.summary.currentProjectedFinish)})`
                            : ""}
                        </>
                      ) : null}
                    </p>
                  ) : null}
                </div>

                {previewPlan.plan.blocked.length > 0 ? (
                  <div className="rounded-md bg-danger-surface px-3 py-2 text-sm text-danger-foreground">
                    <p className="font-semibold">
                      {previewPlan.plan.blocked.length} match
                      {previewPlan.plan.blocked.length === 1 ? "" : "es"} could not be placed.
                    </p>
                    {previewPlan.plan.summary.diagnostics?.deadlockReason ? (
                      <p className="mt-1 text-xs">
                        {previewPlan.plan.summary.diagnostics.deadlockReason}
                      </p>
                    ) : null}
                    <ul className="mt-2 space-y-1 text-xs">
                      {previewPlan.plan.blocked.map((matchId) => (
                        <li key={matchId}>{matchLabel(matchId)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {previewPlan.plan.awaitingTeams.length > 0 ? (
                  <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                    {previewPlan.plan.awaitingTeams.length} match
                    {previewPlan.plan.awaitingTeams.length === 1 ? "" : "es"} awaiting team
                    assignment and will stay unscheduled.
                  </div>
                ) : null}

                {previewPlan.plan.blocked.length === 0 ? (
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
                <Button variant="outline" disabled={busy} onClick={() => setPreviewPlan(null)}>
                  Keep current schedule
                </Button>
                <Button
                  disabled={busy || previewPlan.plan.blocked.length > 0}
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
