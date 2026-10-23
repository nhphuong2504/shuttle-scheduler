import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { Page, EmptyState, Panel } from "@/components/app-shell";
import { KnockoutBracket } from "@/components/knockout-bracket";
import { Button } from "@/components/ui/button";
import { PLACEMENT_TIERS } from "@/lib/tournament/competition-format";
import { bracketNote, bracketRounds, buildCategoryView } from "@/lib/tournament/placement-actions";
import {
  indexBy,
  teamLabel,
  useCategories,
  usePlacementEntrants,
  usePlacementMatches,
  usePlayers,
  useTeams,
  useTierDrawMatches,
  useTierDraws,
  useScopedAccess,
  useTournamentScope,
  type Category,
  type Player,
  type PlacementEntrant,
  type PlacementMatch,
  type Team,
  type TierDraw,
  type TierDrawMatch,
} from "@/lib/tournament/data";
import { PlacementTierLegend } from "@/components/placement-tier-legend";

export const Route = createFileRoute("/tournaments/$tournamentId/knockout")({
  head: () => ({
    meta: [
      { title: "Knockout | Tournova Tournament Ops" },
      {
        name: "description",
        content:
          "The four A/B/C/D knockout brackets of a two-round placement tournament, round by round, with each draw's champion. Results are entered on the Scores page.",
      },
      { property: "og:title", content: "Knockout | Tournova Tournament Ops" },
      {
        property: "og:description",
        content:
          "The four A/B/C/D knockout brackets of a two-round placement tournament, round by round, with each draw's champion. Results are entered on the Scores page.",
      },
    ],
  }),
  component: KnockoutPage,
});

/**
 * The knockout stage of the two-round placement format: the A/B/C/D brackets that
 * the two placement rounds sort entrants into.
 *
 * Read-only by design. Every match here is scored and cleared on `/matches`, so this
 * page exists to show the thing a list of matches cannot — the shape of each bracket,
 * which round is waiting on which, and who came out of it.
 *
 * The round-robin format has its own knockout on `/draws`, drawn from pool standings
 * rather than from placement records, so this page points there instead of rendering
 * an empty set of brackets for it.
 */

function KnockoutPage() {
  const { tournament } = useTournamentScope();
  // The links below stay inside this tournament, so they carry the id the layout resolved
  // rather than a global. A route param, so it is a string here and not a nullable one.
  const { tournamentId } = Route.useParams();
  const canEdit = useScopedAccess().can_edit;
  const { data: categories } = useCategories();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: entrants } = usePlacementEntrants();
  const { data: matches } = usePlacementMatches();
  const { data: draws } = useTierDraws();
  const { data: tierMatches } = useTierDrawMatches();

  const playerMap = useMemo(() => indexBy(players), [players]);
  const teamMap = useMemo(() => indexBy(teams), [teams]);

  const live = (categories ?? []).filter((category) => category.active);
  const wrongFormat = tournament != null && tournament.format !== "two_round_placement";

  return (
    <Page
      title="Knockout"
      subtitle="The four A/B/C/D knockout brackets."
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link to="/tournaments/$tournamentId/scores" params={{ tournamentId }}>
            {canEdit ? "Enter results in Scores" : "See all scores"}
          </Link>
        </Button>
      }
    >
      {wrongFormat ? null : <PlacementTierLegend />}
      {wrongFormat ? (
        <Panel>
          <EmptyState
            title="This is a round-robin tournament"
            hint="Its knockout brackets are drawn from pool standings, not from placement records."
            action={
              <Button size="sm" variant="outline" asChild>
                <Link to="/tournaments/$tournamentId/draws" params={{ tournamentId }}>
                  Open Knockout draws
                </Link>
              </Button>
            }
          />
        </Panel>
      ) : live.length === 0 ? (
        <Panel>
          <EmptyState
            title="No active events"
            hint="Add an event in tournament setup before the brackets can be drawn."
          />
        </Panel>
      ) : (
        <div className="space-y-8">
          {live.map((category) => (
            <BracketSection
              key={category.id}
              category={category}
              teams={(teams ?? []).filter((team) => team.category_id === category.id)}
              playerMap={playerMap}
              entrants={(entrants ?? []).filter((entrant) => entrant.category_id === category.id)}
              matches={(matches ?? []).filter((match) => match.category_id === category.id)}
              draws={(draws ?? []).filter((draw) => draw.category_id === category.id)}
              tierMatches={tierMatches ?? []}
            />
          ))}
        </div>
      )}
    </Page>
  );
}

/**
 * One event's four brackets.
 *
 * The gating state comes from `buildCategoryView` rather than from the draws table,
 * because "waiting on 3 entrants" is a property of the placement results and not of
 * whether the draws exist yet.
 */
