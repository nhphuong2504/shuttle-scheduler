/**
 * The front door's "what happens when a match runs late" story, as data.
 *
 * It is an illustration, not a call into the scheduler, but every move in it follows the
 * live reflow's rules (`20261009010000_safe_live_schedule_reflow.sql`):
 *
 * - nothing moves until the late match's result is recorded, and then everything moves in
 *   one update;
 * - a match only ever moves later, to the latest of its own published time, the previous
 *   match's real end on its court, and its players' rest - so a gap can absorb a delay;
 * - a co-player's match on another court moves too, so the rest gap holds;
 * - played and live matches never move;
 * - a match that would be pushed past the day's close keeps its time instead, and the
 *   overlap that leaves is reported by `schedule_conflicts` for both still-scheduled sides,
 *   which is why the toast counts two matches for review.
 *
 * Times are minutes after 14:00. The day closes at 16:45; the rest gap is 10 minutes.
 */

export const DEMO_START_MINUTE = 14 * 60;
export const DEMO_SPAN = 165;
export const DEMO_SLOT = 25;
export const DEMO_REST = 10;

export type DemoKind = "played" | "live" | "late" | "moved" | "absorbed" | "same" | "held";

export interface DemoMatch {
  court: 1 | 2 | 3;
  label: string;
  /** Published start. */
  start: number;
  /** Start after the reflow, when it moves. */
  movedTo?: number;
  /** Real length when it ran over its slot. */
  ranFor?: number;
  kind: DemoKind;
  /** Flagged for schedule review after the reflow. */
  review?: boolean;
  /** The steps that highlight this match. */
  focus?: readonly number[];
}

export const DEMO_MATCHES: readonly DemoMatch[] = [
  { court: 1, label: "Ito · Vance", start: 0, kind: "played" },
  { court: 1, label: "Kim · Lowe", start: 25, kind: "live" },
  { court: 1, label: "Hughes · Okafor", start: 50, kind: "same" },
  { court: 1, label: "Diaz · Moore", start: 75, kind: "same" },
  { court: 1, label: "Ng · Tate", start: 100, kind: "same" },
  { court: 1, label: "Shaw · Wood", start: 125, kind: "same" },
  { court: 2, label: "Carter · Walsh", start: 0, ranFor: 37, kind: "late", focus: [1, 2] },
  { court: 2, label: "Lewis · Bell", start: 25, movedTo: 37, kind: "moved", focus: [1, 2] },
  { court: 2, label: "Shah · Price", start: 50, movedTo: 62, kind: "moved", focus: [2] },
  { court: 2, label: "Patel · Reid", start: 90, kind: "absorbed", focus: [2] },
  { court: 2, label: "Cole · Hart", start: 115, kind: "same" },
  { court: 2, label: "Dunn · Ray", start: 140, kind: "same" },
  { court: 3, label: "Ali · Moss", start: 0, kind: "played" },
  { court: 3, label: "Carter · Lee", start: 35, movedTo: 47, kind: "moved", focus: [1, 3] },
  { court: 3, label: "King · Lane", start: 60, movedTo: 72, kind: "moved", focus: [3] },
  { court: 3, label: "Ford · Webb", start: 85, movedTo: 97, kind: "moved", focus: [3] },
  { court: 3, label: "Hale · Stone", start: 110, movedTo: 122, kind: "moved", review: true, focus: [3, 4] },
  { court: 3, label: "Park · Quinn", start: 135, kind: "held", review: true, focus: [4] },
];

export interface DemoStep {
  when: string;
  name: string;
  title: string;
  body: string;
}

/** Steps 0-1 happen while the match plays; 2-4 are one update, when its result is recorded. */
export const DEMO_STEPS: readonly DemoStep[] = [
  {
    when: "14:25",
    name: "Before",
    title: "Everything is on time.",
    body: "Three courts, 18 matches, each with a published court and time. Court 2 is still playing.",
  },
  {
    when: "14:37",
    name: "Runs long",
    title: "Court 2 runs 12 minutes over.",
    body: "The desk shows it as Overrun. Ben Carter’s next match on Court 3 waits — nothing moves until the result is in.",
  },
  {
    when: "Same court",
    name: "Catches up",
    title: "The court catches up.",
    body: "The two matches after it move back 12 minutes. The 15:30 match had room to spare, so it keeps its time.",
  },
  {
    when: "Other courts",
    name: "Rest kept",
    title: "Rest is protected on every court.",
    body: "Ben Carter’s match on Court 3 moves too, so they still get their full rest. Court 3’s later matches follow.",
  },
  {
    when: "After",
    name: "You decide",
    title: "The hard one comes to you.",
    body: "The last match would now end after the 16:45 close, so it keeps its time. It overlaps the match before it, and both go to schedule review.",
  },
];

/** The first step at which the result is recorded and the reflow has run. */
export const DEMO_RESULT_STEP = 2;

/** What the Desk says once the result is recorded, worded as `scheduleImpactNote` words it. */
export const DEMO_TOAST =
  "Result recorded. 6 later matches delayed by up to 12 min. 2 matches need schedule review.";

export function demoClock(minute: number): string {
  const total = DEMO_START_MINUTE + minute;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}:${m < 10 ? "0" : ""}${m}`;
}

/** Where a match sits, and how long it runs, at a given step. */
export function demoPlacement(match: DemoMatch, step: number): { start: number; length: number } {
  const lateApplies = match.kind === "late" && step >= 1;
  const resolved = step >= DEMO_RESULT_STEP;
  return {
    start: resolved && match.movedTo != null ? match.movedTo : match.start,
    length: lateApplies && match.ranFor != null ? match.ranFor : DEMO_SLOT,
  };
}
