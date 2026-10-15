import { describe, expect, it } from "vitest";

import { inProgressEnd } from "./in-progress";

const MINUTE = 60_000;
const START = Date.parse("2026-09-17T10:00:00Z");
const SLOT = 30 * MINUTE;

describe("inProgressEnd", () => {
  it("is the end of the slot while the match is still inside it", () => {
    expect(inProgressEnd({ start: START, slotMs: SLOT, now: START })).toBe(START + SLOT);
    expect(inProgressEnd({ start: START, slotMs: SLOT, now: START + 10 * MINUTE })).toBe(START + SLOT);
    expect(inProgressEnd({ start: START, slotMs: SLOT, now: START + SLOT })).toBe(START + SLOT);
  });

  it("does not reserve a full slot from now for a match that is already half played", () => {
    const now = START + 20 * MINUTE;
    // The old model said now + slot = START + 50 min; ten minutes remain, not thirty.
    expect(inProgressEnd({ start: START, slotMs: SLOT, now })).toBe(START + 30 * MINUTE);
  });

  it("is now once the match has overrun, like the database", () => {
    const now = START + 45 * MINUTE;
    expect(inProgressEnd({ start: START, slotMs: SLOT, now })).toBe(now);
  });

  it("never ends before it started, and never before now", () => {
    for (const elapsed of [0, 1, 15, 29, 30, 31, 60, 600]) {
      const now = START + elapsed * MINUTE;
      const end = inProgressEnd({ start: START, slotMs: SLOT, now });
      expect(end).toBeGreaterThan(START);
      expect(end).toBeGreaterThanOrEqual(now);
    }
  });

  it("returns whole milliseconds, because the problem rejects even a sub-millisecond overlap", () => {
    const end = inProgressEnd({ start: START + 0.4, slotMs: SLOT + 0.4, now: START + 12.7 * MINUTE });
    expect(Number.isInteger(end)).toBe(true);
    const overrun = inProgressEnd({ start: START, slotMs: SLOT, now: START + 45.5 * MINUTE + 0.25 });
    expect(Number.isInteger(overrun)).toBe(true);
  });
});
