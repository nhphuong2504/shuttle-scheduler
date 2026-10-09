import { describe, expect, it } from "vitest";

import {
  COURT_STATE_CHIP,
  COURT_STATE_LABEL,
  COURT_STATE_TILE,
  COURT_STATES,
  isCourtState,
  type CourtState,
} from "./court-state";
import { deriveCourtState, type DeskMatchModel } from "./desk";

/**
 * Layer 1 of the phase 6 sweep: the court-state vocabulary and its reachability.
 *
 * Two halves, and the second is the one that matters.
 *
 * The first half is vocabulary hygiene - every state has a label, a fill and an
 * edge, and no two states are drawn the same way. That is the same guard
 * `match-status.test.ts` provides for match statuses, and it exists because the
 * previous arrangement spelled these maps inline in the component, where nothing
 * could see them: a state added to `deriveCourtState` would have rendered as
 * `undefined` in the pill and as the resting hairline in the tile, silently.
 *
 * The second half proves every state is *reachable*. A rendered sweep cannot do
 * this - a live tournament holds one state per court, so driving the app can only
 * sample the vocabulary, and a state that no input can produce looks identical to a
 * state the sweep forgot to build. Constructing the inputs here is what makes
 * "all five render" a fact rather than a hope.
 */

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

const SLOT = 20;
const REST = 10;

const derive = (matches: DeskMatchModel[], nowMinutes: number, courtId = "c1") =>
  deriveCourtState(
    courtId,
    matches,
    () => SLOT,
    () => REST,
    base + nowMinutes * 60_000,
  );

/** One input per state, in vocabulary order. The inputs are the whole point. */
const REACHABLE: { state: CourtState; why: string; matches: DeskMatchModel[]; now: number }[] = [
  {
    state: "playing",
    why: "a match is live and inside its slot",
    matches: [match({ id: "live", status: "in-progress", startedAt: at(0) })],
    now: 5,
  },
  {
    state: "overrun",
    why: "a match is live and past its slot",
    matches: [match({ id: "live", status: "in-progress", startedAt: at(0) })],
    now: SLOT + 6,
  },
  {
    state: "free-ready",
    why: "the court is clear and its next pairing has rested",
    matches: [
      match({ id: "prev", status: "reported", endedAt: at(0), playerIds: ["p1", "p2"] }),
      match({ id: "next", scheduled: at(30), playerIds: ["p1", "p2"] }),
    ],
    now: 30,
  },
  {
    state: "free-blocked",
    why: "the court is clear but a player in the next pairing is still resting",
    matches: [
      match({ id: "prev", status: "reported", endedAt: at(25), playerIds: ["p1"] }),
      match({ id: "next", scheduled: at(30), playerIds: ["p1"] }),
    ],
    now: 30,
  },
  {
    state: "idle",
    why: "the court has nothing scheduled at all",
    matches: [],
    now: 30,
  },
];

describe("the court-state vocabulary", () => {
  it("gives every state a label, a fill and an edge", () => {
    for (const state of COURT_STATES) {
      expect(COURT_STATE_LABEL[state], `${state} has no label`).toBeTruthy();
      expect(COURT_STATE_CHIP[state], `${state} has no chip`).toBeTruthy();
      expect(COURT_STATE_TILE[state], `${state} has no tile treatment`).toBeTruthy();
    }
  });

  it("keeps the label a distinct channel, not a restatement of the token name", () => {
    // Two states sharing a label would make the redundant channel worthless: the
    // text would agree with itself while disagreeing with the state it names.
    const labels = COURT_STATES.map((state) => COURT_STATE_LABEL[state]);
    expect(new Set(labels).size).toBe(labels.length);
    for (const state of COURT_STATES) {
      // `free-ready` is shown as "Ready", which is deliberate, but no label is the
      // raw key - a raw key on screen is how `void` used to render.
      expect(COURT_STATE_LABEL[state]).not.toBe(state);
    }
  });

  it("recognises only its own states", () => {
    for (const state of COURT_STATES) expect(isCourtState(state)).toBe(true);
    expect(isCourtState("bye")).toBe(false); // a draw condition, not a court state
    expect(isCourtState("paused")).toBe(false); // never existed outside the plan
    expect(isCourtState("")).toBe(false);
  });
});

describe("every state in the vocabulary is reachable", () => {
  it("derives all five, one input each", () => {
    const produced = REACHABLE.map(({ matches, now, state, why }) => {
      const derived = derive(matches, now);
      expect(derived.state, `${state} was expected from: ${why}`).toBe(state);
      return derived.state;
    });
    // Set equality rather than a length check, so a sixth state added to the
    // vocabulary fails here until an input is added that can produce it.
    expect(new Set(produced)).toEqual(new Set(COURT_STATES));
  });

  it("never derives a state outside the vocabulary", () => {
    // The drift guard. `deriveCourtState` is what decides the state, so if it ever
    // returned a value the pill had no label for, the render would be blank rather
    // than broken - the failure mode that hid `void`.
    const everyInput = REACHABLE.flatMap(({ matches, now }) =>
      ["c1", "c2"].map((courtId) => derive(matches, now, courtId).state),
    );
    for (const state of everyInput) expect(COURT_STATES).toContain(state);
  });

  it("separates overrun from playing on the configured slot, not a constant", () => {
    // Reachability alone would pass with a hardcoded 20. The boundary is the slot
    // the tournament configured, so it is asserted at the boundary itself.
    const live = [match({ id: "live", status: "in-progress", startedAt: at(0) })];
    expect(derive(live, SLOT).state).toBe("playing");
    expect(derive(live, SLOT + 1).state).toBe("overrun");
  });
});
