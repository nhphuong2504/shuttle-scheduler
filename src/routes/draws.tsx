import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell, EmptyState, Panel, StatTile } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { cn } from "@/lib/utils";
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
import { parseGames } from "@/lib/tournament/format";

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

type Side = "a" | "b";

function SideRow({
  name,
  scores,
  isWinner,
  isBye,
  dimmed,
}: {
  name: string;
  scores: string;
  isWinner: boolean;
  isBye: boolean;
  dimmed: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 px-2.5 py-1.5 text-sm",
        isWinner && "bg-primary/10",
        dimmed && "text-muted-foreground",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {isWinner ? <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-primary" /> : null}
        <span className={cn("truncate", isWinner && "font-semibold text-primary")}>{isBye ? "Bye" : name}</span>
      </span>
      <span className="font-score text-[11px] tabular-nums text-muted-foreground">{scores}</span>
    </div>
  );
}

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
  const [tier, setTier] = useState<Record<string, string>>({});

  const playerMap = useMemo(() => indexBy(players), [players]);
  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const label = (id: string | null) => (id ? teamLabel(teamMap.get(id), playerMap) : "TBC");

  return (
    <AppShell
      title="Knockout draws"
      subtitle="Draw A = pool winners, B = runners-up, C = thirds, D = fourths plus any fifths. Byes go to the top seeds."
    >
      <div className="space-y-8">
        {(categories ?? []).map((c) => {
          const catPools = (pools ?? []).filter((p) => p.category_id === c.id);
          const catPoolMatches = (poolMatches ?? []).filter((m) => m.category_id === c.id);
          const gate = drawGate(catPools, entries ?? [], catPoolMatches);
          const catDraws = (draws ?? []).filter((d) => d.category_id === c.id);
          const activeTier = tier[c.id] ?? catDraws[0]?.tier ?? "A";
          const draw = catDraws.find((d) => d.tier === activeTier) ?? catDraws[0];
          const list = draw ? (drawMatches ?? []).filter((m) => m.draw_id === draw.id) : [];
          const playable = list.filter((m) => m.note !== "Bye");
          const done = playable.filter((m) => m.status === "reported" || m.status === "walkover").length;
          const bracketSize = Math.max(draw?.bracket_size ?? 1, 1);
          const totalRounds = Math.max(Math.round(Math.log2(bracketSize)), 1);
          const rounds = Array.from({ length: totalRounds }, (_, i) => i + 1);
          const finalMatch = list.find((m) => m.round === totalRounds && m.slot === 1);
          const champion = finalMatch?.winner_id ? label(finalMatch.winner_id) : null;

          return (
            <section key={c.id} className="space-y-3">
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

              {catDraws.length === 0 || !draw ? (
                <Panel>
                  <EmptyState
                    title="Draws locked"
                    hint="Draws unlock once every pool in this category has all results recorded."
                  />
                </Panel>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {catDraws.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => setTier((prev) => ({ ...prev, [c.id]: d.tier }))}
                        className={cn(
                          "rounded-full border px-3.5 py-1 text-xs font-semibold transition-colors",
                          d.tier === activeTier
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-hairline bg-surface text-muted-foreground hover:bg-muted/60",
                        )}
                      >
                        Draw {d.tier}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <StatTile label="Entrants" value={draw.entrant_count} />
                    <StatTile label="Matches played" value={`${done}/${playable.length}`} />
                    <StatTile
                      label="Still to play"
                      value={playable.length - done}
                      tone={playable.length - done ? "warn" : "good"}
                    />
                    <StatTile label="Champion" value={champion ?? "—"} tone={champion ? "good" : "normal"} />
                  </div>

                  <Panel title={`Draw ${draw.tier} bracket`} bodyClassName="table-scroll p-3">
                    <div className="flex min-w-max items-stretch gap-4">
                      {rounds.map((round) => {
                        const roundMatches = list
                          .filter((m) => m.round === round)
                          .sort((a, b) => a.slot - b.slot);
                        return (
                          <div key={round} className="flex w-60 shrink-0 flex-col">
                            <h3 className="mb-2 font-display text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                              {roundName(draw.bracket_size, round)}
                            </h3>
                            <div className="flex flex-1 flex-col justify-around gap-2.5">
                              {roundMatches.map((m) => {
                                const games = parseGames(m.games);
                                const isBye = m.note === "Bye";
                                const scoreFor = (side: Side) =>
                                  isBye || !games.length
                                    ? ""
                                    : games.map((g) => (side === "a" ? g.a : g.b)).join(" ");
                                const settled = !!m.winner_id;
                                return (
                                  <div
                                    key={m.id}
                                    className={cn(
                                      "overflow-hidden rounded-lg border bg-surface transition-colors",
                                      settled ? "border-hairline" : "border-dashed border-hairline",
                                      m.status === "in-progress" && "border-primary",
                                    )}
                                  >
                                    <div className="flex items-center justify-between border-b border-hairline/70 bg-muted/40 px-2.5 py-1">
                                      <span className="font-score text-[10px] uppercase tracking-widest text-muted-foreground">
                                        Match {m.slot}
                                      </span>
                                      <span
                                        className={cn(
                                          "font-score text-[10px] uppercase tracking-widest",
                                          m.status === "in-progress"
                                            ? "text-primary"
                                            : "text-muted-foreground",
                                        )}
                                      >
                                        {isBye ? "Bye" : m.status === "in-progress" ? "Live" : settled ? "Final" : "To play"}
                                      </span>
                                    </div>
                                    <SideRow
                                      name={label(m.team_a_id)}
                                      scores={scoreFor("a")}
                                      isWinner={!!m.winner_id && m.winner_id === m.team_a_id}
                                      isBye={false}
                                      dimmed={!m.team_a_id}
                                    />
                                    <div className="h-px bg-hairline/70" />
                                    <SideRow
                                      name={label(m.team_b_id)}
                                      scores={scoreFor("b")}
                                      isWinner={!!m.winner_id && m.winner_id === m.team_b_id}
                                      isBye={isBye}
                                      dimmed={isBye || !m.team_b_id}
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}

                      <div className="flex w-52 shrink-0 flex-col">
                        <h3 className="mb-2 font-display text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                          Champion
                        </h3>
                        <div className="flex flex-1 items-center">
                          <div
                            className={cn(
                              "w-full rounded-lg border px-3 py-4 text-center",
                              champion ? "border-primary bg-primary/10" : "border-dashed border-hairline",
                            )}
                          >
                            <p className={cn("font-display text-sm font-bold", champion ? "text-primary" : "text-muted-foreground")}>
                              {champion ?? "To be decided"}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </Panel>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </AppShell>
  );
}
