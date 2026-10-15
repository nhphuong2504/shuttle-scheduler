/**
 * Automatic scheduling after a result: generate the next stage and slot the newly ready matches.
 *
 * "Update schedule" re-solves the whole unplayed queue, which is the right tool for a deliberate
 * rebuild and a poor one for "a knockout slot just got its second team". This is the quiet
 * counterpart the operator never has to press: once a schedule exists, a reported result
 *
 *   1. generates the stage it unlocked (round two, the knockout draws) for events already under way,
 *   2. plans in `place-ready` mode, where every match holding a court and time is an anchor, and
 *   3. writes only the new placements through the additive `place_ready_matches` RPC.
 *
 * It is best-effort by design. The result is already saved when this runs, a plan built a moment
 * ago may be slightly stale (the server re-checks every slot and skips what no longer fits), and a
 * failure must never get in the way of the next result. So callers swallow its errors and the
 * Schedule page's status line is where anything left unplaced stays visible.
 *
 * The orchestration is pure over injected dependencies so the sequencing is testable without a
 * database; `useAutoSchedule` supplies the real ones.
 */

import type { PlacementEntrant, PlacementMatch, TierDraw, TierDrawMatch } from "./data";
import type { StageGenerationOutcome } from "./placement-actions";
import type {
  PlaceReadyResult,
  PlacementSchedulePlan,
  UnplacedMatch,
} from "./placement-schedule";

export interface FreshSchedulingRows {
  placementMatches: PlacementMatch[];
  tierMatches: TierDrawMatch[];
  draws: TierDraw[];
  entrants: PlacementEntrant[];
}

export interface AutoScheduleDeps {
  fetchFresh: () => Promise<FreshSchedulingRows>;
  /** Generates the stage each event is waiting on. Only called for events already under way. */
  generate: (fresh: FreshSchedulingRows) => Promise<StageGenerationOutcome>;
  plan: (fresh: FreshSchedulingRows) => PlacementSchedulePlan;
  apply: (plan: PlacementSchedulePlan) => Promise<PlaceReadyResult>;
}

export interface AutoScheduleOutcome {
  /** False when there was nothing to do because no schedule has been built yet. */
  ran: boolean;
  generated: StageGenerationOutcome["generated"];
  placed: number;
  /** Matches the server declined (court or player got busy, or already placed by someone else). */
  declined: number;
  /** Ready matches the planner found no room for. */
  unplaced: number;
  /** Why each one was left, for the Schedule page's notice and for deciding whether to retry. */
  reasons: UnplacedMatch[];
  /**
   * Declines that may well succeed on the next try (a race with another desk, a result that moved
   * under the plan). A persistent reason is not counted here: asking again changes nothing.
   */
  transient: number;
}

/** Server refusals that come from a moment passing, not from the schedule being full. */
const TRANSIENT_DECLINES: ReadonlySet<string> = new Set([
  "court_busy",
  "player_busy",
  "already_placed",
  "not_ready",
  "not_scheduled",
  "in_the_past",
]);

export function isTransientDecline(reason: string): boolean {
  return TRANSIENT_DECLINES.has(reason);
}

const NOTHING: AutoScheduleOutcome["generated"] = { roundOne: 0, roundTwo: 0, draws: 0 };

/** True once any match holds a time: the first build is the operator's own decision. */
export function hasBuiltSchedule(
  rows: Pick<FreshSchedulingRows, "placementMatches" | "tierMatches">,
): boolean {
  return [...rows.placementMatches, ...rows.tierMatches].some(
    (match) => match.status !== "void" && match.scheduled_time != null,
  );
}

/** The events that already have placement matches, which is what "under way" means here. */
export function eventsUnderWay(rows: Pick<FreshSchedulingRows, "placementMatches">): Set<string> {
  return new Set(rows.placementMatches.map((match) => match.category_id));
}

function changed(outcome: StageGenerationOutcome): boolean {
  const { roundOne, roundTwo, draws } = outcome.generated;
  return roundOne > 0 || roundTwo > 0 || draws > 0;
}

export async function runAutoSchedule(deps: AutoScheduleDeps): Promise<AutoScheduleOutcome> {
  let fresh = await deps.fetchFresh();
  if (!hasBuiltSchedule(fresh)) {
    return {
      ran: false,
      generated: NOTHING,
      placed: 0,
      declined: 0,
      unplaced: 0,
      reasons: [],
      transient: 0,
    };
  }

  const generation = await deps.generate(fresh);
  if (changed(generation)) fresh = await deps.fetchFresh();

  const plan = deps.plan(fresh);
  const slots = plan.placementNewPayload.length + plan.knockoutNewPayload.length;
  if (slots === 0) {
    return {
      ran: true,
      generated: generation.generated,
      placed: 0,
      declined: 0,
      unplaced: plan.unplaced.length,
      reasons: plan.unplaced,
      transient: 0,
    };
  }

  const result = await deps.apply(plan);
  return {
    ran: true,
    generated: generation.generated,
    placed: result.placed.length,
    declined: result.skipped.length,
    unplaced: plan.unplaced.length,
    reasons: plan.unplaced,
    transient: result.skipped.filter((entry) => isTransientDecline(entry.reason)).length,
  };
}

