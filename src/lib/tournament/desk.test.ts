import { describe, expect, it } from "vitest";

import {
  deriveCourtState,
  deskKindPhase,
  deskKindScoringStage,
  deskKindTable,
  finishStatusLabel,
  getMatchReadiness,
  isPlacementKind,
  playerStatus,
  projectedFinishFromRemaining,
  scheduleVarianceMinutes,
  type DeskMatchKind,
  type DeskMatchModel,
} from "./desk";

const base = new Date("2026-09-12T08:00:00Z").getTime();
const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();

function match(patch: Partial<DeskMatchModel> & Pick<DeskMatchModel, "id">): DeskMatchModel {
  return {
    kind: "pool",
    courtId: "c1",
    status: "scheduled",
    startedAt: null,
    endedAt: null,
    scheduled: at(0),
    playerIds: ["p1", "p2"],
    ...patch,
  };
}

describe("desk readiness", () => {
  it("blocks a match while one of its players is on another court", () => {
    const target = match({ id: "next", courtId: "c1", playerIds: ["p1"] });
    const active = match({
      id: "active",
      courtId: "c2",
      status: "in-progress",
      playerIds: ["p1"],
      startedAt: at(0),
    });

    expect(getMatchReadiness(target, [target, active], 10, base + 5 * 60_000)).toMatchObject({
      state: "player-busy",
      blockingMatchId: "active",
      blockingCourtId: "c2",
      playerId: "p1",
    });
  });

  it("returns the latest player rest deadline", () => {
    const target = match({ id: "next", playerIds: ["p1", "p2"] });
    const previousOne = match({
      id: "previous-1",
      status: "reported",
      endedAt: at(5),
      playerIds: ["p1"],
    });
    const previousTwo = match({
      id: "previous-2",
      status: "reported",
      endedAt: at(8),
      playerIds: ["p2"],
    });

    expect(
      getMatchReadiness(target, [target, previousOne, previousTwo], 10, base + 12 * 60_000),
    ).toMatchObject({
      state: "resting",
      readyAt: base + 18 * 60_000,
      playerId: "p2",
      remainingMinutes: 6,
    });
  });
});

describe("desk court state", () => {
  it("marks an active court overrun using the configured slot", () => {
    const active = match({
      id: "active",
      status: "in-progress",
      startedAt: at(0),
    });
    const state = deriveCourtState(
      "c1",
      [active],
      () => 20,
      () => 10,
      base + 21 * 60_000,
    );
    expect(state.state).toBe("overrun");
    expect(state.elapsedMinutes).toBe(21);
  });

  it("marks a free court blocked when its next player is resting", () => {
    const previous = match({
      id: "previous",
      status: "reported",
      endedAt: at(5),
      playerIds: ["p1"],
    });
    const next = match({ id: "next", scheduled: at(10), playerIds: ["p1"] });
    const state = deriveCourtState(
      "c1",
      [previous, next],
      () => 20,
      () => 10,
      base + 10 * 60_000,
    );
    expect(state.state).toBe("free-blocked");
    expect(state.readiness?.remainingMinutes).toBe(5);
  });
});

describe("desk operational metrics", () => {
  it("projects finish from in-progress matches using elapsed time", () => {
    const active = match({
      id: "active",
      status: "in-progress",
      startedAt: at(0),
      scheduled: at(0),
    });
    // Overrun by five minutes: nothing says when it ends, so it is taken as ending now, like the database.
    const finish = projectedFinishFromRemaining([active], () => 20, base + 25 * 60_000);
    expect(finish).toBe(base + 25 * 60_000);
  });

  it("projects finish at the end of the slot while an in-progress match is still inside it", () => {
    const active = match({
      id: "active",
      status: "in-progress",
      startedAt: at(0),
      scheduled: at(0),
    });
    // Ten minutes in, a twenty-minute slot has ten left: not twenty from now.
    const finish = projectedFinishFromRemaining([active], () => 20, base + 10 * 60_000);
    expect(finish).toBe(base + 20 * 60_000);
  });

  it("formats finish status against the day target", () => {
    const target = base + 9 * 60 * 60_000;
    expect(finishStatusLabel(target + 24 * 60_000, target)).toBe("24 min behind");
    expect(finishStatusLabel(target - 10 * 60_000, target)).toBe("10 min ahead");
    expect(finishStatusLabel(target, target)).toBe("On target");
  });

  it("calculates a signed start variance", () => {
    expect(
      scheduleVarianceMinutes(
        match({ id: "late", scheduled: at(0), startedAt: at(7), status: "in-progress" }),
      ),
    ).toBe(7);
  });
});

