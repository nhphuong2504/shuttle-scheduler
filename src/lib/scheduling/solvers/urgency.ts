/**
 * The one urgency order both solvers read.
 *
 * Greedy processes a pending set; GRASP sweeps an event-driven clock and ranks the candidates at
 * each instant. The two constructions are genuinely different and stay different — greedy's
 * boundary-advancing gap search is what wins on the large shapes — but the *order* they read must be
 * one order, or "the solver prefers X" would mean two things and the objective could not be
 * reasoned about.
 *
 * Before this module greedy ranked by completion pressure descending (drain the biggest unit first)
 * while GRASP ranked by it ascending, and both led with a participant's raw remaining count. That
 * combination is what benched a straggler: a stage with one match left has the *smallest* pressure
 * and the *fewest* remaining matches, so both readings pushed it behind every event that still had
 * a full round to play. The order below fixes that by promoting real bottleneck pressure to the top
 * and putting stage closure directly beneath it, ahead of raw volume.
 *
 * The tuple, highest priority first. Lower sorts first; every key is a number except
 * `stageUnlocks`, and `false` sorts after `true`.
 *
 *   1. **Player bottleneck pressure** — `futureConflictDegree` desc, `fixedWindowPressure` desc.
 *      How boxed-in the match's most constrained participant is: how many shared partners are also
 *      still owed matches, and whether their remaining work already exceeds the window.
 *   2. **Stage-closing urgency** — `stageRemaining` asc, then `stageUnlocks` true first. The stage
 *      with the fewest matches left goes first, so a near-finished stage closes and releases the
 *      next one instead of being postponed behind events that have barely started.
 *   3. **Raw player work volume** — `remainingMatches` desc, `remainingGroupCount` desc. Draining
 *      the largest pool first is still worth doing, but it is no longer allowed to outrank stage
 *      closure: it is a tie-break within a stage tier, not a reason to starve one.
 *   4. **Waiting time** desc — a match that has been placeable longest goes first.
 *   5. **Completion pressure** asc — one polarity only. The smallest completion unit fits, so it
 *      drains; the largest is deferred until there is room for it.
 *   6. **Presentation and canonical tie-breaks** — `phase`, `softOrder`, `sequence`, the constrained
 *      player's id, then the match id. `softOrder` sorts ascending rather than descending because a
 *      lower key is the stronger preference everywhere else in the core.
 *
 * Nothing here is a hard rule. `constraints.ts` is untouched and remains the only gate: these keys
 * can only reorder two placements that are both already legal.
 */

import {
  compareIds,
  completionKeyOf,
  MINUTE_MS,
  type ScheduleMatch,
} from "../domain";
import { durationMsOf, uniqueParticipants } from "./shared";

/**
 * What one participant is still owed, over a still-unplaced set and a reference instant.
 *
 * Split deliberately into the two tiers the urgency tuple reads: the first two fields are bottleneck
 * pressure and the last two are raw volume. They are ordered by `comparePlayerWork`, which is the
 * same split the tuple uses.
 */
export interface PlayerWork {
  /** Matches still unplaced that this participant is in. */
  remainingMatches: number;
  /** Distinct groups among them. */
  remainingGroupCount: number;
  /** Summed `remaining - 1` over co-participants who are themselves still owed more than one. */
  futureConflictDegree: number;
  /** Required minutes beyond the minutes left in the window; 0 when the work fits. */
  fixedWindowPressure: number;
}

/** A participant's work plus its id, so the comparator is total. */
export interface PlayerWorkEntry extends PlayerWork {
  playerId: string;
}

/** The three counts one match's urgency is read against, plus what "still unplaced" meant. */
export interface UrgencyBoard {
  workByPlayer: ReadonlyMap<string, PlayerWork>;
  remainingByStage: ReadonlyMap<string, number>;
  remainingByCompletionKey: ReadonlyMap<string, number>;
}

