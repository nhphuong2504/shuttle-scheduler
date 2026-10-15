import { describe, expect, it, vi } from "vitest";

import {
  eventsUnderWay,
  hasBuiltSchedule,
  runAutoSchedule,
  singleFlight,
  type AutoScheduleDeps,
  type FreshSchedulingRows,
} from "./auto-schedule";
import type { PlacementSchedulePlan } from "./placement-schedule";

const NO_GENERATION = { generated: { roundOne: 0, roundTwo: 0, draws: 0 }, skipped: [] };

function rows(overrides: Partial<FreshSchedulingRows> = {}): FreshSchedulingRows {
  return { placementMatches: [], tierMatches: [], draws: [], entrants: [], ...overrides };
}

const timed = {
  id: "m1",
  category_id: "cat1",
  status: "scheduled",
  scheduled_time: "2026-09-17T10:00:00Z",
} as never;

function plan(partial: Partial<PlacementSchedulePlan> = {}): PlacementSchedulePlan {
  return {
    placementNewPayload: [],
    knockoutNewPayload: [],
    blocked: [],
    ...partial,
  } as PlacementSchedulePlan;
}

function deps(overrides: Partial<AutoScheduleDeps> = {}): AutoScheduleDeps {
  return {
    fetchFresh: vi.fn(async () => rows({ placementMatches: [timed] })),
    generate: vi.fn(async () => NO_GENERATION),
    plan: vi.fn(() => plan()),
    apply: vi.fn(async () => ({ placed: [], skipped: [] })),
    ...overrides,
  };
}

describe("hasBuiltSchedule / eventsUnderWay", () => {
  it("is false until some match holds a time", () => {
    expect(hasBuiltSchedule(rows())).toBe(false);
    expect(
      hasBuiltSchedule(rows({ placementMatches: [{ ...(timed as object), scheduled_time: null } as never] })),
    ).toBe(false);
    expect(hasBuiltSchedule(rows({ placementMatches: [timed] }))).toBe(true);
  });

  it("ignores a void match's time", () => {
    expect(
      hasBuiltSchedule(rows({ placementMatches: [{ ...(timed as object), status: "void" } as never] })),
    ).toBe(false);
  });

  it("counts an event as under way once it has a placement match", () => {
    expect([...eventsUnderWay(rows({ placementMatches: [timed] }))]).toEqual(["cat1"]);
  });
});

describe("runAutoSchedule", () => {
  it("leaves the first build to the operator", async () => {
    const d = deps({ fetchFresh: vi.fn(async () => rows()) });
    const outcome = await runAutoSchedule(d);
    expect(outcome.ran).toBe(false);
    expect(d.generate).not.toHaveBeenCalled();
    expect(d.apply).not.toHaveBeenCalled();
  });

  it("does not write when there is nothing new to place", async () => {
    const d = deps({ plan: vi.fn(() => plan({ blocked: ["x"] })) });
    const outcome = await runAutoSchedule(d);
    expect(outcome).toMatchObject({ ran: true, placed: 0, unplaced: 1 });
    expect(d.apply).not.toHaveBeenCalled();
  });

  it("places new matches through the additive writer and reports the split", async () => {
    const d = deps({
      plan: vi.fn(() =>
        plan({
          knockoutNewPayload: [{ match_id: "k1", scheduled_time: "t", court_id: "c1" }],
        }),
      ),
      apply: vi.fn(async () => ({
        placed: ["k1"],
        skipped: [{ match_id: "k2", reason: "court_busy" }],
      })),
    });
    const outcome = await runAutoSchedule(d);
    expect(outcome).toMatchObject({ ran: true, placed: 1, declined: 1 });
    expect(d.apply).toHaveBeenCalledTimes(1);
  });

  it("re-reads the rows after generating a stage, so the plan sees the new matches", async () => {
    const fetchFresh = vi.fn(async () => rows({ placementMatches: [timed] }));
    const d = deps({
      fetchFresh,
      generate: vi.fn(async () => ({
        generated: { roundOne: 0, roundTwo: 1, draws: 0 },
        skipped: [],
      })),
    });
    const outcome = await runAutoSchedule(d);
    expect(fetchFresh).toHaveBeenCalledTimes(2);
    expect(outcome.generated.roundTwo).toBe(1);
  });

  it("does not re-read when nothing was generated", async () => {
    const fetchFresh = vi.fn(async () => rows({ placementMatches: [timed] }));
    await runAutoSchedule(deps({ fetchFresh }));
    expect(fetchFresh).toHaveBeenCalledTimes(1);
  });
});

describe("singleFlight", () => {
  it("runs once for a burst of calls, plus one follow-up", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = singleFlight(async () => {
      calls += 1;
      if (calls === 1) await gate;
    });

    const first = run();
    run();
    run();
    run();
    release();
    await first;

    // One run in flight, then exactly one more for everything that arrived meanwhile.
    expect(calls).toBe(2);
  });

  it("can run again after it finishes", async () => {
    let calls = 0;
    const run = singleFlight(async () => {
      calls += 1;
    });
    await run();
    await run();
    expect(calls).toBe(2);
  });

  it("keeps working after a run throws", async () => {
    let calls = 0;
    const run = singleFlight(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    });
    await expect(run()).rejects.toThrow("boom");
    await run();
    expect(calls).toBe(2);
  });
});
