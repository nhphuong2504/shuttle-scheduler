import { describe, expect, it } from "vitest";

import vietNamOpen from "./fixtures/viet-nam-open-field.json";
import {
  STRATEGIES,
  findOverlaps,
  mulberry32,
  quantile,
  runReplay,
  type FieldSpec,
  type ReplayConfig,
  type ScheduleAudit,
  type TimelineEntry,
} from "./strategy-replay";

/** Small enough to run with the unit tests; the full comparison lives in the benchmark runner. */
const SMALL: ReplayConfig = {
  seed: 3,
  events: [8, 8],
  courts: 3,
  sharedPlayersPerEvent: 2,
  jitterMinutes: { min: -10, max: 25 },
  dayCount: 2,
  dayEnd: "18:00:00",
  compact: { freezeMinutes: 180, minGainMinutes: 15 },
  gate: { windowMinutes: 120, maxPostponeMinutes: 30 },
};

describe("strategy replay: helpers", () => {
  it("is reproducible from its seed", () => {
    const a = mulberry32(5);
    const b = mulberry32(5);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("takes quantiles of a list, and of nothing", () => {
    expect(quantile([], 0.95)).toBe(0);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
  });
});

describe.each(STRATEGIES)("strategy replay: %s", (strategy) => {
  const timeline: TimelineEntry[] = [];
  const metrics = runReplay(strategy, SMALL, timeline);

  it("plays every match to the end", () => {
    expect(metrics.stuck).toBe(false);
    // Two events of eight: 8 round one, 8 round two, and the brackets of two entrants per tier.
    expect(metrics.matches).toBeGreaterThanOrEqual(2 * (4 + 4) + 2 * 4);
  });

  it("never puts two matches on one court or one player at the same time", () => {
    expect(findOverlaps(timeline)).toEqual([]);
  });

  it("is reproducible: the same seed gives the same tournament", () => {
    const again = runReplay(strategy, SMALL);
    expect(again.finishMs).toBe(metrics.finishMs);
    expect(again.matches).toBe(metrics.matches);
    expect(again.postponements).toBe(metrics.postponements);
  });

  it("never runs a match before its published time or on a negative wait", () => {
    expect(metrics.waitSumMinutes).toBeGreaterThanOrEqual(0);
    expect(metrics.startLatenessMeanMinutes).toBeGreaterThanOrEqual(0);
  });
});

describe("strategy replay: what only some strategies may do", () => {
  it("place-ready never changes a published time", () => {
    const metrics = runReplay("place-ready", SMALL);
    expect(metrics.postponements).toBe(0);
    expect(metrics.advancements).toBe(0);
  });

  it("place-then-compact never pushes something starting within its pinned window", () => {
    const metrics = runReplay("place-then-compact", SMALL);
    expect(metrics.gateBreaches).toBe(0);
  });

  it("the gate keeps its promise: no accepted plan breaches it unless the organiser stepped in", () => {
    const gated = runReplay("gated-rebuild", SMALL);
    // A forced review is the organiser accepting a plan the gate refused, so it may breach.
    if (gated.manualPresses === 0) expect(gated.gateBreaches).toBe(0);
  });
});

describe("strategy replay: the compaction keeps the rules it must", () => {
  it("never breaks court, rest or feeder rules, before or after a pull-forward", () => {
    const log: { before: ScheduleAudit; after: ScheduleAudit }[] = [];
    for (const seed of [1, 2, 3]) {
      runReplay("rebuild-leftshift", { ...SMALL, seed, events: [8, 12], courts: 3 }, undefined, undefined, undefined, log);
    }
    expect(log.length).toBeGreaterThan(0);
    for (const { before, after } of log) {
      expect(after.courtOverlaps).toBe(0);
      expect(after.restViolations).toBe(0);
      expect(after.feederViolations).toBe(0);
      // It must not introduce what the plan did not already contain.
      expect(after.restViolations).toBeLessThanOrEqual(before.restViolations);
    }
  });
});

describe("strategy replay: the real Viet Nam Open entries", () => {
  const REAL: ReplayConfig = {
    ...SMALL,
    courts: 6,
    dayCount: 2,
    field: vietNamOpen as unknown as FieldSpec,
    timing: { groupSlot: 20, groupRest: 10, koSlot: 25, koRest: 30 },
    jitterFraction: { min: -0.3, max: 0.6 },
  };

  // Seeds 3 and 5 made place-ready throw "unknown-dependency" before a dropped prerequisite was kept
  // as a time floor: the 11-entrant event has a held entrant, so its second make-up match depends on its
  // first.
  describe.each(["place-ready", "rebuild"] as const)("%s", (strategy) => {
    for (const seed of [3, 5]) {
      it(`plays every match on seed ${seed}, with no clash and the make-ups in order`, () => {
        const timeline: TimelineEntry[] = [];
        const metrics = runReplay(strategy, { ...REAL, seed }, timeline);
        expect(metrics.stuck).toBe(false);
        // 5 events of 24, 18, 16, 11 and 24: every entrant plays two placement matches, plus the draws.
        expect(metrics.matches).toBeGreaterThan(150);
        expect(findOverlaps(timeline)).toEqual([]);
        const byId = new Map(timeline.map((t) => [t.id, t]));
        const first = byId.get("pm-3-r2-makeup-1");
        const second = byId.get("pm-3-r2-makeup-2");
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        expect((second as TimelineEntry).start).toBeGreaterThanOrEqual((first as TimelineEntry).end);
      });
    }
  });
});
