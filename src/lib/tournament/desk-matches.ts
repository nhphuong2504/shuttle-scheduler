import type {
  Category,
  Draw,
  DrawMatch,
  PlacementMatch,
  PoolMatch,
  Team,
  TierDraw,
  TierDrawMatch,
} from "./data";
import { indexBy, teamPlayerIds } from "./data";
import type { DeskMatchKind, DeskMatchModel } from "./desk";
import { gamesLabel, parseGames, type GameScore } from "./format";

/**
 * A match as both live screens need to see it.
 *
 * The control desk draws a court board from these and the score desk lists them, so
 * the two must agree row for row about which matches exist, what they are called and
 * which stage owns them. Building them in two places is how the score desk ended up
 * showing "0 matches" for a whole format: its copy of this list only knew about the
 * round-robin tables.
 */
export type DeskMatch = DeskMatchModel & {
  teams: [string | null, string | null];
  tag: string;
  score: string | null;
  initialGames?: GameScore[] | undefined;
  /** Only the score desk needs this, for its per-category filter. */
  categoryId: string;
};

export interface DeskMatchSources {
  poolMatches?: readonly PoolMatch[] | null | undefined;
  drawMatches?: readonly DrawMatch[] | null | undefined;
  draws?: readonly Draw[] | null | undefined;
  placementMatches?: readonly PlacementMatch[] | null | undefined;
  tierMatches?: readonly TierDrawMatch[] | null | undefined;
  tierDraws?: readonly TierDraw[] | null | undefined;
  teams?: readonly Team[] | null | undefined;
  categories?: readonly Category[] | null | undefined;
  /** Entrant id to team id. The placement format stores entrants, not teams. */
  entrantTeam: (entrantId: string | null) => string | null;
}

/**
 * How a placement match is labelled: event code plus round.
 *
 * Which round it is matters to the desk, because a make-up match is the reason one
 * player appears twice in round two and a crossover is not simply a spare qualifier.
 */
function placementTag(match: PlacementMatch, catMap: Map<string, Category | undefined>): string {
  const code = catMap.get(match.category_id)?.code;
  const round =
    match.stage === "round1"
      ? "R1"
      : match.is_makeup
        ? "R2 make-up"
        : match.is_crossover
          ? "R2 crossover"
          : "R2";
  return [code, round].filter(Boolean).join(" ");
}

/**
 * Every row the desk and the score desk should see, from every format's tables.
 *
 * The round-robin rows carry team ids directly. The placement rows carry **entrant**
 * ids, so each side is resolved through the entrant before its players can be, and
 * the card shows the entrant's team exactly as the Placement tab does. A knockout
 * fixture whose bracket is not decided yet has no entrant at all, and resolving to
 * "TBC" is correct rather than an error.
 *
 * Byes are dropped: a bye has nothing to score and no court to sit on, and leaving
 * it in makes the score desk offer a result entry for a match that is already
 * decided.
 */
export function buildDeskMatches(sources: DeskMatchSources): DeskMatch[] {
  const teamMap = indexBy(sources.teams ?? []);
  const catMap = indexBy(sources.categories ?? []);
  const playersOf = (teamIds: readonly (string | null)[]) =>
    teamIds.flatMap((id) => (id ? teamPlayerIds(teamMap.get(id)) : []));
  const entrantTeamOf = (entrantId: string | null): string | null =>
    entrantId ? sources.entrantTeam(entrantId) : null;
  const tierOf = (drawId: string) =>
    (sources.tierDraws ?? []).find((draw) => draw.id === drawId)?.tier ?? "";
  const categoryOfDraw = (drawId: string) =>
    (sources.tierDraws ?? []).find((draw) => draw.id === drawId)?.category_id ?? "";

  return [
    ...(sources.poolMatches ?? []).map((match): DeskMatch => {
      const teams: [string | null, string | null] = [match.team_a_id, match.team_b_id];
      return {
        id: match.id,
        kind: "pool" as DeskMatchKind,
        courtId: match.court_id,
        status: match.status,
        startedAt: match.started_at,
        endedAt: match.ended_at,
        scheduled: match.scheduled_time,
        teams,
        playerIds: playersOf(teams),
        tag: catMap.get(match.category_id)?.code ?? "",
        categoryId: match.category_id,
        score: match.status === "reported" ? `${match.score_a}-${match.score_b}` : null,
        initialGames:
          match.status === "reported" && match.score_a != null && match.score_b != null
            ? [{ a: match.score_a, b: match.score_b }]
            : undefined,
      };
    }),
    ...(sources.drawMatches ?? []).map((match): DeskMatch => {
      const teams: [string | null, string | null] = [match.team_a_id, match.team_b_id];
      return {
        id: match.id,
        kind: "draw" as DeskMatchKind,
        courtId: match.court_id,
        status: match.status,
        startedAt: match.started_at,
        endedAt: match.ended_at,
        scheduled: match.scheduled_time,
        teams,
        playerIds: playersOf(teams),
        tag: `Draw ${tierOf(match.draw_id)}`,
        categoryId: categoryOfDraw(match.draw_id),
        score: match.status === "reported" ? gamesLabel(parseGames(match.games)) : null,
        initialGames: match.status === "reported" ? parseGames(match.games) : undefined,
      };
    }),
    ...(sources.placementMatches ?? []).map((match): DeskMatch => {
      const teams: [string | null, string | null] = [
        entrantTeamOf(match.entrant_a_id),
        entrantTeamOf(match.entrant_b_id),
      ];
      return {
        id: match.id,
        kind: "placement" as DeskMatchKind,
        courtId: match.court_id,
        status: match.status,
        startedAt: match.started_at,
        endedAt: match.ended_at,
        scheduled: match.scheduled_time,
        teams,
        playerIds: playersOf(teams),
        tag: placementTag(match, catMap),
        categoryId: match.category_id,
        score: match.status === "reported" ? gamesLabel(parseGames(match.games)) : null,
        initialGames: match.status === "reported" ? parseGames(match.games) : undefined,
      };
    }),
    ...(sources.tierMatches ?? [])
      .filter((match) => !match.is_bye)
      .map((match): DeskMatch => {
        const teams: [string | null, string | null] = [
          entrantTeamOf(match.entrant_a_id),
          entrantTeamOf(match.entrant_b_id),
        ];
        return {
          id: match.id,
          kind: "tier" as DeskMatchKind,
          courtId: match.court_id,
          status: match.status,
          startedAt: match.started_at,
          endedAt: match.ended_at,
          scheduled: match.scheduled_time,
          teams,
          playerIds: playersOf(teams),
          tag: `Tier ${tierOf(match.draw_id)}`,
          categoryId: categoryOfDraw(match.draw_id),
          score: match.status === "reported" ? gamesLabel(parseGames(match.games)) : null,
          initialGames: match.status === "reported" ? parseGames(match.games) : undefined,
        };
      }),
  ];
}
