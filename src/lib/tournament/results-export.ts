import { PLACEMENT_TIERS } from "@/lib/tournament/competition-format";
import { roundName } from "@/lib/tournament/draws";
import { compareEventOrder } from "@/lib/tournament/event-order";
import { gamesLabel, parseGames } from "@/lib/tournament/format";
import {
  indexBy,
  teamLabel,
  type Category,
  type PlacementEntrant,
  type PlacementMatch,
  type Player,
  type Team,
  type TierDraw,
  type TierDrawMatch,
} from "@/lib/tournament/data";

/**
 * A finished tournament's results as a spreadsheet: one row per match that exists, in the
 * order a person reads them (event, placement rounds, then the A/B/C/D brackets).
 *
 * Pure and built from rows the workspace already holds, so the file cannot disagree with the
 * screens: the same `teamLabel`, the same score wording, and the same `champion_id` the
 * Knockout page reads. Waiting bracket slots (no entrants yet) and byes are left out, because
 * they are not matches anyone played.
 */
export const RESULTS_CSV_HEADER = [
  "Event",
  "Stage",
  "Round",
  "Side A",
  "Side B",
  "Score",
  "Winner",
  "Status",
] as const;

/** One CSV field, quoted when it holds a comma, quote or line break. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface ResultsExportInput {
  categories: readonly Category[];
  entrants: readonly PlacementEntrant[];
  teams: readonly Team[];
  players: readonly Player[];
  placementMatches: readonly PlacementMatch[];
  draws: readonly TierDraw[];
  tierMatches: readonly TierDrawMatch[];
}

const STATUS_WORDS: Record<string, string> = {
  reported: "Played",
  walkover: "Walkover",
  void: "Void",
};

function statusWord(status: string): string {
  return STATUS_WORDS[status] ?? "Not played";
}

export function buildResultsCsv(input: ResultsExportInput): string {
  const teamMap = indexBy(input.teams);
  const playerMap = indexBy(input.players);
  const teamOfEntrant = new Map(input.entrants.map((entrant) => [entrant.id, entrant.team_id]));
  const name = (entrantId: string | null): string => {
    if (!entrantId) return "";
    const teamId = teamOfEntrant.get(entrantId);
    return teamId ? teamLabel(teamMap.get(teamId), playerMap) : "";
  };
  const score = (status: string, games: unknown): string =>
    status === "reported" ? gamesLabel(parseGames(games)) : "";

  const rows: string[][] = [];
  // The standard event order, so a spreadsheet of results reads MS, WS, MD, WD, XD whatever
  // order the events were configured in - the same order the organiser's pages use.
  const categories = [...input.categories].sort(compareEventOrder);

  for (const category of categories) {
    const event = `${category.code} ${category.name}`;

    const placement = input.placementMatches
      .filter((match) => match.category_id === category.id)
      .sort((a, b) => a.stage.localeCompare(b.stage) || a.generation_key.localeCompare(b.generation_key, undefined, { numeric: true }));
    for (const match of placement) {
      rows.push([
        event,
        "Placement",
        match.stage === "round1" ? "Round 1" : match.stage === "round2" ? "Round 2" : match.stage,
        name(match.entrant_a_id),
        name(match.entrant_b_id),
        score(match.status, match.games),
        name(match.winner_id),
        statusWord(match.status),
      ]);
    }

    for (const tier of PLACEMENT_TIERS) {
      const draw = input.draws.find(
        (entry) => entry.category_id === category.id && entry.tier === tier.tier,
      );
      if (!draw) continue;
      const matches = input.tierMatches
        .filter((match) => match.draw_id === draw.id && !match.is_bye)
        .filter((match) => match.entrant_a_id && match.entrant_b_id)
        .sort((a, b) => a.round - b.round || a.slot - b.slot);
      for (const match of matches) {
        rows.push([
          event,
          tier.label,
          roundName(draw.bracket_size, match.round),
          name(match.entrant_a_id),
          name(match.entrant_b_id),
          score(match.status, match.games),
          name(match.winner_id),
          statusWord(match.status),
        ]);
      }
    }
  }

  return [RESULTS_CSV_HEADER as readonly string[], ...rows]
    .map((row) => row.map(csvField).join(","))
    .join("\r\n");
}

export interface ResultCounts {
  played: number;
  walkovers: number;
  unplayed: number;
}

/**
 * What became of the matches that exist, for the wrap-up's one-line summary. The same rows
 * the CSV lists, so the number on screen and the number of lines in the file agree.
 */
export function resultCounts(input: ResultsExportInput): ResultCounts {
  const counts: ResultCounts = { played: 0, walkovers: 0, unplayed: 0 };
  const tally = (status: string) => {
    if (status === "reported") counts.played++;
    else if (status === "walkover") counts.walkovers++;
    else if (status !== "void") counts.unplayed++;
  };
  for (const match of input.placementMatches) tally(match.status);
  for (const match of input.tierMatches) {
    if (!match.is_bye && match.entrant_a_id && match.entrant_b_id) tally(match.status);
  }
  return counts;
}
