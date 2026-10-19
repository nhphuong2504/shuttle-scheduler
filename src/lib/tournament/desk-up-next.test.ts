import { describe, expect, it } from "vitest";

import { deriveCourtState, type DeskMatchModel } from "./desk";
import { UP_NEXT_RISK_MARGIN_MINUTES, upNext } from "./desk-up-next";

/**
 * The derivation behind the Desk's Up next panel, without a browser. Anchored to a fixed `BASE`,
 * with a 15-minute slot and a 30-minute rest gap - the knockout pacing the fixtures use.
 */

const BASE = new Date("2026-09-17T12:00:00Z").getTime();
const MINUTE = 60_000;
const at = (minutes: number) => new Date(BASE + minutes * MINUTE).toISOString();
const slot = () => 15;
const rest = () => 30;

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

const queued = (id: string, courtId: string, scheduledIn: number, playerIds = [`${id}-a`, `${id}-b`]) =>
  match({ id, courtId, scheduled: at(scheduledIn), playerIds });
const live = (id: string, courtId: string, startedAgo: number, playerIds = [`${id}-a`, `${id}-b`]) =>
  match({ id, courtId, status: "in-progress", startedAt: at(-startedAgo), scheduled: at(-startedAgo), playerIds });
const done = (id: string, courtId: string, endedAgo: number, playerIds: string[]) =>
  match({ id, courtId, status: "reported", startedAt: at(-endedAgo - 15), scheduled: at(-endedAgo - 15), endedAt: at(-endedAgo), playerIds });

function rowsOf(matches: DeskMatchModel[], options: { now?: number; listedElsewhere?: Set<string> } = {}) {
  const now = options.now ?? BASE;
  const courtIds = [...new Set(matches.map((m) => m.courtId).filter(Boolean))] as string[];
  const courtStates = courtIds.map((courtId) => deriveCourtState(courtId, matches, slot, rest, now));
  return upNext({
    courtStates,
    matches,
    slotMinutesFor: slot,
    restMinutesFor: rest,
    listedElsewhere: options.listedElsewhere ?? new Set(),
    now,
  });
}

describe("up next: when the court frees", () => {
  it("is now for a court with nothing playing, with the published time beside it", () => {
    const [row] = rowsOf([queued("n", "c1", 20)]);
    expect(row).toMatchObject({ courtId: "c1", free: { kind: "now" }, scheduledMs: BASE + 20 * MINUTE });
  });

  it("is the playing match's expected end, and hides the published time when it is the same minute", () => {
    // Started 5 min ago against a 15-min slot: frees in 10, exactly when the next is scheduled.
    const [row] = rowsOf([live("p", "c1", 5), queued("n", "c1", 10)]);
    expect(row).toMatchObject({ free: { kind: "at", ms: BASE + 10 * MINUTE }, scheduledMs: null });
  });

  it("shows the published time when it differs from the projection", () => {
    const [row] = rowsOf([live("p", "c1", 5), queued("n", "c1", 20)]);
    expect(row?.scheduledMs).toBe(BASE + 20 * MINUTE);
  });

  it("gives no time for a court running past its expected end", () => {
    // 20 min on a 15-min slot; its next is still ahead, so it is not yet Needs action's.
    const [row] = rowsOf([live("p", "c1", 20), queued("n", "c1", 5)]);
    expect(row?.free).toEqual({ kind: "over" });
  });
});

describe("up next: what it leaves to Needs action", () => {
  it("leaves out a match past its scheduled start, from the first whole minute", () => {
    expect(rowsOf([queued("late", "c1", -1)])).toEqual([]);
    expect(rowsOf([queued("almost", "c1", 0)], { now: BASE + 59_000 })).toHaveLength(1);
  });

  it("leaves out a match Needs action already names", () => {
    expect(rowsOf([queued("n", "c1", 20)], { listedElsewhere: new Set(["n"]) })).toEqual([]);
  });

  it("has nothing for a court with nothing queued", () => {
    expect(rowsOf([live("p", "c1", 5)])).toEqual([]);
  });
});

describe("up next: whether the players are free", () => {
  it("says free when nobody has played", () => {
    expect(rowsOf([queued("n", "c1", 20)])[0]?.status).toEqual({ kind: "free" });
  });

  it("says unknown when the players are not known yet", () => {
    expect(rowsOf([queued("n", "c1", 20, [])])[0]?.status).toEqual({ kind: "unknown" });
  });

  it("names a player still resting when the court frees, judged at that moment", () => {
    // Ended 10 min ago, rest 30: free in 20. The court is free now, so that is 20 late.
    const rows = rowsOf([done("d", "c2", 10, ["p1", "x"]), queued("n", "c1", 25, ["p1", "p2"])]);
    expect(rows.find((r) => r.courtId === "c1")?.status).toEqual({
      kind: "resting",
      playerId: "p1",
      readyAtMs: BASE + 20 * MINUTE,
    });
  });

  it("does not raise a rest that ends before the court frees", () => {
    // c1 has a match that just started, so it frees at +15.
    const rows = rowsOf([
      done("d", "c2", 10, ["p1", "x"]),
      live("p", "c1", 0),
      match({ id: "n", courtId: "c1", scheduled: at(30), playerIds: ["p1", "p2"] }),
    ]);
    // c1 frees at +15, p1 is free at +20: 5 late, over the margin.
    expect(rows.find((r) => r.courtId === "c1")?.status.kind).toBe("resting");

    const later = rowsOf(
      [done("d", "c2", 25, ["p1", "x"]), live("p", "c1", 0), match({ id: "n", courtId: "c1", scheduled: at(30), playerIds: ["p1", "p2"] })],
    );
    // p1 is free at +5, before the court frees at +15.
    expect(later.find((r) => r.courtId === "c1")?.status).toEqual({ kind: "free" });
  });

  it("treats a gap under the margin as free", () => {
    const margin = UP_NEXT_RISK_MARGIN_MINUTES;
    // Court frees at +15; p1 free at +15 + (margin - 1).
    const endedAgo = 30 - (15 + margin - 1);
    const rows = rowsOf([
      done("d", "c2", endedAgo, ["p1", "x"]),
      live("p", "c1", 0),
      match({ id: "n", courtId: "c1", scheduled: at(30), playerIds: ["p1", "p2"] }),
    ]);
    expect(rows.find((r) => r.courtId === "c1")?.status).toEqual({ kind: "free" });
  });

  it("names a player on another court, free at that match's end plus rest", () => {
    const rows = rowsOf([live("other", "c2", 5, ["p1", "x"]), queued("n", "c1", 20, ["p1", "p2"])]);
    expect(rows.find((r) => r.courtId === "c1")?.status).toEqual({
      kind: "busy",
      playerId: "p1",
      courtId: "c2",
      readyAtMs: BASE + (10 + 30) * MINUTE,
    });
  });

  it("gives no time for a player whose other match is running over", () => {
    const rows = rowsOf([live("other", "c2", 20, ["p1", "x"]), queued("n", "c1", 20, ["p1", "p2"])]);
    expect(rows.find((r) => r.courtId === "c1")?.status).toEqual({
      kind: "busy",
      playerId: "p1",
      courtId: "c2",
      readyAtMs: null,
    });
  });
});

describe("up next: order", () => {
  it("puts the court that frees soonest first, free courts before playing ones", () => {
    const rows = rowsOf([
      live("p1", "c1", 2),
      queued("n1", "c1", 30),
      live("p2", "c2", 10),
      queued("n2", "c2", 30),
      queued("n3", "c3", 30),
    ]);
    expect(rows.map((r) => r.courtId)).toEqual(["c3", "c2", "c1"]);
  });
});
