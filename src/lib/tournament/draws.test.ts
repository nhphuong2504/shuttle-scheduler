import { describe, expect, it } from "vitest";

import { roundName } from "./draws";

describe("roundName", () => {
  /**
   * The ladder a bracket is read in, largest first. This is the naming the Knockout
   * tab, the draws bracket view and the Schedule running order all share, so a
   * change here is a change to every screen that names a round.
   */
  it("names every round of a 32-draw from the opening round to the final", () => {
    const draw = (round: number) => roundName(32, round);
    expect([1, 2, 3, 4, 5].map(draw)).toEqual([
      "Round of 32",
      "Round of 16",
      "Quarterfinal",
      "Semifinal",
      "Final",
    ]);
  });

  it("names small brackets by the same ladder, with no round-of names left", () => {
    expect([1, 2].map((round) => roundName(8, round))).toEqual(["Quarterfinal", "Semifinal"]);
    expect([1, 2].map((round) => roundName(4, round))).toEqual(["Semifinal", "Final"]);
    expect(roundName(2, 1)).toBe("Final");
  });

  it("does not spell the same round two ways", () => {
    // The bug this guards: the Knockout tab used to say "Semi-final" and
    // "Quarter-final" while the draws view said "Semifinal" and "Quarterfinal", so
    // one round of one bracket read differently depending on the screen.
    expect(roundName(4, 1)).toBe("Semifinal");
    expect(roundName(8, 1)).toBe("Quarterfinal");
  });

  /**
   * The reason the round is derived from the bracket size and not from the rounds a
   * draw currently has rows for.
   *
   * Later rounds are only created once the round before them is decided, so a
   * half-played draw has fewer rounds in it than the bracket has. Counting those
   * rounds would make `totalRounds - round` zero for the opening round and label it
   * "Final" — the bug the Knockout tab shipped with.
   */
  it("names the opening round correctly while the bracket is still incomplete", () => {
    // The count-based naming that was replaced, kept here so the regression is
    // pinned rather than described. A 16-draw with only its opening round created
    // has one round of rows in it.
    const roundsPresent = 1;
    const oldName = (round: number, totalRounds: number) => {
      const fromEnd = totalRounds - round;
      if (fromEnd === 0) return "Final";
      if (fromEnd === 1) return "Semi-final";
      if (fromEnd === 2) return "Quarter-final";
      return `Round of ${2 ** (fromEnd + 1)}`;
    };

    expect(oldName(1, roundsPresent)).toBe("Final");
    // The bracket size is what makes it right.
    expect(roundName(16, 1)).toBe("Round of 16");
  });

  it("names the round after the final as the champion", () => {
    // A draw with a champion resolved by bye carries no match for it, so nothing
    // should ask for this round — but returning a round-of-something would be worse.
    expect(roundName(2, 2)).toBe("Champion");
  });

  it("covers brackets larger than the ones in play", () => {
    expect(roundName(64, 1)).toBe("Round of 64");
    expect(roundName(128, 1)).toBe("Round of 128");
  });
});