/**
 * These three mappings are what let one desk board carry both formats. They are
 * pure, so they are pinned here rather than left to the browser: getting the phase
 * wrong would silently measure a placement match with the knockout duration, and
 * getting the table wrong would send the move to the wrong RPC.
 */
describe("desk match kinds", () => {
  it("measures the placement rounds at the group pace and the brackets at the knockout pace", () => {
    expect(deskKindPhase("pool")).toBe("group");
    expect(deskKindPhase("placement")).toBe("group");
    expect(deskKindPhase("draw")).toBe("knockout");
    expect(deskKindPhase("tier")).toBe("knockout");
  });

  it("maps every kind to the table the table-scoped RPCs expect", () => {
    const expected: Record<DeskMatchKind, string> = {
      pool: "pool_matches",
      draw: "draw_matches",
      placement: "placement_matches",
      tier: "tier_draw_matches",
    };
    for (const [kind, table] of Object.entries(expected)) {
      expect(deskKindTable(kind as DeskMatchKind)).toBe(table);
    }
  });

  it("separates the two placement-format kinds from the round-robin ones", () => {
    expect(isPlacementKind("placement")).toBe(true);
    expect(isPlacementKind("tier")).toBe(true);
    expect(isPlacementKind("pool")).toBe(false);
    expect(isPlacementKind("draw")).toBe(false);
  });

  it("sends each kind to the right configured scoring rule", () => {
    // A pool match is pinned to the legacy rule; the other three read tournament
    // settings, with the placement rounds separate from the brackets.
    expect(deskKindScoringStage("pool")).toBe("legacy");
    expect(deskKindScoringStage("placement")).toBe("placement");
    expect(deskKindScoringStage("draw")).toBe("knockout");
    expect(deskKindScoringStage("tier")).toBe("knockout");
  });

  it("agrees with deskKindPhase about which matches share a pace", () => {
    // The invariant that matters: a match measured with the group timings is never
    // scored with the knockout rule, and a knockout-paced match never reads the
    // placement rule. If these two mappings ever drift, a court is planned at one
    // pace and scored at another.
    for (const kind of ["pool", "placement", "draw", "tier"] as DeskMatchKind[]) {
      expect(deskKindPhase(kind) === "group").toBe(deskKindScoringStage(kind) !== "knockout");
    }
  });
});

describe("playerStatus: each player's own answer", () => {
  const T0 = Date.parse("2026-10-18T14:00:00Z");
  const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
  const model = (over: Partial<DeskMatchModel> & Pick<DeskMatchModel, "id" | "playerIds">) => ({
    kind: "tier" as const,
    courtId: "c1",
    status: "scheduled",
    startedAt: null,
    endedAt: null,
    scheduled: iso(10),
    ...over,
  });
  const next = model({ id: "n", playerIds: ["a", "b", "c"] });
  const all = [
    next,
    model({ id: "busy", courtId: "c2", status: "in-progress", startedAt: iso(-5), playerIds: ["a"] }),
    model({ id: "done", status: "completed", endedAt: iso(-10), playerIds: ["b"] }),
  ];

  it("reports every player, where readiness stops at the first in the way", () => {
    expect(playerStatus("a", next, all, 30, T0)).toEqual({ kind: "on-court", matchId: "busy", courtId: "c2" });
    expect(playerStatus("b", next, all, 30, T0)).toEqual({ kind: "resting", readyAt: T0 + 20 * 60_000 });
    expect(playerStatus("c", next, all, 30, T0)).toEqual({ kind: "free" });
  });

  it("agrees with readiness about the first player in the way", () => {
    const readiness = getMatchReadiness(next, all, 30, T0);
    expect(readiness.state).toBe("player-busy");
    expect(readiness.playerId).toBe("a");
    expect(playerStatus(readiness.playerId!, next, all, 30, T0).kind).toBe("on-court");
  });

  it("is free once the rest has run out", () => {
    expect(playerStatus("b", next, all, 30, T0 + 21 * 60_000)).toEqual({ kind: "free" });
  });
});
