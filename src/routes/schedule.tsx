import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell, Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { scheduleDay, type ScheduleSummary } from "@/lib/tournament/actions";
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
import { findRestGapViolations } from "@/lib/tournament/scheduler";

export const Route = createFileRoute("/schedule")({
  head: () => ({
    meta: [
      { title: "Court Schedule | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content: "Build the two-day court schedule with a 30-minute player rest gap and court utilisation alerts.",
      },
      { property: "og:title", content: "Court Schedule | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content: "Build the two-day court schedule with a 30-minute player rest gap and court utilisation alerts.",
      },
    ],
  }),
  component: SchedulePage,
});

function SchedulePage() {
  const qc = useQueryClient();
  const { signedIn } = useSession();
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

  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const playerMap = useMemo(() => indexBy(players), [players]);
  const courtMap = useMemo(() => indexBy(courts), [courts]);
  const catMap = useMemo(() => indexBy(categories), [categories]);
  const drawCategory = useMemo(
    () => new Map((draws ?? []).map((d) => [d.id, d.category_id])),
    [draws],
  );

  const label = (id: string | null) => teamLabel(id ? teamMap.get(id) : undefined, playerMap);

  const playersOf = (a: string | null, b: string | null) => {
    const ids: string[] = [];
    for (const id of [a, b]) {
      const team = id ? teamMap.get(id) : undefined;
      if (!team) continue;
      ids.push(team.player_1_id);
      if (team.player_2_id) ids.push(team.player_2_id);
    }
    return ids;
  };

  const slotMinutes = (kind: "group" | "knockout") =>
    kind === "group" ? (settings?.group_slot_minutes ?? 15) : (settings?.knockout_slot_minutes ?? 25);

  const rows = useMemo(() => {
    const groupRows = (poolMatches ?? [])
      .filter((m) => m.scheduled_time)
      .map((m) => ({
        id: m.id,
        kind: "group" as const,
        categoryCode: catMap.get(m.category_id)?.code ?? "",
        courtNumber: m.court_id ? (courtMap.get(m.court_id)?.number ?? 0) : 0,
        start: new Date(m.scheduled_time as string),
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
        teams: [m.team_a_id, m.team_b_id] as [string | null, string | null],
      }));
    return [...groupRows, ...knockoutRows].sort((a, b) => a.start.getTime() - b.start.getTime());
  }, [poolMatches, drawMatches, catMap, courtMap, drawCategory]);

  const violations = useMemo(
    () =>
      findRestGapViolations(
        rows.map((r) => ({
          matchId: r.id,
          playerIds: playersOf(r.teams[0], r.teams[1]),
          start: r.start,
          end: new Date(r.start.getTime() + slotMinutes(r.kind) * 60000),
        })),
        settings?.rest_gap_minutes ?? 30,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, settings, teamMap],
  );

  const build = async (day: 1 | 2) => {
    if (!settings) return;
    setBusy(true);
    try {
      const result = await scheduleDay(
        day,
        settings,
        courts ?? [],
        teams ?? [],
        poolMatches ?? [],
        drawMatches ?? [],
        drawCategory,
      );
      setSummary((prev) => ({ ...prev, [day]: result }));
      toast.success(`Day ${day} schedule built — ${result.placed} matches placed`);
      qc.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the schedule");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell
      title="Court schedule"
      subtitle="Day 1 is group stage only, day 2 is knockouts only. Every player keeps a 30-minute gap between matches."
      actions={
        <>
          <Button disabled={!signedIn || busy} onClick={() => build(1)}>
            Build day 1 (groups)
          </Button>
          <Button variant="outline" disabled={!signedIn || busy} onClick={() => build(2)}>
            Build day 2 (knockouts)
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {[1, 2].map((day) => {
            const s = summary[day];
            const util = s ? Math.round(s.utilization * 100) : null;
            return (
              <Panel key={day} title={`Day ${day} ${day === 1 ? "groups" : "knockouts"}`}>
                {s ? (
                  <div className="space-y-1 text-sm">
                    <p className="font-score">
                      {s.placed} matches placed · {util}% court utilisation
                    </p>
                    {util != null && util > 90 ? (
                      <p className="rounded-md bg-warn-surface px-2 py-1 text-xs text-warn-foreground">
                        Above 90% utilisation — very little buffer for overruns.
                      </p>
                    ) : null}
                    {s.unscheduled > 0 ? (
                      <p className="rounded-md bg-danger-surface px-2 py-1 text-xs text-danger-foreground">
                        {s.unscheduled} matches could not be placed inside the day — desk intervention needed.
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

        {violations.length ? (
          <Panel title="Rest-gap breaches">
            <ul className="space-y-1 text-sm">
              {violations.slice(0, 20).map((v, i) => (
                <li key={i} className="text-danger-foreground">
                  {playerMap.get(v.playerId)?.name ?? "Player"} has only {v.gapMinutes} minutes between two matches.
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

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
                      {label(r.teams[0])} <span className="text-muted-foreground">vs</span> {label(r.teams[1])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}
