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
  const courtIds = [...courts].sort((a, b) => a.number - b.number);
  const courtFreeAt = new Map<string, number>(courtIds.map((c) => [c.id, dayStart.getTime()]));
  const playerFreeAt = new Map<string, number>();
  const slots: ScheduledSlot[] = [];
  const unscheduled: string[] = [];
  // Fresh (non-fixed) matches always start from the chosen day-start time, never from
  // the current wall-clock time — the tournament start time picked by the desk is
  // authoritative. Matches already in progress/reported are handled as "fixed" below
  // and naturally push courtFreeAt/playerFreeAt forward from their real end times.
  const floor = dayStart.getTime();

  const fixed = matches.filter(
    (m) => m.fixed && m.start != null && m.end != null && m.courtNumber != null,
  );
  for (const match of fixed) {
    const court = courtIds.find((c) => c.number === match.courtNumber);
    if (!court || match.start == null || match.end == null) continue;
    const current = courtFreeAt.get(court.id) ?? dayStart.getTime();
    courtFreeAt.set(court.id, Math.max(current, match.end));
    for (const playerId of match.playerIds) {
      playerFreeAt.set(
        playerId,
        Math.max(playerFreeAt.get(playerId) ?? 0, match.end + restGapMinutes * MINUTE),
      );
    }
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
        if (!best || start < best.start) best = { court, start };
      }
      if (!best) {
        unscheduled.push(match.id);
        continue;
      }
      const end = best.start + slotMinutes * MINUTE;
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
