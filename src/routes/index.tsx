import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { AppShell, Panel, StatusPill } from "@/components/app-shell";
import {
  indexBy,
  teamLabel,
  useCategories,
  useCourts,
  useDrawMatches,
  useDraws,
  usePlayers,
  usePoolMatches,
  usePools,
  useTeams,
} from "@/lib/tournament/data";
import { minutesSince, timeLabel } from "@/lib/tournament/format";
import { poolIsComplete } from "@/lib/tournament/standings";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ShuttleNet Control Desk | Live Badminton Tournament Ops" },
      {
        name: "description",
        content:
          "Live control desk for a two-day, four-category badminton tournament: court board, pool progress, draw readiness and alerts.",
      },
      { property: "og:title", content: "ShuttleNet Control Desk | Live Badminton Tournament Ops" },
      {
        property: "og:description",
        content:
          "Live control desk for a two-day, four-category badminton tournament: court board, pool progress, draw readiness and alerts.",
      },
    ],
  }),
  component: Desk,
});

function Desk() {
  const { data: categories } = useCategories();
  const { data: courts } = useCourts();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: pools } = usePools();
  const { data: poolMatches } = usePoolMatches();
  const { data: draws } = useDraws();
  const { data: drawMatches } = useDrawMatches();

  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const playerMap = useMemo(() => indexBy(players), [players]);
  const catMap = useMemo(() => indexBy(categories), [categories]);
  const label = (id: string | null) => teamLabel(id ? teamMap.get(id) : undefined, playerMap);

  const allMatches = useMemo(
    () => [
      ...(poolMatches ?? []).map((m) => ({
        id: m.id,
        courtId: m.court_id,
        status: m.status,
        startedAt: m.started_at,
        scheduled: m.scheduled_time,
        teams: [m.team_a_id, m.team_b_id] as [string | null, string | null],
        tag: catMap.get(m.category_id)?.code ?? "",
      })),
      ...(drawMatches ?? []).map((m) => ({
        id: m.id,
        courtId: m.court_id,
        status: m.status,
        startedAt: m.started_at,
        scheduled: m.scheduled_time,
        teams: [m.team_a_id, m.team_b_id] as [string | null, string | null],
        tag: `Draw ${(draws ?? []).find((d) => d.id === m.draw_id)?.tier ?? ""}`,
      })),
    ],
    [poolMatches, drawMatches, draws, catMap],
  );

  const latePools = useMemo(() => {
    const now = Date.now();
    return (pools ?? []).filter((pool) => {
      if (!pool.scheduled_end) return false;
      const matches = (poolMatches ?? []).filter((m) => m.pool_id === pool.id);
      if (poolIsComplete(matches)) return false;
      return now > new Date(pool.scheduled_end).getTime() + 15 * 60000;
    });
  }, [pools, poolMatches]);

  const overCap = allMatches.filter((m) => m.status === "in_progress" && (minutesSince(m.startedAt) ?? 0) > 25);

  return (
    <AppShell
      title="Control desk"
      subtitle="Live court board, pool progress and the alerts that need someone chasing."
    >
      <div className="space-y-5">
        {latePools.length || overCap.length ? (
          <Panel title="Alerts">
            <ul className="space-y-1.5 text-sm">
              {latePools.map((p) => (
                <li key={p.id} className="rounded-md bg-danger-surface px-2.5 py-1.5 text-danger-foreground">
                  {p.name} ({catMap.get(p.category_id)?.code}) is more than 15 minutes past its scheduled finish with
                  results still missing — this blocks draw generation.
                </li>
              ))}
              {overCap.map((m) => (
                <li key={m.id} className="rounded-md bg-warn-surface px-2.5 py-1.5 text-warn-foreground">
                  {label(m.teams[0])} vs {label(m.teams[1])} has been on court {minutesSince(m.startedAt)} minutes —
                  past the planned slot.
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        <Panel title="Court board">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(courts ?? []).map((court) => {
              const playing = allMatches.find((m) => m.courtId === court.id && m.status === "in_progress");
              const next = allMatches
                .filter((m) => m.courtId === court.id && m.status === "scheduled" && m.scheduled)
                .sort((a, b) => new Date(a.scheduled as string).getTime() - new Date(b.scheduled as string).getTime())[0];
              return (
                <div key={court.id} className="rounded-lg border border-hairline p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-display text-sm font-bold">Court {court.number}</span>
                    <StatusPill status={playing ? "in_progress" : "scheduled"} />
                  </div>
                  <p className="mt-2 text-sm">
                    {playing ? (
                      <>
                        <span className="font-score text-[11px] text-muted-foreground">{playing.tag}</span>
                        <br />
                        {label(playing.teams[0])} vs {label(playing.teams[1])}
                        <br />
                        <span className="font-score text-[11px] text-muted-foreground">
                          {minutesSince(playing.startedAt)}′ on court
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Free</span>
                    )}
                  </p>
                  <p className="mt-2 border-t border-hairline pt-2 text-xs text-muted-foreground">
                    Next:{" "}
                    {next ? (
                      <>
                        {timeLabel(next.scheduled)} · {label(next.teams[0])} vs {label(next.teams[1])}
                      </>
                    ) : (
                      "nothing queued"
                    )}
                  </p>
                </div>
              );
            })}
          </div>
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Category progress">
            <ul className="divide-y divide-hairline">
              {(categories ?? []).map((c) => {
                const catPools = (pools ?? []).filter((p) => p.category_id === c.id);
                const catMatches = (poolMatches ?? []).filter((m) => m.category_id === c.id);
                const done = catMatches.filter((m) => m.status === "reported").length;
                const ready =
                  catPools.length > 0 &&
                  catPools.every((p) => poolIsComplete(catMatches.filter((m) => m.pool_id === p.id)));
                return (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span>
                      <span className="font-semibold">{c.code}</span>{" "}
                      <span className="text-muted-foreground">
                        {(teams ?? []).filter((t) => t.category_id === c.id).length} entries · {catPools.length} pools
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="font-score text-xs">
                        {done}/{catMatches.length} group results
                      </span>
                      {ready ? (
                        <Link to="/draws" className="text-xs font-semibold text-primary">
                          Draws ready
                        </Link>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel title="Tournament totals">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Players" value={(players ?? []).length} />
              <Stat label="Entries" value={(teams ?? []).length} />
              <Stat label="Group matches" value={(poolMatches ?? []).length} />
              <Stat label="Knockout matches" value={(drawMatches ?? []).length} />
            </dl>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-hairline p-3">
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="font-score text-2xl font-semibold">{value}</dd>
    </div>
  );
}
