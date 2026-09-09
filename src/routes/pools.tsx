import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { toast } from "sonner";

import { AppShell, Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { generatePoolsForCategory, setManualRankOverride } from "@/lib/tournament/actions";
import {
  indexBy,
  teamLabel,
  useCategories,
  usePlayers,
  usePoolEntries,
  usePoolMatches,
  usePools,
  useTeams,
} from "@/lib/tournament/data";
import { signed } from "@/lib/tournament/format";
import { computeStandings, poolIsComplete } from "@/lib/tournament/standings";

export const Route = createFileRoute("/pools")({
  head: () => ({
    meta: [
      { title: "Pools & Standings | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content: "Generate round-robin pools of four or five and track live standings with head-to-head tie-breaks.",
      },
      { property: "og:title", content: "Pools & Standings | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content: "Generate round-robin pools of four or five and track live standings with head-to-head tie-breaks.",
      },
    ],
  }),
  component: PoolsPage,
});

function PoolsPage() {
  const qc = useQueryClient();
  const { signedIn } = useSession();
  const { data: categories } = useCategories();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: pools } = usePools();
  const { data: entries } = usePoolEntries();
  const { data: matches } = usePoolMatches();

  const playerMap = useMemo(() => indexBy(players), [players]);
  const teamMap = useMemo(() => indexBy(teams), [teams]);

  return (
    <AppShell
      title="Pools & standings"
      subtitle="Pools are always four, or five where the entry count requires it — never three."
    >
      <div className="space-y-6">
        {(categories ?? []).map((c) => {
          const catTeams = (teams ?? []).filter((t) => t.category_id === c.id && !t.withdrawn);
          const catPools = (pools ?? []).filter((p) => p.category_id === c.id);
          return (
            <div key={c.id} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-bold">
                  {c.code} — {c.name}
                  <span className="ml-2 font-score text-xs font-normal text-muted-foreground">
                    {catTeams.length} entries · {catPools.length} pools
                  </span>
                </h2>
                <Button
                  size="sm"
                  disabled={!signedIn || catTeams.length < 4}
                  onClick={async () => {
                    try {
                      await generatePoolsForCategory(c.id, catTeams);
                      toast.success(`${c.code} pools generated`);
                      qc.invalidateQueries();
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "Could not generate pools");
                    }
                  }}
                >
                  {catPools.length ? "Regenerate pools" : "Generate pools"}
                </Button>
              </div>

              {catPools.length === 0 ? (
                <Panel>
                  <p className="text-sm text-muted-foreground">
                    No pools yet. {catTeams.length < 4 ? "At least 4 entries are needed." : "Generate them when entries are final."}
                  </p>
                </Panel>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {catPools.map((pool) => {
                    const poolEntries = (entries ?? []).filter((e) => e.pool_id === pool.id);
                    const poolMatches = (matches ?? []).filter((m) => m.pool_id === pool.id);
                    const overrides: Record<string, number | null> = {};
                    for (const e of poolEntries) overrides[e.team_id] = e.manual_rank_override;
                    const standings = computeStandings(
                      poolEntries.map((e) => e.team_id),
                      poolMatches,
                      overrides,
                    );
                    const complete = poolIsComplete(poolMatches);
                    const played = poolMatches.filter((m) => m.status === "reported").length;
                    return (
                      <Panel
                        key={pool.id}
                        title={pool.name}
                        right={
                          <span className="font-score text-[11px] text-muted-foreground">
                            {played}/{poolMatches.length} {complete ? "· complete" : ""}
                          </span>
                        }
                      >
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                              <th className="pb-1">#</th>
                              <th className="pb-1">Entry</th>
                              <th className="pb-1 text-right">W-L</th>
                              <th className="pb-1 text-right">Diff</th>
                              <th className="pb-1" />
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-hairline">
                            {standings.map((s) => {
                              const entry = poolEntries.find((e) => e.team_id === s.teamId);
                              return (
                                <tr key={s.teamId}>
                                  <td className="py-1.5 font-score text-xs text-muted-foreground">{s.rank}</td>
                                  <td className="py-1.5 pr-2">{teamLabel(teamMap.get(s.teamId), playerMap)}</td>
                                  <td className="py-1.5 text-right font-score text-xs">
                                    {s.wins}-{s.losses}
                                  </td>
                                  <td className="py-1.5 text-right font-score text-xs">{signed(s.diff)}</td>
                                  <td className="py-1.5 pl-2 text-right">
                                    {signedIn && entry ? (
                                      <button
                                        className="text-[10px] uppercase tracking-wide text-muted-foreground hover:text-primary"
                                        onClick={async () => {
                                          const input = window.prompt(
                                            "Manual rank (coin toss). Leave blank to clear.",
                                            entry.manual_rank_override?.toString() ?? "",
                                          );
                                          if (input === null) return;
                                          const value = input.trim() === "" ? null : Number(input);
                                          await setManualRankOverride(entry.id, value);
                                          qc.invalidateQueries();
                                        }}
                                      >
                                        {entry.manual_rank_override ? `set ${entry.manual_rank_override}` : "override"}
                                      </button>
                                    ) : null}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </Panel>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </AppShell>
  );
}
