import { describe, expect, it } from "vitest";

import { dayScheduleWording, scheduledFinishWording } from "./finish-wording";

const CLOSE = Date.parse("2026-09-17T17:30:00.000Z");

describe("scheduledFinishWording", () => {
  it("names the latest scheduled finish and the official close it is measured against", () => {
    const wording = scheduledFinishWording({
      finishMs: Date.parse("2026-09-17T13:00:00.000Z"),
      closeMs: CLOSE,
    });
    expect(wording.finish).toContain("Latest scheduled finish");
    expect(wording.close).toContain("Official close");
    expect(wording.warning).toBeNull();
    expect(wording.tone).toBe("normal");
  });

  it("measures the scheduled matches against the close, and names the overrun", () => {
    const wording = scheduledFinishWording({
      finishMs: Date.parse("2026-09-17T18:10:00.000Z"),
      closeMs: CLOSE,
    });
    expect(wording.warning).toBe("40 min past the close");
    expect(wording.tone).toBe("warn");
  });

  it("reports no finish when nothing is left with a time", () => {
    const wording = scheduledFinishWording({ finishMs: null, closeMs: CLOSE });
    expect(wording.finish).toBe("No matches left to play");
    expect(wording.warning).toBeNull();
    expect(wording.tone).toBe("normal");
  });

  it("omits the close when no day has a usable window", () => {
    expect(scheduledFinishWording({ finishMs: null, closeMs: null }).close).toBeNull();
    expect(
      scheduledFinishWording({
        finishMs: Date.parse("2026-09-17T13:00:00.000Z"),
        closeMs: null,
      }).warning,
    ).toBeNull();
  });

  it("is a statement about the schedule, never a forecast of when the event ends", () => {
    const wording = scheduledFinishWording({
      finishMs: Date.parse("2026-09-17T13:00:00.000Z"),
      closeMs: CLOSE,
    });
    expect(JSON.stringify(wording)).not.toMatch(
      /estimated|projected|forecast|expected to finish|still to place/i,
    );
  });
});

describe("dayScheduleWording", () => {
  const dayClose = Date.parse("2026-09-17T17:30:00.000Z");

  it("reports the day's latest scheduled finish against its close", () => {
    const wording = dayScheduleWording({
      latestFinishMs: Date.parse("2026-09-17T17:00:00.000Z"),
      closeMs: dayClose,
    });
    expect(wording.latestFinish).toContain("Last match scheduled to finish");
    expect(wording.closingTime).toContain("Day closes");
    expect(wording.warning).toBeNull();
    expect(wording.tone).toBe("normal");
  });

  it("warns when the day's schedule extends past its close", () => {
    const wording = dayScheduleWording({
      latestFinishMs: Date.parse("2026-09-17T18:10:00.000Z"),
      closeMs: dayClose,
    });
    expect(wording.warning).toBe("Scheduled 40 min past the day's close");
    expect(wording.tone).toBe("warn");
  });

  it("is a statement about the plan, never a forecast of when the day ends", () => {
    const wording = dayScheduleWording({ latestFinishMs: null, closeMs: dayClose });
    expect(wording.latestFinish).toBe("No matches left on the schedule");
    expect(wording.warning).toBeNull();
    expect(JSON.stringify(wording)).not.toMatch(/estimated|projected|expected to finish/i);
  });

  it("says so when the day has no closing time", () => {
    const wording = dayScheduleWording({ latestFinishMs: null, closeMs: null });
    expect(wording.closingTime).toBe("No closing time configured");
  });
});
