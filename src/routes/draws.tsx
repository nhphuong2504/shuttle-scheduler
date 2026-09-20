import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Trophy } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell, EmptyState, Panel } from "@/components/app-shell";
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
import { isByeMatch } from "@/lib/tournament/match-status";

export const Route = createFileRoute("/draws")({
  head: () => ({
    meta: [
      { title: "Knockout Draws A–D | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content:
          "Build seeded A/B/C/D knockout brackets once every pool in a category has reported its results.",
      },
      { property: "og:title", content: "Knockout Draws A–D | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content:
          "Build seeded A/B/C/D knockout brackets once every pool in a category has reported its results.",
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
  isLoser,
  isBye,
  dimmed,
  highlighted,
  onHover,
}: {
  name: string;
  scores: string;
  isWinner: boolean;
  isLoser: boolean;
  isBye: boolean;
  dimmed: boolean;
  highlighted: boolean;
  onHover: () => void;
}) {
  return (
    <div
      onMouseEnter={onHover}
      className={cn(
        "flex items-center justify-between gap-2 px-2.5 py-1 text-t2 leading-tight transition-colors",
        highlighted && "bg-primary/15",
        isWinner && !highlighted && "bg-muted/50",
        (dimmed || isLoser) && "text-muted-foreground",
      )}
    >
      <span className={cn("truncate", isWinner && "font-semibold text-foreground")}>
        {isBye ? "Bye" : name}
      </span>
      <span className="font-score shrink-0 text-t2 tabular-nums text-muted-foreground">
        {scores}
      </span>
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
  const [fit, setFit] = useState<Record<string, boolean>>({});
  const [hoverTeam, setHoverTeam] = useState<string | null>(null);

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
          const bracketSize = Math.max(draw?.bracket_size ?? 1, 1);
          const totalRounds = Math.max(Math.round(Math.log2(bracketSize)), 1);
          const rounds = Array.from({ length: totalRounds }, (_, i) => i + 1);
          const finalMatch = list.find((m) => m.round === totalRounds && m.slot === 1);
          const champion = finalMatch?.winner_id ? label(finalMatch.winner_id) : null;
          const isFit = fit[c.id] ?? false;

          return (
            <section key={c.id} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-lg font-bold">
                  {c.code} — {c.name}
                </h2>
                <div className="flex items-center gap-3">
                  {gate.ready ? (
                    <span className="rounded-full bg-success/20 px-2.5 py-1 text-t4 font-semibold uppercase tracking-wide">
                      All pools complete
                    </span>
                  ) : (
                    <span className="rounded-full bg-warn-surface px-2.5 py-1 text-t4 font-semibold uppercase tracking-wide text-warn-foreground">
                      {catPools.length ? `Waiting on ${gate.waitingOn.join(", ")}` : "No pools yet"}
                    </span>
                  )}
                  <Button
                    size="sm"
                    disabled={!canGenerate || !gate.ready}
                    onClick={async () => {
                      try {
                        const force = catDraws.length
                          ? window.confirm(
                              "Regenerate draws and discard existing knockout results?",
                            )
                          : false;
                        await generateDrawsForCategory(
                          c.id,
                          catPools,
                          entries ?? [],
                          catPoolMatches,
                          force,
                        );
                        toast.success(`${c.code} draws generated`);
                        qc.invalidateQueries();
                      } catch (error) {
                        toast.error(
                          error instanceof Error ? error.message : "Could not generate draws",
                        );
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
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
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
                    <button
                      type="button"
                      onClick={() => setFit((prev) => ({ ...prev, [c.id]: !isFit }))}
                      className={cn(
                        "rounded-full border px-3 py-1 text-t4 font-semibold uppercase tracking-wide transition-colors",
                        isFit
                          ? "border-primary bg-primary/10 text-primary-ink"
                          : "border-hairline bg-surface text-muted-foreground hover:bg-muted/60",
                      )}
                    >
                      Fit to screen
                    </button>
                  </div>

                  <div className="table-scroll rounded-xl border border-hairline bg-surface/40 p-3">
                    <div
                      className="flex min-w-max items-stretch"
                      style={
                        isFit
                          ? {
                              transform: "scale(0.72)",
                              transformOrigin: "top left",
                              width: "138.9%",
                            }
                          : undefined
                      }
                      onMouseLeave={() => setHoverTeam(null)}
                    >
                      {rounds.map((round) => {
                        const bySlot = new Map(
                          list.filter((m) => m.round === round).map((m) => [m.slot, m] as const),
                        );
                        const slotCount = Math.max(bracketSize / Math.pow(2, round), 1);
                        const roundSlots = Array.from({ length: slotCount }, (_, i) => i + 1);
                        const roundPlayable = roundSlots
                          .map((s) => bySlot.get(s))
                          .filter((m) => m && m.note !== "Bye");
                        const roundDone = roundPlayable.filter(
                          (m) => m?.status === "reported" || m?.status === "walkover",
                        ).length;

                        return (
                          <div key={round} className="flex w-56 shrink-0 flex-col">
                            <div className="sticky top-0 z-10 mb-1 flex items-baseline justify-between gap-2 bg-surface/95 px-3 py-1.5 backdrop-blur">
                              <h3 className="font-display text-t4 font-bold uppercase tracking-widest text-muted-foreground">
                                {roundName(bracketSize, round)}
                              </h3>
                              <span className="font-score text-t4 tabular-nums text-muted-foreground">
                                {roundDone}/{roundPlayable.length}
                              </span>
                            </div>
                            <div className="flex flex-1 flex-col">
                              {roundSlots.map((slot) => {
                                const m = bySlot.get(slot);
                                const isBye = m ? isByeMatch(m) : false;
                                const games = m ? parseGames(m.games) : [];
                                const scoreFor = (side: Side) =>
                                  !m || isBye || !games.length
                                    ? ""
                                    : games.map((g) => (side === "a" ? g.a : g.b)).join(" ");
                                const settled = !!m?.winner_id;
                                const live = m?.status === "in-progress";
                                const teamA = m?.team_a_id ?? null;
                                const teamB = m?.team_b_id ?? null;

                                return (
                                  <div
                                    key={`${round}-${slot}`}
                                    className="relative flex flex-1 items-center py-1.5 pl-3 pr-3"
                                  >
                                    {round > 1 ? (
                                      <span className="absolute left-0 top-1/2 h-px w-3 bg-hairline" />
                                    ) : null}
                                    {round < totalRounds ? (
                                      <>
                                        <span className="absolute right-0 top-1/2 h-px w-3 bg-hairline" />
                                        <span
                                          className={cn(
                                            "absolute right-0 w-px bg-hairline",
                                            slot % 2 === 1 ? "top-1/2 h-1/2" : "bottom-1/2 h-1/2",
                                          )}
                                        />
                                      </>
                                    ) : null}

                                    <div
                                      className={cn(
                                        "w-full overflow-hidden rounded-lg border bg-surface transition-colors",
                                        settled
                                          ? "border-hairline"
                                          : "border-dashed border-hairline",
                                        !m && "opacity-70",
                                        live &&
                                          "animate-pulse border-primary shadow-[0_0_0_1px_var(--color-primary)]",
                                      )}
                                    >
                                      <div className="flex items-center justify-between border-b border-hairline/70 bg-muted/30 px-2.5 py-0.5">
                                        <span className="font-score text-t4 uppercase tracking-widest text-muted-foreground">
                                          M{slot}
                                        </span>
                                        <span
                                          className={cn(
                                            "font-score text-t4 uppercase tracking-widest",
                                            live ? "text-primary" : "text-muted-foreground",
                                          )}
                                        >
                                          {!m
                                            ? "Awaiting"
                                            : isBye
                                              ? "Bye"
                                              : live
                                                ? "Live"
                                                : settled
                                                  ? "Final"
                                                  : "To play"}
                                        </span>
                                      </div>
                                      <SideRow
                                        name={label(teamA)}
                                        scores={scoreFor("a")}
                                        isWinner={!!m?.winner_id && m.winner_id === teamA}
                                        isLoser={!!m?.winner_id && m.winner_id !== teamA}
                                        isBye={false}
                                        dimmed={!teamA}
                                        highlighted={!!teamA && teamA === hoverTeam}
                                        onHover={() => setHoverTeam(teamA)}
                                      />
                                      <div className="h-px bg-hairline/70" />
                                      <SideRow
                                        name={label(teamB)}
                                        scores={scoreFor("b")}
                                        isWinner={!!m?.winner_id && m.winner_id === teamB}
                                        isLoser={!!m?.winner_id && m.winner_id !== teamB}
                                        isBye={!!isBye}
                                        dimmed={!!isBye || !teamB}
                                        highlighted={!!teamB && teamB === hoverTeam}
                                        onHover={() => setHoverTeam(teamB)}
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}

                      <div className="flex w-48 shrink-0 flex-col">
                        <div className="sticky top-0 z-10 mb-1 bg-surface/95 px-3 py-1.5 backdrop-blur">
                          <h3 className="font-display text-t4 font-bold uppercase tracking-widest text-muted-foreground">
                            Champion
                          </h3>
                        </div>
                        <div className="flex flex-1 items-center pl-3">
                          <div
                            className={cn(
                              "flex w-full flex-col items-center gap-1.5 rounded-lg border px-3 py-4 text-center",
                              champion
                                ? "border-primary bg-primary/10"
                                : "border-dashed border-hairline",
                            )}
                          >
                            <Trophy
                              className={cn(
                                "h-5 w-5",
                                champion ? "text-primary" : "text-muted-foreground/60",
                              )}
                            />
                            <p
                              className={cn(
                                "font-display text-sm font-bold",
                                champion ? "text-primary" : "text-muted-foreground",
                              )}
                            >
                              {champion ?? "To be decided"}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </AppShell>
  );
}
