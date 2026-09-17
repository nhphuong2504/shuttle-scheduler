import type { BreakWindow, SchedulableMatch, ScheduledSlot } from "./scheduler";
import { normalizeBreaks, startAfterBreaks } from "./scheduler";

const MINUTE = 60_000;
const DEFAULT_RCL_SIZE = 4;
const DEFAULT_GRASP_RUNS = 75;
const DEFAULT_SEED = 20_260_912;
const DEFAULT_FRAGMENTATION_GAP_MINUTES = 30;

export interface GraspSchedulableMatch extends SchedulableMatch {
  round?: number | undefined;
  dependsOn?: string[] | undefined;
  playersKnown?: boolean | undefined;
}

export interface GraspOptions {
  dayStart: Date;
  planningEnd: Date;
  schedulingFloor?: Date | undefined;
  courts: { id: string; number: number }[];
  slotMinutes: number;
  restGapMinutes: number;
  categoryFragmentationGapMinutes?: number | undefined;
  rclSize?: number | undefined;
  graspRuns?: number | undefined;
  seed?: number | undefined;
  debugTrace?: boolean | undefined;
  maxIterationsPerRun?: number | undefined;
  /** Lunch and similar: play may not run through these. */
  breaks?: readonly BreakWindow[] | undefined;
  /**
   * A wall the run may not cross. Without it `planningEnd` is only a soft signal
   * and a run happily overruns, which is what a tournament wants on its last day
   * but not on an intermediate one: a day that cannot stop would absorb the whole
   * queue and the following days would never be reached.
   */
  hardEnd?: Date | undefined;
}

export interface PlayerConstraint {
  playerId: string;
  remainingMatches: number;
  remainingCategoryCount: number;
  futureConflictDegree: number;
  fixedWindowPressure: number;
}

export interface MatchPriority {
  constrainedPlayer: PlayerConstraint;
  waitingTimeMinutes: number;
  round: number;
  completionPressure: number;
  categoryOrder: number;
}

export interface RankedCandidate {
  matchId: string;
  priority: MatchPriority;
}

export interface GraspDebugEntry {
  decisionTime: string;
  selectedCourt: { id: string; number: number };
  eligibleCandidateCount: number;
  rankedCandidates: RankedCandidate[];
  RCLCandidates: RankedCandidate[];
  selectedMatch: string;
  selectedMatchPriorityTuple: MatchPriority;
  randomSeed: number;
}

export interface GraspDiagnostics {
  projectedFinish: string | null;
  makespanMinutes: number;
  courtUtilization: number;
  courtIdleMinutes: number;
  matchesAfterCutoff: number;
  afterCutoffMinutes: number;
  unscheduledMatches: number;
  minimumObservedPlayerRest: number | null;
  maximumPlayerExcessWait: number;
  averagePlayerExcessWait: number;
  categoryFragmentation: number;
  categoryOrderDeviationCount: number;
  categoryOrderDeviationMagnitude: number;
  validCandidateCount: number;
  invalidCandidateCount: number;
  deadlockedRunCount: number;
  deadlockReason: string | null;
  winningScore: number;
  winningSeed: number;
  totalRuntime: number;
  averageRuntimePerRun: number;
  remainingWindowUtilization: number | null;
}

export interface GraspScheduleResult {
  slots: ScheduledSlot[];
  unscheduled: string[];
  utilization: number;
  overrun: boolean;
  projectedFinish: Date | null;
  overrunMinutes: number;
  diagnostics: GraspDiagnostics;
  trace?: GraspDebugEntry[] | undefined;
}

export interface GraspValidationResult {
  valid: boolean;
  errors: string[];
}

interface NumericSlot {
  matchId: string;
  courtId: string;
  courtNumber: number;
  start: number;
  end: number;
  categoryId: string;
  fixed: boolean;
}

interface FixedWindow {
  matchId: string;
  start: number;
  end: number;
}

interface StaticIndexes {
  matchById: Map<string, GraspSchedulableMatch>;
  matchesByPlayer: Map<string, string[]>;
  playersByMatch: Map<string, string[]>;
  fixedByCourt: Map<string, FixedWindow[]>;
  fixedByPlayer: Map<string, FixedWindow[]>;
  fixedSlots: NumericSlot[];
}

interface RunResult {
  slots: NumericSlot[];
  unscheduled: string[];
  deadlocked: boolean;
  deadlockReason: string | null;
  categoryOrderDeviationCount: number;
  categoryOrderDeviationMagnitude: number;
  trace?: GraspDebugEntry[] | undefined;
}

interface ScoreMetrics {
  score: number;
  projectedFinish: number | null;
  makespanMinutes: number;
  courtUtilization: number;
  planningWindowUtilization: number;
  remainingWindowUtilization: number | null;
  courtIdleMinutes: number;
  matchesAfterCutoff: number;
  afterCutoffMinutes: number;
  minimumObservedPlayerRest: number | null;
  maximumPlayerExcessWait: number;
  averagePlayerExcessWait: number;
  totalPlayerExcessWait: number;
  categoryFragmentation: number;
}

