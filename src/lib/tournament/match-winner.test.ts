import { describe, expect, it } from "vitest";

import { sideThatWon } from "./match-winner";

describe("sideThatWon", () => {
  it("names the side that took more games", () => {
    expect(sideThatWon([{ a: 21, b: 14 }])).toBe("a");
    expect(sideThatWon([{ a: 12, b: 21 }])).toBe("b");
    expect(sideThatWon([{ a: 21, b: 19 }, { a: 18, b: 21 }, { a: 15, b: 21 }])).toBe("b");
  });

  it("marks nobody when there is no score, or it does not decide", () => {
    expect(sideThatWon(undefined)).toBeNull();
    expect(sideThatWon([])).toBeNull();
    expect(sideThatWon([{ a: 21, b: 15 }, { a: 15, b: 21 }])).toBeNull();
  });
});