function BracketSection({
  category,
  teams,
  playerMap,
  entrants,
  matches,
  draws,
  tierMatches,
}: {
  category: Category;
  teams: Team[];
  playerMap: Map<string, Player>;
  entrants: PlacementEntrant[];
  matches: PlacementMatch[];
  draws: TierDraw[];
  tierMatches: TierDrawMatch[];
}) {
  const view = useMemo(() => buildCategoryView(entrants, matches), [entrants, matches]);

  // `tierMatches` arrives unfiltered, so scope it through this category's draws —
  // which are already category-filtered. That is what keeps a tier match from
  // another event out of these brackets.
  const drawIds = useMemo(() => new Set(draws.map((draw) => draw.id)), [draws]);
  const categoryTierMatches = useMemo(
    () => tierMatches.filter((match) => drawIds.has(match.draw_id)),
    [tierMatches, drawIds],
  );

  const teamMap = useMemo(() => indexBy(teams), [teams]);
  // A tier match carries ENTRANT ids, not team ids, so naming one needs the entrant
  // -> team hop. Leaving the hop out does not fail loudly: every lookup misses and
  // the whole page reads "TBC". The hop also needs the event's own entrants, which
  // is why this cannot be hoisted to the page.
  const entrantTeam = useMemo(() => {
    const map = new Map<string, string>();
    for (const entrant of entrants) map.set(entrant.id, entrant.team_id);
    return map;
  }, [entrants]);
  const label = (entrantId: string | null | undefined, fallback = "TBC") => {
    const teamId = entrantId ? entrantTeam.get(entrantId) : undefined;
    return teamId ? teamLabel(teamMap.get(teamId), playerMap) : fallback;
  };

  const short = view.gate.short.length;
  const hasDraws = draws.length > 0;
  const championCount = draws.filter((draw) => draw.champion_id).length;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-bold">
          {category.code} — {category.name}
          <span className="ml-2 font-score text-sm font-normal text-muted-foreground">
            {hasDraws
              ? `${draws.length} bracket${draws.length === 1 ? "" : "s"}, ${championCount} decided`
              : view.gate.ready
                ? "ready to draw"
                : `${short} short`}
          </span>
        </h2>
      </div>

      {!hasDraws ? (
        <Panel title="Not drawn yet">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Draws open once every entrant has completed{" "}
              {view.gate.requiredMatches === 0
                ? "the placement stage"
                : `${view.gate.requiredMatches} decided placement match${view.gate.requiredMatches === 1 ? "" : "es"}`}
              .
            </p>
            {short > 0 ? (
              <p className="rounded-md border border-hairline bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                Waiting on {short} entrant{short === 1 ? "" : "s"}. A waived entrant is skipped
                rather than blocking the event.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Every entrant is finished, so the brackets are ready. Drawing them runs from the
                schedule.
              </p>
            )}
          </div>
        </Panel>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          {PLACEMENT_TIERS.map((tierMapping) => {
            const draw = draws.find((entry) => entry.tier === tierMapping.tier);
            const rounds = draw
              ? bracketRounds(categoryTierMatches.filter((match) => match.draw_id === draw.id))
              : new Map<number, TierDrawMatch[]>();

            if (!draw) {
              // A tier nobody landed in is one line, not a panel: four panels of which three say
              // "empty" push the one real bracket down the page.
              return (
                <div
                  key={tierMapping.tier}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-xl border border-hairline bg-card px-4 py-2.5 text-sm"
                >
                  <span className="font-semibold">
                    {tierMapping.label}, {tierMapping.title}
                  </span>
                  <span className="text-muted-foreground">
                    <span className="font-score text-t2">{tierMapping.record}</span>. No entrants
                    in this tier.
                  </span>
                </div>
              );
            }

            return (
              <Panel
                key={tierMapping.tier}
                title={`${tierMapping.label}, ${tierMapping.title}`}
                right={
                  <abbr
                    title={tierMapping.detail}
                    className="font-score text-t2 text-muted-foreground no-underline"
                  >
                    {tierMapping.record}
                  </abbr>
                }
              >
                {
                  <div className="space-y-3">
                    <p className="text-t4 text-muted-foreground">{bracketNote(draw)}</p>

                    <KnockoutBracket
                      rounds={rounds}
                      bracketSize={draw.bracket_size}
                      label={label}
                      ariaLabel={`${category.code} ${tierMapping.label} bracket`}
                      champion={draw.champion_id ? label(draw.champion_id) : null}
                    />
                  </div>
                }
              </Panel>
            );
          })}
        </div>
      )}
    </section>
  );
}
