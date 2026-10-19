import { describe, expect, it } from "vitest";

import { deskActionKey, holdDeskList, NEW_ROW_MS } from "./desk-hold";
import type { DeskAction } from "./desk-actions";
import type { DeskMatchModel } from "./desk";

interface Row {
  id: string;
  /** Stands in for a row's wording, so a test can see which version was drawn. */
  text?: string;
}

const key = (row: Row) => row.id;
const order = (rows: readonly Row[]) => rows.map((row) => row.id);

function hold(ranked: readonly Row[], held: readonly Row[], seen?: ReadonlySet<string>) {
  return holdDeskList({
    ranked,
    key,
    held,
    // What the list drew last time is what it held, unless a test says otherwise.
    seen: seen ?? new Set(held.map(key)),
  });
}

describe("holdDeskList", () => {
  it("is the ranking itself when the list is not held", () => {
    const ranked = [{ id: "b" }, { id: "a" }, { id: "c" }];
    const result = holdDeskList({ ranked, key, held: null, seen: new Set() });

    expect(order(result.rows)).toEqual(["b", "a", "c"]);
    expect([...result.leaving]).toEqual([]);
    expect(result.keys).toEqual(["b", "a", "c"]);
  });

  it("keeps the held order while the ranking moves, without losing its wording", () => {
    const held = [{ id: "a", text: "first, 3 min late" }, { id: "b", text: "second" }];
    const ranked = [
      { id: "b", text: "second, 9 min late" },
      { id: "a", text: "first, 4 min late" },
    ];

    const result = hold(ranked, held);

    // The places are the held ones; the words are the current ones.
    expect(result.rows).toEqual([
      { id: "a", text: "first, 4 min late" },
      { id: "b", text: "second, 9 min late" },
    ]);
    expect([...result.leaving]).toEqual([]);
  });

  it("keeps a row that should leave, marked as leaving, until the hold ends", () => {
    const held = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const ranked = [{ id: "c" }, { id: "a" }];

    const result = hold(ranked, held);

    expect(order(result.rows)).toEqual(["a", "b", "c"]);
    expect([...result.leaving]).toEqual(["b"]);
  });

  it("appends a new row at the end of the held list and reports it as added", () => {
    const held = [{ id: "a" }, { id: "b" }];
    const ranked = [{ id: "d" }, { id: "a" }, { id: "c" }, { id: "b" }];

    const result = hold(ranked, held);

    expect(order(result.rows)).toEqual(["a", "b", "d", "c"]);
    expect([...result.added]).toEqual(["d", "c"]);
  });

  it("settles into the new order when the hold ends, and drops the leaving row", () => {
    const ranked = [{ id: "c" }, { id: "a" }];
    const result = holdDeskList({ ranked, key, held: null, seen: new Set(["a", "b", "c"]) });

    expect(order(result.rows)).toEqual(["c", "a"]);
    expect([...result.leaving]).toEqual([]);
    expect([...result.added]).toEqual([]);
  });

  it("marks nothing new on the list's first sight", () => {
    const ranked = [{ id: "a" }, { id: "b" }];
    const result = holdDeskList({ ranked, key, held: null, seen: null });

    expect(order(result.rows)).toEqual(["a", "b"]);
    expect(result.keys).toEqual(["a", "b"]);
    expect([...result.added]).toEqual([]);
  });

  it("marks only the row that was not there last time", () => {
    const ranked = [{ id: "a" }, { id: "new" }, { id: "b" }];
    const result = holdDeskList({ ranked, key, held: null, seen: new Set(["a", "b"]) });

    expect([...result.added]).toEqual(["new"]);
  });

  it("does not call a row new for moving in or out of the fold", () => {
    // The caller keeps every ordered row in `seen`, folded or not, so a row that becomes
    // visible is drawn where it already was - never tagged as an arrival.
    const ranked = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const result = holdDeskList({ ranked, key, held: null, seen: new Set(["a", "b", "c"]) });

    expect([...result.added]).toEqual([]);
  });

  it("keeps the ten-second window as a boundary the caller can name", () => {
    expect(NEW_ROW_MS).toBe(10_000);
  });
});

describe("deskActionKey", () => {
  const match = (id: string): DeskMatchModel => ({
    id,
    kind: "tier",
    courtId: null,
    status: "scheduled",
    startedAt: null,
    endedAt: null,
    scheduled: null,
    playerIds: [],
  });

  it("keeps one key when a match changes why it is listed", () => {
    const ready: DeskAction<DeskMatchModel, { id: string }> = {
      kind: "start-late",
      courtId: "court-4",
      match: match("m1"),
      lateMinutes: 7,
    };
    const blocked: DeskAction<DeskMatchModel, { id: string }> = {
      kind: "blocked-late",
      courtId: "court-4",
      match: match("m1"),
      lateMinutes: 8,
      readiness: {
        state: "resting",
        readyAt: null,
        playerId: null,
        blockingMatchId: null,
        blockingCourtId: null,
        remainingMinutes: 4,
      },
    };

    expect(deskActionKey(ready)).toBe(deskActionKey(blocked));
    expect(deskActionKey(ready)).toBe("match-m1");
  });

  it("keys a pool by the pool, not by a match it does not have", () => {
    const action: DeskAction<DeskMatchModel, { id: string }> = {
      kind: "results-late",
      pool: { id: "pool-a" },
      lateMinutes: 60,
    };

    expect(deskActionKey(action)).toBe("pool-pool-a");
  });
});
