import { describe, expect, it } from "vitest";
import {
  placementMatchContext,
  placementMatchExplanation,
  placementMatchLabel,
} from "./placement-presentation";

const row = (over: Partial<Parameters<typeof placementMatchContext>[0]> = {}) => ({
  category_id: "cat",
  stage: "round2",
  entrant_a_id: "a",
  entrant_b_id: "b",
  is_makeup: false,
  is_crossover: false,
  ...over,
});

describe("placement presentation", () => {
  it("names the round without assigning a special public match type", () => {
    expect(placementMatchLabel("round1", "MD")).toBe("MD R1");
    expect(placementMatchLabel("round2", "MD")).toBe("MD R2");
    expect(placementMatchLabel("round2")).toBe("R2");
    expect(placementMatchContext(row(), [])).toBeNull();
  });

  it.each(["a", "b"] as const)(
    "explains the held entrant on side %s without numbering the whole match",
    (side) => {
      const next = row({ is_makeup: true });
      const previous = row({
        stage: "round1",
        entrant_a_id: side === "a" ? "b" : "a",
        entrant_b_id: "c",
      });
      const context = placementMatchContext(next, [previous, next]);
      expect(context).toEqual({ kind: "both-in-round-two", heldSide: side });
      const text = placementMatchExplanation(context, "Team A", "Team B")!;
      expect(text).toContain(`${side === "a" ? "Team A" : "Team B"} did not play in Round 1`);
      expect(text).toContain("both placement matches in Round 2");
      expect(text).not.toMatch(/make-up|crossover|Match 1|Match 2/);
    },
  );

  it("does not guess an entrant from incomplete or another category's matches", () => {
    const next = row({ is_makeup: true });
    const foreign = row({ category_id: "other", stage: "round1", entrant_b_id: "c" });
    for (const rows of [[], [foreign]]) {
      const context = placementMatchContext(next, rows);
      expect(context).toEqual({ kind: "both-in-round-two", heldSide: null });
      expect(placementMatchExplanation(context, "Team A", "Team B")).toContain(
        "one entrant did not play",
      );
    }
  });

  it("explains mixed round-one results as an official placement match", () => {
    const context = placementMatchContext(row({ is_crossover: true }), []);
    const text = placementMatchExplanation(context, "A", "B")!;
    expect(text).toContain("a Round 1 winner with a Round 1 loser");
    expect(text).toContain("counts towards draw assignment");
    expect(text).not.toMatch(/crossover|make-up|extra|friendly/);
  });
});