interface NormalizedOptions {
  dayStart: number;
  planningEnd: number;
  schedulingFloor: number;
  courts: { id: string; number: number }[];
  slotMs: number;
  restMs: number;
  fragmentationGapMs: number;
  rclSize: number;
  graspRuns: number;
  baseSeed: number;
  debugTrace: boolean;
  maxIterations: number;
  breaks: BreakWindow[];
  /** `null` means "no wall": the run may overrun its planning end freely. */
  hardEnd: number | null;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function normalizeOptions(
  matches: GraspSchedulableMatch[],
  options: GraspOptions,
): NormalizedOptions {
  if (!options.courts.length) throw new Error("No courts are available to schedule.");
  if (!Number.isFinite(options.slotMinutes) || options.slotMinutes <= 0) {
    throw new Error("Slot duration must be greater than zero.");
  }
  if (!Number.isFinite(options.restGapMinutes) || options.restGapMinutes < 0) {
    throw new Error("Rest gap cannot be negative.");
  }

  const rclSize = Math.floor(options.rclSize ?? DEFAULT_RCL_SIZE);
  const graspRuns = Math.floor(options.graspRuns ?? DEFAULT_GRASP_RUNS);
  if (rclSize < 1) throw new Error("RCL size must be at least 1.");
  if (graspRuns < 1) throw new Error("GRASP run count must be at least 1.");

  const courts = [...options.courts].sort(
    (a, b) => a.number - b.number || a.id.localeCompare(b.id),
  );
  if (new Set(courts.map((court) => court.id)).size !== courts.length) {
    throw new Error("Court IDs must be unique.");
  }

  return {
    dayStart: options.dayStart.getTime(),
    planningEnd: options.planningEnd.getTime(),
    schedulingFloor: Math.max(
      options.dayStart.getTime(),
      options.schedulingFloor?.getTime() ?? options.dayStart.getTime(),
    ),
    courts,
    slotMs: options.slotMinutes * MINUTE,
    restMs: options.restGapMinutes * MINUTE,
    fragmentationGapMs:
      (options.categoryFragmentationGapMinutes ?? DEFAULT_FRAGMENTATION_GAP_MINUTES) * MINUTE,
    rclSize,
    graspRuns,
    baseSeed: (options.seed ?? DEFAULT_SEED) >>> 0,
    debugTrace: options.debugTrace ?? false,
    maxIterations:
      options.maxIterationsPerRun ?? matches.length * Math.max(courts.length, 1) * 6 + 500,
    breaks: normalizeBreaks(options.breaks, options.planningEnd.getTime()),
    hardEnd: options.hardEnd?.getTime() ?? null,
  };
}

function buildIndexes(matches: GraspSchedulableMatch[], options: NormalizedOptions): StaticIndexes {
  const matchById = new Map<string, GraspSchedulableMatch>();
  const matchesByPlayer = new Map<string, string[]>();
  const playersByMatch = new Map<string, string[]>();
  const courtByNumber = new Map(options.courts.map((court) => [court.number, court]));
  const fixedByCourt = new Map<string, FixedWindow[]>();
  const fixedByPlayer = new Map<string, FixedWindow[]>();
  const fixedSlots: NumericSlot[] = [];

  for (const match of matches) {
    if (matchById.has(match.id)) throw new Error(`Duplicate match ID: ${match.id}`);
    matchById.set(match.id, match);
    const uniquePlayers = [...new Set(match.playerIds)];
    playersByMatch.set(match.id, uniquePlayers);
    for (const playerId of uniquePlayers) {
      const playerMatches = matchesByPlayer.get(playerId) ?? [];
      playerMatches.push(match.id);
      matchesByPlayer.set(playerId, playerMatches);
    }

    if (!match.fixed) continue;
    if (match.start == null || match.end == null || match.courtNumber == null) {
      throw new Error(`Fixed match ${match.id} is missing its court, start, or end.`);
    }
    const court = courtByNumber.get(match.courtNumber);
    if (!court)
      throw new Error(`Fixed match ${match.id} references unavailable court ${match.courtNumber}.`);
    if (match.end <= match.start)
      throw new Error(`Fixed match ${match.id} has an invalid time range.`);

    const window = { matchId: match.id, start: match.start, end: match.end };
    const courtWindows = fixedByCourt.get(court.id) ?? [];
    courtWindows.push(window);
    fixedByCourt.set(court.id, courtWindows);
    for (const playerId of uniquePlayers) {
      const playerWindows = fixedByPlayer.get(playerId) ?? [];
      playerWindows.push(window);
      fixedByPlayer.set(playerId, playerWindows);
    }
    fixedSlots.push({
      matchId: match.id,
      courtId: court.id,
      courtNumber: court.number,
      start: match.start,
      end: match.end,
      categoryId: match.categoryId,
      fixed: true,
    });
  }

  const sortWindows = (windows: FixedWindow[]) =>
    windows.sort(
      (a, b) => a.start - b.start || a.end - b.end || a.matchId.localeCompare(b.matchId),
    );
  for (const windows of fixedByCourt.values()) sortWindows(windows);
  for (const windows of fixedByPlayer.values()) sortWindows(windows);
  fixedSlots.sort((a, b) => a.start - b.start || a.courtNumber - b.courtNumber);

  return {
    matchById,
    matchesByPlayer,
    playersByMatch,
    fixedByCourt,
    fixedByPlayer,
    fixedSlots,
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

function fixedCourtAllows(
  courtId: string,
  start: number,
  end: number,
  indexes: StaticIndexes,
): boolean {
  return !(indexes.fixedByCourt.get(courtId) ?? []).some((window) =>
    overlaps(start, end, window.start, window.end),
  );
}

function fixedPlayerAllows(
  playerId: string,
  start: number,
  end: number,
  indexes: StaticIndexes,
  restMs: number,
): boolean {
  return !(indexes.fixedByPlayer.get(playerId) ?? []).some((window) => {
    if (end <= window.start) return end + restMs > window.start;
    if (start >= window.end) return start < window.end + restMs;
    return true;
  });
}

function earliestEligibleTime(
  match: GraspSchedulableMatch,
  playerFreeAt: Map<string, number>,
  scheduledEnd: Map<string, number>,
  indexes: StaticIndexes,
  options: NormalizedOptions,
): number {
  let earliest = Math.max(options.schedulingFloor, match.earliestStart ?? options.schedulingFloor);
  for (const playerId of indexes.playersByMatch.get(match.id) ?? []) {
    earliest = Math.max(earliest, playerFreeAt.get(playerId) ?? options.schedulingFloor);
  }
  for (const dependencyId of match.dependsOn ?? []) {
    const end = scheduledEnd.get(dependencyId);
    if (end != null) earliest = Math.max(earliest, end);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const playerId of indexes.playersByMatch.get(match.id) ?? []) {
      for (const window of indexes.fixedByPlayer.get(playerId) ?? []) {
        const canFitBefore = earliest + options.slotMs + options.restMs <= window.start;
        const isAfterRest = earliest >= window.end + options.restMs;
        if (!canFitBefore && !isAfterRest) {
          earliest = window.end + options.restMs;
          changed = true;
        }
      }
    }
  }
  return earliest;
}

function isEligible(
  match: GraspSchedulableMatch,
  courtId: string,
  currentTime: number,
  remaining: Set<string>,
  courtFreeAt: Map<string, number>,
  playerFreeAt: Map<string, number>,
  scheduledEnd: Map<string, number>,
  indexes: StaticIndexes,
  options: NormalizedOptions,
): boolean {
  if (
    !remaining.has(match.id) ||
    match.fixed ||
    match.playersKnown === false ||
    match.playerIds.length === 0
  ) {
    return false;
  }
  if ((courtFreeAt.get(courtId) ?? options.schedulingFloor) > currentTime) return false;
  if ((match.earliestStart ?? options.schedulingFloor) > currentTime) return false;
  for (const dependencyId of match.dependsOn ?? []) {
    const dependencyEnd = scheduledEnd.get(dependencyId);
    if (dependencyEnd == null || dependencyEnd > currentTime) return false;
  }

  const end = currentTime + options.slotMs;
  if (!fixedCourtAllows(courtId, currentTime, end, indexes)) return false;
  for (const playerId of indexes.playersByMatch.get(match.id) ?? []) {
    if ((playerFreeAt.get(playerId) ?? options.schedulingFloor) > currentTime) return false;
    if (!fixedPlayerAllows(playerId, currentTime, end, indexes, options.restMs)) return false;
  }
  return true;
}

function comparePlayerConstraint(a: PlayerConstraint, b: PlayerConstraint): number {
  return (
    a.remainingMatches - b.remainingMatches ||
    a.remainingCategoryCount - b.remainingCategoryCount ||
    a.futureConflictDegree - b.futureConflictDegree ||
    a.fixedWindowPressure - b.fixedWindowPressure ||
    b.playerId.localeCompare(a.playerId)
  );
}

function playerConstraint(
  playerId: string,
  currentTime: number,
  remaining: Set<string>,
  remainingByPlayer: Map<string, number>,
  indexes: StaticIndexes,
  options: NormalizedOptions,
): PlayerConstraint {
  const remainingIds = (indexes.matchesByPlayer.get(playerId) ?? []).filter((id) =>
    remaining.has(id),
  );
  const categories = new Set<string>();
  let futureConflictDegree = 0;

  for (const matchId of remainingIds) {
    const match = indexes.matchById.get(matchId);
    if (!match) continue;
    categories.add(match.categoryId);
    for (const otherPlayerId of indexes.playersByMatch.get(match.id) ?? []) {
      if (otherPlayerId === playerId) continue;
      const otherRemaining = remainingByPlayer.get(otherPlayerId) ?? 0;
      if (otherRemaining > 1) futureConflictDegree += otherRemaining - 1;
    }
  }

  const availableMinutes = Math.max(0, options.planningEnd - currentTime) / MINUTE;
  const requiredMinutes = (remainingIds.length * (options.slotMs + options.restMs)) / MINUTE;
  return {
    playerId,
    remainingMatches: remainingIds.length,
    remainingCategoryCount: categories.size,
    futureConflictDegree,
    fixedWindowPressure: Math.max(0, requiredMinutes - availableMinutes),
  };
}

function priorityFor(
  match: GraspSchedulableMatch,
  currentTime: number,
  remaining: Set<string>,
  remainingByPlayer: Map<string, number>,
  remainingByCompletionKey: Map<string, number>,
  constraintCache: Map<string, PlayerConstraint>,
  playerFreeAt: Map<string, number>,
  scheduledEnd: Map<string, number>,
  indexes: StaticIndexes,
  options: NormalizedOptions,
): MatchPriority {
  const constraints = (indexes.playersByMatch.get(match.id) ?? []).map((playerId) => {
    let constraint = constraintCache.get(playerId);
    if (!constraint) {
      constraint = playerConstraint(
        playerId,
        currentTime,
        remaining,
        remainingByPlayer,
        indexes,
        options,
      );
      constraintCache.set(playerId, constraint);
    }
    return constraint;
  });
  const constrainedPlayer = constraints.reduce((most, current) =>
    comparePlayerConstraint(current, most) > 0 ? current : most,
  );
  const completionKey = match.poolId ?? match.categoryId;
  const completionPressure = remainingByCompletionKey.get(completionKey) ?? 0;

  return {
    constrainedPlayer,
    waitingTimeMinutes: Math.max(
      0,
      (currentTime - earliestEligibleTime(match, playerFreeAt, scheduledEnd, indexes, options)) /
        MINUTE,
    ),
    round: match.round ?? match.order,
    completionPressure,
    categoryOrder: match.categoryOrder ?? 0,
  };
}

function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  const ap = a.priority;
  const bp = b.priority;
  return (
    comparePlayerConstraint(bp.constrainedPlayer, ap.constrainedPlayer) ||
    bp.waitingTimeMinutes - ap.waitingTimeMinutes ||
    ap.round - bp.round ||
    ap.completionPressure - bp.completionPressure ||
    ap.categoryOrder - bp.categoryOrder ||
    a.matchId.localeCompare(b.matchId)
  );
}

function nextFutureEvent(
  currentTime: number,
  remaining: Set<string>,
  courtFreeAt: Map<string, number>,
  playerFreeAt: Map<string, number>,
  scheduledEnd: Map<string, number>,
  indexes: StaticIndexes,
  options: NormalizedOptions,
): number | null {
  let next = Number.POSITIVE_INFINITY;
  const consider = (value: number | undefined) => {
    if (value != null && value > currentTime && value < next) next = value;
  };

  for (const value of courtFreeAt.values()) consider(value);
  for (const value of playerFreeAt.values()) consider(value);
  for (const windows of indexes.fixedByCourt.values()) {
    for (const window of windows) {
      consider(window.start);
      consider(window.end);
    }
  }
  for (const windows of indexes.fixedByPlayer.values()) {
    for (const window of windows) {
      consider(window.start);
      consider(window.end + options.restMs);
    }
  }
  for (const matchId of remaining) {
    const match = indexes.matchById.get(matchId);
    if (!match) continue;
    consider(match.earliestStart);
    for (const dependencyId of match.dependsOn ?? []) consider(scheduledEnd.get(dependencyId));
  }
  return Number.isFinite(next) ? next : null;
}

function runSchedule(
  matches: GraspSchedulableMatch[],
  seed: number,
  indexes: StaticIndexes,
  options: NormalizedOptions,
  captureTrace: boolean,
): RunResult {
  const random = mulberry32(seed);
  const remaining = new Set(matches.filter((match) => !match.fixed).map((match) => match.id));
  const remainingByPlayer = new Map<string, number>();
  const remainingByCompletionKey = new Map<string, number>();
  for (const match of matches) {
    if (match.fixed) continue;
    for (const playerId of indexes.playersByMatch.get(match.id) ?? []) {
      remainingByPlayer.set(playerId, (remainingByPlayer.get(playerId) ?? 0) + 1);
    }
    const completionKey = match.poolId ?? match.categoryId;
    remainingByCompletionKey.set(
      completionKey,
      (remainingByCompletionKey.get(completionKey) ?? 0) + 1,
    );
  }
  const courtFreeAt = new Map(options.courts.map((court) => [court.id, options.schedulingFloor]));
  const playerFreeAt = new Map<string, number>();
  const scheduledEnd = new Map(indexes.fixedSlots.map((slot) => [slot.matchId, slot.end]));
  const slots = indexes.fixedSlots.map((slot) => ({ ...slot }));
  const trace: GraspDebugEntry[] = [];
  // Every match in a wave starts together, so a break moves the whole wave: a
  // match cannot be paused part-way through. Snapping here means no candidate is
  // ever considered at a time that would run into a break.
  let currentTime = startAfterBreaks(options.schedulingFloor, options.slotMs, options.breaks);
  let categoryOrderDeviationCount = 0;
  let categoryOrderDeviationMagnitude = 0;
  let iterations = 0;
  let deadlocked = false;
  let deadlockReason: string | null = null;

  while (remaining.size > 0) {
    iterations++;
    if (iterations > options.maxIterations) {
      deadlocked = true;
      deadlockReason = `Iteration cap ${options.maxIterations} reached at ${new Date(currentTime).toISOString()}.`;
      break;
    }

    // Past the hard end the day is full, so stop rather than overrun. Everything
    // still in `remaining` is deferred rather than blocked: it is the caller's
    // decision whether there is another day to carry it into.
    if (options.hardEnd != null && currentTime + options.slotMs > options.hardEnd) break;

    let assigned = false;
    const constraintCache = new Map<string, PlayerConstraint>();
    const availableCourts = options.courts.filter(
      (court) => (courtFreeAt.get(court.id) ?? options.schedulingFloor) <= currentTime,
    );

    for (const court of availableCourts) {
      const ranked: RankedCandidate[] = [];
      for (const matchId of remaining) {
        const match = indexes.matchById.get(matchId);
        if (
          match &&
          isEligible(
            match,
            court.id,
            currentTime,
            remaining,
            courtFreeAt,
            playerFreeAt,
            scheduledEnd,
            indexes,
            options,
          )
        ) {
          ranked.push({
            matchId,
            priority: priorityFor(
              match,
              currentTime,
              remaining,
              remainingByPlayer,
              remainingByCompletionKey,
              constraintCache,
              playerFreeAt,
              scheduledEnd,
              indexes,
              options,
            ),
          });
        }
      }
      if (!ranked.length) continue;

      ranked.sort(compareRanked);
      const rcl = ranked.slice(0, Math.min(options.rclSize, ranked.length));
      const selectedRanked = rcl[Math.floor(random() * rcl.length)]!;
      const selected = indexes.matchById.get(selectedRanked.matchId)!;
      const end = currentTime + options.slotMs;
      const earliestCategoryOrder = Math.min(
        ...ranked.map((candidate) => candidate.priority.categoryOrder),
      );
      const selectedCategoryOrder = selected.categoryOrder ?? 0;
      if (selectedCategoryOrder > earliestCategoryOrder) {
        categoryOrderDeviationCount++;
        categoryOrderDeviationMagnitude += selectedCategoryOrder - earliestCategoryOrder;
      }

      slots.push({
        matchId: selected.id,
        courtId: court.id,
        courtNumber: court.number,
        start: currentTime,
        end,
        categoryId: selected.categoryId,
        fixed: false,
      });
      remaining.delete(selected.id);
      for (const playerId of indexes.playersByMatch.get(selected.id) ?? []) {
        remainingByPlayer.set(playerId, Math.max(0, (remainingByPlayer.get(playerId) ?? 1) - 1));
      }
      const completionKey = selected.poolId ?? selected.categoryId;
      remainingByCompletionKey.set(
        completionKey,
        Math.max(0, (remainingByCompletionKey.get(completionKey) ?? 1) - 1),
      );
      courtFreeAt.set(court.id, end);
      for (const playerId of indexes.playersByMatch.get(selected.id) ?? []) {
        playerFreeAt.set(playerId, end + options.restMs);
      }
      scheduledEnd.set(selected.id, end);

      if (captureTrace) {
        trace.push({
          decisionTime: new Date(currentTime).toISOString(),
          selectedCourt: { ...court },
          eligibleCandidateCount: ranked.length,
          rankedCandidates: ranked,
          RCLCandidates: rcl,
          selectedMatch: selected.id,
          selectedMatchPriorityTuple: selectedRanked.priority,
          randomSeed: seed,
        });
      }
      assigned = true;
      break;
    }

    if (assigned) continue;
    const next = nextFutureEvent(
      currentTime,
      remaining,
      courtFreeAt,
      playerFreeAt,
      scheduledEnd,
      indexes,
      options,
    );
    if (next == null) {
      deadlocked = true;
      deadlockReason = `No future event can make ${remaining.size} remaining match(es) eligible.`;
      break;
    }
    // `next` is always greater than the current time, so snapping past a break
    // still advances and the loop cannot spin.
    currentTime = startAfterBreaks(next, options.slotMs, options.breaks);
  }

  return {
    slots,
    unscheduled: [...remaining].sort(),
    deadlocked,
    deadlockReason,
    categoryOrderDeviationCount,
    categoryOrderDeviationMagnitude,
    ...(captureTrace ? { trace } : {}),
  };
}

function toScheduledSlots(slots: NumericSlot[], planningEnd: number): ScheduledSlot[] {
  return slots
    .map((slot) => ({
      matchId: slot.matchId,
      courtId: slot.courtId,
      courtNumber: slot.courtNumber,
      start: new Date(slot.start),
      end: new Date(slot.end),
      categoryId: slot.categoryId,
      overrun: slot.end > planningEnd,
    }))
    .sort(
      (a, b) =>
        a.start.getTime() - b.start.getTime() ||
        a.courtNumber - b.courtNumber ||
        a.matchId.localeCompare(b.matchId),
    );
}

function validationOptions(options: GraspOptions): {
  dayStart: number;
  schedulingFloor: number;
  restMs: number;
  courts: Map<string, { id: string; number: number }>;
} {
  return {
    dayStart: options.dayStart.getTime(),
    schedulingFloor: Math.max(
      options.dayStart.getTime(),
      options.schedulingFloor?.getTime() ?? options.dayStart.getTime(),
    ),
    restMs: options.restGapMinutes * MINUTE,
    courts: new Map(options.courts.map((court) => [court.id, court])),
  };
}

export function validateGraspSchedule(
  matches: GraspSchedulableMatch[],
  slots: ScheduledSlot[],
  unscheduled: string[],
  options: GraspOptions,
): GraspValidationResult {
  const errors: string[] = [];
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const config = validationOptions(options);
  const appearances = new Map<string, number>();
  const slotByMatch = new Map<string, ScheduledSlot>();

  for (const slot of slots) {
    appearances.set(slot.matchId, (appearances.get(slot.matchId) ?? 0) + 1);
    if (!slotByMatch.has(slot.matchId)) slotByMatch.set(slot.matchId, slot);
    const match = matchById.get(slot.matchId);
    if (!match) errors.push(`Scheduled slot references unknown match ${slot.matchId}.`);
    const court = config.courts.get(slot.courtId);
    if (!court || court.number !== slot.courtNumber) {
      errors.push(`Match ${slot.matchId} references invalid court ${slot.courtId}.`);
    }
    if (slot.end.getTime() <= slot.start.getTime()) {
      errors.push(`Match ${slot.matchId} has an invalid time range.`);
    }
    if (!match?.fixed && slot.start.getTime() < config.schedulingFloor) {
      errors.push(`Match ${slot.matchId} starts before the scheduling floor.`);
    }
  }

  for (const matchId of unscheduled) {
    appearances.set(matchId, (appearances.get(matchId) ?? 0) + 1);
    if (!matchById.has(matchId))
      errors.push(`Unscheduled list references unknown match ${matchId}.`);
  }
  for (const match of matches) {
    const count = appearances.get(match.id) ?? 0;
    if (count !== 1)
      errors.push(`Match ${match.id} appears ${count} times; expected exactly once.`);
  }

  const byCourt = new Map<string, ScheduledSlot[]>();
  for (const slot of slots) {
    const courtSlots = byCourt.get(slot.courtId) ?? [];
    courtSlots.push(slot);
    byCourt.set(slot.courtId, courtSlots);
  }
  for (const [courtId, courtSlots] of byCourt) {
    courtSlots.sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let index = 1; index < courtSlots.length; index++) {
      const previous = courtSlots[index - 1]!;
      const current = courtSlots[index]!;
      const previousMatch = matchById.get(previous.matchId);
      const currentMatch = matchById.get(current.matchId);
      if (previousMatch?.fixed && currentMatch?.fixed) continue;
      if (current.start.getTime() < previous.end.getTime()) {
        errors.push(
          `Court ${courtId} overlaps matches ${previous.matchId} and ${current.matchId}.`,
        );
      }
    }
  }

