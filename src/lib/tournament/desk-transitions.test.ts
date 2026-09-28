import { describe, expect, it } from "vitest";

import {
  COURT_TRANSITION_KINDS,
  COURT_TRANSITION_LABEL,
  nextCourtTransitions,
  transitionCountdown,
  transitionOverdueBy,
} from "./desk-transitions";
import { deriveCourtState, type DeskMatchModel } from "./desk";

/**
 * Layer 1 for the Next-transitions panel: the derivation, without a browser.
 *
 * The panel is a projection, and a projection is easy to get subtly wrong in ways a rendered
 * test cannot see - a countdown that reads "in 0 min", an overrun restated as a transition, a
 * court offering two transitions at once. Those are the assertions here.
 *
 * The instants are anchored to a fixed `BASE` rather than the wall clock, so this file cannot
 * fail at a particular hour. The rendered sweep in `e2e/desk-transitions.spec.ts` is the other
 * half: it proves the same vocabulary draws in a real cascade.
 */

const BASE = new Date("2026-09-17T12:00:00Z").getTime();
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
const MINUTE = 60_000;

/** A desk match, with only the fields the derivation reads. */
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

/** A flat 15-minute slot, so an expected finish is trivially predictable. */
const slot = () => 15;

/** The board's own derivation, so these tests exercise the real pairing. */
function statesOf(matches: DeskMatchModel[]) {
  const courtIds = [...new Set(matches.map((m) => m.courtId).filter(Boolean))] as string[];
  return courtIds.map((courtId) => deriveCourtState(courtId, matches, slot, slot, BASE));
}

const transitionsOf = (matches: DeskMatchModel[], now = BASE, limit?: number) =>
  nextCourtTransitions(statesOf(matches), slot, now, limit);

describe("next court transitions", () => {
  it("projects a playing match's finish from its own start, marked as an estimate", () => {
    // Started seven minutes ago against a fifteen-minute slot, so it is due in eight.
    const playing = match({
      id: "playing",
      courtId: "c2",
      status: "in-progress",
      startedAt: at(-7),
      scheduled: at(-8),
    });

    const [transition] = transitionsOf([playing]);
    expect(transition?.kind).toBe("finish");
    expect(transition?.courtId).toBe("c2");
    expect(transition?.estimated).toBe(true);
    expect(transition?.overdue).toBe(false);
    expect(transition?.atMs).toBe(BASE + 8 * MINUTE);
    expect(transition?.minutesAway).toBe(8);
    expect(transition?.minutesOverdue).toBeNull();
  });

  it("measures the projection with the match's own slot, not a fixed one", () => {
    // One slot resolver, two answers: a group match is the caller's rule, and changing it must
    // move the projection. A hardcoded duration here would be a second set of timings.
    const playing = match({
      id: "playing",
      courtId: "c2",
      status: "in-progress",
      startedAt: at(0),
      scheduled: at(0),
    });

    expect(nextCourtTransitions(statesOf([playing]), () => 15, BASE)[0]?.minutesAway).toBe(15);
    expect(nextCourtTransitions(statesOf([playing]), () => 30, BASE)[0]?.minutesAway).toBe(30);
  });

  it("drops a playing match that is already past its expected finish", () => {
    // Live for 48 minutes against a fifteen-minute slot: an overrun. It has a tile state and an
    // Act-now alert, and restating it here as a transition would be a third copy of one fact.
    const overrun = match({
      id: "overrun",
      courtId: "c1",
      status: "in-progress",
      startedAt: at(-48),
      scheduled: at(-50),
    });

    expect(transitionsOf([overrun])).toEqual([]);
  });

  it("reports a scheduled start from the schedule, not as an estimate", () => {
    const next = match({ id: "next", courtId: "c3", status: "scheduled", scheduled: at(20) });

    const [transition] = transitionsOf([next]);
    expect(transition?.kind).toBe("start");
    expect(transition?.estimated).toBe(false);
    expect(transition?.overdue).toBe(false);
    expect(transition?.minutesAway).toBe(20);
  });

  it("marks a start whose scheduled time has passed, and gives it no countdown", () => {
    // Nothing else on the desk reports this: the overrun alert needs a match in progress, and
    // the pool alert cannot fire without pools. So it stays, turning upward rather than negative.
    const late = match({ id: "late", courtId: "c5", status: "scheduled", scheduled: at(-6) });

    const [transition] = transitionsOf([late]);
    expect(transition?.kind).toBe("start");
    expect(transition?.overdue).toBe(true);
    expect(transition?.minutesAway).toBeNull();
    expect(transition?.minutesOverdue).toBe(6);
    expect(transitionOverdueBy(transition!.minutesOverdue!)).toBe("6 min overdue");
  });

  it("never projects a match with no usable time", () => {
    // `expectedEndMs` returns null without a start or a schedule, and a guess is exactly the
    // misleading countdown this must not produce.
    const untimedPlaying = match({
      id: "no-time",
      courtId: "c1",
      status: "in-progress",
      scheduled: null,
      startedAt: null,
    });
    const untimedNext = match({ id: "no-time-next", courtId: "c2", status: "scheduled" });

    expect(transitionsOf([untimedPlaying, untimedNext])).toEqual([]);
  });

  it("gives a court one transition - the soonest - rather than two", () => {
    // The queued match cannot start before the current one ends, so offering both would spend
    // two rows on one court and count down an event that cannot happen on schedule. It is also
    // what lets the default cap be the court count rather than a guess.
    const playing = match({
      id: "playing",
      courtId: "c2",
      status: "in-progress",
      startedAt: at(-7),
      scheduled: at(-8),
    });
    const queued = match({ id: "queued", courtId: "c2", status: "scheduled", scheduled: at(5) });

    const transitions = transitionsOf([playing, queued]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.kind).toBe("finish");
    expect(transitions[0]?.match.id).toBe("playing");
  });

  it("orders across courts by when the transitions fall due", () => {
    const soonFinish = match({
      id: "finish-soon",
      courtId: "c1",
      status: "in-progress",
      startedAt: at(-10),
      scheduled: at(-10),
    });
    const laterStart = match({
      id: "start-later",
      courtId: "c2",
      status: "scheduled",
      scheduled: at(20),
    });
    const middleStart = match({
      id: "start-middle",
      courtId: "c3",
      status: "scheduled",
      scheduled: at(8),
    });

    expect(transitionsOf([laterStart, soonFinish, middleStart]).map((t) => t.match.id)).toEqual([
      "finish-soon",
      "start-middle",
      "start-later",
    ]);
  });

  it("puts overdue work first, because it is the most overdue and the most urgent", () => {
    const late = match({ id: "late", courtId: "c1", status: "scheduled", scheduled: at(-30) });
    const later = match({ id: "later", courtId: "c2", status: "scheduled", scheduled: at(-5) });
    const soon = match({ id: "soon", courtId: "c3", status: "scheduled", scheduled: at(3) });

    expect(transitionsOf([soon, late, later]).map((t) => t.match.id)).toEqual([
      "late",
      "later",
      "soon",
    ]);
  });

  it("defaults its cap to one row per court, so no court is truncated", () => {
    // Eight courts, one transition each. The old default of a fixed five cut three of them
    // off; the panel is stretched to share a height with Court progress, which draws one row
    // per court, so five rows left it short while the data to fill it was already derived.
    const many = Array.from({ length: 8 }, (_, i) =>
      match({ id: `m${i}`, courtId: `c${i}`, status: "scheduled", scheduled: at(i + 1) }),
    );

    expect(transitionsOf(many)).toHaveLength(many.length);
    expect(
      transitionsOf(many),
      "the default cap is the court count, not the match count",
    ).toHaveLength(new Set(many.map((m) => m.courtId)).size);
  });

  it("still accepts an explicit cap, and applies it after the sort", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      match({ id: `m${i}`, courtId: `c${i}`, status: "scheduled", scheduled: at(i + 1) }),
    );

    expect(transitionsOf(many, BASE, 3)).toHaveLength(3);
    // The soonest three, not the first three encountered - the cap narrows an ordered list.
    expect(transitionsOf(many, BASE, 3).map((t) => t.match.id)).toEqual(["m0", "m1", "m2"]);
    // A trailing start must not survive a cap that trims it.
    expect(transitionsOf(many, BASE, 3).map((t) => t.match.id)).not.toContain("m7");
  });

  it("is empty when no court is playing and nothing is queued", () => {
    expect(transitionsOf([])).toEqual([]);
    expect(transitionsOf([match({ id: "done", courtId: "c1", status: "reported" })])).toEqual([]);
  });
});

