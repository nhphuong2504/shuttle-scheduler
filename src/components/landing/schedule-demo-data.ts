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
  /** The steps whose story this match belongs to. */
  focus?: readonly number[];
}

export const DEMO_MATCHES: readonly DemoMatch[] = [
  { court: 1, label: "Ito vs Vance", start: 0, kind: "played" },
  { court: 1, label: "Kim vs Lowe", start: 25, kind: "live" },
  { court: 1, label: "Hughes vs Okafor", start: 50, kind: "same" },
  { court: 1, label: "Diaz vs Moore", start: 75, kind: "same" },
  { court: 1, label: "Ng vs Tate", start: 100, kind: "same" },
  { court: 1, label: "Shaw vs Wood", start: 125, kind: "same" },
  { court: 2, label: "Carter vs Walsh", start: 0, ranFor: 37, kind: "late", focus: [1, 2] },
  { court: 2, label: "Lewis vs Bell", start: 25, movedTo: 37, kind: "moved", focus: [1, 2] },
  { court: 2, label: "Shah vs Price", start: 50, movedTo: 62, kind: "moved", focus: [2] },
  { court: 2, label: "Patel vs Reid", start: 90, kind: "absorbed", focus: [2] },
  { court: 2, label: "Cole vs Hart", start: 115, kind: "same" },
  { court: 2, label: "Dunn vs Ray", start: 140, kind: "same" },
  { court: 3, label: "Ali vs Moss", start: 0, kind: "played" },
  { court: 3, label: "Carter vs Lee", start: 35, movedTo: 47, kind: "moved", focus: [1, 3] },
  { court: 3, label: "King vs Lane", start: 60, movedTo: 72, kind: "moved", focus: [3] },
  { court: 3, label: "Ford vs Webb", start: 85, movedTo: 97, kind: "moved", focus: [3] },
  { court: 3, label: "Hale vs Stone", start: 110, movedTo: 122, kind: "moved", review: true, focus: [3, 4] },
  { court: 3, label: "Park vs Quinn", start: 135, kind: "held", review: true, focus: [4] },
];

export interface DemoStep {
  when: string;
  name: string;
  /** Who is acting at this step, as the visitor should read it. */
  badge: string;
  badgeTone: "neutral" | "waiting" | "auto" | "review";
  title: string;
  body: string;
}

/** Steps 0-1 happen while the match plays; 2-4 are one update, when its result is recorded. */
export const DEMO_STEPS: readonly DemoStep[] = [
  {
    when: "14:25",
    name: "Before",
    badge: "Published plan",
    badgeTone: "neutral",
    title: "Everything is on time.",
    body: "Three courts, 18 matches, each with a published court and time. Court 2 is still playing.",
  },
  {
    when: "14:37",
    name: "Runs long",
    badge: "Waiting for the result",
    badgeTone: "waiting",
    title: "Court 2 runs 12 minutes over.",
    body: "The desk shows it as Overrun. Ben Carter’s next match on Court 3 waits — nothing moves until the result is in.",
  },
  {
    when: "Same court",
    name: "Catches up",
    badge: "Automatic",
    badgeTone: "auto",
    title: "The court catches up.",
    body: "The two matches after it move back 12 minutes. The 15:30 match had room to spare, so it keeps its time.",
  },
  {
    when: "Other courts",
    name: "Rest kept",
    badge: "Automatic",
    badgeTone: "auto",
    title: "Rest is protected on every court.",
    body: "Ben Carter’s match on Court 3 moves too, so they still get their full rest. Court 3’s later matches follow.",
  },
  {
    when: "After",
    name: "You decide",
    badge: "Needs your review",
    badgeTone: "review",
    title: "The hard one comes to you.",
    body: "The last match would now end after the 16:45 close, so it keeps its time. It overlaps the match before it, and both go to schedule review.",
  },
];

/** The first step at which the result is recorded and the reflow has run. */
export const DEMO_RESULT_STEP = 2;
export const DEMO_LAST_STEP = DEMO_STEPS.length - 1;

/** What the Desk says once the result is recorded, worded as `scheduleImpactNote` words it. */
export const DEMO_TOAST =
  "Result recorded. 6 later matches delayed by up to 12 min. 2 matches need schedule review.";

/**
 * The three things a match can be to the organiser after a late result: moved for them,
 * untouchable, or theirs to decide. Untouched matches belong to none of them.
 */
export type DemoGroup = "auto" | "locked" | "review";

export function demoGroup(match: DemoMatch): DemoGroup | null {
  if (match.kind === "played" || match.kind === "live" || match.kind === "late") return "locked";
  if (match.review) return "review";
  if (match.kind === "moved" || match.kind === "absorbed") return "auto";
  return null;
}

/**
 * How many matches each group holds at a step, read off the picture rather than written
 * down beside it. Before the result nothing has been moved or flagged; from the result on,
 * everything the reflow does is already true, whichever part of it the story is pointing at.
 */
export function demoCounts(step: number): Record<DemoGroup, number> {
  const resolved = step >= DEMO_RESULT_STEP;
  const moved = DEMO_MATCHES.filter((m) => m.movedTo != null).length;
  return {
    auto: resolved ? moved : 0,
    locked: DEMO_MATCHES.filter((m) => demoGroup(m) === "locked").length,
    review: resolved ? DEMO_MATCHES.filter((m) => m.review).length : 0,
  };
}

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
