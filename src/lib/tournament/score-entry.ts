/**
 * Reading what the desk typed into the score box.
 *
 * The dialog's job is not to decide whether a result is legal - `gamesWinnerFor` and the
 * database already do, and they must keep doing it. Its job is to turn "the Save button is
 * dead" into a sentence a moderator can act on, without ever sending the database a payload
 * that means something different from what is on screen.
 *
 * Two rules come from that:
 *
 *   A blank row in the middle is a mistake, not a deletion. Filtering incomplete rows out
 *   used to collapse `21-19, (blank), 21-19` into a legal two-game win, which recorded a
 *   result nobody entered. Only *trailing* blanks are ignored, because those are how a
 *   best-of-three looks when the match ended in two.
 *
 *   The result is read from the same `gamesWinnerFor` the database path is built on, so the
 *   button and the server agree. This module only explains a refusal; it never widens one.
 */

import { gamesWinnerFor, isLegalGameScoreFor, type GameScore } from "./format";
import { gamePointCap, gamesNeededToWin, isScoringRuleValid, type ScoringRule } from "./scoring";

/** One game row exactly as it is held in the form. Digits only, either side may be blank. */
export interface ScoreRow {
  a: string;
  b: string;
}

export interface ScoreEntry {
  /** The complete games that would be sent, with trailing blanks dropped. */
  games: GameScore[];
  /** Why this cannot be saved, in words for the person at the desk. Null when it can. */
  problem: string | null;
  /** The row the problem is about, so the field can be marked. Null when it is not one row. */
  problemRow: number | null;
  /** The side the result decides, or null while it does not decide one. */
  winner: "a" | "b" | null;
  /** Games won by each side, for the confirmation line. */
  winsA: number;
  winsB: number;
}

/**
 * Keeps digits and drops everything else, and holds at most two of them.
 *
 * `inputMode="numeric"` only shapes a phone's soft keyboard, so a hardware keyboard or a
 * paste could put `0x15`, `1e1` or a stray space in the box - and `Number` reads those as
 * 21, 10 and 0. Digits are the only thing a badminton score is made of, so the box holds
 * nothing else. A leading zero is dropped so the digits read as the number they mean, but a
 * lone `0` is kept: a game can be lost to nothing.
 *
 * The two-digit ceiling is the honest maximum, not a rule: a 21-point deuce can reach 30, a
 * 15-point one has no cap at all, and a score typed past two digits is a keystroke or a
 * whole-game paste rather than a number. The rule itself is still `isLegalGameScoreFor`; the
 * field only stops a value the rule would have to refuse anyway.
 */
export function parseScoreInput(raw: string): string {
  return raw
    .replace(/[^0-9]/g, "")
    .replace(/^0+(?=\d)/, "")
    .slice(0, 2);
}

/** What the box says when a paste is not a score at all. */
export const SCORE_INPUT_NOTICE = "Digits only, one score per box.";

/** What the box says when the paste is a score, but not one this box can hold. */
export const SCORE_BOX_FULL_NOTICE =
  "That would make three digits. Clear the box, or select a digit to replace.";

