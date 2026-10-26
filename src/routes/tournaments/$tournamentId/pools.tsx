import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { toast } from "sonner";

import { Page, EmptyState, Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { generatePoolsForCategory, setManualRankOverride } from "@/lib/tournament/actions";
import { compareEventOrder } from "@/lib/tournament/event-order";
import {
  indexBy,
  teamLabel,
  useScopedAccess,
  useScopedTournament,
  useCategories,
  usePlayers,
  usePoolEntries,
  usePoolMatches,
  usePools,
  useTeams,
} from "@/lib/tournament/data";
import { signed } from "@/lib/tournament/format";
import { computeStandings, poolIsComplete } from "@/lib/tournament/standings";

export const Route = createFileRoute("/tournaments/$tournamentId/pools")({
  head: () => ({
    meta: [
      { title: "Pools & Standings | Tournova Tournament Ops" },
      {
        name: "description",
        content:
          "Generate round-robin pools of four or five and track live standings with head-to-head tie-breaks.",
      },
      { property: "og:title", content: "Pools & Standings | Tournova Tournament Ops" },
      {
        property: "og:description",
        content:
          "Generate round-robin pools of four or five and track live standings with head-to-head tie-breaks.",
      },
    ],
  }),
  component: PoolsPage,
});

function PoolsPage() {
  const qc = useQueryClient();
  const tournament = useScopedTournament();
  // Both former role flags are now one question - may this person change anything in
  // this tournament - so generating pools and scoring a pool match take the same answer.
  const access = useScopedAccess();
  const canEdit = access.can_edit;
  const { data: categories } = useCategories();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: pools } = usePools();
  const { data: entries } = usePoolEntries();
  const { data: matches } = usePoolMatches();

  const playerMap = useMemo(() => indexBy(players), [players]);
  const teamMap = useMemo(() => indexBy(teams), [teams]);

  return (
    <Page
      title="Pools & standings"
      subtitle="Pools of four, or five when the entry count needs it."
    >
      <div className="space-y-6">
        {(categories ?? []).slice().sort(compareEventOrder).map((c) => {
          const catTeams = (teams ?? []).filter((t) => t.category_id === c.id && !t.withdrawn);
          const catPools = (pools ?? []).filter((p) => p.category_id === c.id);
          return (
            <div key={c.id} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-bold">
                  {c.code} — {c.name}
                  <span className="ml-2 font-score text-sm font-normal text-muted-foreground">
                    {catTeams.length} entries, {catPools.length} pools
                  </span>
                </h2>
                <Button
                  size="sm"
                  disabled={!canEdit || catTeams.length < 4}
                  onClick={async () => {
                    try {
                      const force = catPools.length
                        ? window.confirm(
                            "Regenerate pools and invalidate existing draws for this category?",
                          )
                        : false;
                      await generatePoolsForCategory(c.id, catTeams, force);
                      toast.success(`${c.code} pools generated`);
                      qc.invalidateQueries();
                    } catch (error) {
                      toast.error(
                        error instanceof Error ? error.message : "Could not generate pools",
                      );
                    }
                  }}
                >
                  {catPools.length ? "Regenerate pools" : "Generate pools"}
                </Button>
              </div>

              {catPools.length === 0 ? (
                <Panel>
                  <EmptyState
                    title="No pools yet"
                    hint={
                      catTeams.length < 4
                        ? "At least 4 entries are needed before pools can be drawn."
                        : "Generate them when entries are final."
                    }
                  />
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
                    const complete = poolIsComplete(
                      poolEntries.map((e) => e.team_id),
                      poolMatches,
                    );
                    const played = poolMatches.filter((m) => m.status === "reported").length;
                    return (
                      <Panel
                        key={pool.id}
                        title={pool.name}
                        right={
                          <span className="font-score text-t4 text-muted-foreground">
                            {played}/{poolMatches.length}{complete ? ", complete" : ""}
                          </span>
                        }
                      >
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th className="w-8">#</th>
                              <th>Entry</th>
                              <th className="text-right">W-L</th>
                              <th className="text-right">Diff</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {standings.map((s) => {
                              const entry = poolEntries.find((e) => e.team_id === s.teamId);
                              return (
                                <tr key={s.teamId}>
                                  <td className="font-score text-sm font-semibold text-primary">
                                    {s.rank}
                                  </td>
                                  <td className="pr-2 font-medium">
                                    {teamLabel(teamMap.get(s.teamId), playerMap)}
                                  </td>
                                  <td className="text-right font-score text-sm">
                                    {s.wins}-{s.losses}
                                  </td>
                                  <td className="text-right font-score text-sm">
                                    {signed(s.diff)}
                                  </td>
                                  <td className="pl-2 text-right">
                                    {canEdit && entry ? (
                                      <button
                                        className="text-sm text-muted-foreground hover:text-primary"
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
                                        {entry.manual_rank_override
                                          ? `set ${entry.manual_rank_override}`
                                          : "override"}
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
    </Page>
  );
}
