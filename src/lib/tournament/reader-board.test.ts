import { describe, expect, it } from "vitest";

import type { DeskMatch } from "./desk-matches";
import {
  groupByTime,
  inPlayingOrder,
  matchesOfPlayer,
  nextMatchOf,
  nowBoard,
  outcomeFor,
  placementPath,
} from "./reader-board";

function match(over: Partial<DeskMatch> & { id: string }): DeskMatch {
  return {
    kind: "placement",
    courtId: "c1",
    status: "scheduled",
    startedAt: null,
    endedAt: null,
    scheduled: null,
    playerIds: [],
    teams: ["t1", "t2"],
    tag: "MS R1",
    score: null,
    categoryId: "ms",
    ...over,
  };
}

const at = (hhmm: string) => `2026-10-18T${hhmm}:00Z`;
const won = (side: "a" | "b") => (side === "a" ? [{ a: 21, b: 15 }] : [{ a: 12, b: 21 }]);

describe("nowBoard", () => {
  it("splits a day into on court, up next and just finished", () => {
    const board = nowBoard(
      [
        match({ id: "late", scheduled: at("11:00") }),
        match({ id: "soon", scheduled: at("10:00") }),
        match({ id: "unplanned", courtId: null, scheduled: null }),
        match({ id: "live2", status: "in-progress", startedAt: at("09:40") }),
        match({ id: "live1", status: "in-progress", startedAt: at("09:20") }),
        match({ id: "old", status: "reported", endedAt: at("08:30") }),
        match({ id: "new", status: "reported", endedAt: at("09:10") }),
      ],
      { upNext: 5, justFinished: 5 },
    );
    expect(board.live.map((m) => m.id)).toEqual(["live1", "live2"]);
    expect(board.upNext.map((m) => m.id)).toEqual(["soon", "late"]);
    expect(board.justFinished.map((m) => m.id)).toEqual(["new", "old"]);
  });

  it("caps the two lists that can grow long", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      match({ id: `s${i}`, scheduled: at(`1${i}:00`) }),
    );
    expect(nowBoard(rows, { upNext: 3, justFinished: 3 }).upNext).toHaveLength(3);
  });
});

describe("a player's matches", () => {
  const rows = [
    match({ id: "r2", playerIds: ["p1"], scheduled: at("12:00") }),
    match({ id: "r1", playerIds: ["p1"], status: "reported", scheduled: at("10:00") }),
    match({ id: "other", playerIds: ["p9"], scheduled: at("09:00") }),
  ];

  it("lists only that player's, in playing order", () => {
    expect(matchesOfPlayer(rows, "p1").map((m) => m.id)).toEqual(["r1", "r2"]);
  });

  it("names the match on court first, else the next unplayed one", () => {
    const mine = matchesOfPlayer(rows, "p1");
    expect(nextMatchOf(mine)?.id).toBe("r2");
    expect(nextMatchOf([...mine, match({ id: "now", status: "in-progress" })])?.id).toBe("now");
    expect(nextMatchOf([mine[0]!])).toBeNull();
  });
});

describe("outcomeFor", () => {
  it("reads the result from the side the team is on", () => {
    const m = match({ id: "m", status: "reported", initialGames: won("b") });
    expect(outcomeFor(m, "t2")).toBe("won");
    expect(outcomeFor(m, "t1")).toBe("lost");
  });

  it("does not guess a walkover's winner", () => {
    expect(outcomeFor(match({ id: "w", status: "walkover" }), "t1")).toBe("walkover");
  });
});

describe("placementPath", () => {
  const r1 = (games: ReturnType<typeof won>) =>
    match({ id: "r1", status: "reported", scheduled: at("10:00"), initialGames: games });
  const r2 = (over: Partial<DeskMatch>) =>
    match({ id: "r2", tag: "MS R2", scheduled: at("12:00"), ...over });

  it("says where the remaining match leads after one result", () => {
    expect(placementPath([r1(won("a")), r2({})], "t1")).toEqual({
      results: ["won"],
      draw: null,
      next: { ifWin: "A", ifLose: "B" },
    });
    expect(placementPath([r1(won("b")), r2({})], "t1").next).toEqual({ ifWin: "C", ifLose: "D" });
  });

  it("names the draw once both results are in", () => {
    const path = placementPath(
      [r1(won("a")), r2({ status: "reported", initialGames: won("b") })],
      "t1",
    );
    expect(path).toEqual({ results: ["won", "lost"], draw: "B", next: null });
  });

  it("stops at a walkover rather than counting it", () => {
    const path = placementPath([r1(won("a")), r2({ status: "walkover" })], "t1");
    expect(path.draw).toBeNull();
    expect(path.results).toEqual(["won"]);
  });

  it("has nothing to say before the first result", () => {
    expect(placementPath([r2({})], "t1")).toEqual({ results: [], draw: null, next: null });
  });
});

describe("inPlayingOrder", () => {
  it("orders by start or scheduled time and leaves untimed matches last", () => {
    const rows = [
      match({ id: "untimed" }),
      match({ id: "late", scheduled: at("12:00") }),
      match({
        id: "started",
        status: "in-progress",
        startedAt: at("09:00"),
        scheduled: at("13:00"),
      }),
    ];
    expect(inPlayingOrder(rows).map((m) => m.id)).toEqual(["started", "late", "untimed"]);
  });
});

describe("groupByTime", () => {
  it("joins neighbours that start at the same time, keeping the order", () => {
    const groups = groupByTime([
      match({ id: "a", scheduled: at("10:05") }),
      match({ id: "b", scheduled: at("10:05") }),
      match({ id: "c", scheduled: at("10:25") }),
      match({ id: "d", scheduled: at("10:05") }),
    ]);
    expect(groups.map((g) => [g.scheduled, g.matches.map((m) => m.id)])).toEqual([
      [at("10:05"), ["a", "b"]],
      [at("10:25"), ["c"]],
      [at("10:05"), ["d"]],
    ]);
  });

  it("names the event and round only when the whole group shares them", () => {
    const [same, mixed] = groupByTime([
      match({ id: "a", scheduled: at("10:05"), tag: "MS", roundTag: "R2" }),
      match({ id: "b", scheduled: at("10:05"), tag: "MS", roundTag: "R2" }),
      match({ id: "c", scheduled: at("10:25"), tag: "MS", roundTag: "R2" }),
      match({ id: "d", scheduled: at("10:25"), tag: "WS", roundTag: "R2" }),
    ]);
    expect(same?.shared).toEqual({ tag: "MS", roundTag: "R2" });
    expect(mixed?.shared).toBeNull();
  });

  it("keeps untimed matches together under no time", () => {
    const groups = groupByTime([match({ id: "a" }), match({ id: "b" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.scheduled).toBeNull();
  });
});
