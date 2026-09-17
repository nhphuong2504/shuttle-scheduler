/**
 * Court/time scheduling with stage-specific rest gaps, category blocks,
 * and no hard end-of-day cap. 17:00 is a planning benchmark only.
 */

export interface SchedulableMatch {
  id: string;
  categoryId: string;
  categoryOrder?: number | undefined;
  poolId?: string | null | undefined;
  playerIds: string[];
  kind: "group" | "knockout";
  order: number;
  earliestStart?: number | undefined;
  fixed?: boolean;
  start?: number | undefined;
  end?: number | undefined;
  courtNumber?: number | undefined;
}

export interface SchedulerOptions {
  dayStart: Date;
  planningEnd: Date;
  courts: { id: string; number: number }[];
  slotMinutes: number;
  restGapMinutes: number;
  /** Lunch and similar: play may not run through these. */
  breaks?: readonly BreakWindow[] | undefined;
  /**
   * A wall the run may not cross. Without it `planningEnd` is only a soft signal and
   * a run overruns freely, which is what a tournament wants on its last day but not
   * on an intermediate one.
   */
  hardEnd?: Date | undefined;
  /**
   * The earliest a match without a time of its own may start.
   *
   * Defaults to `dayStart`, which is what a first build wants: the tournament's own
   * opening time is authoritative and the wall clock is not. A rebuild passes the
   * current minute instead, so replanning a day already under way cannot put a match
   * in the past — the desk would otherwise read a start time that has already gone by
   * as "ready now" and send a player out for a slot that never existed.
   */
  floor?: Date | undefined;
}

/**
 * A window play cannot run through, e.g. a lunch break. Absolute epoch
 * milliseconds, because every scheduler works in numbers internally.
 */
export interface BreakWindow {
  start: number;
  end: number;
}

/**
 * Normalises configured breaks into sorted, merged windows.
 *
 * Merging matters because two touching breaks would otherwise need two passes to
 * step over, and an overlapping pair could leave a match starting inside one.
 * Breaks beginning after the day's planned end are dropped: matches are allowed
 * to overrun the plan, so a break past the end would only delay work needlessly.
 */
export function normalizeBreaks(
  breaks: readonly BreakWindow[] | undefined,
  planningEnd: number,
): BreakWindow[] {
  const usable = (breaks ?? [])
    .filter((brk) => Number.isFinite(brk.start) && Number.isFinite(brk.end) && brk.end > brk.start)
    .filter((brk) => brk.start < planningEnd)
    .sort((a, b) => a.start - b.start);

  const merged: BreakWindow[] = [];
  for (const brk of usable) {
    const last = merged[merged.length - 1];
    if (last && brk.start <= last.end) {
      last.end = Math.max(last.end, brk.end);
    } else {
      merged.push({ start: brk.start, end: brk.end });
    }
  }
  return merged;
}

/**
 * Pushes a start time forward until a match of `durationMs` no longer overlaps a
 * break. A match cannot be paused part-way, so one that would straddle a break
 * moves wholly after it.
 *
 * Looping because clearing one break can land inside the next. The bound is the
 * break count because each pass clears at least one and never moves backwards.
 */
export function startAfterBreaks(
  start: number,
  durationMs: number,
  breaks: readonly BreakWindow[],
): number {
  let time = start;
  for (let pass = 0; pass <= breaks.length; pass++) {
    const overlapping = breaks.find((brk) => time < brk.end && time + durationMs > brk.start);
    if (!overlapping) return time;
    time = overlapping.end;
  }
  return time;
}

export interface ScheduledSlot {
  matchId: string;
  courtId: string;
  courtNumber: number;
  start: Date;
  end: Date;
  categoryId: string;
  overrun: boolean;
}

export interface ScheduleResult {
  slots: ScheduledSlot[];
  unscheduled: string[];
  utilization: number;
  overrun: boolean;
  projectedFinish: Date | null;
  overrunMinutes: number;
}

const MINUTE = 60_000;

