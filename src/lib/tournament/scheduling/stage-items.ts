/**
 * Row-to-item conversion for the placement format.
 *
 * These builders are shared by the real planner and the finish estimator so the two cannot
 * disagree about what a placement or tier row means: the same void/bye filtering, the same fixed
 * window, the same prerequisite handling. The estimator additionally *extends* the tier items with
 * undecided and synthetic rounds, but it starts from exactly these rows.
 */

import { MINUTE_MS } from "@/lib/scheduling";
import type { PlacementEntrant, PlacementMatch, Team, TierDrawMatch } from "../data";
import type { ComposedMatch } from "./composition";

const MINUTE = MINUTE_MS;

/**
 * A tournament-side item before the day's courts are known.
 *
 * `courtNumber` is the declared court, resolved by the day runner against the day's own court
 * list: a match on a court the day has becomes a pinned match, one on any other court becomes a
 * participant/time anchor. Resolving late is what lets one item list feed several days that play
 * on different courts.
 */
export interface StageItem extends ComposedMatch {
  courtNumber?: number | undefined;
  /**
   * Pinned by the planner for near-term stability rather than by a result.
   *
   * Distinct from `fixed`, which means the desk has already decided the match. Both are pinned for
   * the solver, but only a `fixed` item is decided history: a `frozen` one is still `scheduled`, so
   * the writer must keep writing it at its slot and the rebuild preview must keep showing it. That
   * difference is why the two are tracked as separate sets — see `frozenMatchIdsFor`.
   */
  frozen?: boolean | undefined;
}

/** A match has a real result, so its time is an anchor rather than a suggestion. */
export function isFixed(status: string): boolean {
  return status === "reported" || status === "in-progress" || status === "walkover";
}

function anchorStart(scheduledTime: string | null, startedAt: string | null): number | undefined {
  const anchor = startedAt ?? scheduledTime;
  return anchor ? new Date(anchor).getTime() : undefined;
}

/**
 * The range a fixed match occupies, returned as a pair so the two can never
 * disagree about the direction of time.
 *
 * A reported match is modelled by the interval it actually took. Its `ended_at` is
 * not always after its `scheduled_time`: the desk can report a walkover, or a round
 * played ahead of schedule, and then the finish precedes the planned start. A match
 * that ends before it begins is refused by the scheduler, which refuses the whole
 * batch rather than the one row, so a finish at or before the start falls back to one
 * slot and the pair always points forward.
 *
 * Stretching every reported match to a whole slot regardless of its real finish is a
 * legacy guard that is deliberately not carried over. A finished row claims nothing,
 * so there is no slot left to protect, and the stretch manufactured overlaps between
 * rows that were simply played faster than a slot. The problem validator refuses two
 * fixed matches sharing a resource at overlapping times, and it is right to: the
 * overlap was an artefact of the guard, so it rejected the whole batch over history
 * that never actually conflicted.
 *
 * A match reported before it was ever given a slot is the one case with no interval
 * of its own: it has no start, so one slot is inferred from the finish, because it
 * cannot have been played without occupying a court for a slot's worth of time.
 */
export function fixedRange(input: {
  status: string;
  scheduledTime: string | null;
  startedAt: string | null;
  endedAt: string | null;
  slotMinutes: number;
  floor: number;
  now: number;
}): { start: number; end: number } | undefined {
  const slotMs = input.slotMinutes * MINUTE;
  const anchored = anchorStart(input.scheduledTime, input.startedAt);
  const finished = input.endedAt ? new Date(input.endedAt).getTime() : undefined;

  if (input.status === "reported" || input.status === "walkover") {
    const end = finished ?? (anchored != null ? anchored + slotMs : undefined);
    if (end == null) return undefined;
    const start = anchored ?? end - slotMs;
    return end > start ? { start, end } : { start, end: start + slotMs };
  }

  // Anything else is in progress. Its real end is unknown, so it is modelled as at
  // least one slot from now: leaving it at its planned end would let the next match
  // start on that court before the running one has finished.
  const start = anchored ?? finished;
  if (start == null) return undefined;
  return {
    start,
    end: Math.max(start + slotMs, input.floor + slotMs, input.now + slotMs),
  };
}

export interface PlayerLookup {
  (entrantIds: readonly (string | null)[]): {
    playerIds: string[];
    playersKnown: boolean;
  };
}

/**
 * Resolves entrant ids to player ids through the entrant's team.
 *
 * Entrants that are still unknown (a knockout match whose parents have not been
 * decided) are reported as not known, not as an error: that match simply is not
 * schedulable yet.
 */
