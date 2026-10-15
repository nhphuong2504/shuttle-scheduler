import { Link, createFileRoute } from "@tanstack/react-router";
import { Trophy } from "lucide-react";
import { useMemo } from "react";

import { Page, ByeMarker, EmptyState, Panel, StatusPill } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { PLACEMENT_TIERS } from "@/lib/tournament/competition-format";
import { roundName } from "@/lib/tournament/draws";
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
import { gamesLabel, parseGames } from "@/lib/tournament/format";
import { isByeMatch } from "@/lib/tournament/match-status";
import { feederLabel, isTierMatchReady } from "@/lib/tournament/tier-draw";

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
      subtitle="The four brackets the placement rounds sort entrants into. WW goes to Draw A, WL to B, LW to C, LL to D."
      actions={
        <Button size="sm" variant="outline" asChild>
          <Link to="/tournaments/$tournamentId/scores" params={{ tournamentId }}>
            {canEdit ? "Enter results in Scores" : "See all scores"}
          </Link>
        </Button>
      }
    >
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
              ? `${draws.length} bracket${draws.length === 1 ? "" : "s"} · ${championCount} decided`
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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {PLACEMENT_TIERS.map((tierMapping) => {
            const draw = draws.find((entry) => entry.tier === tierMapping.tier);
            const rounds = draw
              ? bracketRounds(categoryTierMatches.filter((match) => match.draw_id === draw.id))
              : new Map<number, TierDrawMatch[]>();

            return (
              <Panel
                key={tierMapping.tier}
                title={`${tierMapping.label} · ${tierMapping.title}`}
                right={
                  <span className="font-score text-t2 text-muted-foreground">
                    {tierMapping.record}
                  </span>
                }
              >
                {!draw ? (
                  <p className="text-sm text-muted-foreground">No entrants in this tier.</p>
                ) : (
                  <div className="space-y-3">
                    <p className="text-t4 text-muted-foreground">{bracketNote(draw)}</p>

                    {draw.champion_id ? (
                      // A decided bracket is a state, and the system's rule is that a state
                      // carries a colour, a glyph and a word - never colour alone. The tint was
                      // here; the glyph was not, so finding which of the four brackets had been
                      // decided meant reading all four. `draws.tsx` already marks the same award
                      // with a `Trophy`, and the other arm of this ternary is already `text-t4`,
                      // so the size follows the branch it is chosen against rather than `text-sm`.
                      //
                      // The glyph inherits the row's ink rather than taking `text-success`.
                      // `--success` is a fill token: `styles.css` states it is not text-safe
                      // at 2.95:1 and that a text use must add an ink twin. No such
                      // twin exists, and no sweep would catch the mistake - axe reads text nodes,
                      // and the 1.4.11 sweep measures selected markers and control edges, not
                      // icons. The measured ink is the one already on the surface.
                      <p className="flex items-center gap-1.5 rounded-md border border-hairline bg-success/10 px-3 py-2 text-t4">
                        <Trophy className="size-3.5 shrink-0" aria-hidden />
                        <span>
                          <span className="font-semibold">Champion:</span> {label(draw.champion_id)}
                        </span>
                      </p>
                    ) : (
                      <p className="text-t4 text-muted-foreground">No champion yet.</p>
                    )}

                    {[...rounds.entries()].map(([round, roundMatches]) => (
                      <div key={round} className="space-y-1">
                        <p className="text-sm font-semibold text-muted-foreground">
                          {roundName(draw.bracket_size, round)}
                        </p>
                        {roundMatches.map((match) => (
                          <TierMatchRow
                            key={match.id}
                            match={match}
                            bracketSize={draw.bracket_size}
                            label={label}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** One match in a bracket. Read-only: scoring lives on the Scores page. */
function TierMatchRow({
  match,
  bracketSize,
  label,
}: {
  match: TierDrawMatch;
  bracketSize: number;
  label: (entrantId: string | null | undefined, fallback?: string) => string;
}) {
  const decided = match.status === "reported" || match.status === "walkover";
  const bye = isByeMatch(match);
  const waiting =
    !bye &&
    match.status === "scheduled" &&
    !isTierMatchReady({ entrantAId: match.entrant_a_id, entrantBId: match.entrant_b_id });
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-hairline px-2 py-1.5">
      <div className="min-w-0 break-words text-sm">
        <span className="font-medium">
          {label(match.entrant_a_id, feederLabel(bracketSize, match.round, match.slot, "a"))}
        </span>
        <span className="mx-1.5 text-muted-foreground">vs</span>
        <span className="font-medium">
          {label(match.entrant_b_id, feederLabel(bracketSize, match.round, match.slot, "b"))}
        </span>
        {decided && !bye ? (
          <span className="ml-2 font-score text-t4 text-muted-foreground">
            {gamesLabel(parseGames(match.games))}
          </span>
        ) : null}
      </div>
      {/* A bye carries status "reported" because that is how the generator stores an
          automatic advance, so rendering the raw status would label it "Completed".
          The marker replaces the pill rather than sitting beside it, and takes over
          the games label too: a bye has no games to show. */}
      {bye ? (
        <ByeMarker />
      ) : waiting ? (
        // An empty future slot is not "Scheduled": nothing can be scheduled until both sides
        // are known, so say what it is waiting on.
        <span className="shrink-0 text-t4 text-muted-foreground">Waiting for teams</span>
      ) : (
        <StatusPill status={match.status} />
      )}
    </div>
  );
}
