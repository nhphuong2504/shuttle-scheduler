import { describe, expect, it } from "vitest";

import {
  currentFinishFor,
  diffPlan,
  formatProjectedFinishDelta,
  projectedFinishFromRemainingMatches,
  startsSoon,
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

describe("currentFinishFor", () => {
  const now = Date.parse("2026-09-12T12:00:00.000Z");
  const scheduled = (at: string) => ({ status: "scheduled", scheduled_time: at, started_at: null });

  it("takes the later of the two stages, each with its own slot", () => {
    const finish = currentFinishFor({
      // 13:00 + 30 min.
      placementMatches: [scheduled("2026-09-12T13:00:00.000Z")],
      // 13:10 + 45 min, which is later.
      tierMatches: [scheduled("2026-09-12T13:10:00.000Z")],
      placementSlotMinutes: 30,
      knockoutSlotMinutes: 45,
      now,
    });
    expect(finish).toBe(Date.parse("2026-09-12T13:55:00.000Z"));
  });

  it("says nothing when nothing is left on either stage", () => {
    // Reported matches are decided, so they are not part of a finish that is still ahead.
    const reported = { status: "reported", scheduled_time: "2026-09-12T13:00:00.000Z", started_at: null };
    expect(
      currentFinishFor({
        placementMatches: [reported],
        tierMatches: [],
        placementSlotMinutes: 30,
        knockoutSlotMinutes: 45,
        now,
      }),
    ).toBeNull();
  });

  it("measures a live match by its slot and never as already finished", () => {
    const finish = currentFinishFor({
      placementMatches: [
        // Started an hour ago on a 30-minute slot: its slot is over, so it ends no earlier than now.
        { status: "in-progress", scheduled_time: "2026-09-12T11:00:00.000Z", started_at: "2026-09-12T11:00:00.000Z" },
      ],
      tierMatches: [],
      placementSlotMinutes: 30,
      knockoutSlotMinutes: 45,
      now,
    });
    expect(finish).toBe(now);
  });
});

describe("startsSoon", () => {
  const now = Date.parse("2026-09-12T12:00:00.000Z");

  it("counts a match inside the hour, including one that is already late", () => {
    expect(startsSoon(new Date(now + 12 * 60_000).toISOString(), now)).toBe(true);
    expect(startsSoon(new Date(now + 60 * 60_000).toISOString(), now)).toBe(true);
    // Already past: a late match is the most expensive thing to move, not the least.
    expect(startsSoon(new Date(now - 5 * 60_000).toISOString(), now)).toBe(true);
  });

  it("does not count a match later in the day, or one with no published time", () => {
    expect(startsSoon(new Date(now + 61 * 60_000).toISOString(), now)).toBe(false);
    // A row the plan places for the first time: there is no time to be reading yet.
    expect(startsSoon(null, now)).toBe(false);
    expect(startsSoon("not a date", now)).toBe(false);
  });
});
