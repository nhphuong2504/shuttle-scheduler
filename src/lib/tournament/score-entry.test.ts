import { describe, expect, it } from "vitest";

import { parseScoreInput, readScoreEntry, type ScoreRow } from "./score-entry";
import { LEGACY_GAME_RULE, type ScoringRule } from "./scoring";

const BEST_OF_THREE: ScoringRule = { gamesTo: 21, winBy: 2, bestOf: 3 };

const rows = (...pairs: Array<[string, string]>): ScoreRow[] =>
  pairs.map(([a, b]) => ({ a, b }));

describe("parseScoreInput", () => {
  it("keeps digits and drops everything else", () => {
    expect(parseScoreInput("21")).toBe("21");
    expect(parseScoreInput(" 2 1 ")).toBe("21");
    // `Number` would read these as 21 and 10; digits are what was meant.
    expect(parseScoreInput("0x15")).toBe("15");
    expect(parseScoreInput("1e1")).toBe("11");
    // A lone zero is a real score; only a leading zero before other digits is noise.
    expect(parseScoreInput("0")).toBe("0");
    expect(parseScoreInput("007")).toBe("7");
    expect(parseScoreInput("21-19")).toBe("2119");
  });
});

describe("readScoreEntry", () => {
  it("drops trailing blanks, because a two-game win is a best of three that ended early", () => {
    const entry = readScoreEntry(rows(["21", "19"], ["21", "18"], ["", ""]), BEST_OF_THREE);
    expect(entry.games).toEqual([
      { a: 21, b: 19 },
      { a: 21, b: 18 },
    ]);
    expect(entry.winner).toBe("a");
    expect(entry.winsA).toBe(2);
    expect(entry.winsB).toBe(0);
    expect(entry.problem).toBeNull();
  });

  it("refuses a blank row in the middle instead of collapsing it away", () => {
    // Filtering this to two games would record a 2-0 nobody entered.
    const entry = readScoreEntry(
      rows(["21", "19"], ["", ""], ["21", "18"]),
      BEST_OF_THREE,
    );
    expect(entry.games).toEqual([]);
    expect(entry.winner).toBeNull();
    expect(entry.problem).toBe("Game 2 is empty. Fill it in, or clear the games after it.");
    expect(entry.problemRow).toBe(1);
  });

  it("refuses a game with only one side entered", () => {
    const entry = readScoreEntry(rows(["21", "19"], ["", "18"]), BEST_OF_THREE);
    expect(entry.winner).toBeNull();
    expect(entry.problem).toBe("Enter both scores for game 2.");
    expect(entry.problemRow).toBe(1);
  });

  it("names the rule when a game is not won by enough", () => {
    const entry = readScoreEntry(rows(["21", "20"], ["", ""]), BEST_OF_THREE);
    expect(entry.winner).toBeNull();
    expect(entry.problem).toBe(
      "Game 1 is not a winning score. Games are to 21, win by 2, capped at 30.",
    );
    expect(entry.problemRow).toBe(0);
  });

  it("accepts 30-29, which is how a 21-point deuce ends", () => {
    const entry = readScoreEntry(rows(["30", "29"], ["21", "18"]), BEST_OF_THREE);
    expect(entry.winner).toBe("a");
    expect(entry.problem).toBeNull();
  });

  it("refuses a game past the cap", () => {
    const entry = readScoreEntry(rows(["31", "29"], ["", ""]), BEST_OF_THREE);
    expect(entry.winner).toBeNull();
    expect(entry.problem).toBe("Game 1 is past the cap. A game stops at 30.");
  });

  /**
   * 25-10 clears the target and the margin, which is all the rule used to ask. It is still not
   * a score a game can stop on: the game ended at 21-10. The refusal has to say that, because
   * "not a winning score" against 25-10 reads like the target, not the margin.
   */
  it("refuses a score past the target that is not the winning margin", () => {
    const entry = readScoreEntry(rows(["25", "10"], ["", ""]), BEST_OF_THREE);
    expect(entry.winner).toBeNull();
    expect(entry.problem).toBe(
      "Game 1 cannot end 25-10. Past 21, a game ends on the point that opens a lead of 2.",
    );
    expect(entry.problemRow).toBe(0);
  });

  it("says a game won by one point ends at the target, not after it", () => {
    const onePoint: ScoringRule = { gamesTo: 21, winBy: 1, bestOf: 1 };
    expect(readScoreEntry(rows(["21", "20"]), onePoint).problem).toBeNull();
    const entry = readScoreEntry(rows(["22", "21"]), onePoint);
    expect(entry.problem).toBe(
      "Game 1 cannot end 22-21. A game to 21 is won by the first side to reach 21.",
    );
  });

  it("leaves a 15-point game uncapped, because only the 21 game has a ceiling", () => {
    const to15: ScoringRule = { gamesTo: 15, winBy: 2, bestOf: 1 };
    // 16-14 is a deuce that runs on; nothing stops it at 15.
    expect(readScoreEntry(rows(["16", "14"]), to15).problem).toBeNull();
    expect(readScoreEntry(rows(["40", "38"]), to15).problem).toBeNull();
  });

  it("refuses a level game, which has no winner", () => {
    const entry = readScoreEntry(rows(["21", "21"], ["", ""]), BEST_OF_THREE);
    expect(entry.problem).toBe("Game 1 is level. A game needs a winner.");
  });

  it("refuses a game entered after the match was decided", () => {
    const entry = readScoreEntry(
      rows(["21", "19"], ["21", "19"], ["21", "19"]),
      BEST_OF_THREE,
    );
    expect(entry.winner).toBeNull();
    expect(entry.problem).toBe("Game 3 was entered after the match was already won.");
    expect(entry.problemRow).toBe(2);
  });

  it("says how many games the match needs while it is still short", () => {
    const entry = readScoreEntry(rows(["21", "19"], ["", ""]), BEST_OF_THREE);
    expect(entry.winner).toBeNull();
    expect(entry.problem).toBe("This match is best of 3: a side needs 2 games to win.");
  });

  it("reads a legal single game under the legacy rule", () => {
    const entry = readScoreEntry(rows(["19", "21"]), LEGACY_GAME_RULE);
    expect(entry.winner).toBe("b");
    expect(entry.winsB).toBe(1);
    expect(entry.problem).toBeNull();
  });

  it("asks for the score when nothing is typed", () => {
    const entry = readScoreEntry(rows(["", ""], ["", ""]), BEST_OF_THREE);
    expect(entry.problem).toBe("Enter the score.");
    expect(entry.problemRow).toBeNull();
  });

  it("takes the winner from the games, not from the row order", () => {
    const entry = readScoreEntry(
      rows(["19", "21"], ["21", "17"], ["18", "21"]),
      BEST_OF_THREE,
    );
    expect(entry.winner).toBe("b");
    expect(entry.winsA).toBe(1);
    expect(entry.winsB).toBe(2);
    expect(entry.problem).toBeNull();
  });
});
