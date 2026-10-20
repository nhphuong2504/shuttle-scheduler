import { describe, expect, it } from "vitest";

import {
  callNextAvailability,
  callNextContext,
  callNextMessage,
  reachableCount,
} from "./call-next";
import type { DeskMatchModel } from "./desk";

/** Fixed instants so every minute below is stated, not computed from the wall clock. */
const BASE = Date.parse("2026-10-18T14:00:00Z");
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

type M = DeskMatchModel & { teams: (string | null)[] };
function match(over: Partial<M> & Pick<M, "id">): M {
  return {
    kind: "tier",
    courtId: "c1",
    status: "scheduled",
    startedAt: null,
    endedAt: null,
    scheduled: at(30),
    playerIds: ["a", "b"],
    teams: ["t1", "t2"],
    ...over,
  };
}

describe("call next: whether a court offers it", () => {
  it("offers nothing when nothing is queued", () => {
    expect(callNextAvailability(null, [])).toEqual({ kind: "none" });
  });

  it("locks while a side is not known", () => {
    const next = match({ id: "n", teams: ["t1", null], playerIds: ["a"] });
    expect(callNextAvailability(next, [next])).toEqual({ kind: "locked" });
  });

  it("is ready when every player is free", () => {
    const next = match({ id: "n" });
    expect(callNextAvailability(next, [next])).toEqual({ kind: "ready" });
  });

  it("warns, naming who, when a player is on another court", () => {
    const next = match({ id: "n" });
    const elsewhere = match({ id: "x", courtId: "c2", status: "in-progress", playerIds: ["b", "z"] });
    expect(callNextAvailability(next, [next, elsewhere])).toEqual({
      kind: "warn",
      busyPlayerIds: ["b"],
    });
  });

  it("does not warn for a player still on this court: calling ahead allows that", () => {
    const next = match({ id: "n" });
    const here = match({ id: "h", courtId: "c1", status: "in-progress", playerIds: ["a", "z"] });
    expect(callNextAvailability(next, [next, here])).toEqual({ kind: "ready" });
  });
});

describe("call next: the context line", () => {
  const base = { tag: "MD R2", courtNumber: 2, dueMs: BASE, dueLabel: "14:25" };

  it("reads as comma-separated facts on a busy court", () => {
    expect(
      callNextContext({ ...base, court: { kind: "busy", elapsedMinutes: 37 }, now: BASE + 20 * 60_000 }),
    ).toBe("MD R2, due 14:25, Court 2 still playing, 37′ on court");
  });

  it("says how late a free court's match is, once a whole minute has passed", () => {
    expect(callNextContext({ ...base, court: { kind: "free" }, now: BASE + 7 * 60_000 })).toBe(
      "MD R2, due 14:25 (7 min ago), Court 2 free now",
    );
    expect(callNextContext({ ...base, court: { kind: "free" }, now: BASE + 30_000 })).toBe(
      "MD R2, due 14:25, Court 2 free now",
    );
  });
});

describe("call next: the proposed message", () => {
  it("asks the players of a court that is not Ready to be ready, not to come", () => {
    const text = callNextMessage({ tag: "MD R2", courtNumber: 2, dueLabel: "14:25", courtReady: false });
    expect(text).toBe("Tournova: your match is next on Court 2, due 14:25 (MD R2). Please be ready near the court.");
  });

  it("asks a Ready court's players to come now", () => {
    expect(callNextMessage({ tag: "MS R1", courtNumber: 4, dueLabel: "14:30", courtReady: true })).toBe(
      "Tournova: your match is ready on Court 4 (MS R1). Please come to the court now.",
    );
  });
});

describe("call next: who a send reaches", () => {
  it("counts a player any channel reaches, and nobody else", () => {
    const reach = new Map([
      ["a", { sms: true, email: false }],
      ["b", { sms: false, email: true }],
      ["c", { sms: false, email: false }],
    ]);
    expect(reachableCount(["a", "b", "c", "d"], reach)).toBe(2);
  });
});