export function buildPlayerLookup(
  entrants: readonly PlacementEntrant[],
  teams: readonly Team[],
): PlayerLookup {
  const teamIdByEntrant = new Map(entrants.map((entrant) => [entrant.id, entrant.team_id]));
  const teamById = new Map(teams.map((team) => [team.id, team]));

  return (entrantIds) => {
    const playerIds: string[] = [];
    let playersKnown = true;
    for (const entrantId of entrantIds) {
      const teamId = entrantId ? teamIdByEntrant.get(entrantId) : undefined;
      const team = teamId ? teamById.get(teamId) : undefined;
      if (!team) {
        // A missing side is "not yet decided" for a knockout, and a data problem
        // for a placement match. Both are handled the same way: the match is not
        // schedulable, and it surfaces as awaiting teams rather than as a silent
        // match with one player.
        playersKnown = false;
        continue;
      }
      playerIds.push(team.player_1_id);
      if (team.player_2_id) playerIds.push(team.player_2_id);
    }
    return { playerIds, playersKnown };
  };
}

/**
 * Placement matches, as generic scheduling input.
 *
 * `dependencies` is filled from `prerequisite_ids`, but only for prerequisites that
 * are themselves in this batch. A prerequisite that is void or missing would
 * otherwise be a dependency the solver can never satisfy, which turns one
 * abandoned match into an unschedulable day — so it is dropped and the match is
 * left to the desk.
 *
 * A fixed match keeps its `courtNumber` rather than a resolved resource id: only the
 * day that runs it knows which courts are open, and the day runner turns it into a
 * pinned match or a participant anchor accordingly.
 */
export function placementItems(input: {
  matches: readonly PlacementMatch[];
  playerLookup: PlayerLookup;
  courtNumberById: ReadonlyMap<string, number>;
  categoryOrder: ReadonlyMap<string, number>;
  /**
   * Category ids whose field is large enough to run a round two.
   *
   * Round two does not exist as a row while round one is closing, so "does finishing round one
   * release anything?" cannot be read off the match set. It is a property of the field size, and the
   * caller has the entrant list that decides it.
   */
  roundTwoCategories?: ReadonlySet<string> | undefined;
  slotMinutes: number;
  restGap: number;
  floor: number;
  now: number;
}): StageItem[] {
  const { matches, playerLookup, courtNumberById, categoryOrder, slotMinutes, floor, now } = input;
  const roundTwoCategories = input.roundTwoCategories ?? new Set<string>();
  // Non-void rows are the schedulable universe, and the set a prerequisite must
  // be a member of to be honoured.
  const inBatch = new Set(
    matches.filter((match) => match.status !== "void").map((match) => match.id),
  );

  return matches
    .filter((match) => match.status !== "void")
    .map((match) => {
      const { playerIds, playersKnown } = playerLookup([match.entrant_a_id, match.entrant_b_id]);
      const fixed = isFixed(match.status);
      const range = fixed
        ? fixedRange({
            status: match.status,
            scheduledTime: match.scheduled_time,
            startedAt: match.started_at,
            endedAt: match.ended_at,
            slotMinutes,
            floor,
            now,
          })
        : undefined;
      return {
        id: match.id,
        categoryId: match.category_id,
        participantIds: playerIds,
        participantsKnown: playersKnown,
        durationMinutes: slotMinutes,
        restAfterMinutes: input.restGap,
        // No pool to complete: a placement category is its own completion unit.
        groupKey: match.category_id,
        // A placement stage is the category's own round: `MD:round1`, `MD:round2`. The two are one
        // queue slot but two milestones, and only round one releases anything.
        stageKey: `${match.category_id}:${match.stage}`,
        stageUnlocks: match.stage === "round1" && roundTwoCategories.has(match.category_id),
        // Round one ranks before round two, but only as a late tie-break: the solver
        // prioritises the most constrained participant first. That is sufficient here
        // because round two is only generated once every round-one result is in,
        // so a round-one match is always a fixed anchor by the time a round-two
        // match is movable — and a fixed anchor constrains its participants directly.
        sequence: match.stage === "round1" ? 1 : 2,
        softOrder: categoryOrder.get(match.category_id) ?? 0,
        dependencies: match.prerequisite_ids.filter((id) => inBatch.has(id)),
        fixed,
        start: range?.start,
        end: range?.end,
        courtNumber: match.court_id ? courtNumberById.get(match.court_id) : undefined,
      };
    });
}

