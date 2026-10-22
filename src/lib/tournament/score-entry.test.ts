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
    expect(entry.problem).toBe("Game 1 is not a winning score. Games are to 21, win by 2.");
    expect(entry.problemRow).toBe(0);
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
