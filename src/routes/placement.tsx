import { useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { toast } from "sonner";

import { AppShell, EmptyState, Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { entrantCountNote } from "@/lib/tournament/competition-format";
import {
  buildCategoryView,
  lockPlacementSeeds,
  setPlacementSkill,
  shuffleSeedFor,
  syncPlacementEntrants,
  type CategoryPlacementView,
} from "@/lib/tournament/placement-actions";
import {
  indexBy,
  teamLabel,
  useCategories,
  usePlacementEntrants,
  usePlacementMatches,
  usePlayers,
  useTeams,
  useTournamentScope,
  type Category,
  type Player,
  type PlacementEntrant,
  type PlacementMatch,
  type Team,
} from "@/lib/tournament/data";
import { mulberry32 } from "@/lib/tournament/rng";

export const Route = createFileRoute("/placement")({
  head: () => ({
    meta: [
      { title: "Placement | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content:
          "Set the seed order for a two-round placement tournament and see which Draw A, B, C or D tier each entrant has sorted into. Results are entered on the Scores page.",
      },
      { property: "og:title", content: "Placement | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content:
          "Set the seed order for a two-round placement tournament and see which Draw A, B, C or D tier each entrant has sorted into. Results are entered on the Scores page.",
      },
    ],
  }),
  component: PlacementPage,
});

/**
 * Seeding for the two-round placement format: the seed order, the skill blocks it
 * comes from, and the Draw A/B/C/D tier each entrant has been sorted into.
 *
 * It is a separate route from `/pools` and `/draws` because this format has its own
 * tables. It deliberately does not list matches — the two rounds and the four
 * brackets are all scored on `/matches`, so a match list here was a second copy of
 * the same table with a second set of score buttons.
 */

function PlacementPage() {
  const qc = useQueryClient();
  const { canEditPlacementEntrants } = useSession();
  const { tournament } = useTournamentScope();
  const { data: categories } = useCategories();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: entrants } = usePlacementEntrants();
  const { data: matches } = usePlacementMatches();

  const playerMap = useMemo(() => indexBy(players), [players]);
  const teamMap = useMemo(() => indexBy(teams), [teams]);

  const refresh = () => qc.invalidateQueries();

  const live = (categories ?? []).filter((category) => category.active);
  const wrongFormat = tournament != null && tournament.format !== "two_round_placement";

  return (
    <AppShell
      title="Placement"
      subtitle="Every entrant plays two placement matches. The two results sort them into Draw A (WW), B (WL), C (LW) or D (LL)."
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link to="/matches">Enter results in Scores</Link>
        </Button>
      }
    >
      {wrongFormat ? (
        <div className="mb-4 rounded-lg border border-warn-border bg-warn-surface px-3 py-2 text-xs font-medium text-warn-foreground">
          This tournament's stored format is{" "}
          <span className="font-score">{tournament?.format}</span>, not two-round placement. The
          tables below are the placement format's own and will stay empty for a round-robin event.
        </div>
      ) : null}

      <div className="space-y-8">
        {live.length === 0 ? (
          <Panel>
            <EmptyState
              title="No active events"
              hint="Activate a tournament and enable its events before running the placement stage."
            />
          </Panel>
        ) : null}

        {live.map((category) => (
          <CategorySection
            key={category.id}
            category={category}
            teams={(teams ?? []).filter((team) => team.category_id === category.id)}
            playerMap={playerMap}
            entrants={(entrants ?? []).filter((entrant) => entrant.category_id === category.id)}
            matches={(matches ?? []).filter((match) => match.category_id === category.id)}
            canEdit={canEditPlacementEntrants}
            onRefresh={refresh}
          />
        ))}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// One category
// ---------------------------------------------------------------------------

function CategorySection({
  category,
  teams,
  playerMap,
  entrants,
  matches,
  canEdit,
  onRefresh,
}: {
  category: Category;
  teams: Team[];
  playerMap: Map<string, Player>;
  entrants: PlacementEntrant[];
  matches: PlacementMatch[];
  canEdit: boolean;
  onRefresh: () => void;
}) {
  const view = useMemo(() => buildCategoryView(entrants, matches), [entrants, matches]);
  const activeTeams = teams.filter((team) => !team.withdrawn);
  const teamMap = useMemo(() => indexBy(teams), [teams]);
  // A match row carries ENTRANT ids, not team ids, so naming one needs the
  // entrant -> team hop. Leaving the hop out does not fail loudly: every lookup
  // misses and the whole page reads "TBC". The seeding table is the one place
  // that has a team id to hand, and it passes the entrant id instead so there is
  // a single, entrant-keyed function rather than one function used two ways.
  const entrantTeam = useMemo(() => {
    const map = new Map<string, string>();
    for (const entrant of entrants) map.set(entrant.id, entrant.team_id);
    return map;
  }, [entrants]);
  const labelEntrant = (entrantId: string | null | undefined) => {
    const teamId = entrantId ? entrantTeam.get(entrantId) : undefined;
    return teamId ? teamLabel(teamMap.get(teamId), playerMap) : "TBC";
  };

  // The placement stage holds an odd entrant, so this is informational, never a
  // blocker. See `entrantCountNote`.
  const oddNote = entrantCountNote(view.active.length);

  async function run(work: () => Promise<unknown>, success: string) {
    try {
      await work();
      toast.success(success);
      onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That action failed.");
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-bold">
          {category.code} — {category.name}
          <span className="ml-2 font-score text-xs font-normal text-muted-foreground">
            {view.active.length} entrants · {view.matches.length} matches · {stageLabel(view.stage)}
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                run(() => syncPlacementEntrants(category.id), `${category.code} entrants synced`)
              }
            >
              Sync entrants
            </Button>
          ) : null}
        </div>
      </div>

      {oddNote ? (
        <p className="rounded-md border border-hairline bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {oddNote}
        </p>
      ) : null}

      {view.active.length === 0 ? (
        <Panel>
          <EmptyState
            title="No entrants yet"
            hint={
              activeTeams.length === 0
                ? "Register teams for this event first."
                : `${activeTeams.length} team(s) registered. Sync entrants to bring them into the placement stage.`
            }
          />
        </Panel>
      ) : (
        <SeedingPanel
          category={category}
          view={view}
          label={labelEntrant}
          canEdit={canEdit}
          onRefresh={onRefresh}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function SeedingPanel({
  category,
  view,
  label,
  canEdit,
  onRefresh,
}: {
  category: Category;
  view: CategoryPlacementView;
  label: (entrantId: string | null | undefined) => string;
  canEdit: boolean;
  onRefresh: () => void;
}) {
  const counts = { advanced: 0, intermediate: 0, beginner: 0 };
  for (const entrant of view.active) {
    const level = entrant.skill_level as keyof typeof counts;
    if (level in counts) counts[level]++;
  }

  const hasMatches = view.matches.length > 0;

  return (
    <Panel
      title="Seeding"
      right={
        <span className="font-score text-[11px] text-muted-foreground">
          {view.seedsLocked ? "locked" : "not locked"}
        </span>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Skill level decides the seed order once: entrants are grouped by the block they reported,
          shuffled inside it, and seeded strongest block first. Every pairing rule after this reads
          the seed only.
        </p>

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-12">Seed</th>
                <th>Entrant</th>
                <th>Skill</th>
                <th className="text-right">Matches</th>
                <th>Tier</th>
              </tr>
            </thead>
            <tbody>
              {view.outcomes
                .slice()
                .sort((a, b) => {
                  if (a.seed === 0 || b.seed === 0) return a.seed === 0 ? 1 : -1;
                  return a.seed - b.seed;
                })
                .map((outcome) => {
                  const entrant = view.active.find((e) => e.id === outcome.entrantId);
                  if (!entrant) return null;
                  return (
                    <tr key={entrant.id}>
                      <td className="font-score text-xs font-semibold text-primary">
                        {entrant.seed ?? "—"}
                      </td>
                      <td className="pr-2 font-medium">{label(entrant.id)}</td>
                      <td>
                        {canEdit && !view.seedsLocked ? (
                          <select
                            className="h-7 rounded-md border border-hairline bg-surface px-2 text-xs"
                            value={entrant.skill_level}
                            onChange={async (event) => {
                              try {
                                await setPlacementSkill(
                                  category.id,
                                  entrant.team_id,
                                  event.target.value,
                                );
                                onRefresh();
                              } catch (error) {
                                toast.error(
                                  error instanceof Error ? error.message : "Could not set skill",
                                );
                              }
                            }}
                          >
                            <option value="advanced">Advanced</option>
                            <option value="intermediate">Intermediate</option>
                            <option value="beginner">Beginner</option>
                          </select>
                        ) : (
                          <span className="text-xs capitalize">{entrant.skill_level}</span>
                        )}
                      </td>
                      <td className="text-right font-score text-xs">
                        {outcome.played}/{view.requiredMatches}
                      </td>
                      <td className="font-score text-xs">{outcome.tier ?? "—"}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Blocks: {counts.advanced} advanced · {counts.intermediate} intermediate ·{" "}
          {counts.beginner} beginner
          {view.excluded.length > 0 ? ` · ${view.excluded.length} waived` : ""}
        </p>

        {canEdit ? (
          <Button
            size="sm"
            variant={view.seedsLocked ? "outline" : "default"}
            disabled={hasMatches}
            onClick={async () => {
              try {
                if (view.seedsLocked && !window.confirm("Re-shuffle and re-lock the seed order?")) {
                  return;
                }
                await lockPlacementSeeds(
                  category.id,
                  view.active,
                  mulberry32(shuffleSeedFor(category.id)),
                );
                toast.success(`${category.code} seeds locked`);
                onRefresh();
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not lock seeds");
              }
            }}
          >
            {view.seedsLocked ? "Re-shuffle seeds" : "Shuffle & lock seeds"}
          </Button>
        ) : null}
        {hasMatches && canEdit ? (
          <p className="text-[11px] text-muted-foreground">
            Seeding is frozen because placement matches already exist. The seed order is only
            editable while the stage is still empty.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Small display helpers
// ---------------------------------------------------------------------------

function stageLabel(stage: CategoryPlacementView["stage"]): string {
  switch (stage) {
    case "seeding":
      return "seeding";
    case "round1":
      return "round one";
    case "round2":
      return "round two";
    case "draws":
      return "draws";
    default:
      return "seeding";
  }
}
