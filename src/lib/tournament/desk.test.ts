import { describe, expect, it } from "vitest";

import {
  deriveCourtState,
  finishStatusLabel,
  getMatchReadiness,
  getOperationalKpis,
  projectedFinishFromRemaining,
  scheduleVarianceMinutes,
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
    const state = deriveCourtState("c1", [active], () => 20, () => 10, base + 21 * 60_000);
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
  it("summarizes court pressure and projected finish", () => {
    const active = match({
      id: "active",
      courtId: "c1",
      status: "in-progress",
      startedAt: at(0),
    });
    const next = match({
      id: "next",
      courtId: "c2",
      scheduled: at(30),
      playerIds: ["p3", "p4"],
    });
    const states = [
      deriveCourtState("c1", [active, next], () => 20, () => 10, base + 21 * 60_000),
      deriveCourtState("c2", [active, next], () => 20, () => 10, base + 21 * 60_000),
    ];

    expect(getOperationalKpis(states, [active, next], () => 20, base + 21 * 60_000)).toEqual({
      activeCourts: 1,
      waitingCourts: 0,
      idleCourts: 0,
      completedMatches: 0,
      remainingMatches: 2,
      overrunCourts: 1,
      projectedFinish: base + 50 * 60_000,
    });
  });

  it("projects finish from in-progress matches using elapsed time", () => {
    const active = match({
      id: "active",
      status: "in-progress",
      startedAt: at(0),
      scheduled: at(0),
    });
    const finish = projectedFinishFromRemaining([active], () => 20, base + 25 * 60_000);
    expect(finish).toBe(base + 45 * 60_000);
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
