import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { toast } from "sonner";

import { AppShell, Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { drawGate, generateDrawsForCategory } from "@/lib/tournament/actions";
import {
  indexBy,
  teamLabel,
  useCategories,
  useDrawMatches,
  useDraws,
  usePlayers,
  usePoolEntries,
  usePoolMatches,
  usePools,
  useTeams,
} from "@/lib/tournament/data";
import { roundName } from "@/lib/tournament/draws";
import { gamesLabel, parseGames } from "@/lib/tournament/format";

export const Route = createFileRoute("/draws")({
  head: () => ({
    meta: [
      { title: "Knockout Draws A–D | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content: "Build seeded A/B/C/D knockout brackets once every pool in a category has reported its results.",
      },
      { property: "og:title", content: "Knockout Draws A–D | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content: "Build seeded A/B/C/D knockout brackets once every pool in a category has reported its results.",
      },
    ],
  }),
  component: DrawsPage,
});

function DrawsPage() {
  const qc = useQueryClient();
  const { canGenerate } = useSession();
  const { data: categories } = useCategories();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: pools } = usePools();
  const { data: entries } = usePoolEntries();
  const { data: poolMatches } = usePoolMatches();
  const { data: draws } = useDraws();
  const { data: drawMatches } = useDrawMatches();

  const playerMap = useMemo(() => indexBy(players), [players]);
  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const label = (id: string | null) => (id ? teamLabel(teamMap.get(id), playerMap) : "TBC");

  return (
    <AppShell
      title="Knockout draws"
      subtitle="Draw A = pool winners, B = runners-up, C = thirds, D = fourths plus any fifths. Byes go to the top seeds."
    >
      <div className="space-y-6">
        {(categories ?? []).map((c) => {
          const catPools = (pools ?? []).filter((p) => p.category_id === c.id);
          const catPoolMatches = (poolMatches ?? []).filter((m) => m.category_id === c.id);
          const gate = drawGate(catPools, entries ?? [], catPoolMatches);
          const catDraws = (draws ?? []).filter((d) => d.category_id === c.id);

          return (
            <div key={c.id} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-bold">
                  {c.code} — {c.name}
                </h2>
                <div className="flex items-center gap-3">
                  {gate.ready ? (
                    <span className="rounded-full bg-mint/20 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide">
                      All pools complete
                    </span>
                  ) : (
                    <span className="rounded-full bg-warn-surface px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-warn-foreground">
                      {catPools.length ? `Waiting on ${gate.waitingOn.join(", ")}` : "No pools yet"}
                    </span>
                  )}
                  <Button
                    size="sm"
                    disabled={!canGenerate || !gate.ready}
                    onClick={async () => {
                      try {
                        const force = catDraws.length
                          ? window.confirm("Regenerate draws and discard existing knockout results?")
                          : false;
                        await generateDrawsForCategory(c.id, catPools, entries ?? [], catPoolMatches, force);
                        toast.success(`${c.code} draws generated`);
                        qc.invalidateQueries();
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : "Could not generate draws");
                      }
                    }}
                  >
                    {catDraws.length ? "Regenerate draws" : "Generate draws A–D"}
                  </Button>
                </div>
              </div>

              {catDraws.length === 0 ? (
                <Panel>
                  <p className="text-sm text-muted-foreground">
                    Draws unlock once every pool in this category has all results recorded.
                  </p>
                </Panel>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {catDraws.map((draw) => {
                    const list = (drawMatches ?? []).filter((m) => m.draw_id === draw.id);
                    const rounds = [...new Set(list.map((m) => m.round))].sort((a, b) => a - b);
                    return (
                      <Panel
                        key={draw.id}
                        title={`Draw ${draw.tier}`}
                        right={
                          <span className="font-score text-[11px] text-muted-foreground">
                            {draw.entrant_count} entrants · {Math.max(draw.entrant_count - 1, 0)} playable matches
                          </span>
                        }
                      >
                        <div className="space-y-4">
                          {rounds.map((round) => (
                            <div key={round}>
                              <h3 className="mb-1.5 font-display text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                                {roundName(draw.bracket_size, round)}
                              </h3>
                              <ul className="divide-y divide-hairline">
                                {list
                                  .filter((m) => m.round === round)
                                  .sort((a, b) => a.slot - b.slot)
                                  .map((m) => (
                                    <li key={m.id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                                      <span>
                                        <span className={m.winner_id === m.team_a_id ? "font-semibold" : ""}>
                                          {label(m.team_a_id)}
                                        </span>
                                        <span className="text-muted-foreground"> vs </span>
                                        <span className={m.winner_id === m.team_b_id ? "font-semibold" : ""}>
                                          {m.note === "Bye" ? "Bye" : label(m.team_b_id)}
                                        </span>
                                      </span>
                                      <span className="font-score text-[11px] text-muted-foreground">
                                        {m.note === "Bye" ? "—" : gamesLabel(parseGames(m.games))}
                                      </span>
                                    </li>
                                  ))}
                              </ul>
                            </div>
                          ))}
                        </div>
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
