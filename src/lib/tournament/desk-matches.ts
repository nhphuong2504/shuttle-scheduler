import { isSupportedFormat } from "./competition-format";
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
import { roundName } from "./draws";
import { gamesLabel, parseGames, type GameScore } from "./format";
import { isTierMatchReady } from "./tier-draw";

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
  /**
   * The knockout round alone ("Semifinal"), for a surface that already names the draw.
   *
   * The Control desk prints `tag` in full - the event and draw are not on the tile - but the
   * Score desk groups tier matches under "MS · Draw A", so repeating that in every row is
   * noise and the round is the part the group header does not carry. Undefined for every kind
   * that is not a tier bracket match.
   */
  roundTag?: string | undefined;
  score: string | null;
  initialGames?: GameScore[] | undefined;
  /** Only the score desk needs this, for its per-category filter. */
  categoryId: string;
};

export interface DeskMatchSources {
  /**
   * The tournament's stored format.
   *
   * The four legacy sources below are listed only for a tournament that stored the
   * round-robin format; see `isSupportedFormat`. Optional so a caller that has no
   * tournament yet still gets the legacy rows rather than silently nothing.
   */
  format?: string | null | undefined;
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
 * How a knockout match is labelled: event code, draw and round.
 *
 * The board used to print only the draw - "Tier A" - which named neither the event it
 * belonged to (every event has a Draw A) nor the round inside the bracket, so a semifinal
 * and a final read identically on the tile. It now mirrors `placementTag`'s shape and uses
 * the same round vocabulary the Knockout tab prints, so one thing has one name across the
 * app rather than "Tier A" here and "Draw A" everywhere else.
 */
function tierTag(
  draw: TierDraw | undefined,
  round: number,
  catMap: Map<string, Category | undefined>,
): string {
  if (!draw) return "";
  const code = catMap.get(draw.category_id)?.code;
  return [code, `Draw ${draw.tier}`, roundName(draw.bracket_size, round)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Every row the desk and the score desk should see, from the tables the tournament's
 * own format uses.
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
 *
 * The legacy round-robin sources are listed only for a tournament that stored that
 * format. Both live surfaces read this one list, so the exclusion belongs here rather
 * than in either page: a page that filtered its own copy is how the score desk ended
 * up disagreeing with the board in the first place.
 */
export function buildDeskMatches(sources: DeskMatchSources): DeskMatch[] {
  const teamMap = indexBy(sources.teams ?? []);
  const catMap = indexBy(sources.categories ?? []);
  const playersOf = (teamIds: readonly (string | null)[]) =>
    teamIds.flatMap((id) => (id ? teamPlayerIds(teamMap.get(id)) : []));
  const entrantTeamOf = (entrantId: string | null): string | null =>
    entrantId ? sources.entrantTeam(entrantId) : null;
  const drawOf = (drawId: string): TierDraw | undefined =>
    (sources.tierDraws ?? []).find((draw) => draw.id === drawId);
  const tierOf = (drawId: string) => drawOf(drawId)?.tier ?? "";
  const categoryOfDraw = (drawId: string) => drawOf(drawId)?.category_id ?? "";

  /** False for the supported format, whose pools and pooled draws are leftovers. */
  const roundRobin = !isSupportedFormat(sources.format);

  const poolRows: DeskMatch[] = roundRobin
    ? (sources.poolMatches ?? []).map((match): DeskMatch => {
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
      })
    : [];

  const drawRows: DeskMatch[] = roundRobin
    ? (sources.drawMatches ?? []).map((match): DeskMatch => {
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
      })
    : [];

  return [
    ...poolRows,
    ...drawRows,
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
      // The bracket exists in full from its draw, so a slot still waiting on a feeder is
      // not a match yet: the desk only lists fixtures whose two sides are known.
      .filter((match) =>
        isTierMatchReady({
          entrantAId: match.entrant_a_id,
          entrantBId: match.entrant_b_id,
          isBye: match.is_bye,
        }),
      )
      .map((match): DeskMatch => {
        const teams: [string | null, string | null] = [
          entrantTeamOf(match.entrant_a_id),
          entrantTeamOf(match.entrant_b_id),
        ];
        const draw = drawOf(match.draw_id);
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
          tag: tierTag(draw, match.round, catMap),
          roundTag: draw ? roundName(draw.bracket_size, match.round) : undefined,
          categoryId: draw?.category_id ?? "",
          score: match.status === "reported" ? gamesLabel(parseGames(match.games)) : null,
          initialGames: match.status === "reported" ? parseGames(match.games) : undefined,
        };
      }),
  ];
}
