/**
 * The first direct tests for the row-to-item builders.
 *
 * `stage-items.ts` had no test file of its own before this: it was only covered indirectly through
 * `placement-schedule.test.ts`, which asserts on whole plans. A whole plan cannot show *why* a match
 * carries the stage it does, and stage identity is now a ranking input — so it is pinned here, at
 * the point where it is produced, in the shape's own terms.
 */

import { describe, expect, it } from "vitest";

import type { PlacementMatch, TierDrawMatch } from "../data";
import {
  buildPlayerLookup,
  fixedRange,
  placementItems,
  tierItems,
  type PlayerLookup,
} from "./stage-items";
import { buildRoundRobin } from "./formats/round-robin";
import { buildSingleElimination } from "./formats/single-elimination";

const NOW = new Date("2026-09-17T08:00:00Z").getTime();

/** Every entrant resolves to a distinct pair of players, so no test depends on a lookup collision. */
const playerLookup: PlayerLookup = (entrantIds) => ({
  playerIds: entrantIds.flatMap((id) => (id ? [`${id}-p1`, `${id}-p2`] : [])),
  playersKnown: entrantIds.every((id) => id != null),
});

function placementMatch(
  id: string,
  stage: "round1" | "round2",
  categoryId = "cat1",
): PlacementMatch {
  return {
    id,
    tournament_id: "t1",
    category_id: categoryId,
    stage,
    generation_key: id,
    entrant_a_id: `${id}-a`,
    entrant_b_id: `${id}-b`,
    winner_id: null,
    games: [],
    is_makeup: false,
    is_crossover: false,
    prerequisite_ids: [],
    court_id: null,
    scheduled_time: null,
    started_at: null,
    ended_at: null,
    reported_time: null,
    status: "scheduled",
    note: null,
    created_at: "2026-09-17T00:00:00Z",
  };
}

function tierMatch(id: string, drawId: string, round: number, slot: number): TierDrawMatch {
  return {
    id,
    tournament_id: "t1",
    draw_id: drawId,
    round,
    slot,
    entrant_a_id: `${id}-a`,
    entrant_b_id: `${id}-b`,
    parent_a_id: null,
    parent_b_id: null,
    winner_id: null,
    games: [],
    is_bye: false,
    court_id: null,
    scheduled_time: null,
    started_at: null,
    ended_at: null,
    reported_time: null,
    status: "scheduled",
    note: null,
    created_at: "2026-09-17T00:00:00Z",
  };
}

const EMPTY_COURTS = new Map<string, number>();
const EMPTY_ORDER = new Map<string, number>();

describe("placementItems stage identity", () => {
  it("keeps decided round-one sources as end-plus-rest floors when their day is no longer in the problem", () => {
    const source = {
      ...placementMatch("source", "round1"),
      status: "reported",
      winner_id: "source-a",
      ended_at: "2026-09-17T23:50:00Z",
    };
    const makeup = { ...placementMatch("makeup", "round2"), status: "reported" };
    const child = { ...placementMatch("child", "round2"), prerequisite_ids: ["source", "makeup"] };
    const items = placementItems({
      matches: [source, makeup, child],
      playerLookup,
      courtNumberById: EMPTY_COURTS,
      categoryOrder: EMPTY_ORDER,
      slotMinutes: 30,
      restGap: 20,
      now: NOW,
    });
    expect(items.find((i) => i.id === "child")).toMatchObject({
      dependencies: ["makeup"],
      eligibleFrom: Date.parse("2026-09-18T00:10:00Z"),
    });
  });
  it("keys a match by its category and its own round", () => {
    const items = placementItems({
      matches: [placementMatch("m1", "round1"), placementMatch("m2", "round2")],
      playerLookup,
      courtNumberById: EMPTY_COURTS,
      categoryOrder: EMPTY_ORDER,
      roundTwoCategories: new Set(["cat1"]),
      slotMinutes: 30,
      restGap: 20,
      now: NOW,
    });

    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get("m1")?.stageKey).toBe("cat1:round1");
    expect(byId.get("m2")?.stageKey).toBe("cat1:round2");
  });

  it("marks round one as unlocking only when the field can produce a round two", () => {
    const build = (roundTwoCategories: ReadonlySet<string>) =>
      placementItems({
        matches: [placementMatch("r1", "round1"), placementMatch("r2", "round2")],
        playerLookup,
        courtNumberById: EMPTY_COURTS,
        categoryOrder: EMPTY_ORDER,
        roundTwoCategories,
        slotMinutes: 30,
        restGap: 20,
        now: NOW,
      });

    const withRoundTwo = build(new Set(["cat1"]));
    expect(withRoundTwo[0]?.stageUnlocks).toBe(true);
    // Round two is the end of the placement event, so it releases nothing.
    expect(withRoundTwo[1]?.stageUnlocks).toBe(false);

    // A field of one or two reaches the draws without a round two: nothing is released.
    const withoutRoundTwo = build(new Set());
    expect(withoutRoundTwo[0]?.stageUnlocks).toBe(false);
  });

  it("falls back to no unlock when the caller supplies no field-size knowledge", () => {
    // The pre-change behaviour, and what keeps "absent means false" honest rather than assumed.
    const items = placementItems({
      matches: [placementMatch("r1", "round1")],
      playerLookup,
      courtNumberById: EMPTY_COURTS,
      categoryOrder: EMPTY_ORDER,
      slotMinutes: 30,
      restGap: 20,
      now: NOW,
    });
    expect(items[0]?.stageKey).toBe("cat1:round1");
    expect(items[0]?.stageUnlocks).toBe(false);
  });
});

