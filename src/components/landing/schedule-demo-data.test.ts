import { describe, expect, it } from "vitest";

import {
  DEMO_MATCHES,
  DEMO_REST,
  DEMO_SLOT,
  DEMO_SPAN,
  DEMO_STEPS,
  DEMO_TOAST,
  demoPlacement,
} from "./schedule-demo-data";

/**
 * The front door's scheduling story is an illustration, so these pin it to the rules it
 * illustrates: if someone edits a time, the picture must still be one the reflow could draw.
 */
describe("schedule demo", () => {
  const after = DEMO_MATCHES.map((m) => ({ m, ...demoPlacement(m, DEMO_STEPS.length - 1) }));

  it("only ever moves a match later", () => {
    for (const { m, start } of after) expect(start).toBeGreaterThanOrEqual(m.start);
  });

  it("never moves a played or live match", () => {
    for (const { m, start } of after) {
      if (m.kind === "played" || m.kind === "live" || m.kind === "late") expect(start).toBe(m.start);
    }
  });

  it("moves a match only as far as the court and the player's rest require", () => {
    const late = DEMO_MATCHES.find((m) => m.kind === "late")!;
    const lateEnd = late.start + (late.ranFor ?? DEMO_SLOT);
    for (const court of [1, 2, 3] as const) {
      const row = after.filter((a) => a.m.court === court && a.m.kind !== "held");
      for (let i = 1; i < row.length; i += 1) {
        const prevEnd = row[i - 1]!.start + row[i - 1]!.length;
        const earliest = Math.max(row[i]!.m.start, prevEnd);
        // The co-player's match waits for the late player's rest as well.
        const needsRest = row[i]!.m.label.startsWith("Carter") && court !== late.court;
        expect(row[i]!.start).toBe(needsRest ? Math.max(earliest, lateEnd + DEMO_REST) : earliest);
      }
    }
  });

  it("holds a match that would cross the close, leaving it for review", () => {
    const held = after.find((a) => a.m.kind === "held")!;
    expect(held.start).toBe(held.m.start);
    const before = after.filter((a) => a.m.court === held.m.court && a.m.start < held.m.start).at(-1)!;
    // Pushed behind its predecessor it would end past the close, so it keeps its time and overlaps.
    expect(before.start + before.length + DEMO_SLOT).toBeGreaterThan(DEMO_SPAN);
    expect(before.start + before.length).toBeGreaterThan(held.start);
  });

  it("says in the toast exactly what the picture shows", () => {
    const moved = after.filter((a) => a.start !== a.m.start);
    const largest = Math.max(...moved.map((a) => a.start - a.m.start));
    const review = DEMO_MATCHES.filter((m) => m.review).length;
    expect(DEMO_TOAST).toBe(
      `Result recorded. ${moved.length} later matches delayed by up to ${largest} min. ${review} matches need schedule review.`,
    );
  });
});
