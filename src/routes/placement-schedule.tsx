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
import { updateTournamentDay } from "@/lib/tournament/actions";
import {
  indexBy,
  keys,
  placementStagesForDay,
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
  useTournamentScope,
  type PlacementMatch,
  type PlacementStageName,
  type TierDrawMatch,
  type TournamentDay,
} from "@/lib/tournament/data";
import { timeLabel } from "@/lib/tournament/format";
import {
  applyPlacementDayPlan,
  placementMatchLabel,
  placementStageLabel,
  planPlacementDay,
  type PlacementDayPlan,
} from "@/lib/tournament/placement-schedule";
import { formatProjectedFinishDelta } from "@/lib/tournament/schedule-diff";

export const Route = createFileRoute("/placement-schedule")({
  head: () => ({
    meta: [
      { title: "Court Schedule | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content:
          "Lay out the placement rounds and the A/B/C/D knockouts across the courts, day by day, with stage-specific durations and rest gaps.",
      },
      { property: "og:title", content: "Court Schedule | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content:
          "Lay out the placement rounds and the A/B/C/D knockouts across the courts, day by day, with stage-specific durations and rest gaps.",
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
 * The layout: one panel per day, each carrying its window and the stages that
 * belong to that day. Placement runs on day one, the knockouts on the final day,
 * and a middle day is a buffer with a window but nothing to build.
 */

interface DayWindow {
  date: string;
  start: string;
  end: string;
}

interface BuildTarget {
  key: string;
  day: TournamentDay;
  dayNumber: number;
  stage: PlacementStageName;
}

function normalizeTime(value: string) {
  if (!value) return value;
  return value.length === 5 ? `${value}:00` : value;
}

function stageTitle(dayNumber: number, dayCount: number) {
  const stages = placementStagesForDay(dayNumber, dayCount);
  if (!stages.length) return "buffer day";
  return stages.map(placementStageLabel).join(" + ");
}

function PlacementSchedulePage() {
  const qc = useQueryClient();
  const { canSchedule } = useSession();
  const { tournament, days, loading } = useTournamentScope();
  const { data: courts } = useCourts();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: categories } = useCategories();
  const { data: entrants } = usePlacementEntrants();
  const { data: placementMatches } = usePlacementMatches();
  const { data: draws } = useTierDraws();
  const { data: tierMatches } = useTierDrawMatches();

  const [drafts, setDrafts] = useState<Record<string, DayWindow>>({});
  const [summaries, setSummaries] = useState<Record<string, PlacementDayPlan["summary"]>>({});
  const [preview, setPreview] = useState<{ plan: PlacementDayPlan; key: string } | null>(null);
  const [showAllChanges, setShowAllChanges] = useState(false);
  const [windowsUnlocked, setWindowsUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [buildingKey, setBuildingKey] = useState<string | null>(null);

  const tournamentDays = useMemo(() => days ?? [], [days]);
  const dayCount = tournament?.day_count ?? tournamentDays.length;
  const tournamentId = tournament?.id ?? null;

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

  const targets = useMemo<BuildTarget[]>(() => {
    const list: BuildTarget[] = [];
    for (const day of tournamentDays) {
      for (const stage of placementStagesForDay(day.day_number, dayCount)) {
        list.push({ key: `${day.day_number}:${stage}`, day, dayNumber: day.day_number, stage });
      }
    }
    return list;
  }, [tournamentDays, dayCount]);

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
   * Planning always re-reads the two match tables first.
   *
   * A plan is only safe against current rows: the anchors are the reported and
   * in-progress matches, so planning from a cached copy would happily move a match
   * that has just been finished on court. The refetch is scoped to this
   * tournament, so it is two small queries.
   */
  const freshMatches = async () => {
    const placementKey = scopedKey(keys.placementMatches, tournamentId);
    const tierKey = scopedKey(keys.tierDrawMatches, tournamentId);
    await qc.invalidateQueries({ queryKey: placementKey });
    await qc.invalidateQueries({ queryKey: tierKey });
    await qc.refetchQueries({ queryKey: placementKey });
    await qc.refetchQueries({ queryKey: tierKey });
    return {
      placementMatches: qc.getQueryData<PlacementMatch[]>(placementKey) ?? [],
      tierMatches: qc.getQueryData<TierDrawMatch[]>(tierKey) ?? [],
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
    const fresh = await freshMatches();
    return planPlacementDay({
      day: target.dayNumber,
      stage: target.stage,
      tournament,
      dayConfig: effectiveDay,
      courts: courts ?? [],
      teams: teams ?? [],
      entrants: entrants ?? [],
      draws: draws ?? [],
      placementMatches: fresh.placementMatches,
      tierMatches: fresh.tierMatches,
      categoryOrder: new Map((categories ?? []).map((c) => [c.id, c.sort_order])),
    });
  };

  const finishApply = async (day: TournamentDay, plan: PlacementDayPlan) => {
    const window = windowFor(day);
    const normalized = {
      date: window.date,
      start_time: normalizeTime(window.start),
      end_time: normalizeTime(window.end),
    };
    // The schedule page owns the day window, so persist an edit before applying.
    if (
      normalized.date !== day.date ||
      normalized.start_time !== day.start_time ||
      normalized.end_time !== day.end_time
    ) {
      await updateTournamentDay(day.id, normalized);
    }
    await applyPlacementDayPlan(plan);
    setSummaries((prev) => ({ ...prev, [`${plan.day}:${plan.stage}`]: plan.summary }));
    toast.success(
      `${placementStageLabel(plan.stage)} schedule built — ${plan.summary.placed} matches placed, ` +
        `${plan.summary.anchorCount} anchors kept`,
    );
    await qc.invalidateQueries();
  };

  const build = async (target: BuildTarget) => {
    if (!validateWindow(target.dayNumber, windowFor(target.day))) return;
    setBusy(true);
    setBuildingKey(target.key);
    try {
      const plan = await computePlan(target);
      if (plan.blocked.length > 0) {
        setPreview({ plan, key: target.key });
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
      setPreview({ plan, key: target.key });
      setShowAllChanges(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not plan the rebuild");
    } finally {
      setBusy(false);
      setBuildingKey(null);
    }
  };

  const applyPreview = async () => {
    if (!preview || preview.plan.blocked.length > 0) return;
    setBusy(true);
    try {
      const day = tournamentDays.find((d) => d.day_number === preview.plan.day);
      if (day) await finishApply(day, preview.plan);
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

  const previewDay = preview
    ? tournamentDays.find((d) => d.day_number === preview.plan.day)
    : undefined;
  const previewWindow = previewDay ? windowFor(previewDay) : null;

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
            placementScheduled || knockoutScheduled
              ? "border-warn-border bg-warn-surface text-warn-foreground"
              : "border-hairline bg-surface text-muted-foreground"
          }`}
        >
          <p className="font-semibold text-foreground">
            {placementScheduled || knockoutScheduled ? "Rebuild mode" : "Before the first build"}
          </p>
          <p className="mt-0.5 text-xs">
            {placementScheduled || knockoutScheduled
              ? "A rebuild plans from the current time and keeps reported, walkover and in-progress matches exactly where they are."
              : "Choose each day's window, then build. The window is what utilisation and the overrun forecast are measured against."}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {tournamentDays.map((day) => {
            const window = windowFor(day);
            const dayTargets = targets.filter((target) => target.day.id === day.id);
            const locked = day.day_number === 1 && placementScheduled && !windowsUnlocked;
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
                      <Input
                        id={`day-${day.id}-date`}
                        type="date"
                        className="mt-1 h-9 w-36"
                        value={window.date}
                        disabled={!canSchedule || busy || locked}
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
                        disabled={!canSchedule || busy || locked}
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
                        disabled={!canSchedule || busy || locked}
                        onChange={(event) => setWindow(day, { end: event.target.value })}
                      />
                    </div>
                    {locked ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setWindowsUnlocked(true)}
                      >
                        Unlock window
                      </Button>
                    ) : null}
                  </div>

                  {dayTargets.length ? (
                    <div className="flex flex-wrap gap-2">
                      {dayTargets.map((target) => {
                        const isRebuild =
                          target.stage === "placement" ? placementScheduled : knockoutScheduled;
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
                              ? `Building ${placementStageLabel(target.stage)}…`
                              : `${isRebuild ? "Rebuild" : "Build"} ${placementStageLabel(target.stage)}`}
                          </Button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                      Placement runs on day one and the knockouts on the final day, so this day only
                      gets a window. Spilling a stage across extra days is not supported yet.
                    </p>
                  )}

                  {!dayTargets.length || (courts ?? []).length ? null : (
                    <p className="rounded-md bg-danger-surface px-2 py-1 text-xs text-danger-foreground">
                      No courts are configured, so there is nothing to schedule onto.
                    </p>
                  )}

                  {dayTargets.map((target) => {
                    const summary = summaries[target.key];
                    if (!summary) return null;
                    const utilization = Math.round(
                      (summary.remainingUtilization ?? summary.utilization) * 100,
                    );
                    return (
                      <div key={target.key} className="space-y-1 text-sm">
                        <p className="font-score">
                          <span className="capitalize">{placementStageLabel(target.stage)}</span>:{" "}
                          {summary.placed} matches placed · {summary.anchorCount} anchors kept ·{" "}
                          {utilization}% of the {window.start}–{window.end} window
                        </p>
                        {summary.movedCount > 0 ? (
                          <p className="text-xs text-muted-foreground">
                            {summary.movedCount} match{summary.movedCount === 1 ? "" : "es"} moved
                          </p>
                        ) : null}
                        {summary.projectedFinish ? (
                          <p className="text-xs text-muted-foreground">
                            Projected finish {timeLabel(summary.projectedFinish)}
                            {summary.overrunMinutes > 0
                              ? ` · ${summary.overrunMinutes} min past ${window.end}`
                              : ""}
                          </p>
                        ) : null}
                        {summary.awaitingTeams > 0 ? (
                          <p className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                            {summary.awaitingTeams} match
                            {summary.awaitingTeams === 1 ? "" : "es"} waiting on a bracket that has
                            not been decided yet.
                          </p>
                        ) : null}
                        {summary.unscheduled > 0 ? (
                          <p className="rounded-md bg-danger-surface px-2 py-1 text-xs text-danger-foreground">
                            {summary.unscheduled} match
                            {summary.unscheduled === 1 ? "" : "es"} could not be placed — desk
                            intervention needed.
                          </p>
                        ) : null}
                      </div>
                    );
                  })}

                  {dayTargets.length && !dayTargets.some((target) => summaries[target.key]) ? (
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
                        ? ` · ${preview.plan.summary.overrunMinutes} min past ${
                            previewWindow?.end ?? "day end"
                          }`
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
