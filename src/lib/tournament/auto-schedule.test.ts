import { describe, expect, it, vi } from "vitest";

import {
  INITIAL_RETRY,
  RETRY_DELAYS_MS,
  type RetryState,
  SETTLE_MS,
  attemptResult,
  autoScheduleProblem,
  describeUnplaced,
  eventsUnderWay,
  hasBuiltSchedule,
  isTransientDecline,
  planRetry,
  runAutoSchedule,
  singleFlight,
  type AutoScheduleDeps,
  type AutoScheduleOutcome,
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
    unplaced: [],
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
    const d = deps({
      plan: vi.fn(() => plan({ unplaced: [{ matchId: "x", reason: "past_closing" }] })),
    });
    const outcome = await runAutoSchedule(d);
    expect(outcome).toMatchObject({ ran: true, placed: 0, unplaced: 1, transient: 0 });
    expect(outcome.reasons).toEqual([{ matchId: "x", reason: "past_closing" }]);
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
    expect(outcome).toMatchObject({ ran: true, placed: 1, declined: 1, transient: 1 });
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

describe("isTransientDecline / attemptResult", () => {
  it("treats races as transient and a bad court as not", () => {
    for (const reason of [
      "court_busy",
      "player_busy",
      "already_placed",
      "not_ready",
      "prerequisite_unplaced",
    ]) {
      expect(isTransientDecline(reason)).toBe(true);
    }
    for (const reason of [
      "bad_court",
      "incomplete",
      "unknown_match",
      "before_prerequisite",
      "after_dependent",
    ]) {
      expect(isTransientDecline(reason)).toBe(false);
    }
  });

  it("calls an attempt settled, transient or failed", () => {
    const base = {
      ran: true,
      generated: { roundOne: 0, roundTwo: 0, draws: 0 },
      placed: 0,
      declined: 0,
      unplaced: 0,
      reasons: [],
      transient: 0,
    };
    expect(attemptResult({ ...base }, false)).toBe("settled");
    expect(attemptResult({ ...base, transient: 2 }, false)).toBe("transient");
    expect(attemptResult(null, true)).toBe("failed");
    expect(attemptResult(null, false)).toBe("settled");
  });
});

describe("planRetry", () => {
  it("waits for a new situation to settle, then tries once", () => {
    const first = planRetry(INITIAL_RETRY, "a|b", null);
    expect(first).toEqual({ state: { signature: "a|b", attempts: 0 }, delayMs: SETTLE_MS });
  });

  it("does not ask again once an attempt settled, whatever it left behind", () => {
    const state = { signature: "a|b", attempts: 0 };
    expect(planRetry(state, "a|b", "settled").delayMs).toBeNull();
  });

  it("retries a transient failure with growing waits, three times, then stops", () => {
    let state: RetryState = { signature: "s", attempts: 0 };
    const waits: (number | null)[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = planRetry(state, "s", "transient");
      waits.push(next.delayMs);
      state = next.state;
    }
    expect(waits).toEqual([...RETRY_DELAYS_MS, null]);
  });

  it("treats a thrown error like a transient one", () => {
    expect(planRetry({ signature: "s", attempts: 0 }, "s", "failed").delayMs).toBe(RETRY_DELAYS_MS[0]);
  });

  it("starts over when the situation changes, and stops when there is nothing left", () => {
    const worn = { signature: "old", attempts: 3 };
    expect(planRetry(worn, "new", "transient")).toEqual({
      state: { signature: "new", attempts: 0 },
      delayMs: SETTLE_MS,
    });
    expect(planRetry(worn, null, null)).toEqual({ state: INITIAL_RETRY, delayMs: null });
  });
});

describe("describeUnplaced", () => {
  const u = (reason: "no_courts" | "past_closing" | "held_behind_placement" | "data" | "no_slot") =>
    ({ matchId: reason, reason }) as const;

  it("says nothing when nothing is left", () => {
    expect(describeUnplaced([])).toBeNull();
  });

  it("names the cause in the organiser's terms and counts matches", () => {
    const notice = describeUnplaced([u("past_closing"), { matchId: "b", reason: "past_closing" }]);
    expect(notice?.headline).toBe("2 ready matches have no time yet");
    expect(notice?.detail).toMatch(/after the last day closes/);
    expect(notice?.action).toBe("rebuild");
    expect(describeUnplaced([u("past_closing")])?.headline).toBe("1 ready match has no time yet");
  });

  it("puts the most fundamental cause first and sends no-courts to settings", () => {
    const notice = describeUnplaced([u("past_closing"), u("no_courts"), u("data")]);
    expect(notice?.action).toBe("settings");
    expect(notice?.detail).toMatch(/No day has a court/);
  });

  it("explains a knockout held behind placement, then a data problem, in that order", () => {
    expect(describeUnplaced([u("held_behind_placement"), u("data")])?.detail).toMatch(/placement matches/);
    expect(describeUnplaced([u("data")])?.detail).toMatch(/prerequisite is missing/);
  });

  it("never offers a button called Place now", () => {
    for (const reason of ["no_courts", "past_closing", "held_behind_placement", "data"] as const) {
      expect(describeUnplaced([u(reason)])?.actionLabel).not.toMatch(/place/i);
    }
  });
});

describe("autoScheduleProblem", () => {
  const outcome = (partial: Partial<AutoScheduleOutcome> = {}): AutoScheduleOutcome => ({
    ran: true,
    generated: { roundOne: 0, roundTwo: 0, draws: 0 },
    placed: 0,
    declined: 0,
    unplaced: 0,
    reasons: [],
    transient: 0,
    ...partial,
  });

  it("names a pass that threw, with the error it threw", () => {
    expect(autoScheduleProblem(null, new Error("Invalid scheduling problem (7 issues)"))).toEqual({
      kind: "error",
      detail: "Automatic scheduling failed: Invalid scheduling problem (7 issues)",
    });
  });

  it("says a refused pass will try again", () => {
    expect(autoScheduleProblem(outcome({ declined: 1, transient: 1 }), null)?.kind).toBe("declined");
  });

  it("words what is left unplaced in the Schedule page's terms", () => {
    expect(
      autoScheduleProblem(outcome({ unplaced: 1, reasons: [{ matchId: "m1", reason: "past_closing" }] }), null),
    ).toEqual({
      kind: "unplaced",
      detail: describeUnplaced([{ matchId: "m1", reason: "past_closing" }])!.detail,
    });
  });

  it("has nothing to say when the pass placed everything", () => {
    expect(autoScheduleProblem(outcome({ placed: 3 }), null)).toBeNull();
  });
});
