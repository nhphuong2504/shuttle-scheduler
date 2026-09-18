import { describe, expect, it } from "vitest";

import type { FinishEstimate } from "./finish-estimate";
import { finishEstimateWording } from "./finish-wording";

function estimate(overrides: Partial<FinishEstimate> = {}): FinishEstimate {
  return {
    finish: "2026-09-17T13:00:00.000Z",
    placedFinish: "2026-09-17T12:00:00.000Z",
    unplacedMatches: 0,
    uncreatedMatches: 3,
    deficitMinutes: null,
    basis: "projected",
    remainingMatches: 3,
    days: 2,
    ...overrides,
  };
}

describe("finishEstimateWording", () => {
  it("reads a placed tournament as a finish, not an estimate", () => {
    const wording = finishEstimateWording(
      estimate({ basis: "placed", remainingMatches: 0, uncreatedMatches: 0 }),
    );
    expect(wording.headline.startsWith("Finishes")).toBe(true);
    expect(wording.headline).not.toContain("~");
    expect(wording.detail).toBeNull();
    expect(wording.tone).toBe("good");
  });

  it("labels forecast work as an estimate and says how much is left", () => {
    const wording = finishEstimateWording(estimate({ remainingMatches: 7 }));
    expect(wording.headline.startsWith("Estimated finish")).toBe(true);
    expect(wording.detail).toBe("7 matches still to place");
    expect(wording.tone).toBe("normal");
  });

  it("singularises a single remaining match", () => {
    expect(finishEstimateWording(estimate({ remainingMatches: 1 })).detail).toBe(
      "1 match still to place",
    );
  });

  it("names the extension, never the official close, when the work overruns", () => {
    const wording = finishEstimateWording(estimate({ basis: "overflow", deficitMinutes: 40 }));
    expect(wording.headline).toBe("Needs ~40 min beyond the tournament window");
    expect(wording.detail?.startsWith("Estimated finish")).toBe(true);
    expect(wording.tone).toBe("warn");
  });

  it("names no clock time when something cannot be placed at all", () => {
    const wording = finishEstimateWording(
      estimate({
        basis: "overflow",
        finish: null,
        deficitMinutes: null,
        remainingMatches: 4,
        days: 2,
      }),
    );
    expect(wording.headline).toBe("Cannot finish in 2 days");
    expect(wording.detail).toBe("4 matches still need capacity");
    expect(wording.value).toBe("—");
    expect(wording.tone).toBe("danger");
  });

  it("falls back to the configured days when no day has courts", () => {
    const wording = finishEstimateWording(
      estimate({ basis: "overflow", finish: null, remainingMatches: 4, days: 0 }),
    );
    expect(wording.headline).toBe("Cannot finish in the configured days");
  });

  it("discloses that the number is a structural estimate", () => {
    const wording = finishEstimateWording(estimate());
    expect(wording.note).toContain("Structural estimate");
    expect(wording.note).toContain("does not account for one player appearing in several events");
  });

  it("never invents a time when the rows are already an impossible layout", () => {
    const wording = finishEstimateWording(
      estimate({ basis: "invalid", finish: null, remainingMatches: 6 }),
    );
    expect(wording.headline).toBe("Finish estimate unavailable");
    expect(wording.detail).toContain("6 matches still to place");
    expect(wording.value).toBe("—");
    expect(wording.tone).toBe("warn");
  });

  it("compares forecast against forecast, and returns nothing when either side has no clock", () => {
    const current = estimate({ finish: "2026-09-17T12:00:00.000Z" });
    expect(finishEstimateWording(estimate(), current).comparison).not.toBeNull();
    // A current state with no nameable finish cannot be compared against: never a floor.
    expect(
      finishEstimateWording(estimate(), estimate({ finish: null, basis: "overflow" })).comparison,
    ).toBeNull();
    expect(finishEstimateWording(estimate(), null).comparison).toBeNull();
  });
});