export function scheduleMatches(
  matches: SchedulableMatch[],
  options: SchedulerOptions,
): ScheduleResult {
  const { dayStart, planningEnd, courts, slotMinutes, restGapMinutes } = options;
  if (!courts.length) throw new Error("No courts are available to schedule.");
  const slotMs = slotMinutes * MINUTE;
  const breakWindows = normalizeBreaks(options.breaks, planningEnd.getTime());
  const hardEnd = options.hardEnd?.getTime() ?? null;
  const courtIds = [...courts].sort((a, b) => a.number - b.number);
  const courtFreeAt = new Map<string, number>(courtIds.map((c) => [c.id, dayStart.getTime()]));
  const playerFreeAt = new Map<string, number>();
  const slots: ScheduledSlot[] = [];
  const unscheduled: string[] = [];
  // Fresh (non-fixed) matches start no earlier than `options.floor` (day one's opening
  // time on a first build, the current minute on a rebuild) or than the earliest free
  // court/player, whichever is later. Matches already in progress or reported are
  // handled as "fixed" below and push courtFreeAt/playerFreeAt forward from their real
  // end times.
  const floor = (options.floor ?? dayStart).getTime();

  const fixed = matches.filter((m) => m.fixed && m.start != null && m.end != null);
  for (const match of fixed) {
    if (match.start == null || match.end == null) continue;
    // A court the day is not playing on cannot host anything new, so its busy window
    // has nothing to guard — but a match played on it still used its players, so
    // their rest is recorded either way. A match with no court at all (reported
    // before it was ever laid out) is the same case with no court to guard.
    const court =
      match.courtNumber == null ? undefined : courtIds.find((c) => c.number === match.courtNumber);
    if (court) {
      const current = courtFreeAt.get(court.id) ?? dayStart.getTime();
      courtFreeAt.set(court.id, Math.max(current, match.end));
    }
    for (const playerId of match.playerIds) {
      playerFreeAt.set(
        playerId,
        Math.max(playerFreeAt.get(playerId) ?? 0, match.end + restGapMinutes * MINUTE),
      );
    }
    if (!court) continue;
    slots.push({
      matchId: match.id,
      courtId: court.id,
      courtNumber: court.number,
      start: new Date(match.start),
      end: new Date(match.end),
      categoryId: match.categoryId,
      overrun: match.end > planningEnd.getTime(),
    });
  }

  const pending = matches.filter((m) => !m.fixed);
  const grouped = new Map<string, SchedulableMatch[]>();
  for (const match of pending) {
    const list = grouped.get(match.categoryId) ?? [];
    list.push(match);
    grouped.set(match.categoryId, list);
  }

  const categories = [...grouped.entries()].sort((a, b) => {
    const ao = a[1][0]?.categoryOrder ?? 0;
    const bo = b[1][0]?.categoryOrder ?? 0;
    if (ao !== bo) return ao - bo;
    return a[0].localeCompare(b[0]);
  });

  for (const [, catMatches] of categories) {
    const ordered = [...catMatches].sort(
      (a, b) => a.order - b.order || (a.poolId ?? "").localeCompare(b.poolId ?? ""),
    );
    for (const match of ordered) {
      if (!match.playerIds.length) {
        unscheduled.push(match.id);
        continue;
      }
      let best: { court: (typeof courtIds)[number]; start: number } | null = null;
      for (const court of courtIds) {
        let start = Math.max(
          courtFreeAt.get(court.id) ?? dayStart.getTime(),
          floor,
          match.earliestStart ?? 0,
        );
        for (const playerId of match.playerIds) {
          const free = playerFreeAt.get(playerId);
          if (free != null && free > start) start = free;
        }
        // A match cannot be paused part-way, so one that would straddle a break
        // moves wholly after it rather than being split.
        start = startAfterBreaks(start, slotMs, breakWindows);
        if (!best || start < best.start) best = { court, start };
      }
      if (!best) {
        unscheduled.push(match.id);
        continue;
      }
      const end = best.start + slotMs;
      // Past the hard end the day is full. The match is deferred, not blocked: the
      // caller decides whether another day can take it.
      if (hardEnd != null && end > hardEnd) {
        unscheduled.push(match.id);
        continue;
      }
      courtFreeAt.set(best.court.id, end);
      for (const playerId of match.playerIds) {
        playerFreeAt.set(playerId, end + restGapMinutes * MINUTE);
      }
      slots.push({
        matchId: match.id,
        courtId: best.court.id,
        courtNumber: best.court.number,
        start: new Date(best.start),
        end: new Date(end),
        categoryId: match.categoryId,
        overrun: end > planningEnd.getTime(),
      });
    }
  }

  const windowMinutes = ((planningEnd.getTime() - dayStart.getTime()) / MINUTE) * courtIds.length;
  const usedMinutes = slots.length * slotMinutes;
  const last = slots.reduce<number | null>(
    (acc, slot) => Math.max(acc ?? 0, slot.end.getTime()),
    null,
  );
  return {
    slots: slots.sort(
      (a, b) => a.start.getTime() - b.start.getTime() || a.courtNumber - b.courtNumber,
    ),
    unscheduled,
    utilization: windowMinutes > 0 ? usedMinutes / windowMinutes : 0,
    overrun: slots.some((s) => s.overrun) || unscheduled.length > 0,
    projectedFinish: last != null ? new Date(last) : null,
    overrunMinutes:
      last != null ? Math.max(0, Math.round((last - planningEnd.getTime()) / MINUTE)) : 0,
  };
}

