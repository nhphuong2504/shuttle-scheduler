import { Link } from "@tanstack/react-router";
import { Trophy } from "lucide-react";
import { useMemo } from "react";

import { Panel } from "@/components/app-shell";
import { PLACEMENT_TIERS } from "@/lib/tournament/competition-format";
import {
  indexBy,
  teamLabel,
  useCategories,
  usePlacementEntrants,
  usePlayers,
  useTeams,
  useTierDraws,
} from "@/lib/tournament/data";

/**
 * Who won each event: the champion of every decided bracket, event by event.
 *
 * A finished tournament's own page said only that it had finished. The answer a visitor came
 * for - who won - was three clicks away on Knockout. This reads the same `champion_id` the
 * bracket's champion card does, so the two cannot disagree, and draws nothing until at least
 * one bracket is decided.
 */
export function TournamentResults({ tournamentId }: { tournamentId: string }) {
  const { data: categories } = useCategories();
  const { data: draws } = useTierDraws();
  const { data: entrants } = usePlacementEntrants();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();

  const results = useMemo(() => {
    const teamMap = indexBy(teams);
    const playerMap = indexBy(players);
    const teamOfEntrant = new Map((entrants ?? []).map((entrant) => [entrant.id, entrant.team_id]));
    const name = (entrantId: string) => {
      const teamId = teamOfEntrant.get(entrantId);
      return teamId ? teamLabel(teamMap.get(teamId), playerMap) : null;
    };
    return (categories ?? [])
      .map((category) => ({
        category,
        winners: PLACEMENT_TIERS.flatMap((tier) => {
          const draw = (draws ?? []).find(
            (entry) => entry.category_id === category.id && entry.tier === tier.tier,
          );
          const champion = draw?.champion_id ? name(draw.champion_id) : null;
          return champion ? [{ label: tier.label, champion }] : [];
        }),
      }))
      .filter((row) => row.winners.length > 0);
  }, [categories, draws, entrants, teams, players]);

  if (!results.length) return null;

  return (
    <Panel
      title="Results"
      right={
        <Link
          to="/tournaments/$tournamentId/knockout"
          params={{ tournamentId }}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-primary-ink hover:underline"
        >
          See the brackets
        </Link>
      }
    >
      <ul className="grid gap-3 sm:grid-cols-2">
        {results.map(({ category, winners }) => (
          <li key={category.id} className="rounded-lg border border-hairline p-3">
            <p className="font-display text-base font-bold">
              {category.code} — {category.name}
            </p>
            <dl className="mt-2 space-y-1.5 text-sm">
              {winners.map((winner, index) => (
                <div key={winner.label} className="flex items-baseline gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">
                    {index === 0 ? (
                      <Trophy aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
                    ) : null}
                    {winner.label}
                  </dt>
                  <dd className={index === 0 ? "font-semibold" : undefined}>{winner.champion}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