/** The keys one match is compared on. Two matches tie only when every field ties. */
export interface UrgencyKeys {
  futureConflictDegree: number;
  fixedWindowPressure: number;
  stageRemaining: number;
  stageUnlocks: boolean;
  remainingMatches: number;
  remainingGroupCount: number;
  waitingTimeMinutes: number;
  completionPressure: number;
  phase: number;
  softOrder: number;
  sequence: number;
  constrainedPlayerId: string;
  matchId: string;
}

/**
 * Orders two participants' work by the two pressure tiers, bottleneck first.
 *
 * This is how a match's "most constrained participant" is chosen, so it must agree with the tuple:
 * it reads the same fields in the same order, and falls back to the id so the choice is canonical
 * rather than insertion-dependent.
 */
export function comparePlayerWork(a: PlayerWorkEntry, b: PlayerWorkEntry): number {
  return (
    b.futureConflictDegree - a.futureConflictDegree ||
    b.fixedWindowPressure - a.fixedWindowPressure ||
    b.remainingMatches - a.remainingMatches ||
    b.remainingGroupCount - a.remainingGroupCount ||
    compareIds(a.playerId, b.playerId)
  );
}

/** The urgency tuple. Negative sorts `a` first. */
export function compareUrgency(a: UrgencyKeys, b: UrgencyKeys): number {
  return (
    // 1. Player bottleneck pressure.
    b.futureConflictDegree - a.futureConflictDegree ||
    b.fixedWindowPressure - a.fixedWindowPressure ||
    // 2. Stage-closing urgency: fewest matches left first, then the one that releases something.
    a.stageRemaining - b.stageRemaining ||
    (a.stageUnlocks === b.stageUnlocks ? 0 : a.stageUnlocks ? -1 : 1) ||
    // 3. Raw work volume.
    b.remainingMatches - a.remainingMatches ||
    b.remainingGroupCount - a.remainingGroupCount ||
    // 4. Waiting.
    b.waitingTimeMinutes - a.waitingTimeMinutes ||
    // 5. Completion pressure, ascending — one polarity.
    a.completionPressure - b.completionPressure ||
    // 6. Presentation, then canonical ids.
    a.phase - b.phase ||
    a.softOrder - b.softOrder ||
    a.sequence - b.sequence ||
    compareIds(a.constrainedPlayerId, b.constrainedPlayerId) ||
    compareIds(a.matchId, b.matchId)
  );
}

/**
 * The work every participant is still owed over `remaining`.
 *
 * `referenceTime` is the instant the window is measured from: GRASP passes its sweeping clock, while
 * greedy passes the problem floor because it has no clock of its own. The comparator is unaffected —
 * only the input is — so the two remain comparable where the inputs agree.
 */
export function buildPlayerWork(
  remaining: readonly ScheduleMatch[],
  planningEnd: number,
  referenceTime: number,
): Map<string, PlayerWork> {
  const matchesByPlayer = new Map<string, ScheduleMatch[]>();
  const countByPlayer = new Map<string, number>();

  for (const match of remaining) {
    for (const participantId of uniqueParticipants(match)) {
      countByPlayer.set(participantId, (countByPlayer.get(participantId) ?? 0) + 1);
      const list = matchesByPlayer.get(participantId);
      if (list) list.push(match);
      else matchesByPlayer.set(participantId, [match]);
    }
  }

  const availableMinutes = Math.max(0, planningEnd - referenceTime) / MINUTE_MS;
  const work = new Map<string, PlayerWork>();
  for (const [playerId, matches] of matchesByPlayer) {
    const groups = new Set<string>();
    let futureConflictDegree = 0;
    let requiredMs = 0;
    for (const match of matches) {
      groups.add(match.groupKey);
      for (const otherPlayerId of uniqueParticipants(match)) {
        if (otherPlayerId === playerId) continue;
        const otherRemaining = countByPlayer.get(otherPlayerId) ?? 0;
        if (otherRemaining > 1) futureConflictDegree += otherRemaining - 1;
      }
      requiredMs += durationMsOf(match) + (match.restAfterMinutes ?? 0) * MINUTE_MS;
    }
    work.set(playerId, {
      remainingMatches: matches.length,
      remainingGroupCount: groups.size,
      futureConflictDegree,
      fixedWindowPressure: Math.max(0, requiredMs / MINUTE_MS - availableMinutes),
    });
  }
  return work;
}

