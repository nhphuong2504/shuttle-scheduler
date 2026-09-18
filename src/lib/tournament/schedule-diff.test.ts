import { describe, expect, it } from "vitest";

import {
  diffPlan,
  formatProjectedFinishDelta,
  projectedFinishFromRemainingMatches,
} from "./schedule-diff";
import type { ScheduledSlot } from "./scheduling/types";

const courtNumberById = new Map([
  ["c1", 1],
  ["c2", 2],
]);

function slot(
  matchId: string,
  start: string,
  courtId: string,
  courtNumber: number,
): ScheduledSlot {
  const startDate = new Date(start);
  return {
    matchId,
    courtId,
    courtNumber,
    start: startDate,
    end: new Date(startDate.getTime() + 20 * 60_000),
    categoryId: "cat",
    overrun: false,
  };
}

describe("diffPlan", () => {
  it("classifies unchanged, moved, and newly placed matches", () => {
    const current = [
      {
        id: "m1",
        scheduled_time: "2026-09-12T10:00:00.000Z",
        court_id: "c1",
      },
      {
        id: "m2",
        scheduled_time: "2026-09-12T10:20:00.000Z",
        court_id: "c1",
      },
    ];
    const slots = [
      slot("anchor", "2026-09-12T09:00:00.000Z", "c1", 1),
      slot("m1", "2026-09-12T10:00:00.000Z", "c1", 1),
      slot("m2", "2026-09-12T10:40:00.000Z", "c2", 2),
      slot("m3", "2026-09-12T11:00:00.000Z", "c1", 1),
    ];
    const diff = diffPlan(current, slots, new Set(["anchor"]), courtNumberById);

    expect(diff.anchorCount).toBe(1);
    expect(diff.placedCount).toBe(3);
    expect(diff.changes.find((change) => change.matchId === "m1")?.kind).toBe("unchanged");
    expect(diff.changes.find((change) => change.matchId === "m2")).toMatchObject({
      kind: "both-moved",
      shiftMinutes: 20,
    });
    expect(diff.changes.find((change) => change.matchId === "m3")?.kind).toBe("newly-placed");
    expect(diff.movedCount).toBe(1);
    expect(diff.newlyPlacedCount).toBe(1);
    expect(diff.largestShiftMinutes).toBe(20);
  });
});

describe("projectedFinishFromRemainingMatches", () => {
  it("uses the latest end among scheduled and in-progress matches", () => {
    const now = new Date("2026-09-12T13:00:00.000Z").getTime();
    const finish = projectedFinishFromRemainingMatches(
      [
        {
          status: "scheduled",
          scheduled_time: "2026-09-12T14:00:00.000Z",
        },
        {
          status: "in-progress",
          scheduled_time: "2026-09-12T12:20:00.000Z",
          started_at: "2026-09-12T12:48:00.000Z",
        },
      ],
      20,
      now,
    );
    expect(finish).toBe(new Date("2026-09-12T14:20:00.000Z").getTime());
  });
});

describe("formatProjectedFinishDelta", () => {
  it("describes earlier, later, and unchanged finishes", () => {
    expect(formatProjectedFinishDelta(40)).toBe("40 min later than the current schedule");
    expect(formatProjectedFinishDelta(-15)).toBe("15 min earlier than the current schedule");
    expect(formatProjectedFinishDelta(0)).toBe("Same finish as the current schedule");
  });
});
