import { describe, expect, it } from "vitest";

import {
  MAX_ACTION_ROWS,
  OVERRUN_ALERT_AFTER_MINUTES,
  READY_ALERT_AFTER_MINUTES,
  deskActions,
  splitActions,
} from "./desk-actions";
import { deriveCourtState, type DeskMatchModel } from "./desk";

/**
 * The derivation behind the Desk's "Needs action" rows, without a browser.
 *
 * The `states` preset the rendered specs use has no late start in it, so the most important
 * row this panel draws is pinned here. Instants are anchored to a fixed `BASE`, so nothing in
 * this file can fail at a particular hour.
 */

const BASE = new Date("2026-09-17T12:00:00Z").getTime();
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

function match(over: Partial<DeskMatchModel> & { id: string }): DeskMatchModel {
  return {
    kind: "tier",
    courtId: null,
    status: "scheduled",
    startedAt: null,
    endedAt: null,
    scheduled: null,
    playerIds: [],
    ...over,
  };
}

/** A 15-minute slot and a 30-minute rest gap: the knockout pacing the fixtures use. */
const slot = () => 15;
const rest = () => 30;

function actionsOf(
  matches: DeskMatchModel[],
  { now = BASE, latePools = [] as { pool: string; scheduledEndMs: number }[] } = {},
) {
  const courtIds = [...new Set(matches.map((m) => m.courtId).filter(Boolean))] as string[];
  const courtStates = courtIds.map((courtId) =>
    deriveCourtState(courtId, matches, slot, rest, now),
  );
  return deskActions({ courtStates, matches, slotMinutesFor: slot, latePools, now });
}

const onCourt = (courtId: string) => (action: ReturnType<typeof actionsOf>[number]) =>
  action.kind !== "results-late" && action.courtId === courtId;

const queued = (id: string, courtId: string, scheduledIn: number, playerIds = [`${id}-a`, `${id}-b`]) =>
  match({ id, courtId, scheduled: at(scheduledIn), playerIds });

describe("needs action: late starts", () => {
  it("offers a late, ready match as the thing to start, with how late it is", () => {
    const [row] = actionsOf([queued("m", "c1", -8)]);
    expect(row).toMatchObject({ kind: "start-late", courtId: "c1", lateMinutes: 8 });
  });

  it("names what is in the way when a late match cannot start: a player on another court", () => {
    const busy = match({
      id: "busy",
      courtId: "c2",
      status: "in-progress",
      startedAt: at(-5),
      scheduled: at(-5),
      playerIds: ["p1", "x"],
    });
    const late = queued("late", "c1", -6, ["p1", "p2"]);
    const row = actionsOf([busy, late]).find(onCourt("c1"));
    expect(row?.kind).toBe("blocked-late");
    if (row?.kind !== "blocked-late") return;
    expect(row.lateMinutes).toBe(6);
    expect(row.readiness).toMatchObject({ state: "player-busy", playerId: "p1", blockingCourtId: "c2" });
  });

  it("names a resting player", () => {
    const earlier = match({
      id: "earlier",
      courtId: "c2",
      status: "reported",
      startedAt: at(-30),
      scheduled: at(-30),
      endedAt: at(-10),
      playerIds: ["p1", "x"],
    });
    const late = queued("late", "c1", -4, ["p1", "p2"]);
    const row = actionsOf([earlier, late]).find(onCourt("c1"));
    expect(row?.kind).toBe("blocked-late");
    if (row?.kind !== "blocked-late") return;
    expect(row.readiness).toMatchObject({ state: "resting", playerId: "p1", remainingMinutes: 20 });
  });

  it("names a match whose players are not known yet", () => {
    const row = actionsOf([queued("late", "c1", -3, [])])[0];
    expect(row?.kind).toBe("blocked-late");
    if (row?.kind !== "blocked-late") return;
    expect(row.readiness.state).toBe("teams-missing");
  });

  it("does not call a start late until it is a whole minute late", () => {
    const now = BASE + 59_000;
    const rows = actionsOf([queued("m", "c1", 0)], { now });
    // Not late, so it is the plain ready row (nothing has freed the court, so no grace applies).
    expect(rows).toEqual([expect.objectContaining({ kind: "ready", courtId: "c1" })]);
  });

  it("raises nothing for a blocked court whose match is not late: the tile already says why", () => {
    const busy = match({
      id: "busy",
      courtId: "c2",
      status: "in-progress",
      startedAt: at(-5),
      scheduled: at(-5),
      playerIds: ["p1", "x"],
    });
    const rows = actionsOf([busy, queued("soon", "c1", 10, ["p1", "p2"])]);
    expect(rows.filter(onCourt("c1"))).toEqual([]);
  });

  it("raises nothing for a free court with nothing timed queued on it", () => {
    // An untimed match is not the court's `next` at all, so there is nothing to start or chase.
    const untimed = match({ id: "untimed", courtId: "c1", playerIds: ["a", "b"] });
    expect(actionsOf([untimed])).toEqual([]);
  });
});