export function restGapForKind(
  kind: "group" | "knockout",
  groupMinutes: number,
  knockoutMinutes: number,
): number {
  return kind === "group" ? groupMinutes : knockoutMinutes;
}

/** A match, reduced to just what's needed to check start-time constraints for another match. */
export interface StartCheckMatch {
  id: string;
  playerIds: string[];
  status: string;
  courtNumber?: number | null;
  /** When the match actually finished (report/walkover time), if it has. */
  endedAt?: string | null;
}

export interface StartConflict {
  playerId: string;
  /** The other match the player is currently on court for. */
  matchId: string;
  courtNumber?: number | null;
}

export interface StartRestWarning {
  playerId: string;
  /** The player's most recently finished match. */
  matchId: string;
  restMinutes: number;
  requiredMinutes: number;
}

export interface StartConstraints {
  /** Hard blockers — a player physically cannot start this match right now. */
  conflicts: StartConflict[];
  /** Soft warnings — starting is allowed, but a player hasn't had the configured rest gap. */
  warnings: StartRestWarning[];
}

/**
 * Checks whether a match is safe to start right now, given every other match's live state.
 * - `conflicts`: a player in this match is `in-progress` elsewhere — should block starting.
 * - `warnings`: a player's most recently finished match ended too recently — desk can override.
 */
export function checkStartConstraints(
  targetPlayerIds: string[],
  requiredRestMinutes: number,
  others: StartCheckMatch[],
  now: number = Date.now(),
): StartConstraints {
  const conflicts: StartConflict[] = [];
  const warnings: StartRestWarning[] = [];

  for (const playerId of targetPlayerIds) {
    const inProgress = others.find(
      (m) => m.status === "in-progress" && m.playerIds.includes(playerId),
    );
    if (inProgress) {
      conflicts.push({
        playerId,
        matchId: inProgress.id,
        courtNumber: inProgress.courtNumber ?? null,
      });
      continue; // a hard conflict makes the rest gap moot for this player
    }

    const lastFinished = others
      .filter((m) => m.endedAt && m.playerIds.includes(playerId))
      .sort(
        (a, b) => new Date(b.endedAt as string).getTime() - new Date(a.endedAt as string).getTime(),
      )[0];
    if (lastFinished?.endedAt) {
      const restMinutes = Math.floor((now - new Date(lastFinished.endedAt).getTime()) / MINUTE);
      if (restMinutes < requiredRestMinutes) {
        warnings.push({
          playerId,
          matchId: lastFinished.id,
          restMinutes: Math.max(restMinutes, 0),
          requiredMinutes: requiredRestMinutes,
        });
      }
    }
  }

  return { conflicts, warnings };
}