/**
 * Collapses overlapping calls into at most one run in flight plus one queued.
 *
 * Two results reported a few seconds apart should not plan against each other's half-written
 * rows. A call made while a run is going marks one more run to follow it, and every caller shares
 * the same promise, so ten quick results cost two passes, not ten.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        let last: T;
        do {
          again = false;
          last = await run();
        } while (again);
        return last;
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

// ---------------------------------------------------------------------------
// Saying what is left, in the organiser's terms
// ---------------------------------------------------------------------------

export interface UnplacedNotice {
  headline: string;
  detail: string;
  /** `rebuild` opens the rebuild preview, `settings` opens days and courts. */
  action: "rebuild" | "settings";
  actionLabel: string;
}

/**
 * The one sentence the Schedule page shows when ready matches are still without a time after
 * everything that could be done automatically was done.
 *
 * It names the cause, never the operation: nobody should have to know what "place" means. The
 * most fundamental cause wins (no courts explains all the rest), and there is one action, because
 * every cause here needs the organiser to change the schedule's rules or accept a rebuild.
 */
export function describeUnplaced(unplaced: readonly UnplacedMatch[]): UnplacedNotice | null {
  if (!unplaced.length) return null;
  const n = unplaced.length;
  const headline = `${n} ready match${n === 1 ? " has" : "es have"} no time yet`;
  const has = (reason: UnplacedMatch["reason"]) => unplaced.some((entry) => entry.reason === reason);

  if (has("no_courts")) {
    return {
      headline,
      detail: "No day has a court, so nothing can be scheduled.",
      action: "settings",
      actionLabel: "Open settings",
    };
  }
  if (has("past_closing") || has("no_slot")) {
    return {
      headline,
      detail:
        "They would finish after the last day closes. Extend a day, add a court, or review a rebuild.",
      action: "rebuild",
      actionLabel: "Review options",
    };
  }
  if (has("held_behind_placement")) {
    return {
      headline,
      detail: "Knockout matches are waiting for placement matches that have no slot yet.",
      action: "rebuild",
      actionLabel: "Review options",
    };
  }
  return {
    headline,
    detail: "A prerequisite is missing or a team no longer exists, so they cannot be placed.",
    action: "rebuild",
    actionLabel: "Review options",
  };
}

// ---------------------------------------------------------------------------
// Retrying without a button
// ---------------------------------------------------------------------------

/** Wait before the first look at a changed set of unplaced matches, so a burst coalesces. */
export const SETTLE_MS = 1500;
/** Waits between retries of a transient failure. Three tries, then stop and let the next change decide. */
export const RETRY_DELAYS_MS: readonly number[] = [2000, 8000, 30000];

export interface RetryState {
  signature: string | null;
  attempts: number;
}

export const INITIAL_RETRY: RetryState = { signature: null, attempts: 0 };

/** What an attempt ended as, for the purpose of deciding whether to ask again. */
export type AttemptResult = "settled" | "transient" | "failed";

/** Classifies an attempt: an outcome with transient declines, or a thrown error, is worth retrying. */
export function attemptResult(outcome: AutoScheduleOutcome | null, threw: boolean): AttemptResult {
  if (threw) return "failed";
  if (outcome && outcome.transient > 0) return "transient";
  return "settled";
}

/**
 * Whether to look again, and after how long.
 *
 * A new signature (the set of matches without a time, plus the days, courts and breaks they could
 * go on) is a new situation: wait for it to settle, then try once. A transient failure retries with
 * backoff, three times at most. A persistent reason (no room before the close, nothing to place
 * on) is not retried: the same signature would give the same answer, and the notice on the Schedule
 * page is what asks the organiser to change something, which changes the signature.
 */
export function planRetry(
  state: RetryState,
  signature: string | null,
  last: AttemptResult | null,
): { state: RetryState; delayMs: number | null } {
  if (signature == null) return { state: INITIAL_RETRY, delayMs: null };
  if (signature !== state.signature) {
    return { state: { signature, attempts: 0 }, delayMs: SETTLE_MS };
  }
  if (last == null || last === "settled") return { state, delayMs: null };
  const attempts = state.attempts + 1;
  const delayMs = RETRY_DELAYS_MS[state.attempts] ?? null;
  return { state: { signature, attempts }, delayMs };
}
