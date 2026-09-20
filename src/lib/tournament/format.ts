import {
  gamesNeededToWin,
  isScoringRuleValid,
  LEGACY_GAME_RULE,
  LEGACY_KNOCKOUT_RULE,
  type ScoringRule,
} from "./scoring";

export function timeLabel(
  value: string | Date | null | undefined,
  timezone?: string | undefined,
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  const options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  if (timezone) options.timeZone = timezone;
  try {
    return d.toLocaleTimeString([], options);
  } catch {
    // An unrecognised timezone should never blank out a time; fall back to the
    // runtime zone rather than throwing inside render.
    delete options.timeZone;
    return d.toLocaleTimeString([], options);
  }
}

export function minutesSince(
  value: string | Date | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!value) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  return Math.floor((now - d.getTime()) / 60000);
}

/**
 * A local date *and* time, e.g. "Thu 17 Sep, 18:20".
 *
 * The finish forecast is an instant and it is read across a day boundary — a
 * tournament that overruns finishes after midnight — so a bare time would be
 * ambiguous. Unlike `dayDateLabel`, this takes a real instant rather than a
 * `YYYY-MM-DD`, because a forecast is always an absolute moment.
 */
export function dateTimeLabel(
  value: string | Date | number | null | undefined,
  timezone?: string | undefined,
): string {
  if (value == null) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  if (timezone) options.timeZone = timezone;
  try {
    return d.toLocaleString([], options);
  } catch {
    // An unrecognised timezone should never blank out a finish; fall back to the
    // runtime zone rather than throwing inside render.
    delete options.timeZone;
    return d.toLocaleString([], options);
  }
}

/**
 * A short local date for a day heading, e.g. "Thu, Sep 17" or "Thu 17 Sep"
 * depending on the locale.
 *
 * Takes the `YYYY-MM-DD` the database stores and parses it at local midnight rather
 * than as an instant: `new Date("2026-09-17")` is UTC midnight, which reads as the
 * previous day everywhere west of Greenwich.
 *
 * The date is returned unchanged if it does not parse, so a malformed row shows the
 * raw value instead of "Invalid Date".
 */
export function dayDateLabel(date: string): string {
  const at = new Date(`${date}T00:00:00`);
  if (Number.isNaN(at.getTime())) return date;
  return at.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export interface GameScore {
  a: number;
  b: number;
}

export function parseGames(value: unknown): GameScore[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (g): g is { a: number; b: number } => !!g && typeof g === "object" && "a" in g && "b" in g,
    )
    .map((g) => ({ a: Number(g.a), b: Number(g.b) }));
}

/**
 * A game is legal when the winner reached at least `gamesTo` and won by at least
 * `winBy`. This mirrors the rule enforced by the database in `report_draw_result`,
 * so the client and the server always agree about a valid result.
 */
export function isLegalGameScoreFor(a: number, b: number, rule: ScoringRule): boolean {
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a < 0 || b < 0 || a === b) return false;
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  return high >= rule.gamesTo && high - low >= rule.winBy;
}

/**
 * Decides a match under a rule, or null when the games are not a complete and
 * legal result. A side must win `gamesNeededToWin` games and no games may be
 * entered after the match is already decided.
 */
export function gamesWinnerFor(games: GameScore[], rule: ScoringRule): "a" | "b" | null {
  if (!isScoringRuleValid(rule)) return null;
  const needed = gamesNeededToWin(rule);
  if (games.length < needed || games.length > rule.bestOf) return null;

  let a = 0;
  let b = 0;
  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    if (!game || !isLegalGameScoreFor(game.a, game.b, rule)) return null;
    if (game.a > game.b) a++;
    else b++;
    if ((a >= needed || b >= needed) && i < games.length - 1) return null;
  }
  if (a >= needed && b < needed) return "a";
  if (b >= needed && a < needed) return "b";
  return null;
}

/**
 * The legacy rule pinned to what `report_pool_result` enforces in the database,
 * so the score dialog and the database always agree about a valid group result.
 */
export function isLegalGameScore(a: number, b: number): boolean {
  return isLegalGameScoreFor(a, b, LEGACY_GAME_RULE);
}

export function gamesWinner(games: GameScore[]): "a" | "b" | null {
  return gamesWinnerFor(games, LEGACY_KNOCKOUT_RULE);
}

export function gamesLabel(games: GameScore[]): string {
  if (!games.length) return "—";
  return games.map((g) => `${g.a}-${g.b}`).join(", ");
}
