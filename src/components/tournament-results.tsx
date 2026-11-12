import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Trophy } from "lucide-react";
import { useId, useMemo } from "react";

import { PLACEMENT_TIERS } from "@/lib/tournament/competition-format";
import {
  indexBy,
  teamPlayerIds,
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
  const headingId = useId();
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
      return teamId
        ? teamPlayerIds(teamMap.get(teamId)).map((id) => playerMap.get(id)?.name ?? "Unknown")
        : [];
    };
    return (categories ?? [])
      .map((category) => ({
        category,
        winners: PLACEMENT_TIERS.flatMap((tier) => {
          const draw = (draws ?? []).find(
            (entry) => entry.category_id === category.id && entry.tier === tier.tier,
          );
          const champion = draw?.champion_id ? name(draw.champion_id) : [];
          return champion.length ? [{ label: tier.label, champion }] : [];
        }),
      }))
      .filter((row) => row.winners.length > 0);
  }, [categories, draws, entrants, teams, players]);

  if (!results.length) return null;

  return (
    <section aria-labelledby={headingId} className="rounded-xl bg-surface px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <h2
          id={headingId}
          className="flex items-center gap-2 font-display text-lg font-bold tracking-tight"
        >
          <Trophy aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          Draw champions
        </h2>
        <Link
          to="/tournaments/$tournamentId/knockout"
          params={{ tournamentId }}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-primary-ink underline-offset-4 hover:underline"
        >
          View draws
          <ArrowUpRight aria-hidden className="size-4" />
        </Link>
      </div>
      <ul className="grid gap-x-8 sm:grid-cols-2">
        {results.map(({ category, winners }) => (
          <li key={category.id} className="min-w-0 border-t border-hairline py-2">
            <h3 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-display text-base font-bold">
              <span className="min-w-0 [overflow-wrap:anywhere]">{category.name}</span>
              <span className="min-w-0 font-score text-sm font-medium tracking-normal text-muted-foreground [overflow-wrap:anywhere]">
                {category.code}
              </span>
            </h3>
            <dl className="mt-1.5 space-y-1">
              {winners.map((winner) => (
                <div
                  key={winner.label}
                  className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-x-2"
                >
                  <dt className="text-sm text-muted-foreground">{winner.label}</dt>
                  <dd className="text-base font-medium leading-snug sm:text-sm sm:leading-tight">
                    {winner.champion.map((player, index) => (
                      <span key={index} className="block [overflow-wrap:anywhere] sm:inline">
                        {player}
                        {index < winner.champion.length - 1 ? (
                          <span className="hidden sm:inline"> / </span>
                        ) : null}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