/** What a score box holds, as the input element reports it at the moment of the paste. */
export interface ScoreBoxState {
  /** The digits already in the box. */
  value: string;
  /** Where the selection starts; equal to `selectionEnd` when the caret is not a selection. */
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Whether a paste fits this box - the box's current contents included.
 *
 * Typing is filtered a character at a time, which is invisible and safe: a stray keypress
 * vanishes and the digits that were meant are still there. A paste arrives whole, so
 * filtering it would *rewrite* it - `21-19` would become `2119`, then be cut to `21`: a score
 * nobody copied. A paste the box cannot hold is refused whole instead, and the box keeps
 * what it already had.
 *
 * The room a paste needs is what the box will hold *after* it, which is why the existing
 * digits and the selection matter: `21` is a score, and it still does not fit a box that
 * already reads `1` - accepting it would let `maxLength` produce `12`, a third score nobody
 * pasted. Selecting the digit it replaces is how a moderator asks to overwrite it.
 *
 * Returns the reason the box refused, or null when the paste can go ahead. The wording lives
 * here rather than at the call site so the two refusals say different things: a letter is a
 * mistake about digits, a third digit is a mistake about rooms.
 */
export function scorePasteRefusal(text: string, box: ScoreBoxState): string | null {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return SCORE_INPUT_NOTICE;
  // A whole game pasted in one box, or a leading zero that is not a score, is too long for a
  // box - the same answer either way, because the box is what ran out of room.
  if (trimmed.length > 2) return SCORE_BOX_FULL_NOTICE;

  const length = box.value.length;
  const start = Math.min(Math.max(box.selectionStart, 0), length);
  const end = Math.min(Math.max(box.selectionEnd, 0), length);
  // Only the digits that are not being replaced stay in the box.
  const kept = Math.max(length - Math.abs(end - start), 0);
  return kept + trimmed.length <= 2 ? null : SCORE_BOX_FULL_NOTICE;
}

const NOTHING: ScoreEntry = {
  games: [],
  problem: null,
  problemRow: null,
  winner: null,
  winsA: 0,
  winsB: 0,
};

/**
 * "Games are to 21, win by 2, capped at 30." - the rule restated, for a refusal that names
 * the rule. The cap is left out when the rule has none, so a 15-point tournament is not
 * told about a ceiling it does not play.
 */
function ruleShape(rule: ScoringRule): string {
  const cap = gamePointCap(rule);
  return `Games are to ${rule.gamesTo}${rule.winBy > 1 ? `, win by ${rule.winBy}` : ""}${cap === null ? "" : `, capped at ${cap}`}.`;
}

/**
 * Why a score past the target that is not the winning margin could not have happened.
 *
 * A game ends the instant it is won, so 25-10 never exists: at 21-10 the game was already
 * over. Naming the moment it ends is the only part of that a person at the desk can act on -
 * "not a winning score" against 25-10 reads like the target, not the margin.
 */
function pastTargetReason(rule: ScoringRule): string {
  return rule.winBy === 1
    ? `A game to ${rule.gamesTo} is won by the first side to reach ${rule.gamesTo}.`
    : `Past ${rule.gamesTo}, a game ends on the point that opens a lead of ${rule.winBy}.`;
}

/**
 * Explains why a complete set of games is not a result. Only called when `gamesWinnerFor`
 * has already refused, so every branch here is a reason rather than the decision.
 */
function explain(games: GameScore[], rule: ScoringRule): { message: string; row: number | null } {
  const needed = gamesNeededToWin(rule);

  for (let i = 0; i < games.length; i++) {
    const game = games[i] as GameScore;
    if (!isLegalGameScoreFor(game.a, game.b, rule)) {
      const cap = gamePointCap(rule);
      const high = Math.max(game.a, game.b);
      const low = Math.min(game.a, game.b);
      return {
        message:
          game.a === game.b
            ? `Game ${i + 1} is level. A game needs a winner.`
            : cap !== null && high > cap
              ? `Game ${i + 1} is past the cap. A game stops at ${cap}.`
              : high > rule.gamesTo
                ? `Game ${i + 1} cannot end ${high}-${low}. ${pastTargetReason(rule)}`
                : `Game ${i + 1} is not a winning score. ${ruleShape(rule)}`,
        row: i,
      };
    }
  }

  let winsA = 0;
  let winsB = 0;
  for (let i = 0; i < games.length; i++) {
    const game = games[i] as GameScore;
    if (game.a > game.b) winsA++;
    else winsB++;
    if ((winsA >= needed || winsB >= needed) && i < games.length - 1) {
      return {
        message: `Game ${i + 2} was entered after the match was already won.`,
        row: i + 1,
      };
    }
  }

  if (rule.bestOf === 1) {
    return { message: "A single game decides this match.", row: null };
  }
  return {
    message: `This match is best of ${rule.bestOf}: a side needs ${needed} game${needed === 1 ? "" : "s"} to win.`,
    row: null,
  };
}

/**
 * Reads the form into complete games, a refusal reason, and the side the result decides.
 *
 * `values` is every row the rule allows, so `values.length` is `bestOf`. Rows after the
 * last filled one are dropped; a blank row *before* one is refused rather than removed.
 */
export function readScoreEntry(
  values: readonly ScoreRow[],
  rule: ScoringRule,
): ScoreEntry {
  const cells = values.map((row) => ({ a: row.a.trim(), b: row.b.trim() }));

  let lastFilled = -1;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] as { a: string; b: string };
    if (cell.a !== "" || cell.b !== "") lastFilled = i;
  }
  if (lastFilled < 0) return { ...NOTHING, problem: "Enter the score." };

  for (let i = 0; i <= lastFilled; i++) {
    const cell = cells[i] as { a: string; b: string };
    if (cell.a === "" && cell.b === "") {
      return {
        ...NOTHING,
        problem: `Game ${i + 1} is empty. Fill it in, or clear the games after it.`,
        problemRow: i,
      };
    }
    if (cell.a === "" || cell.b === "") {
      return {
        ...NOTHING,
        problem: `Enter both scores for game ${i + 1}.`,
        problemRow: i,
      };
    }
  }

  const games = cells
    .slice(0, lastFilled + 1)
    .map((cell) => ({ a: Number(cell.a), b: Number(cell.b) }));

  let winsA = 0;
  let winsB = 0;
  for (const game of games) {
    if (game.a > game.b) winsA++;
    else winsB++;
  }

  if (!isScoringRuleValid(rule)) {
    return { ...NOTHING, games, problem: "This stage's scoring rule is not usable." };
  }

  const winner = gamesWinnerFor(games, rule);
  if (!winner) {
    const why = explain(games, rule);
    return { ...NOTHING, games, winsA, winsB, problem: why.message, problemRow: why.row };
  }

  return { games, problem: null, problemRow: null, winner, winsA, winsB };
}
