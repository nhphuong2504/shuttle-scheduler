import type { ScoringRule } from "./scoring";

/**
 * One table of scores, answered by both sides of the wire.
 *
 * A game ends the instant it is won, so a score that could not have stopped there is not a
 * result. The rule lives twice - `isLegalGameScoreFor` in `format.ts` and
 * `game_score_is_legal` in the database - and the two must never disagree: a score the desk
 * accepts and the RPC refuses is a dead Save button, and a score the RPC accepts is a result
 * that never happened.
 *
 * These cases are read by `tournament.test.ts` (the TypeScript predicate) and by
 * `integration/score-cap.test.ts` (the SQL one, through the report RPC). One table, one
 * answer: changing a case here changes what both sides are required to do.
 *
 * Each rule is named, because a flat list cannot say what `100-98` means: it is illegal
 * under the 21-point rule only because that rule stops at 30, while an uncapped rule has no
 * ceiling and would refuse it for its margin instead. Which rule a case is played under is
 * part of the case.
 */
export interface GameRuleCase {
  a: number;
  b: number;
  legal: boolean;
}

export interface GameRuleCaseGroup {
  /** Names the rule in a failure, since a bare 21-19 means nothing on its own. */
  label: string;
  rule: ScoringRule;
  cases: GameRuleCase[];
}

const to21: ScoringRule = { gamesTo: 21, winBy: 2, bestOf: 1 };
const to15: ScoringRule = { gamesTo: 15, winBy: 2, bestOf: 1 };
const to11: ScoringRule = { gamesTo: 11, winBy: 2, bestOf: 1 };
const winBy3: ScoringRule = { gamesTo: 21, winBy: 3, bestOf: 1 };
const winBy1: ScoringRule = { gamesTo: 21, winBy: 1, bestOf: 1 };

export const GAME_RULE_CASE_GROUPS: GameRuleCaseGroup[] = [
  {
    label: "21 point, win by 2, capped at 30",
    rule: to21,
    cases: [
      // Legal: the winner stopped at 21 by a full margin, ran the deuce to exactly two
      // clear, or took the cap.
      { a: 21, b: 0, legal: true },
      { a: 21, b: 19, legal: true },
      { a: 22, b: 20, legal: true },
      { a: 29, b: 27, legal: true },
      { a: 30, b: 28, legal: true },
      { a: 30, b: 29, legal: true },
      // 25-10 was a game as far as a margin floor could tell; it is not a score a game can
      // stop at, because at 21-10 it was already over.
      { a: 25, b: 10, legal: false },
      { a: 30, b: 0, legal: false },
      // Reaching 30 is only a win against 29 - the cap ends a deuce, not a rout.
      { a: 24, b: 21, legal: false },
      { a: 29, b: 21, legal: false },
      { a: 22, b: 5, legal: false },
      // The cap is what refuses these, not the margin: 31-29 is two clear of nothing, and
      // 100-98 is a margin-legal score under a rule that has no ceiling to stop it.
      { a: 31, b: 29, legal: false },
      { a: 100, b: 98, legal: false },
    ],
  },
  {
    label: "15 point, win by 2, no cap",
    rule: to15,
    cases: [
      { a: 15, b: 13, legal: true },
      { a: 16, b: 14, legal: true },
      { a: 15, b: 0, legal: true },
      // A deuce that runs on is a game; nothing caps it at 15 or anywhere else.
      { a: 40, b: 38, legal: true },
      { a: 20, b: 10, legal: false },
      { a: 15, b: 14, legal: false },
    ],
  },
  {
    label: "11 point, win by 2, no cap",
    rule: to11,
    cases: [
      { a: 11, b: 9, legal: true },
      { a: 12, b: 10, legal: true },
      { a: 11, b: 10, legal: false },
      { a: 14, b: 10, legal: false },
    ],
  },
  {
    label: "21 point, win by 3, no cap",
    rule: winBy3,
    cases: [
      { a: 21, b: 18, legal: true },
      { a: 21, b: 17, legal: true },
      { a: 22, b: 19, legal: true },
      { a: 24, b: 21, legal: true },
      { a: 21, b: 19, legal: false },
      { a: 23, b: 21, legal: false },
      { a: 25, b: 10, legal: false },
    ],
  },
  {
    label: "21 point, win by 1, no cap",
    rule: winBy1,
    cases: [
      { a: 21, b: 20, legal: true },
      { a: 21, b: 0, legal: true },
      // The first side to 21 has won, so a score past it describes a game already over.
      // This is the case a bare "a margin of at least winBy" cannot refuse.
      { a: 22, b: 21, legal: false },
      { a: 21, b: 21, legal: false },
    ],
  },
];
