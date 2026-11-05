import { PLACEMENT_TIERS, type DrawTier } from "./competition-format";
import type { Court } from "./data";
import { matchStartMs } from "./day-scope";
import type { DeskMatch } from "./desk-matches";
import { sideThatWon } from "./match-winner";
import { courtsForDay } from "./scheduling/day-plan";

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

/** Matches in the order they are played: by start, else scheduled, time; untimed last. */
export function inPlayingOrder(matches: readonly DeskMatch[]): DeskMatch[] {
  return [...matches].sort(startOrder);
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

export interface TimeGroup {
  /** The published start every match in the group shares, or null for untimed matches. */
  scheduled: string | null;
  matches: DeskMatch[];
  /** The event and round when every match in the group has the same one, so a row need not repeat it. */
  shared: Pick<DeskMatch, "tag" | "roundTag"> | null;
}

/**
 * A list in playing order, cut into runs that start at the same published time.
 *
 * A hall calls a wave of matches at once - six at 10:25 - and listing each with its own
 * "10:25" and its own "MS R2" was the noise that made the reader's lists hard to scan. Only
 * neighbours are joined, so the order of the list is never changed by the grouping.
 */
export function groupByTime(matches: readonly DeskMatch[]): TimeGroup[] {
  const groups: TimeGroup[] = [];
  for (const match of matches) {
    const last = groups[groups.length - 1];
    if (last && last.scheduled === match.scheduled) last.matches.push(match);
    else groups.push({ scheduled: match.scheduled, matches: [match], shared: null });
  }
  for (const group of groups) {
    const [first] = group.matches;
    const same = group.matches.every((m) => m.tag === first!.tag && m.roundTag === first!.roundTag);
    group.shared = same && first!.tag ? { tag: first!.tag, roundTag: first!.roundTag } : null;
  }
  return groups;
}

export interface HallCourt {
  /** Null for a match on court somewhere this day's courts do not name. */
  court: Pick<Court, "id" | "number"> | null;
  match: DeskMatch | null;
}

/**
 * The hall as a spectator stands in it: every court the day plays on, by number, each with
 * the match on it or nothing.
 *
 * A board of only the busy courts reshuffled itself whenever a match started or finished;
 * keeping every court in its place means a realtime update changes a tile, never the layout.
 * A match on a court the day does not list is still shown, after the hall, rather than lost.
 */
export function hallBoard(
  courts: readonly Court[],
  dayCourtIds: ReadonlySet<string>,
  live: readonly DeskMatch[],
): HallCourt[] {
  const hall = courtsForDay(courts, dayCourtIds).sort((a, b) => a.number - b.number);
  const byCourt = new Map(live.flatMap((m) => (m.courtId ? [[m.courtId, m] as const] : [])));
  const placed = new Set<string>();
  const tiles: HallCourt[] = hall.map((court) => {
    const match = byCourt.get(court.id) ?? null;
    if (match) placed.add(match.id);
    return { court, match };
  });
  for (const match of live) {
    if (placed.has(match.id)) continue;
    const court = courts.find((c) => c.id === match.courtId) ?? null;
    tiles.push({ court, match });
  }
  return tiles;
}