const NO_WORK: PlayerWork = {
  remainingMatches: 0,
  remainingGroupCount: 0,
  futureConflictDegree: 0,
  fixedWindowPressure: 0,
};

/**
 * Builds the board both solvers read.
 *
 * `remaining` is the set that is *still unplaced*. Rebuilding it as that set shrinks is what makes
 * `stageRemaining` actually fall as a stage drains; a single snapshot from the whole problem would
 * keep voting for a stage that has already finished.
 */
export function buildUrgencyBoard(input: {
  remaining: readonly ScheduleMatch[];
  planningEnd: number;
  referenceTime: number;
}): UrgencyBoard {
  const remainingByStage = new Map<string, number>();
  const remainingByCompletionKey = new Map<string, number>();
  for (const match of input.remaining) {
    if (match.stageKey != null) {
      remainingByStage.set(match.stageKey, (remainingByStage.get(match.stageKey) ?? 0) + 1);
    }
    const completionKey = completionKeyOf(match);
    remainingByCompletionKey.set(
      completionKey,
      (remainingByCompletionKey.get(completionKey) ?? 0) + 1,
    );
  }
  return {
    workByPlayer: buildPlayerWork(input.remaining, input.planningEnd, input.referenceTime),
    remainingByStage,
    remainingByCompletionKey,
  };
}

/**
 * The urgency keys of one match: its most constrained participant's bottleneck and volume, plus the
 * match's own stage, waiting, completion and presentation keys.
 *
 * `waitingTimeMinutes` is passed per call rather than read from the board because it depends on the
 * match's own earliest legal start and the deciding instant, which only the caller knows. A strategy
 * with no clock passes 0, which leaves that tier a tie without changing the tuple.
 */
export function urgencyKeysOf(
  match: ScheduleMatch,
  board: UrgencyBoard,
  waitingTimeMinutes = 0,
): UrgencyKeys {
  let constrained: PlayerWorkEntry | null = null;
  for (const playerId of uniqueParticipants(match)) {
    const work = board.workByPlayer.get(playerId) ?? NO_WORK;
    const entry: PlayerWorkEntry = { playerId, ...work };
    if (constrained == null || comparePlayerWork(entry, constrained) < 0) constrained = entry;
  }
  const stage = match.stageKey;
  return {
    futureConflictDegree: constrained?.futureConflictDegree ?? 0,
    fixedWindowPressure: constrained?.fixedWindowPressure ?? 0,
    stageRemaining: stage == null ? 0 : (board.remainingByStage.get(stage) ?? 0),
    stageUnlocks: match.stageUnlocks === true,
    remainingMatches: constrained?.remainingMatches ?? 0,
    remainingGroupCount: constrained?.remainingGroupCount ?? 0,
    waitingTimeMinutes,
    completionPressure: board.remainingByCompletionKey.get(completionKeyOf(match)) ?? 0,
    phase: match.phase ?? 0,
    softOrder: match.softOrder ?? 0,
    sequence: match.sequence ?? 0,
    constrainedPlayerId: constrained?.playerId ?? "",
    matchId: match.id,
  };
}

/**
 * A canonical sort of a candidate set by the shared urgency order.
 *
 * Exported so a test can compare what each strategy would do with *the same board* — which is what
 * makes "unified semantics" a checked property rather than an intention.
 */
export function rankByUrgency(
  matches: readonly ScheduleMatch[],
  board: UrgencyBoard,
  waitingMinutesOf: (match: ScheduleMatch) => number = () => 0,
): ScheduleMatch[] {
  return [...matches].sort((a, b) =>
    compareUrgency(
      urgencyKeysOf(a, board, waitingMinutesOf(a)),
      urgencyKeysOf(b, board, waitingMinutesOf(b)),
    ),
  );
}