describe("tierItems stage identity", () => {
  const input = (drawRoundCount: ReadonlyMap<string, number>) =>
    tierItems({
      matches: [
        tierMatch("d1-r1", "draw-A", 1, 0),
        tierMatch("d1-r2", "draw-A", 2, 0),
        tierMatch("d2-r1", "draw-B", 1, 0),
      ],
      drawCategory: new Map([
        ["draw-A", "cat1"],
        ["draw-B", "cat1"],
      ]),
      drawRoundCount,
      playerLookup,
      courtNumberById: EMPTY_COURTS,
      categoryOrder: EMPTY_ORDER,
      slotMinutes: 45,
      restGap: 30,
      now: NOW,
    });

  it("keys a bracket round by its draw, not by its category", () => {
    const items = input(new Map([["draw-A", 2]]));
    const byId = new Map(items.map((item) => [item.id, item]));
    // Two draws of one category are two brackets, so they must not collapse into one stage.
    expect(byId.get("d1-r1")?.stageKey).toBe("draw-A:r1");
    expect(byId.get("d1-r2")?.stageKey).toBe("draw-A:r2");
    expect(byId.get("d2-r1")?.stageKey).toBe("draw-B:r1");
  });

  it("unlocks every round but the draw's last", () => {
    const items = input(new Map([["draw-A", 2]]));
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get("d1-r1")?.stageUnlocks).toBe(true);
    expect(byId.get("d1-r2")?.stageUnlocks).toBe(false);
    // A draw whose depth the caller did not state releases nothing, which is the pre-change
    // behaviour rather than a guessed unlock.
    expect(byId.get("d2-r1")?.stageUnlocks).toBe(false);
  });
});

describe("tierItems with the whole bracket drawn", () => {
  const items = (matches: TierDrawMatch[]) =>
    tierItems({
      matches,
      drawCategory: new Map([["draw-A", "cat1"]]),
      drawRoundCount: new Map([["draw-A", 2]]),
      playerLookup,
      courtNumberById: EMPTY_COURTS,
      categoryOrder: EMPTY_ORDER,
      slotMinutes: 45,
      restGap: 30,
      now: NOW,
    });

  it("schedules only a match whose two sides are both known", () => {
    const ready = tierMatch("ready", "draw-A", 1, 1);
    const half = { ...tierMatch("half", "draw-A", 2, 1), entrant_b_id: null };
    const empty = {
      ...tierMatch("empty", "draw-A", 2, 2),
      entrant_a_id: null,
      entrant_b_id: null,
    };
    expect(items([ready, half, empty]).map((item) => item.id)).toEqual(["ready"]);
  });

  it("binds a child to its feeders once the parents are linked", () => {
    const parentA = {
      ...tierMatch("pa", "draw-A", 1, 1),
      status: "reported" as const,
      ended_at: "2026-09-20T10:00:00Z",
    };
    const child = {
      ...tierMatch("child", "draw-A", 2, 1),
      parent_a_id: "pa",
      parent_b_id: "pb",
    };
    const item = items([parentA, child]).find((entry) => entry.id === "child");
    // 30 minutes of rest after the feeder ended; the missing second feeder adds no floor.
    expect(item?.eligibleFrom).toBe(Date.parse("2026-09-20T10:30:00Z"));
  });
});