describe("transition countdown wording", () => {
  it("never counts down to zero", () => {
    // A transition twenty seconds away is one minute away, not zero: "in 0 min" reads as
    // "this has arrived". `ceil` is what guarantees it, so the boundary is pinned.
    expect(transitionCountdown(1)).toBe("in 1 min");
    expect(transitionCountdown(59)).toBe("in 59 min");
  });

  it("rolls over to hours without losing the minutes", () => {
    expect(transitionCountdown(60)).toBe("in 1h");
    expect(transitionCountdown(75)).toBe("in 1h 15m");
    expect(transitionCountdown(120)).toBe("in 2h");
  });

  it("turns upward once a transition is late, and says so without a number under a minute", () => {
    expect(transitionOverdueBy(0)).toBe("overdue");
    expect(transitionOverdueBy(6)).toBe("6 min overdue");
    expect(transitionOverdueBy(90)).toBe("1h 30m overdue");
  });
});

describe("the transition vocabulary", () => {
  it("gives every kind a label", () => {
    for (const kind of COURT_TRANSITION_KINDS) {
      expect(COURT_TRANSITION_LABEL[kind], `${kind} has no label`).toBeTruthy();
    }
  });

  it("keeps the two kinds distinguishable by name, and only by the names it has", () => {
    const labels = COURT_TRANSITION_KINDS.map((kind) => COURT_TRANSITION_LABEL[kind]);
    expect(new Set(labels).size).toBe(COURT_TRANSITION_KINDS.length);
    // The panel renders the kind as words and nothing else, so the name is now the *only*
    // channel separating a projection from a schedule. Neither label may be a bare noun that
    // drops the distinction: one of them has to still say it is expected.
    expect(COURT_TRANSITION_LABEL.finish).toMatch(/expected/i);
    expect(COURT_TRANSITION_LABEL.start).toMatch(/scheduled/i);
  });
});