describe("needs action: ready courts", () => {
  it("waits for a court that has just freed before asking for it to start", () => {
    const finished = match({
      id: "done",
      courtId: "c1",
      status: "reported",
      startedAt: at(-20),
      scheduled: at(-20),
      endedAt: at(-1),
      playerIds: ["x", "y"],
    });
    const next = queued("next", "c1", 10);
    expect(actionsOf([finished, next])).toEqual([]);

    const later = BASE + READY_ALERT_AFTER_MINUTES * 60_000;
    expect(actionsOf([finished, next], { now: later })).toEqual([
      expect.objectContaining({ kind: "ready", courtId: "c1" }),
    ]);
  });

  it("asks for a court nothing has finished on straight away", () => {
    expect(actionsOf([queued("next", "c1", 20)])).toEqual([
      expect.objectContaining({ kind: "ready", courtId: "c1" }),
    ]);
  });
});

describe("needs action: overruns", () => {
  const live = (id: string, courtId: string, elapsed: number, playerIds = [`${id}-a`, `${id}-b`]) =>
    match({ id, courtId, status: "in-progress", startedAt: at(-elapsed), scheduled: at(-elapsed), playerIds });

  it("leaves a match running a little long to the amber tile", () => {
    const elapsed = 15 + OVERRUN_ALERT_AFTER_MINUTES - 1;
    expect(actionsOf([live("m", "c1", elapsed)])).toEqual([]);
  });

  it("raises it once it is the grace past the expected finish", () => {
    const elapsed = 15 + OVERRUN_ALERT_AFTER_MINUTES;
    expect(actionsOf([live("m", "c1", elapsed)])).toEqual([
      expect.objectContaining({
        kind: "overrun",
        elapsedMinutes: elapsed,
        overByMinutes: OVERRUN_ALERT_AFTER_MINUTES,
        nextLateMinutes: null,
      }),
    ]);
  });

  it("raises a short overrun when the match behind it is already late", () => {
    const rows = actionsOf([live("m", "c1", 18), queued("next", "c1", -2)]);
    expect(rows).toEqual([
      expect.objectContaining({ kind: "overrun", overByMinutes: 3, nextLateMinutes: 2 }),
    ]);
  });
});

describe("needs action: order", () => {
  it("ranks every late row by how late it is, pools included, and ready courts last", () => {
    const rows = actionsOf(
      [
        queued("ready", "c1", 30),
        queued("late4", "c2", -4),
        match({
          id: "over",
          courtId: "c3",
          status: "in-progress",
          startedAt: at(-27),
          scheduled: at(-27),
          playerIds: ["o1", "o2"],
        }),
        queued("late20", "c4", -20),
      ],
      { latePools: [{ pool: "Pool A", scheduledEndMs: BASE - 16 * 60_000 }] },
    );
    expect(rows.map((row) => (row.kind === "results-late" ? row.pool : row.match.id))).toEqual([
      "late20",
      "Pool A",
      "over",
      "late4",
      "ready",
    ]);
  });

  it("orders ready courts by their match's scheduled start", () => {
    const rows = actionsOf([queued("later", "c1", 40), queued("sooner", "c2", 5)]);
    expect(rows.map((row) => row.kind !== "results-late" && row.match.id)).toEqual([
      "sooner",
      "later",
    ]);
  });

  it("draws the first rows and folds the rest, in rank order", () => {
    const rows = Array.from({ length: MAX_ACTION_ROWS + 2 }, (_, i) => i);
    expect(splitActions(rows)).toEqual({
      shown: rows.slice(0, MAX_ACTION_ROWS),
      folded: [MAX_ACTION_ROWS, MAX_ACTION_ROWS + 1],
    });
    expect(splitActions([1, 2])).toEqual({ shown: [1, 2], folded: [] });
  });
});
