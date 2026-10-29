import { useCallback, useMemo } from "react";

import { buildDeskMatches } from "@/lib/tournament/desk-matches";
import {
  indexBy,
  teamLabel,
  useCategories,
  useCourts,
  useDrawMatches,
  useDraws,
  usePlacementEntrants,
  usePlacementMatches,
  usePlayers,
  usePoolMatches,
  useRealtimeRefresh,
  useScopedTournament,
  useTeams,
  useTierDrawMatches,
  useTierDraws,
  useTournamentDayCourts,
  useTournamentDays,
} from "@/lib/tournament/data";

/**
 * Everything the reader's pages read, assembled once.
 *
 * The rows are `buildDeskMatches`, the same list the Desk and Scores draw, so a reader's page
 * cannot list a match the board does not have. It also owns the live channel, so every reader
 * page can say how fresh it is.
 */
export function useReaderMatches() {
  const tournament = useScopedTournament();
  const live = useRealtimeRefresh();
  const categoriesQuery = useCategories();
  const courtsQuery = useCourts();
  const teamsQuery = useTeams();
  const playersQuery = usePlayers();
  const poolMatchesQuery = usePoolMatches();
  const drawsQuery = useDraws();
  const drawMatchesQuery = useDrawMatches();
  const entrantsQuery = usePlacementEntrants();
  const placementQuery = usePlacementMatches();
  const tierDrawsQuery = useTierDraws();
  const tierMatchesQuery = useTierDrawMatches();
  const daysQuery = useTournamentDays();
  // Which courts each day plays on. Not waited for: without it every court is the day's, as the planner reads it.
  const { data: dayCourts } = useTournamentDayCourts(tournament?.id);
  const queries = [
    categoriesQuery,
    courtsQuery,
    teamsQuery,
    playersQuery,
    poolMatchesQuery,
    drawsQuery,
    drawMatchesQuery,
    entrantsQuery,
    placementQuery,
    tierDrawsQuery,
    tierMatchesQuery,
    daysQuery,
  ];
  const { data: categories } = categoriesQuery;
  const { data: courts } = courtsQuery;
  const { data: teams } = teamsQuery;
  const { data: players } = playersQuery;
  const { data: poolMatches } = poolMatchesQuery;
  const { data: draws } = drawsQuery;
  const { data: drawMatches } = drawMatchesQuery;
  const { data: entrants } = entrantsQuery;
  const { data: placementMatches } = placementQuery;
  const { data: tierDraws } = tierDrawsQuery;
  const { data: tierDrawMatches } = tierMatchesQuery;
  const { data: days } = daysQuery;

  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const playerMap = useMemo(() => indexBy(players), [players]);
  const courtMap = useMemo(() => indexBy(courts), [courts]);
  const catMap = useMemo(() => indexBy(categories), [categories]);
  const entrantMap = useMemo(() => indexBy(entrants), [entrants]);

  const entrantTeam = useCallback(
    (entrantId: string | null) => (entrantId ? (entrantMap.get(entrantId)?.team_id ?? null) : null),
    [entrantMap],
  );

  const matches = useMemo(
    () =>
      buildDeskMatches({
        format: tournament?.format,
        poolMatches,
        drawMatches,
        draws,
        placementMatches,
        tierMatches: tierDrawMatches,
        tierDraws,
        teams,
        categories,
        entrantTeam,
      }),
    [
      tournament?.format,
      poolMatches,
      drawMatches,
      draws,
      placementMatches,
      tierDrawMatches,
      tierDraws,
      teams,
      categories,
      entrantTeam,
    ],
  );

  const label = useCallback(
    (teamId: string | null) => teamLabel(teamId ? teamMap.get(teamId) : undefined, playerMap),
    [teamMap, playerMap],
  );
  const courtName = useCallback(
    (courtId: string | null) => {
      if (!courtId) return null;
      const number = courtMap.get(courtId)?.number;
      return number != null ? `Court ${number}` : null;
    },
    [courtMap],
  );

  /**
   * Three outcomes, never a fourth. Every match read is enabled with the tournament, so all of
   * them settle: until they do the page is loading rather than empty. A read that fails with
   * nothing loaded is an error with a retry; one that fails on a background refetch keeps what
   * was loaded on screen and marks it stale - on venue wifi that is the ordinary case, and a
   * board that vanished behind an error would be worse than a slightly old one.
   */
  const hasData = !!tournament && !!teams && !!players && !!placementMatches && !!tierDrawMatches;
  const failed = queries.some((query) => query.isError);
  const error = failed && !hasData;
  const stale = failed && hasData;
  const loading = !hasData && !failed;

  return {
    tournament,
    live,
    matches,
    teams: teams ?? [],
    players: players ?? [],
    categories: categories ?? [],
    tierDraws: tierDraws ?? [],
    entrants: entrants ?? [],
    days: days ?? [],
    courts: courts ?? [],
    dayCourts: dayCourts ?? [],
    teamMap,
    playerMap,
    catMap,
    label,
    courtName,
    loading,
    error,
    stale,
    retry: () => {
      for (const query of queries) if (query.isError) void query.refetch();
    },
  };
}
