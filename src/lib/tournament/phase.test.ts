import { describe, expect, it } from "vitest";

import { isReminderPhase, phaseLabel, phaseReminder, tournamentPhase, type PhaseInput } from "./phase";

/** A Chicago tournament whose window is 20-30 Oct 2030: opens 00:00 CDT = 05:00Z on the 20th. */
const WINDOW = {
  starts_at: "2030-10-20T05:00:00.000Z",
  ends_at: "2030-10-31T05:00:00.000Z",
};
const at = (iso: string) => new Date(iso);

function input(over: Partial<PhaseInput> = {}): PhaseInput {
  return { status: "upcoming", ...WINDOW, play_starts_at: null, play_ends_at: null, ...over };
}

describe("tournamentPhase", () => {
  it("is upcoming well before the window opens", () => {
    expect(tournamentPhase(input(), at("2030-10-01T12:00:00Z"))).toBe("upcoming");
    expect(tournamentPhase(input(), at("2030-10-20T04:59:59Z"))).toBe("upcoming");
  });

  it("is completed whatever the clock says", () => {
    expect(tournamentPhase(input({ status: "completed" }), at("2030-10-01T00:00:00Z"))).toBe("completed");
    expect(tournamentPhase(input({ status: "completed" }), at("2031-06-01T00:00:00Z"))).toBe("completed");
  });

  it("starts today in the 24 hours from the moment the window opens, with no timezone needed", () => {
    const planned = input({ play_starts_at: "2030-10-20T14:00:00.000Z" });
    expect(tournamentPhase(planned, at("2030-10-20T05:00:00Z"))).toBe("starts_today");
    expect(tournamentPhase(planned, at("2030-10-20T13:59:00Z"))).toBe("starts_today");
  });

  it("is just upcoming again once the window's first day is over but nothing is planned until later", () => {
    // The window opened on the 20th; the first playing day is the 25th. On the 22nd the
    // tournament is in its window and nothing is late.
    const planned = input({ play_starts_at: "2030-10-25T14:00:00.000Z" });
    expect(tournamentPhase(planned, at("2030-10-22T12:00:00Z"))).toBe("upcoming");
  });

  it("is not started once the first playing day begins and no match has", () => {
    const planned = input({ play_starts_at: "2030-10-20T14:00:00.000Z" });
    expect(tournamentPhase(planned, at("2030-10-20T14:00:00Z"))).toBe("not_started");
    expect(tournamentPhase(planned, at("2030-10-21T09:00:00Z"))).toBe("not_started");
  });

  it("measures lateness from the plan, not the window", () => {
    // Window from the 20th, played only from the 25th: not late on the 20th.
    const planned = input({ play_starts_at: "2030-10-25T14:00:00.000Z" });
    expect(tournamentPhase(planned, at("2030-10-20T20:00:00Z"))).toBe("starts_today");
    expect(tournamentPhase(planned, at("2030-10-24T20:00:00Z"))).toBe("upcoming");
    expect(tournamentPhase(planned, at("2030-10-25T14:01:00Z"))).toBe("not_started");
  });

  it("falls back to the window when there are no playing days yet", () => {
    expect(tournamentPhase(input(), at("2030-10-20T06:00:00Z"))).toBe("not_started");
  });

  it("is live while in progress, and past its last day once the plan has ended", () => {
    const running = input({
      status: "in_progress",
      play_starts_at: "2030-10-20T14:00:00.000Z",
      play_ends_at: "2030-10-26T23:00:00.000Z",
    });
    expect(tournamentPhase(running, at("2030-10-22T12:00:00Z"))).toBe("live");
    expect(tournamentPhase(running, at("2030-10-26T22:59:00Z"))).toBe("live");
    expect(tournamentPhase(running, at("2030-10-26T23:00:00Z"))).toBe("past_last_day");
    expect(tournamentPhase(running, at("2030-12-01T00:00:00Z"))).toBe("past_last_day");
  });

  it("measures past its last day from the last playing day, not the window's end", () => {
    // Played 20th-22nd inside a window to the 30th: past its last day on the 23rd.
    const running = input({
      status: "in_progress",
      play_starts_at: "2030-10-20T14:00:00.000Z",
      play_ends_at: "2030-10-22T23:00:00.000Z",
    });
    expect(tournamentPhase(running, at("2030-10-23T09:00:00Z"))).toBe("past_last_day");
  });

  it("falls back to the window's end for a running tournament with no playing days", () => {
    const running = input({ status: "in_progress" });
    expect(tournamentPhase(running, at("2030-10-25T00:00:00Z"))).toBe("live");
    expect(tournamentPhase(running, at("2030-10-31T05:00:00Z"))).toBe("past_last_day");
  });

  it("does not guess when it has no dates", () => {
    const blank = { status: "in_progress" as const, starts_at: null, ends_at: null };
    expect(tournamentPhase(blank, at("2030-10-25T00:00:00Z"))).toBe("live");
    expect(tournamentPhase({ ...blank, status: "upcoming" }, at("2030-10-25T00:00:00Z"))).toBe("upcoming");
    expect(
      tournamentPhase({ status: "upcoming", starts_at: "not a date", ends_at: null }, at("2030-10-25T00:00:00Z")),
    ).toBe("upcoming");
  });
});

describe("the words", () => {
  it("spells each phase once", () => {
    expect(phaseLabel("upcoming")).toBe("Upcoming");
    expect(phaseLabel("starts_today")).toBe("Starts today");
    expect(phaseLabel("live")).toBe("Live");
    expect(phaseLabel("not_started")).toBe("Not started");
    expect(phaseLabel("past_last_day")).toBe("Past its last day");
    expect(phaseLabel("completed")).toBe("Completed");
  });

  it("marks only the two late phases as reminders", () => {
    expect(isReminderPhase("not_started")).toBe(true);
    expect(isReminderPhase("past_last_day")).toBe(true);
    for (const phase of ["upcoming", "starts_today", "live", "completed"] as const) {
      expect(isReminderPhase(phase)).toBe(false);
    }
  });

  it("asks something of the host only for a reminder", () => {
    expect(phaseReminder("not_started", "City Open")).toMatch(/City Open should have started/);
    expect(phaseReminder("past_last_day", "City Open")).toMatch(/Complete it/);
    expect(phaseReminder("live", "City Open")).toBeNull();
  });
});
