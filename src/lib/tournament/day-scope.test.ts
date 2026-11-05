import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TournamentDay } from "./data";
import {
  attributeMatchesToDays,
  awaitingResultMatches,
  dayIdForTime,
  dayOperationalCounts,
  matchStartMs,
  resolveSelectedDay,
  type DayScopedMatch,
} from "./day-scope";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A match as the desk sees it: a status, a time to attribute by, and nothing else. */
type ScopedMatch = DayScopedMatch & { courtId?: string | null };

function day(
  dayNumber: number,
  date: string,
  start: string,
  end: string,
  id = `d${dayNumber}`,
): TournamentDay {
  return {
    id,
    tournament_id: "t1",
    day_number: dayNumber,
    date,
    start_time: start,
    end_time: end,
    created_at: "2026-09-17T00:00:00Z",
  };
}

function match(id: string, overrides: Partial<ScopedMatch> = {}): ScopedMatch {
  return {
    id,
    status: "scheduled",
    scheduled: null,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

/** Two ordinary days, 09:00–18:00 local. */
const TWO_DAYS = [
  day(1, "2026-09-17", "09:00:00", "18:00:00"),
  day(2, "2026-09-18", "09:00:00", "18:00:00"),
];

/**
 * The fixtures write instants without a zone ("2026-09-17T09:00:00"), so they are read in the
 * process's own zone; the venue is declared to be that same zone so a window and a stamp agree on
 * any machine. That the venue's zone, not the process's, decides is pinned in `zoned-time.test.ts`
 * and the Viet Nam Open replay.
 */
const VENUE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = (stamp: string) => new Date(stamp).getTime();
const SLOT = () => 20;

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

describe("attributeMatchesToDays", () => {
  it("attributes a match that has a time but no court to its day", () => {
    // Court is not part of attribution: a build that has placed a match in time but not yet
    // on a court has still placed it on a day, and the desk must show it there.
    const { byDayId, untimed } = attributeMatchesToDays(TWO_DAYS, [
      match("planned", { scheduled: "2026-09-18T10:00:00", courtId: null }),
    ], VENUE_TZ);

    expect(byDayId.get("d2")?.map((row) => row.id)).toEqual(["planned"]);
    expect(byDayId.get("d1")).toEqual([]);
    expect(untimed).toEqual([]);
  });

  it("keeps a post-midnight overrun on the day it is the tail of", () => {
    // The last day is allowed to run past its close, so a match starting after midnight on the
    // next calendar date still belongs to that last day. Calendar-date grouping would file it
    // under no day at all.
    const days = [
      day(1, "2026-09-17", "09:00:00", "18:00:00"),
      day(2, "2026-09-18", "09:00:00", "23:30:00"),
    ];
    const { byDayId } = attributeMatchesToDays(days, [
      match("overrun", { status: "in-progress", startedAt: "2026-09-19T00:20:00" }),
    ], VENUE_TZ);

    expect(byDayId.get("d1")).toEqual([]);
    expect(byDayId.get("d2")?.map((row) => row.id)).toEqual(["overrun"]);
  });

  it("leaves a match with no usable time unattributed rather than guessing a day", () => {
    const { byDayId, untimed } = attributeMatchesToDays(TWO_DAYS, [
      match("timed", { scheduled: "2026-09-17T10:00:00" }),
      match("untimed", { courtId: "c1" }),
    ], VENUE_TZ);

    expect(byDayId.get("d1")?.map((row) => row.id)).toEqual(["timed"]);
    expect(untimed.map((row) => row.id)).toEqual(["untimed"]);
  });

  it("gives every configured day a bucket, including empty ones", () => {
    const { byDayId } = attributeMatchesToDays(TWO_DAYS, [], VENUE_TZ);
    expect([...byDayId.keys()]).toEqual(["d1", "d2"]);
  });

  it("attributes by when a match started, not when its result was entered", () => {
    // A reported match belongs to the day it was played on; otherwise a result typed in the
    // next morning would move a completed match to the wrong day.
    const { byDayId } = attributeMatchesToDays(TWO_DAYS, [
      match("played", {
        status: "reported",
        scheduled: "2026-09-17T16:00:00",
        startedAt: "2026-09-17T16:05:00",
        endedAt: "2026-09-18T09:30:00",
      }),
    ], VENUE_TZ);

    expect(byDayId.get("d1")?.map((row) => row.id)).toEqual(["played"]);
    expect(byDayId.get("d2")).toEqual([]);
  });

  it("reads the attribution time in order: started, then scheduled, then ended", () => {
    expect(
      matchStartMs(
        match("a", { startedAt: "2026-09-17T10:00:00", scheduled: "2026-09-17T09:00:00" }),
      ),
    ).toBe(at("2026-09-17T10:00:00"));
    expect(matchStartMs(match("b", { scheduled: "2026-09-17T09:00:00" }))).toBe(
      at("2026-09-17T09:00:00"),
    );
    expect(matchStartMs(match("c", { endedAt: "2026-09-17T09:30:00" }))).toBe(
      at("2026-09-17T09:30:00"),
    );
    expect(matchStartMs(match("d"))).toBeNull();
  });

  it("identifies the day a single instant belongs to", () => {
    expect(dayIdForTime(TWO_DAYS, at("2026-09-18T10:00:00"), VENUE_TZ)).toBe("d2");
    // After both windows have closed, the last day that had opened still owns it.
    expect(dayIdForTime(TWO_DAYS, at("2026-09-18T23:50:00"), VENUE_TZ)).toBe("d2");
    expect(dayIdForTime([], at("2026-09-18T10:00:00"), VENUE_TZ)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Day resolution
// ---------------------------------------------------------------------------

describe("resolveSelectedDay", () => {
  const none = attributeMatchesToDays(TWO_DAYS, [], VENUE_TZ);

  it("returns null when there are no configured days", () => {
    expect(
      resolveSelectedDay({
        timeZone: VENUE_TZ, days: [], attribution: none, now: Date.now(), pickedDayId: null }),
    ).toBeNull();
  });

  it("prefers the day whose window contains now", () => {
    expect(
      resolveSelectedDay({
        timeZone: VENUE_TZ,
        days: TWO_DAYS,
        attribution: none,
        now: at("2026-09-18T10:00:00"),
        pickedDayId: null,
      }),
    ).toBe("d2");
  });

  it("keeps an explicit pick even while another day's window contains now", () => {
    // A board that jumps to another day while someone is reading it is worse than one showing
    // a day that has since emptied, so a realtime update must never move the pick.
    expect(
      resolveSelectedDay({
        timeZone: VENUE_TZ,
        days: TWO_DAYS,
        attribution: none,
        now: at("2026-09-18T10:00:00"),
        pickedDayId: "d1",
      }),
    ).toBe("d1");
  });

  it("falls back when the picked day no longer exists", () => {
    expect(
      resolveSelectedDay({
        timeZone: VENUE_TZ,
        days: TWO_DAYS,
        attribution: none,
        now: at("2026-09-18T10:00:00"),
        pickedDayId: "removed",
      }),
    ).toBe("d2");
  });

  it("picks the day with work in progress when no configured window contains now", () => {
    // The post-midnight case: both windows are in the past, so containment cannot find the
    // active day and only the ongoing work can.
    const attribution = attributeMatchesToDays(TWO_DAYS, [
      match("live", { status: "in-progress", startedAt: "2026-09-18T23:50:00" }),
    ], VENUE_TZ);

    expect(
      resolveSelectedDay({
        timeZone: VENUE_TZ,
        days: TWO_DAYS,
        attribution,
        now: at("2026-09-19T00:20:00"),
        pickedDayId: null,
      }),
    ).toBe("d2");
  });

  it("falls back to the earliest day with work still to play", () => {
    const attribution = attributeMatchesToDays(TWO_DAYS, [
      match("later", { scheduled: "2026-09-18T10:00:00" }),
      match("earlier", { scheduled: "2026-09-17T10:00:00" }),
    ], VENUE_TZ);

    expect(
      resolveSelectedDay({
        timeZone: VENUE_TZ,
        days: TWO_DAYS,
        attribution,
        now: at("2026-09-20T10:00:00"),
        pickedDayId: null,
      }),
    ).toBe("d1");
  });

  it("falls back to today's date, then to the first day with anything, then to the first day", () => {
    const today = new Date(at("2026-09-18T10:00:00"));
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate(),
    ).padStart(2, "0")}`;
    const days = [
      day(1, "2026-01-01", "09:00:00", "18:00:00"),
      day(2, todayKey, "00:00:00", "00:01:00"),
    ];
    // A window of one minute is behind `now`, so containment does not fire and the date decides.
    expect(
      resolveSelectedDay({
        timeZone: VENUE_TZ,
        days,
        attribution: attributeMatchesToDays(days, [], VENUE_TZ),
        now: at("2026-09-18T10:00:00"),
        pickedDayId: null,
      }),
    ).toBe("d2");

    const empty = attributeMatchesToDays(days, [], VENUE_TZ);
    expect(
      resolveSelectedDay({
        timeZone: VENUE_TZ,
        days,
        attribution: { byDayId: empty.byDayId, untimed: [] },
        now: Date.now(),
        pickedDayId: null,
      }),
    ).toBe("d1");
  });
});

// ---------------------------------------------------------------------------
// Day counts
// ---------------------------------------------------------------------------

describe("dayOperationalCounts", () => {
  const now = at("2026-09-17T10:00:00");

  const rows: ScopedMatch[] = [
    match("done", { status: "reported", scheduled: "2026-09-17T09:00:00" }),
    match("walkover", { status: "walkover", scheduled: "2026-09-17T09:00:00" }),
    match("inside-slot", { status: "in-progress", startedAt: "2026-09-17T09:55:00" }),
    match("overdue", { status: "in-progress", startedAt: "2026-09-17T09:30:00" }),
    match("still-to-play", { scheduled: "2026-09-17T11:00:00" }),
    match("void", { status: "void", scheduled: "2026-09-17T09:00:00" }),
    match("untimed"),
  ];

  it("counts completed, remaining, in progress and awaiting results distinctly", () => {
    const counts = dayOperationalCounts(rows, SLOT, now);

    expect(counts.completed).toBe(2);
    expect(counts.walkovers).toBe(1);
    // Void is neither work nor a result, and an untimed row is still work.
    expect(counts.remaining).toBe(4);
    expect(counts.inProgress).toBe(2);
    // Only the match past its expected end is awaiting a result; `inside-slot` is not.
    expect(counts.awaitingResults).toBe(1);
  });

  it("lists exactly the matches the awaiting-results count counts", () => {
    expect(awaitingResultMatches(rows, SLOT, now).map((row) => row.id)).toEqual(["overdue"]);
  });

  it("reports the latest expected finish among the day's remaining matches", () => {
    expect(dayOperationalCounts(rows, SLOT, now).latestFinishMs).toBe(at("2026-09-17T11:20:00"));
  });

  it("never treats an untimed match as overdue or as having a finish", () => {
    const counts = dayOperationalCounts([match("untimed")], SLOT, now);
    expect(counts.remaining).toBe(1);
    expect(counts.awaitingResults).toBe(0);
    expect(counts.latestFinishMs).toBeNull();
    expect(awaitingResultMatches([match("untimed")], SLOT, now)).toEqual([]);
  });

  it("is empty for a day with nothing on it", () => {
    expect(dayOperationalCounts([], SLOT, now)).toEqual({
      completed: 0,
      remaining: 0,
      inProgress: 0,
      awaitingResults: 0,
      walkovers: 0,
      latestFinishMs: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Reuse guards
// ---------------------------------------------------------------------------

describe("day-scope boundaries", () => {
  const source = readFileSync(join(__dirname, "day-scope.ts"), "utf8");

  it("does not import the readiness engine or a forecast solver", () => {
    // Day scoping must stay a pure bucketing and counting job: readiness and dispatch are the
    // one eligibility system, and forecasting is not a day-scoped tool. There is no estimator
    // module left to import, and this guard stops one being reintroduced behind the desk.
    expect(source).not.toMatch(/from "\.\/desk"/);
    expect(source).not.toMatch(/estimateFinish|forecastTournament|finish-estimate/);
  });

  it("imports no scheduler", () => {
    expect(source).not.toMatch(/planPlacementSchedule|runPlanDays/);
  });
});
