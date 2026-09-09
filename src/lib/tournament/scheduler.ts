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
  now?: Date;
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

export interface RestGapViolation {
  playerId: string;
  matchA: string;
  matchB: string;
  gapMinutes: number;
}

const MINUTE = 60_000;

export function scheduleMatches(matches: SchedulableMatch[], options: SchedulerOptions): ScheduleResult {
  const { dayStart, planningEnd, courts, slotMinutes, restGapMinutes, now } = options;
  if (!courts.length) throw new Error("No courts are available to schedule.");
  const courtIds = [...courts].sort((a, b) => a.number - b.number);
  const courtFreeAt = new Map<string, number>(courtIds.map((c) => [c.id, dayStart.getTime()]));
  const playerFreeAt = new Map<string, number>();
  const slots: ScheduledSlot[] = [];
  const unscheduled: string[] = [];
  const floor = Math.max(dayStart.getTime(), now?.getTime() ?? dayStart.getTime());

  const fixed = matches.filter((m) => m.fixed && m.start != null && m.end != null && m.courtNumber != null);
  for (const match of fixed) {
    const court = courtIds.find((c) => c.number === match.courtNumber);
    if (!court || match.start == null || match.end == null) continue;
    const current = courtFreeAt.get(court.id) ?? dayStart.getTime();
    courtFreeAt.set(court.id, Math.max(current, match.end));
    for (const playerId of match.playerIds) {
      playerFreeAt.set(playerId, Math.max(playerFreeAt.get(playerId) ?? 0, match.end + restGapMinutes * MINUTE));
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
    const ordered = [...catMatches].sort((a, b) => a.order - b.order || (a.poolId ?? "").localeCompare(b.poolId ?? ""));
    for (const match of ordered) {
      if (!match.playerIds.length) {
        unscheduled.push(match.id);
        continue;
      }
      let best: { court: (typeof courtIds)[number]; start: number } | null = null;
      for (const court of courtIds) {
        let start = Math.max(courtFreeAt.get(court.id) ?? dayStart.getTime(), floor, match.earliestStart ?? 0);
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
  const last = slots.reduce<number | null>((acc, slot) => Math.max(acc ?? 0, slot.end.getTime()), null);
  return {
    slots: slots.sort((a, b) => a.start.getTime() - b.start.getTime() || a.courtNumber - b.courtNumber),
    unscheduled,
    utilization: windowMinutes > 0 ? usedMinutes / windowMinutes : 0,
    overrun: slots.some((s) => s.overrun) || unscheduled.length > 0,
    projectedFinish: last != null ? new Date(last) : null,
    overrunMinutes: last != null ? Math.max(0, Math.round((last - planningEnd.getTime()) / MINUTE)) : 0,
  };
}

export function findRestGapViolations(
  entries: { matchId: string; playerIds: string[]; start: Date; end: Date }[],
  restGapMinutes: number,
): RestGapViolation[] {
  const byPlayer = new Map<string, typeof entries>();
  for (const entry of entries) {
    for (const playerId of entry.playerIds) {
      const list = byPlayer.get(playerId) ?? [];
      list.push(entry);
      byPlayer.set(playerId, list);
    }
  }

  const violations: RestGapViolation[] = [];
  for (const [playerId, list] of byPlayer) {
    const sorted = [...list].sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      const gap = (curr.start.getTime() - prev.end.getTime()) / MINUTE;
      if (gap < restGapMinutes) {
        violations.push({
          playerId,
          matchA: prev.matchId,
          matchB: curr.matchId,
          gapMinutes: Math.round(gap),
        });
      }
    }
  }
  return violations;
}

export function restGapForKind(kind: "group" | "knockout", groupMinutes: number, knockoutMinutes: number): number {
  return kind === "group" ? groupMinutes : knockoutMinutes;
}
