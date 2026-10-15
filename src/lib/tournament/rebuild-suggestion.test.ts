import { describe, expect, it } from "vitest";

import {
  MIN_FINISH_GAIN_MINUTES,
  buildRebuildSuggestion,
  describeMinutes,
} from "./rebuild-suggestion";
import type { PlanChange } from "./schedule-diff";

const MINUTE = 60_000;
const NOW = Date.parse("2026-09-17T12:00:00Z");

const change = (kind: PlanChange["kind"], minutesFromNow: number | null): PlanChange => ({
  matchId: `m${minutesFromNow}-${kind}`,
  kind,
  fromStart: minutesFromNow == null ? null : new Date(NOW + minutesFromNow * MINUTE).toISOString(),
  toStart: new Date(NOW + 5 * MINUTE).toISOString(),
  fromCourtNumber: 1,
  toCourtNumber: 1,
  shiftMinutes: 10,
});

const base = {
  currentFinishMs: NOW + 300 * MINUTE,
  plannedFinishMs: NOW + 245 * MINUTE,
  blockedCount: 0,
  diff: {
    changes: [change("time-moved", 30), change("time-moved", 200), change("unchanged", 10)],
    movedCount: 2,
  },
  now: NOW,
};

describe("buildRebuildSuggestion", () => {
  it("says nothing unless the rebuild finishes meaningfully sooner", () => {
    expect(buildRebuildSuggestion({ ...base, plannedFinishMs: NOW + 295 * MINUTE })).toBeNull();
    expect(
      buildRebuildSuggestion({ ...base, plannedFinishMs: base.currentFinishMs - (MIN_FINISH_GAIN_MINUTES - 1) * MINUTE }),
    ).toBeNull();
    expect(
      buildRebuildSuggestion({ ...base, plannedFinishMs: base.currentFinishMs - MIN_FINISH_GAIN_MINUTES * MINUTE }),
    ).not.toBeNull();
  });

  it("says nothing when the rebuild would finish later", () => {
    expect(buildRebuildSuggestion({ ...base, plannedFinishMs: NOW + 400 * MINUTE })).toBeNull();
  });

  it("says nothing when there is nothing left to play, or no plan to compare", () => {
    expect(buildRebuildSuggestion({ ...base, currentFinishMs: null })).toBeNull();
    expect(buildRebuildSuggestion({ ...base, plannedFinishMs: null })).toBeNull();
  });

  it("does not offer a rebuild that cannot place every match", () => {
    expect(buildRebuildSuggestion({ ...base, blockedCount: 1 })).toBeNull();
  });

  it("does not offer a gain that moves nothing", () => {
    expect(
      buildRebuildSuggestion({ ...base, diff: { changes: [change("unchanged", 10), change("newly-placed", null)], movedCount: 0 } }),
    ).toBeNull();
  });

  it("states the gain and the cost, counting only matches that already had a time", () => {
    const suggestion = buildRebuildSuggestion({
      ...base,
      diff: {
        changes: [
          change("time-moved", 30),
          change("both-moved", 45),
          change("court-moved", 200),
          change("newly-placed", null),
          change("unchanged", 5),
        ],
        movedCount: 3,
      },
    });
    expect(suggestion?.finishGainMinutes).toBe(55);
    expect(suggestion?.movedCount).toBe(3);
    expect(suggestion?.movedSoonCount).toBe(2);
    expect(suggestion?.headline).toBe("A rebuild would finish 55 min sooner");
    expect(suggestion?.detail).toBe(
      "It would move 3 matches, 2 of them starting within the hour. Nothing changes until you review and apply it.",
    );
  });

  it("says plainly when none of the moves is soon", () => {
    const suggestion = buildRebuildSuggestion({
      ...base,
      diff: { changes: [change("time-moved", 120)], movedCount: 1 },
    });
    expect(suggestion?.detail).toBe(
      "It would move 1 match, none starting within the hour. Nothing changes until you review and apply it.",
    );
  });

  it("reads naturally when every move, or the only move, is soon", () => {
    const one = buildRebuildSuggestion({
      ...base,
      diff: { changes: [change("time-moved", 20)], movedCount: 1 },
    });
    expect(one?.detail).toContain("1 match, starting within the hour");
    const all = buildRebuildSuggestion({
      ...base,
      diff: { changes: [change("time-moved", 20), change("time-moved", 40)], movedCount: 2 },
    });
    expect(all?.detail).toContain("2 matches, all starting within the hour");
  });
});

describe("describeMinutes", () => {
  it("shows minutes under an hour and hours above it", () => {
    expect(describeMinutes(55)).toBe("55 min");
    expect(describeMinutes(60)).toBe("1 h");
    expect(describeMinutes(130)).toBe("2 h 10 min");
  });
});
