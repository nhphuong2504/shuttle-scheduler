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
import type { PlaceReadyResult, PlacementSchedulePlan } from "./placement-schedule";

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
    return { ran: false, generated: NOTHING, placed: 0, declined: 0, unplaced: 0 };
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
      unplaced: plan.blocked.length,
    };
  }

  const result = await deps.apply(plan);
  return {
    ran: true,
    generated: generation.generated,
    placed: result.placed.length,
    declined: result.skipped.length,
    unplaced: plan.blocked.length,
  };
}

/**
 * Collapses overlapping calls into at most one run in flight plus one queued.
 *
 * Two results reported a few seconds apart should not plan against each other's half-written
 * rows. A call made while a run is going marks one more run to follow it, and every caller shares
 * the same promise, so ten quick results cost two passes, not ten.
 */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await run();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}
