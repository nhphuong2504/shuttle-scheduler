import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
  applyDayPlan,
  planDay,
  type DayPlan,
  type ScheduleSummary,
} from "@/lib/tournament/actions";
import {
  indexBy,
  keys,
  teamLabel,
  useCategories,
  useCourts,
  useDrawMatches,
  useDraws,
  usePlayers,
  usePoolMatches,
  useSettings,
  useTeams,
} from "@/lib/tournament/data";
import { timeLabel } from "@/lib/tournament/format";

export const Route = createFileRoute("/schedule")({
  head: () => ({
    meta: [
      { title: "Court Schedule | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content:
          "Build the two-day court schedule with stage-specific rest gaps and overrun forecasts.",
      },
      { property: "og:title", content: "Court Schedule | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content:
          "Build the two-day court schedule with stage-specific rest gaps and overrun forecasts.",
      },
    ],
  }),
  component: SchedulePage,
});

function SchedulePage() {
  const qc = useQueryClient();
  const { canSchedule } = useSession();
  const { data: settings } = useSettings();
  const { data: courts } = useCourts();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: poolMatches } = usePoolMatches();
  const { data: draws } = useDraws();
  const { data: drawMatches } = useDrawMatches();
  const { data: categories } = useCategories();

  const [summary, setSummary] = useState<Record<number, ScheduleSummary>>({});
  const [busy, setBusy] = useState(false);
  const [buildingDay, setBuildingDay] = useState<1 | 2 | null>(null);
  const [day1Date, setDay1Date] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [windowTouched, setWindowTouched] = useState(false);
  const [windowUnlocked, setWindowUnlocked] = useState(false);
  const [previewPlan, setPreviewPlan] = useState<DayPlan | null>(null);
  const [showAllChanges, setShowAllChanges] = useState(false);

  useEffect(() => {
    if (!windowTouched && settings) {
      setDay1Date(settings.day_1);
      setStartTime(settings.day_start_time.slice(0, 5));
      setEndTime((settings.planning_end_time || settings.day_end_time).slice(0, 5));
    }
  }, [settings, windowTouched]);

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
  const hasDay1Schedule = (poolMatches ?? []).some(
    (match) => match.status !== "void" && match.scheduled_time,
  );
  const windowLocked = hasDay1Schedule && !windowUnlocked;

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

  const validateDay1Window = () => {
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(day1Date);
    const validTimes = /^\d{2}:\d{2}$/.test(startTime) && /^\d{2}:\d{2}$/.test(endTime);
    if (!validDate || !validTimes) {
      toast.error("Choose a valid Day 1 date, start time, and end time.");
      return false;
    }
    if (
      new Date(`${day1Date}T${endTime}`).getTime() <=
      new Date(`${day1Date}T${startTime}`).getTime()
    ) {
      toast.error("Day 1 end time must be later than its start time.");
      return false;
    }
    return true;
  };

  const day1SettingsPatch = () => {
    if (!settings) return null;
    const normalizedStart = `${startTime}:00`;
    const normalizedEnd = `${endTime}:00`;
    if (
      day1Date === settings.day_1 &&
      normalizedStart === settings.day_start_time &&
      normalizedEnd === settings.planning_end_time &&
      normalizedEnd === settings.day_end_time
    ) {
      return null;
    }
    return {
      day_1: day1Date,
      day_start_time: normalizedStart,
      day_end_time: normalizedEnd,
      planning_end_time: normalizedEnd,
    };
  };

  const effectiveDay1Settings = () => {
    if (!settings) throw new Error("Settings are not loaded.");
    const patch = day1SettingsPatch();
    return patch ? { ...settings, ...patch } : settings;
  };

  const refetchScheduleData = async () => {
    await qc.invalidateQueries({ queryKey: keys.poolMatches });
    await qc.invalidateQueries({ queryKey: keys.drawMatches });
    await qc.refetchQueries({ queryKey: keys.poolMatches });
    await qc.refetchQueries({ queryKey: keys.drawMatches });
    return {
      poolMatches: (qc.getQueryData<typeof poolMatches>(keys.poolMatches) ?? []) as NonNullable<
        typeof poolMatches
      >,
      drawMatches: (qc.getQueryData<typeof drawMatches>(keys.drawMatches) ?? []) as NonNullable<
        typeof drawMatches
      >,
    };
  };

  const computePlan = async (day: 1 | 2) => {
    if (!settings) throw new Error("Settings are not loaded.");
    const fresh = await refetchScheduleData();
    const effectiveSettings = day === 1 ? effectiveDay1Settings() : settings;
    return planDay(
      day,
      effectiveSettings,
      courts ?? [],
      teams ?? [],
      fresh.poolMatches,
      fresh.drawMatches,
      drawCategory,
      new Map((categories ?? []).map((c) => [c.id, c.sort_order])),
      undefined,
      day === 1 ? day1SettingsPatch() : null,
    );
  };

  const finishApply = async (day: 1 | 2, plan: DayPlan) => {
    const impact = await applyDayPlan(plan);
    setSummary((prev) => ({ ...prev, [day]: plan.summary }));
    if (day === 1 && hasDay1Schedule) {
      toast.success(
        `Day 1 rebuilt — ${plan.summary.placed} matches replanned, ${plan.summary.anchorCount} anchors kept${
          impact.shiftedMatches
            ? `; ${impact.shiftedMatches} moved by up to ${impact.largestShiftMinutes} min`
            : ""
        }`,
      );
    } else {
      toast.success(
        `Day ${day} schedule built — ${plan.summary.placed} matches placed, ${plan.summary.anchorCount} anchors kept`,
      );
    }
    qc.invalidateQueries();
  };

  const build = async (day: 1 | 2) => {
    if (!settings) return;
    if (day === 1 && !validateDay1Window()) return;
    setBusy(true);
    setBuildingDay(day);
    try {
      const plan = await computePlan(day);
      if (plan.blocked.length > 0) {
        setPreviewPlan(plan);
        setShowAllChanges(false);
        return;
      }
      await finishApply(day, plan);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the schedule");
    } finally {
      setBusy(false);
      setBuildingDay(null);
    }
  };

  const previewRebuild = async () => {
    if (!settings || !validateDay1Window()) return;
    setBusy(true);
    setBuildingDay(1);
    try {
      const plan = await computePlan(1);
      setPreviewPlan(plan);
      setShowAllChanges(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not plan the rebuild");
    } finally {
      setBusy(false);
      setBuildingDay(null);
    }
  };

  const applyPreview = async () => {
    if (!previewPlan || previewPlan.blocked.length > 0) return;
    setBusy(true);
    try {
      await finishApply(previewPlan.day, previewPlan);
      setPreviewPlan(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not apply the rebuild");
    } finally {
      setBusy(false);
    }
  };

  const visibleChanges = previewPlan
    ? showAllChanges
      ? previewPlan.diff.changes
      : previewPlan.diff.changes.filter((change) => change.kind !== "unchanged")
    : [];

  return (
    <AppShell
      title="Court schedule"
      subtitle="Build the initial running order before play, or safely rebuild the remaining Day 1 matches from the current time."
      actions={
        <>
          <div className="flex items-center gap-1.5">
            <Label htmlFor="day-1-date" className="text-xs text-muted-foreground">
              Day 1
            </Label>
            <Input
              id="day-1-date"
              type="date"
              className="h-9 w-36"
              value={day1Date}
              disabled={!canSchedule || busy || windowLocked}
              onChange={(e) => {
                setDay1Date(e.target.value);
                setWindowTouched(true);
              }}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Label htmlFor="day-1-start-time" className="text-xs text-muted-foreground">
              Start
            </Label>
            <Input
              id="day-1-start-time"
              type="time"
              className="h-9 w-28"
              value={startTime}
              disabled={!canSchedule || busy || windowLocked}
              onChange={(e) => {
                setStartTime(e.target.value);
                setWindowTouched(true);
              }}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Label htmlFor="day-1-end-time" className="text-xs text-muted-foreground">
              End
            </Label>
            <Input
              id="day-1-end-time"
              type="time"
              className="h-9 w-28"
              value={endTime}
              disabled={!canSchedule || busy || windowLocked}
              onChange={(e) => {
                setEndTime(e.target.value);
                setWindowTouched(true);
              }}
            />
          </div>
          {windowLocked ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setWindowUnlocked(true)}
            >
              Unlock window
            </Button>
          ) : null}
          <Button
            disabled={!canSchedule || busy || !settings || !(courts ?? []).length}
            onClick={() => {
              if (hasDay1Schedule) void previewRebuild();
              else void build(1);
            }}
          >
            {buildingDay === 1
              ? "Building Day 1…"
              : hasDay1Schedule
                ? "Rebuild remaining Day 1"
                : "Build day 1"}
          </Button>
          <Button
            variant="outline"
            disabled={!canSchedule || busy || !settings || !(courts ?? []).length}
            onClick={() => build(2)}
          >
            {buildingDay === 2 ? "Building Day 2…" : "Build day 2 (knockouts)"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div
          className={`rounded-lg border px-3 py-2.5 text-sm ${
            hasDay1Schedule
              ? "border-warn-border bg-warn-surface text-warn-foreground"
              : "border-hairline bg-surface text-muted-foreground"
          }`}
        >
          <p className="font-semibold text-foreground">
            {hasDay1Schedule ? "Day 1 rebuild mode" : "Before the first Day 1 build"}
          </p>
          <p className="mt-0.5 text-xs">
            {hasDay1Schedule
              ? windowLocked
                ? "Rebuilding keeps reported, walkover, and in-progress matches fixed. The day window is locked once play starts; unlock only for a deliberate correction."
                : "Window editing is unlocked. Rebuilding keeps reported, walkover, and in-progress matches fixed."
              : `The first build uses ${day1Date || "the selected day"}, ${startTime || "start"}–${endTime || "end"}. This full window is used for schedule scoring, utilization, and overrun calculations.`}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {[1, 2].map((day) => {
            const s = summary[day];
            const util = s
              ? Math.round(
                  (hasDay1Schedule && day === 1 && s.remainingUtilization != null
                    ? s.remainingUtilization
                    : s.utilization) * 100,
                )
              : null;
            const utilLabel =
              hasDay1Schedule && day === 1 && s?.remainingUtilization != null
                ? "remaining window"
                : `${startTime}–${endTime} window`;
            return (
              <Panel key={day} title={`Day ${day} ${day === 1 ? "groups" : "knockouts"}`}>
                {s ? (
                  <div className="space-y-1 text-sm">
                    <p className="font-score">
                      {s.placed} matches placed · {s.anchorCount} anchors kept · {util}% of the{" "}
                      {utilLabel}
                    </p>
                    {s.movedCount > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {s.movedCount} match{s.movedCount === 1 ? "" : "es"} moved
                      </p>
                    ) : null}
                    {s.projectedFinish ? (
                      <p className="text-xs text-muted-foreground">
                        Projected finish {timeLabel(s.projectedFinish)}
                        {s.overrunMinutes > 0 ? ` · ${s.overrunMinutes} min past ${endTime}` : ""}
                      </p>
                    ) : null}
                    {util != null && util > 90 ? (
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
                ) : (
                  <p className="text-sm text-muted-foreground">Not built in this session.</p>
                )}
              </Panel>
            );
          })}
        </div>

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
              hint="Build Day 1 to place the group matches across the courts."
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
                        <span className="inline-flex rounded-md bg-primary/10 px-1.5 py-0.5 font-score text-[11px] font-semibold text-primary">
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
                  Nothing is written until you apply. Anchors stay fixed; only scheduled matches
                  may move.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 overflow-y-auto pr-1">
                <div className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm">
                  <p className="font-score">
                    {previewPlan.summary.anchorCount} anchors kept · {previewPlan.summary.placed}{" "}
                    matches replanned · {previewPlan.diff.movedCount} moving
                  </p>
                  {previewPlan.summary.projectedFinish ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Projected finish {timeLabel(previewPlan.summary.projectedFinish)}
                      {previewPlan.summary.overrunMinutes > 0
                        ? ` · ${previewPlan.summary.overrunMinutes} min past ${endTime}`
                        : ""}
                      {previewPlan.summary.remainingUtilization != null
                        ? ` · ${Math.round(previewPlan.summary.remainingUtilization * 100)}% of remaining window`
                        : ""}
                    </p>
                  ) : null}
                </div>

                {previewPlan.blocked.length > 0 ? (
                  <div className="rounded-md bg-danger-surface px-3 py-2 text-sm text-danger-foreground">
                    <p className="font-semibold">
                      {previewPlan.blocked.length} match
                      {previewPlan.blocked.length === 1 ? "" : "es"} could not be placed.
                    </p>
                    {previewPlan.summary.diagnostics?.deadlockReason ? (
                      <p className="mt-1 text-xs">{previewPlan.summary.diagnostics.deadlockReason}</p>
                    ) : null}
                    <ul className="mt-2 space-y-1 text-xs">
                      {previewPlan.blocked.map((matchId) => (
                        <li key={matchId}>{matchLabel(matchId)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {previewPlan.awaitingTeams.length > 0 ? (
                  <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                    {previewPlan.awaitingTeams.length} match
                    {previewPlan.awaitingTeams.length === 1 ? "" : "es"} awaiting team assignment
                    and will stay unscheduled.
                  </div>
                ) : null}

                {previewPlan.blocked.length === 0 ? (
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
                  disabled={busy || previewPlan.blocked.length > 0}
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
