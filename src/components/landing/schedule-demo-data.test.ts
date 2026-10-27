import { describe, expect, it } from "vitest";

import { SCHEDULE_SHIFT_THRESHOLD_MS } from "@/lib/tournament/published-time";

import {
  DEMO_CLOSE,
  DEMO_MATCHES,
  DEMO_REST,
  DEMO_RESULT_STEP,
  DEMO_SLOT,
  DEMO_STEPS,
  DEMO_TOAST,
  demoCounts,
  demoGroup,
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

  it("shows only moves the reflow would write: whole minutes, never under the threshold", () => {
    for (const { m, start } of after) {
      expect(Number.isInteger(start)).toBe(true);
      if (start !== m.start) expect((start - m.start) * 60_000).toBeGreaterThanOrEqual(SCHEDULE_SHIFT_THRESHOLD_MS);
    }
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
      const row = after.filter((a) => a.m.court === court);
      for (let i = 1; i < row.length; i += 1) {
        const prevEnd = row[i - 1]!.start + row[i - 1]!.length;
        const earliest = Math.max(row[i]!.m.start, prevEnd);
        // The co-player's match waits for the late player's rest as well.
        const needsRest = row[i]!.m.label.startsWith("Carter") && court !== late.court;
        expect(row[i]!.start).toBe(needsRest ? Math.max(earliest, lateEnd + DEMO_REST) : earliest);
      }
    }
  });

  it("moves the last match past closing without overlapping and flags only its new finish", () => {
    const last = after.find((a) => a.m.label === "Park vs Quinn")!;
    const before = after.filter((a) => a.m.court === last.m.court && a.m.start < last.m.start).at(-1)!;
    expect(last.start).toBe(before.start + before.length);
    expect(last.start + last.length - DEMO_CLOSE).toBe(7);
    expect(after.filter((a) => a.m.review)).toEqual(after.filter((a) => a.start + a.length > DEMO_CLOSE));
  });

  it("counts nothing as moved or flagged until the result is in, and everything after", () => {
    expect(demoCounts(0)).toEqual({ auto: 0, locked: 4, review: 0 });
    expect(demoCounts(1)).toEqual({ auto: 0, locked: 4, review: 0 });
    // The reflow is one update: every step after the result shows all of it.
    for (let step = DEMO_RESULT_STEP; step < DEMO_STEPS.length; step += 1) {
      expect(demoCounts(step)).toEqual({ auto: 7, locked: 4, review: 1 });
    }
  });

  it("keeps every locked match out of the moved and review groups", () => {
    for (const m of DEMO_MATCHES) {
      if (demoGroup(m) === "locked") {
        expect(m.movedTo).toBeUndefined();
        expect(m.review).toBeFalsy();
      }
    }
  });

  it("says in the toast exactly what the picture shows", () => {
    const moved = after.filter((a) => a.start !== a.m.start);
    const largest = Math.max(...moved.map((a) => a.start - a.m.start));
    const review = DEMO_MATCHES.filter((m) => m.review).length;
    expect(DEMO_TOAST).toBe(
      `Result recorded. ${moved.length} later matches delayed by up to ${largest} min. ${review} ${review === 1 ? "match needs" : "matches need"} schedule review.`,
    );
  });
});