describe("format builders stage identity", () => {
  it("gives a round robin one stage per round, and releases all but the last", () => {
    const matches = buildRoundRobin({ entrants: ["a", "b", "c", "d"], groupKey: "pool-1" });
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      const round = Number(match.stageKey!.split(":r")[1]);
      expect(match.stageKey).toBe(`pool-1:r${round}`);
      expect(match.stageUnlocks).toBe(round < 3);
    }
    // The last round is present, so the assertion above is not vacuous.
    expect(matches.some((match) => match.stageKey === "pool-1:r3")).toBe(true);
  });

  it("gives a bracket one stage per round and marks the final as releasing nothing", () => {
    const matches = buildSingleElimination({ entrants: ["a", "b", "c", "d"], groupKey: "draw-7" });
    const byRound = new Map(matches.map((match) => [match.stageKey, match]));
    expect([...byRound.keys()].sort()).toEqual(["draw-7:r1", "draw-7:r2"]);
    expect(byRound.get("draw-7:r1")?.stageUnlocks).toBe(true);
    expect(byRound.get("draw-7:r2")?.stageUnlocks).toBe(false);
  });

  it("still says round one unlocks the rest when the caller builds round one alone", () => {
    // `roundOneOnly` means the later rounds are created as results arrive — they do not exist as
    // rows yet, which is exactly the case the unlock signal exists for.
    const matches = buildSingleElimination({
      entrants: ["a", "b", "c", "d"],
      groupKey: "draw-7",
      roundOneOnly: true,
    });
    expect(matches).toHaveLength(2);
    for (const match of matches) {
      expect(match.stageKey).toBe("draw-7:r1");
      expect(match.stageUnlocks).toBe(true);
    }
  });

  it("releases nothing from a two-entrant bracket, whose only round is the final", () => {
    const matches = buildSingleElimination({ entrants: ["a", "b"], groupKey: "draw-7" });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.stageKey).toBe("draw-7:r1");
    expect(matches[0]?.stageUnlocks).toBe(false);
  });
});

describe("buildPlayerLookup", () => {
  it("reports an unknown side rather than inventing a player", () => {
    const lookup = buildPlayerLookup(
      [
        {
          id: "e1",
          tournament_id: "t1",
          category_id: "cat1",
          team_id: "team1",
          skill_level: "intermediate",
          seed: 1,
          tier: null,
          excluded: false,
          seed_locked_at: null,
          created_at: "2026-09-17T00:00:00Z",
        },
      ],
      [
        {
          id: "team1",
          tournament_id: "t1",
          category_id: "cat1",
          player_1_id: "p1",
          player_2_id: null,
          seed: null,
          withdrawn: false,
          created_at: "2026-09-17T00:00:00Z",
        },
      ],
    );
    expect(lookup(["e1"])).toEqual({ playerIds: ["p1"], playersKnown: true });
    // A knockout side awaiting its winner: not schedulable, and not a one-player match either.
    expect(lookup(["e1", null])).toEqual({ playerIds: ["p1"], playersKnown: false });
  });
});

describe("fixedRange for a match that is in progress", () => {
  const MIN = 60_000;
  const start = Date.parse("2026-09-17T10:00:00Z");
  const base = {
    status: "in-progress",
    scheduledTime: new Date(start).toISOString(),
    startedAt: new Date(start).toISOString(),
    endedAt: null,
    slotMinutes: 30,
  };

  it("ends at the end of its slot while it is inside it, not a slot from now", () => {
    const range = fixedRange({ ...base, now: start + 20 * MIN });
    expect(range).toEqual({ start, end: start + 30 * MIN });
  });

  it("is taken as ending now once it has overrun", () => {
    const now = start + 50 * MIN;
    expect(fixedRange({ ...base, now })).toEqual({ start, end: now });
  });

  it("gives whole milliseconds even from a fractional clock", () => {
    const range = fixedRange({ ...base, now: start + 50 * MIN + 0.6 });
    expect(Number.isInteger(range?.end)).toBe(true);
  });

  it("still models a finished match by the interval it really took", () => {
    const range = fixedRange({
      ...base,
      status: "reported",
      endedAt: new Date(start + 22 * MIN).toISOString(),
      now: start + 90 * MIN,
    });
    expect(range).toEqual({ start, end: start + 22 * MIN });
  });
});