  const byPlayer = new Map<string, ScheduledSlot[]>();
  for (const slot of slots) {
    const match = matchById.get(slot.matchId);
    if (!match) continue;
    for (const playerId of new Set(match.playerIds)) {
      const playerSlots = byPlayer.get(playerId) ?? [];
      playerSlots.push(slot);
      byPlayer.set(playerId, playerSlots);
    }
  }
  for (const [playerId, playerSlots] of byPlayer) {
    playerSlots.sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let index = 1; index < playerSlots.length; index++) {
      const previous = playerSlots[index - 1]!;
      const current = playerSlots[index]!;
      const previousMatch = matchById.get(previous.matchId);
      const currentMatch = matchById.get(current.matchId);
      if (previousMatch?.fixed && currentMatch?.fixed) continue;
      const gap = current.start.getTime() - previous.end.getTime();
      if (gap < 0) {
        errors.push(
          `Player ${playerId} overlaps matches ${previous.matchId} and ${current.matchId}.`,
        );
      } else if (gap < config.restMs) {
        errors.push(
          `Player ${playerId} has ${gap / MINUTE} minutes rest between ${previous.matchId} and ${current.matchId}; expected ${options.restGapMinutes}.`,
        );
      }
    }
  }

  for (const match of matches) {
    if (match.fixed) {
      const slot = slotByMatch.get(match.id);
      if (
        !slot ||
        match.start == null ||
        match.end == null ||
        match.courtNumber == null ||
        slot.start.getTime() !== match.start ||
        slot.end.getTime() !== match.end ||
        slot.courtNumber !== match.courtNumber
      ) {
        errors.push(`Fixed match ${match.id} was moved or omitted.`);
      }
    }

    const slot = slotByMatch.get(match.id);
    if (!slot) continue;
    for (const dependencyId of match.dependsOn ?? []) {
      const dependency = slotByMatch.get(dependencyId);
      if (!dependency) {
        errors.push(`Match ${match.id} is scheduled without dependency ${dependencyId}.`);
      } else if (slot.start.getTime() < dependency.end.getTime()) {
        errors.push(`Match ${match.id} starts before dependency ${dependencyId} ends.`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function occupiedMinutes(slots: NumericSlot[], dayStart: number, projectedFinish: number): number {
  const byCourt = new Map<string, { start: number; end: number }[]>();
  for (const slot of slots) {
    const start = Math.max(dayStart, slot.start);
    const end = Math.min(projectedFinish, slot.end);
    if (end <= start) continue;
    const intervals = byCourt.get(slot.courtId) ?? [];
    intervals.push({ start, end });
    byCourt.set(slot.courtId, intervals);
  }

  let occupied = 0;
  for (const intervals of byCourt.values()) {
    intervals.sort((a, b) => a.start - b.start);
    let blockStart = intervals[0]?.start;
    let blockEnd = intervals[0]?.end;
    if (blockStart == null || blockEnd == null) continue;
    for (let index = 1; index < intervals.length; index++) {
      const interval = intervals[index]!;
      if (interval.start <= blockEnd) {
        blockEnd = Math.max(blockEnd, interval.end);
      } else {
        occupied += blockEnd - blockStart;
        blockStart = interval.start;
        blockEnd = interval.end;
      }
    }
    occupied += blockEnd - blockStart;
  }
  return occupied / MINUTE;
}

function playerWaitMetrics(
  matches: GraspSchedulableMatch[],
  slots: NumericSlot[],
  restMs: number,
): {
  minimumRest: number | null;
  maximumExcessWait: number;
  averageExcessWait: number;
  totalExcessWait: number;
} {
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const byPlayer = new Map<string, NumericSlot[]>();
  for (const slot of slots) {
    const match = matchById.get(slot.matchId);
    if (!match) continue;
    for (const playerId of new Set(match.playerIds)) {
      const list = byPlayer.get(playerId) ?? [];
      list.push(slot);
      byPlayer.set(playerId, list);
    }
  }

  let minimumRest = Number.POSITIVE_INFINITY;
  let maximumExcessWait = 0;
  let totalExcessWait = 0;
  let pairCount = 0;
  for (const playerSlots of byPlayer.values()) {
    playerSlots.sort((a, b) => a.start - b.start);
    for (let index = 1; index < playerSlots.length; index++) {
      const rawWait = playerSlots[index]!.start - playerSlots[index - 1]!.end;
      const excess = Math.max(0, rawWait - restMs) / MINUTE;
      minimumRest = Math.min(minimumRest, rawWait / MINUTE);
      maximumExcessWait = Math.max(maximumExcessWait, excess);
      totalExcessWait += excess;
      pairCount++;
    }
  }
  return {
    minimumRest: Number.isFinite(minimumRest) ? minimumRest : null,
    maximumExcessWait,
    averageExcessWait: pairCount ? totalExcessWait / pairCount : 0,
    totalExcessWait,
  };
}

function categoryFragmentation(slots: NumericSlot[], gapMs: number): number {
  const byCategory = new Map<string, NumericSlot[]>();
  for (const slot of slots) {
    const list = byCategory.get(slot.categoryId) ?? [];
    list.push(slot);
    byCategory.set(slot.categoryId, list);
  }

  let fragmentation = 0;
  for (const categorySlots of byCategory.values()) {
    categorySlots.sort((a, b) => a.start - b.start || a.end - b.end);
    let blocks = 0;
    let blockEnd = Number.NEGATIVE_INFINITY;
    for (const slot of categorySlots) {
      if (blocks === 0 || slot.start - blockEnd > gapMs) blocks++;
      blockEnd = Math.max(blockEnd, slot.end);
    }
    fragmentation += Math.max(0, blocks - 1);
  }
  return fragmentation;
}

function scoreSchedule(
  matches: GraspSchedulableMatch[],
  run: RunResult,
  options: NormalizedOptions,
): ScoreMetrics {
  const projectedFinish = run.slots.length ? Math.max(...run.slots.map((slot) => slot.end)) : null;
  const makespanMinutes =
    projectedFinish == null ? 0 : Math.max(0, projectedFinish - options.dayStart) / MINUTE;
  const occupied =
    projectedFinish == null ? 0 : occupiedMinutes(run.slots, options.dayStart, projectedFinish);
  const capacity = makespanMinutes * options.courts.length;
  const courtIdleMinutes = Math.max(0, capacity - occupied);
  const courtUtilization = capacity > 0 ? occupied / capacity : 0;
  const planningWindowMinutes =
    (Math.max(0, options.planningEnd - options.dayStart) / MINUTE) * options.courts.length;
  const planningWindowOccupied = occupiedMinutes(run.slots, options.dayStart, options.planningEnd);
  const planningWindowUtilization =
    planningWindowMinutes > 0 ? planningWindowOccupied / planningWindowMinutes : 0;
  const remainingWindowMinutes =
    (Math.max(0, options.planningEnd - options.schedulingFloor) / MINUTE) * options.courts.length;
  const remainingWindowOccupied = occupiedMinutes(
    run.slots,
    options.schedulingFloor,
    options.planningEnd,
  );
  const remainingWindowUtilization =
    remainingWindowMinutes > 0 ? remainingWindowOccupied / remainingWindowMinutes : null;
  const afterCutoffMinutes =
    projectedFinish == null ? 0 : Math.max(0, projectedFinish - options.planningEnd) / MINUTE;
  const matchesAfterCutoff = run.slots.filter((slot) => slot.end > options.planningEnd).length;
  const waits = playerWaitMetrics(matches, run.slots, options.restMs);
  const fragmentation = categoryFragmentation(run.slots, options.fragmentationGapMs);

  // The tiers deliberately dominate all lower-order terms for realistic one-day schedules.
  const score =
    run.unscheduled.length * 10_000_000_000_000 +
    afterCutoffMinutes * 1_000_000_000 +
    makespanMinutes * 1_000_000 +
    courtIdleMinutes * 1_000 +
    waits.totalExcessWait * 10 +
    fragmentation * 2 +
    run.categoryOrderDeviationMagnitude;

  return {
    score,
    projectedFinish,
    makespanMinutes,
    courtUtilization,
    planningWindowUtilization,
    remainingWindowUtilization,
    courtIdleMinutes,
    matchesAfterCutoff,
    afterCutoffMinutes,
    minimumObservedPlayerRest: waits.minimumRest,
    maximumPlayerExcessWait: waits.maximumExcessWait,
    averagePlayerExcessWait: waits.averageExcessWait,
    totalPlayerExcessWait: waits.totalExcessWait,
    categoryFragmentation: fragmentation,
  };
}

function runValidation(
  matches: GraspSchedulableMatch[],
  run: RunResult,
  originalOptions: GraspOptions,
  options: NormalizedOptions,
): GraspValidationResult {
  return validateGraspSchedule(
    matches,
    toScheduledSlots(run.slots, options.planningEnd),
    run.unscheduled,
    originalOptions,
  );
}

export function scheduleGroupStageGrasp(
  matches: GraspSchedulableMatch[],
  options: GraspOptions,
): GraspScheduleResult {
  const startedAt = nowMs();
  const normalized = normalizeOptions(matches, options);
  const indexes = buildIndexes(matches, normalized);
  let validCandidateCount = 0;
  let invalidCandidateCount = 0;
  let deadlockedRunCount = 0;
  let winner: { run: RunResult; metrics: ScoreMetrics; seed: number } | null = null;
  let firstInvalidErrors: string[] = [];

  for (let index = 0; index < normalized.graspRuns; index++) {
    const seed = (normalized.baseSeed + index) >>> 0;
    const run = runSchedule(matches, seed, indexes, normalized, false);
    if (run.deadlocked) deadlockedRunCount++;
    const validation = runValidation(matches, run, options, normalized);
    if (!validation.valid) {
      invalidCandidateCount++;
      if (!firstInvalidErrors.length) firstInvalidErrors = validation.errors;
      continue;
    }
    validCandidateCount++;
    const metrics = scoreSchedule(matches, run, normalized);
    if (
      !winner ||
      metrics.score < winner.metrics.score ||
      (metrics.score === winner.metrics.score && seed < winner.seed)
    ) {
      winner = { run, metrics, seed };
    }
  }

  if (!winner) {
    const details = firstInvalidErrors.slice(0, 3).join(" ");
    throw new Error(
      `Day 1 scheduler produced no valid candidates (${invalidCandidateCount} invalid).${details ? ` ${details}` : ""}`,
    );
  }

  let winningRun = winner.run;
  if (normalized.debugTrace) {
    winningRun = runSchedule(matches, winner.seed, indexes, normalized, true);
    const validation = runValidation(matches, winningRun, options, normalized);
    if (!validation.valid) {
      throw new Error(`Winning schedule was not reproducible: ${validation.errors.join(" ")}`);
    }
    for (const entry of winningRun.trace ?? []) console.debug("[Day 1 GRASP]", entry);
  }

  const totalRuntime = nowMs() - startedAt;
  const metrics = scoreSchedule(matches, winningRun, normalized);
  const slots = toScheduledSlots(winningRun.slots, normalized.planningEnd);
  const projectedFinish =
    metrics.projectedFinish == null ? null : new Date(metrics.projectedFinish);
  const diagnostics: GraspDiagnostics = {
    projectedFinish: projectedFinish?.toISOString() ?? null,
    makespanMinutes: metrics.makespanMinutes,
    courtUtilization: metrics.courtUtilization,
    courtIdleMinutes: metrics.courtIdleMinutes,
    matchesAfterCutoff: metrics.matchesAfterCutoff,
    afterCutoffMinutes: metrics.afterCutoffMinutes,
    unscheduledMatches: winningRun.unscheduled.length,
    minimumObservedPlayerRest: metrics.minimumObservedPlayerRest,
    maximumPlayerExcessWait: metrics.maximumPlayerExcessWait,
    averagePlayerExcessWait: metrics.averagePlayerExcessWait,
    categoryFragmentation: metrics.categoryFragmentation,
    categoryOrderDeviationCount: winningRun.categoryOrderDeviationCount,
    categoryOrderDeviationMagnitude: winningRun.categoryOrderDeviationMagnitude,
    validCandidateCount,
    invalidCandidateCount,
    deadlockedRunCount,
    deadlockReason: winningRun.deadlockReason,
    winningScore: metrics.score,
    winningSeed: winner.seed,
    totalRuntime,
    averageRuntimePerRun: totalRuntime / normalized.graspRuns,
    remainingWindowUtilization: metrics.remainingWindowUtilization,
  };

  return {
    slots,
    unscheduled: winningRun.unscheduled,
    utilization: metrics.planningWindowUtilization,
    overrun: metrics.afterCutoffMinutes > 0 || winningRun.unscheduled.length > 0,
    projectedFinish,
    overrunMinutes: Math.round(metrics.afterCutoffMinutes),
    diagnostics,
    ...(winningRun.trace ? { trace: winningRun.trace } : {}),
  };
}
