import { PLACEMENT_TIERS, type DrawTier } from "./competition-format";
import { matchStartMs } from "./day-scope";
import type { DeskMatch } from "./desk-matches";
import { sideThatWon } from "./match-winner";

/**
 * What the reader's pages ask of the match list, as pure answers.
 *
 * The Watch screens (see `docs/design-principles.md`) are organised around a reader's
 * questions rather than the operator's order of work: what is on court now, what comes next,
 * what just finished, and - for one person - when do I play and where does it lead. The rows
 * are the same `DeskMatch` rows the Desk and Scores build, so the three cannot disagree about
 * which matches exist; this module only sorts and selects them.
 */

const DONE = new Set(["reported", "walkover"]);

export function isFinished(match: Pick<DeskMatch, "status">): boolean {
  return DONE.has(match.status);
}

function finishedMs(match: DeskMatch): number {
  const raw = match.endedAt ?? match.reportedAt ?? match.startedAt ?? match.scheduled;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function startOrder(a: DeskMatch, b: DeskMatch): number {
  const x = matchStartMs(a) ?? Number.POSITIVE_INFINITY;
  const y = matchStartMs(b) ?? Number.POSITIVE_INFINITY;
  if (x !== y) return x < y ? -1 : 1;
  return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
}

export interface NowBoard {
  /** On court right now, longest-running first. */
  live: DeskMatch[];
  /** Not started yet, in playing order. Only matches with a court or a time are listed. */
  upNext: DeskMatch[];
  /** Finished, most recent first. */
  justFinished: DeskMatch[];
}

/**
 * One day's matches, split the way a spectator reads a hall.
 *
 * Untimed and unassigned matches are left out of "up next": a fixture with neither a court nor
 * a time is a plan, not something a person standing courtside can go and watch.
 */
export function nowBoard(
  dayMatches: readonly DeskMatch[],
  limits: { upNext: number; justFinished: number },
): NowBoard {
  const live = dayMatches.filter((m) => m.status === "in-progress").sort(startOrder);
  const upNext = dayMatches
    .filter((m) => m.status === "scheduled" && (m.courtId || m.scheduled))
    .sort(startOrder)
    .slice(0, limits.upNext);
  const justFinished = dayMatches
    .filter(isFinished)
    .sort((a, b) => finishedMs(b) - finishedMs(a))
    .slice(0, limits.justFinished);
  return { live, upNext, justFinished };
}

/** Every match one player is in, in playing order. */
export function matchesOfPlayer(matches: readonly DeskMatch[], playerId: string): DeskMatch[] {
  return matches.filter((m) => m.playerIds.includes(playerId)).sort(startOrder);
}

/**
 * The match a player should be thinking about: the one on court, else the next unplayed one.
 * Null once everything they are in is finished.
 */
export function nextMatchOf(playerMatches: readonly DeskMatch[]): DeskMatch | null {
  return (
    playerMatches.find((m) => m.status === "in-progress") ??
    playerMatches.find((m) => m.status === "scheduled") ??
    null
  );
}

export type MatchOutcome = "won" | "lost" | "walkover" | null;

/**
 * How a finished match went for the side holding `teamId`.
 *
 * A walkover has no games, so its winner is not readable from the score and is reported as
 * such rather than guessed.
 */
export function outcomeFor(match: DeskMatch, teamId: string): MatchOutcome {
  if (match.status === "walkover") return "walkover";
  if (match.status !== "reported") return null;
  const won = sideThatWon(match.initialGames);
  if (!won) return null;
  const mine = match.teams[0] === teamId ? "a" : match.teams[1] === teamId ? "b" : null;
  if (!mine) return null;
  return won === mine ? "won" : "lost";
}

export interface PlacementPath {
  /** The placement results so far, in playing order. */
  results: ("won" | "lost")[];
  /** The draw the two results lead to, once both are in. */
  draw: DrawTier | null;
  /**
   * Where the one remaining placement match leads, when exactly one result is in:
   * winning it gives `ifWin`, losing it `ifLose`.
   */
  next: { ifWin: DrawTier; ifLose: DrawTier } | null;
}

function tierOfRecord(record: string): DrawTier | null {
  return PLACEMENT_TIERS.find((entry) => entry.record === record)?.tier ?? null;
}

/**
 * The two-round placement path for one entry: WW to A, WL to B, LW to C, LL to D.
 *
 * Read from the results in the order the matches were played, which is the order the format
 * reads them in. A walkover or an unreadable result stops the path rather than being counted
 * as either, so the page never names a draw the database has not.
 */
export function placementPath(
  placementMatches: readonly DeskMatch[],
  teamId: string,
): PlacementPath {
  const results: ("won" | "lost")[] = [];
  for (const match of [...placementMatches].sort(startOrder)) {
    if (!isFinished(match)) break;
    const outcome = outcomeFor(match, teamId);
    if (outcome !== "won" && outcome !== "lost") break;
    results.push(outcome);
  }
  const letters = results.map((r) => (r === "won" ? "W" : "L")).join("");
  if (results.length >= 2)
    return { results: results.slice(0, 2), draw: tierOfRecord(letters.slice(0, 2)), next: null };
  if (results.length === 1) {
    const ifWin = tierOfRecord(`${letters}W`);
    const ifLose = tierOfRecord(`${letters}L`);
    return { results, draw: null, next: ifWin && ifLose ? { ifWin, ifLose } : null };
  }
  return { results, draw: null, next: null };
}
