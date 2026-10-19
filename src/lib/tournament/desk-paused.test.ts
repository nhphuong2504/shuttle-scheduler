import { describe, expect, it } from "vitest";

import { isPaused, nextPausedSince } from "./desk-paused";

describe("desk paused since", () => {
  it("pauses on offline and on a failed channel, not while connecting", () => {
    expect(isPaused("offline")).toBe(true);
    expect(isPaused("error")).toBe(true);
    expect(isPaused("connecting")).toBe(false);
    expect(isPaused("live")).toBe(false);
  });

  it("records the first instant of a pause and keeps it through the outage", () => {
    const first = nextPausedSince(null, "offline", 1000);
    expect(first).toBe(1000);
    // Offline then a channel error is one outage: the start does not move.
    expect(nextPausedSince(first, "error", 5000)).toBe(1000);
  });

  it("keeps the pause while reconnecting and clears it once live", () => {
    expect(nextPausedSince(1000, "connecting", 9000)).toBe(1000);
    expect(nextPausedSince(1000, "live", 9000)).toBeNull();
  });

  it("does not invent a pause while connecting from the start", () => {
    expect(nextPausedSince(null, "connecting", 1000)).toBeNull();
  });
});
