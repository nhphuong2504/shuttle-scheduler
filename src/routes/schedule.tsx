import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell, Panel, StatusPill } from "@/components/app-shell";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/hooks/useSession";
import { scheduleDay, updateSettings, type ScheduleSummary } from "@/lib/tournament/actions";
import {
  indexBy,
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
  const [confirmRebuild, setConfirmRebuild] = useState(false);

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

  const label = (id: string | null) => teamLabel(id ? teamMap.get(id) : undefined, playerMap);
  const hasDay1Schedule = (poolMatches ?? []).some(
    (match) => match.status !== "void" && match.scheduled_time,
  );

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

  const build = async (day: 1 | 2) => {
    if (!settings) return;
    if (day === 1) {
      const validDate = /^\d{4}-\d{2}-\d{2}$/.test(day1Date);
      const validTimes = /^\d{2}:\d{2}$/.test(startTime) && /^\d{2}:\d{2}$/.test(endTime);
      if (!validDate || !validTimes) {
        toast.error("Choose a valid Day 1 date, start time, and end time.");
        return;
      }
      if (
        new Date(`${day1Date}T${endTime}`).getTime() <=
        new Date(`${day1Date}T${startTime}`).getTime()
      ) {
        toast.error("Day 1 end time must be later than its start time.");
        return;
      }
    }
    setBusy(true);
    setBuildingDay(day);
    try {
      let effectiveSettings = settings;
      if (day === 1) {
        const normalizedStart = `${startTime}:00`;
        const normalizedEnd = `${endTime}:00`;
        effectiveSettings = {
          ...settings,
          day_1: day1Date,
          day_start_time: normalizedStart,
          day_end_time: normalizedEnd,
          planning_end_time: normalizedEnd,
        };
        if (
          day1Date !== settings.day_1 ||
          normalizedStart !== settings.day_start_time ||
          normalizedEnd !== settings.planning_end_time ||
          normalizedEnd !== settings.day_end_time
        ) {
          await updateSettings(settings.id, {
            day_1: day1Date,
            day_start_time: normalizedStart,
            day_end_time: normalizedEnd,
            planning_end_time: normalizedEnd,
          });
        }
      }
      const result = await scheduleDay(
        day,
        effectiveSettings,
        courts ?? [],
        teams ?? [],
        poolMatches ?? [],
        drawMatches ?? [],
        drawCategory,
        new Map((categories ?? []).map((c) => [c.id, c.sort_order])),
      );
      setSummary((prev) => ({ ...prev, [day]: result }));
      toast.success(
        day === 1 && hasDay1Schedule
          ? `Day 1 rebuilt — ${result.placed} matches placed; active and completed matches preserved`
          : `Day ${day} schedule built — ${result.placed} matches placed`,
      );
      qc.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the schedule");
    } finally {
      setBusy(false);
      setBuildingDay(null);
    }
  };

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
              disabled={!canSchedule || busy}
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
              disabled={!canSchedule || busy}
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
              disabled={!canSchedule || busy}
              onChange={(e) => {
                setEndTime(e.target.value);
                setWindowTouched(true);
              }}
            />
          </div>
          <Button
            disabled={!canSchedule || busy || !settings || !(courts ?? []).length}
            onClick={() => {
              if (hasDay1Schedule) setConfirmRebuild(true);
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
              ? "Rebuilding keeps reported, walkover, and in-progress matches fixed. All other group matches may move to new courts or times, but never into the past."
              : `The first build uses ${day1Date || "the selected day"}, ${startTime || "start"}–${endTime || "end"}. This full window is used for schedule scoring, utilization, and overrun calculations.`}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {[1, 2].map((day) => {
            const s = summary[day];
            const util = s ? Math.round(s.utilization * 100) : null;
            return (
              <Panel key={day} title={`Day ${day} ${day === 1 ? "groups" : "knockouts"}`}>
                {s ? (
                  <div className="space-y-1 text-sm">
                    <p className="font-score">
                      {s.placed} matches placed · {util}% of the {startTime}–{endTime} window
                    </p>
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
                        {s.unscheduled} matches could not be placed inside the day — desk
                        intervention needed.
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

        <Panel title="Running order">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing scheduled yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="pb-1">Time</th>
                  <th className="pb-1">Court</th>
                  <th className="pb-1">Cat</th>
                  <th className="pb-1">Stage</th>
                  <th className="pb-1">Status</th>
                  <th className="pb-1">Match</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5 font-score text-xs">{timeLabel(r.start)}</td>
                    <td className="py-1.5 font-score text-xs">C{r.courtNumber || "—"}</td>
                    <td className="py-1.5 font-score text-xs">{r.categoryCode}</td>
                    <td className="py-1.5 text-xs text-muted-foreground">{r.kind}</td>
                    <td className="py-1.5">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="py-1.5">
                      {label(r.teams[0])} <span className="text-muted-foreground">vs</span>{" "}
                      {label(r.teams[1])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <AlertDialog open={confirmRebuild} onOpenChange={setConfirmRebuild}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild the remaining Day 1 schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              Reported, walkover, and in-progress matches will remain fixed. Every other group match
              may receive a new court or time, starting no earlier than the current time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current schedule</AlertDialogCancel>
            <AlertDialogAction onClick={() => void build(1)}>
              Rebuild remaining matches
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}