/**
 * Tier-draw matches, as generic scheduling input.
 *
 * A match with an undecided side is dropped rather than listed as awaiting teams:
 * it is not a match yet, and including it would make every not-yet-reached round
 * show as a missing fixture. Byes are dropped for the same reason plus one more —
 * they are already decided and there is nothing to place.
 *
 * The estimator is what puts the undecided and not-yet-created rounds back, on its own terms; the
 * production planner deliberately never sees them.
 */
export function tierItems(input: {
  matches: readonly TierDrawMatch[];
  drawCategory: ReadonlyMap<string, string>;
  /**
   * Rounds each draw plays, keyed by draw id — `bracketRoundCount(bracket_size)`.
   *
   * A bracket round's successor is a property of the draw's depth, and the later rounds may not
   * exist as rows yet, so the depth has to be handed in rather than re-derived here.
   */
  drawRoundCount?: ReadonlyMap<string, number> | undefined;
  playerLookup: PlayerLookup;
  courtNumberById: ReadonlyMap<string, number>;
  categoryOrder: ReadonlyMap<string, number>;
  slotMinutes: number;
  restGap: number;
  floor: number;
  now: number;
}): StageItem[] {
  const { matches, drawCategory, playerLookup, courtNumberById, categoryOrder } = input;
  const { slotMinutes, restGap, floor, now } = input;
  const drawRoundCount = input.drawRoundCount ?? new Map<string, number>();

  // Indexed once: the parent lookup below would otherwise rescan `matches` for
  // every match, which is quadratic in a bracket that is already large.
  const byId = new Map(matches.map((match) => [match.id, match]));

  return matches
    .filter((match) => !match.is_bye && match.status !== "void")
    .map((match) => {
      const { playerIds, playersKnown } = playerLookup([match.entrant_a_id, match.entrant_b_id]);
      // A knockout match may not start until both of its feeders have finished,
      // plus the participant rest gap — including when a feeder was decided by a bye
      // rather than played.
      const parentEnd = [match.parent_a_id, match.parent_b_id].reduce((acc, parentId) => {
        const parent = parentId ? byId.get(parentId) : undefined;
        const finished = parent?.ended_at ?? parent?.reported_time;
        return finished ? Math.max(acc, new Date(finished).getTime() + restGap * MINUTE) : acc;
      }, 0);
      const fixed = isFixed(match.status);
      const range = fixed
        ? fixedRange({
            status: match.status,
            scheduledTime: match.scheduled_time,
            startedAt: match.started_at,
            endedAt: match.ended_at,
            slotMinutes,
            floor,
            now,
          })
        : undefined;
      const categoryId = drawCategory.get(match.draw_id) ?? match.draw_id;

      return {
        id: match.id,
        categoryId,
        participantIds: playerIds,
        participantsKnown: playersKnown,
        durationMinutes: slotMinutes,
        restAfterMinutes: restGap,
        groupKey: categoryId,
        // One draw is one bracket, so a stage is that draw's round: `draw-7:r2`. Reaching the last
        // round is the end of the event, so a final releases nothing.
        stageKey: `${match.draw_id}:r${match.round}`,
        stageUnlocks: match.round < (drawRoundCount.get(match.draw_id) ?? 0),
        sequence: match.round * 100 + match.slot,
        softOrder: categoryOrder.get(categoryId) ?? 0,
        ...(parentEnd ? { eligibleFrom: parentEnd } : {}),
        fixed,
        start: range?.start,
        end: range?.end,
        courtNumber: match.court_id ? courtNumberById.get(match.court_id) : undefined,
      };
    })
    .filter((item) => {
      // An already-reported match stays in the batch as an anchor. Anything else
      // needs two sides that have actually been decided: a knockout fixture waiting
      // on its bracket is not a match yet, and listing it would make every
      // not-yet-reached round look like something the desk has to chase.
      // The whole bracket exists as rows from the draw, so a half-known match (one side
      // still waiting on a feeder) must be dropped here too: only both sides known counts.
      if (!item.fixed) return item.participantsKnown && item.participantIds.length > 0;
      // A decided match needs no slot of its own, so it is only ever an anchor — and
      // an anchor needs a window to hold. A reported row with no window cannot be
      // modelled, so it is left out rather than making the problem invalid over a row
      // that is already history. A missing court is fine: it just anchors instead.
      return item.start != null && item.end != null;
    });
}
