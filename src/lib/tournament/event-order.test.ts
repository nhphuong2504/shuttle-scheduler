import { describe, expect, it } from "vitest";

import { STANDARD_EVENTS, compareEventIds, compareEventOrder, eventRank } from "./event-order";

const category = (code: string, sort_order: number) => ({ code, sort_order });

describe("the standard event order", () => {
  it("is MS, WS, MD, WD, XD", () => {
    expect(STANDARD_EVENTS.map((event) => event.code)).toEqual(["MS", "WS", "MD", "WD", "XD"]);
  });

  it("puts the singles before the doubles, and the men's event before the women's", () => {
    const order = [...STANDARD_EVENTS]
      .map((event, index) => ({ code: event.code, sort_order: index + 1 }))
      .reverse()
      .sort(compareEventOrder)
      .map((event) => event.code);
    expect(order).toEqual(["MS", "WS", "MD", "WD", "XD"]);
  });

  it("ignores the order the events were added in", () => {
    // What a tournament built by pressing WS first stores: the insertion order, which is
    // why the placement stage cannot just read `sort_order`.
    const stored = [category("WS", 1), category("XD", 2), category("MD", 3), category("MS", 4)];
    expect([...stored].sort(compareEventOrder).map((event) => event.code)).toEqual([
      "MS",
      "WS",
      "MD",
      "XD",
    ]);
  });

  it("ranks every standard event ahead of anything else", () => {
    expect(eventRank("MS")).toBe(0);
    expect(eventRank("XD")).toBe(STANDARD_EVENTS.length - 1);
    expect(eventRank("XX")).toBe(STANDARD_EVENTS.length);
    expect(eventRank("ms")).toBe(STANDARD_EVENTS.length);
  });

  it("keeps an event outside the standard five after them, in its own configured order", () => {
    const events = [
      category("XX", 1),
      category("ZZ", 2),
      category("WS", 9),
    ];
    expect([...events].sort(compareEventOrder).map((event) => event.code)).toEqual([
      "WS",
      "XX",
      "ZZ",
    ]);
  });

  it("is a total order, so two equal codes never depend on the browser", () => {
    const a = category("MS", 1);
    const b = category("MS", 2);
    expect(compareEventOrder(a, b)).toBeLessThan(0);
    expect(compareEventOrder(b, a)).toBeGreaterThan(0);
    expect(compareEventOrder(a, a)).toBe(0);
  });
});

describe("compareEventIds", () => {
  const byId = new Map([
    ["c-ms", category("MS", 5)],
    ["c-ws", category("WS", 4)],
    ["c-md", category("MD", 3)],
    ["c-wd", category("WD", 2)],
    ["c-xd", category("XD", 1)],
  ]);
  const eventFor = (id: string) => byId.get(id);

  it("orders ids by the standard events rather than by their configured order", () => {
    // The configured order is the reverse of the standard one, which is what a tournament built
    // by pressing the toggles backwards stores.
    const ids = ["c-xd", "c-wd", "c-md", "c-ws", "c-ms"];
    expect([...ids].sort((a, b) => compareEventIds(a, b, eventFor))).toEqual([
      "c-ms",
      "c-ws",
      "c-md",
      "c-wd",
      "c-xd",
    ]);
  });

  it("puts an id it cannot resolve last, not first", () => {
    // On a screen the usual reason for an unknown id is a category that has not loaded yet;
    // putting it at the top would make the list jump as the data arrives.
    expect(compareEventIds("c-unknown", "c-ms", eventFor)).toBeGreaterThan(0);
    expect(compareEventIds("c-ms", "c-unknown", eventFor)).toBeLessThan(0);
  });

  it("treats two missing ids as equal, and a null the same as an unknown one", () => {
    expect(compareEventIds("x", "y", eventFor)).toBe(0);
    expect(compareEventIds(null, undefined, eventFor)).toBe(0);
    expect(compareEventIds(null, "c-unknown", eventFor)).toBe(0);
  });
});
