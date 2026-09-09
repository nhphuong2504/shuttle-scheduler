/**
 * Court/time scheduling with a hard 30-minute rest gap per player,
 * a day-1 groups / day-2 knockouts split, and per-category court blocks
 * so all pools in a category finish around the same time.
 */

export interface SchedulableMatch {
  id: string;
  categoryId: string;
  /** every player involved, both halves of a doubles pair */
  playerIds: string[];
  kind: "group" | "knockout";
  /** used to keep pool rounds in order */
  order: number;
}

export interface SchedulerOptions {
  dayStart: Date;
  dayEnd: Date;
  courtCount: number;
  slotMinutes: number;
  restGapMinutes: number;
}

export interface ScheduledSlot {
  matchId: string;
  courtNumber: number;
  start: Date;
  end: Date;
  categoryId: string;
  /** true when the match had to be placed after the planned day end */
  overrun: boolean;
}

export interface ScheduleResult {
  slots: ScheduledSlot[];
  unscheduled: string[];
  utilization: number;
  overrun: boolean;
}

const MINUTE = 60_000;

export function scheduleMatches(matches: SchedulableMatch[], options: SchedulerOptions): ScheduleResult {
  const { dayStart, dayEnd, courtCount, slotMinutes, restGapMinutes } = options;
  const courtFreeAt: number[] = Array.from({ length: courtCount }, () => dayStart.getTime());
  const playerFreeAt = new Map<string, number>();
  const slots: ScheduledSlot[] = [];
  const unscheduled: string[] = [];

  // Group matches by category so a category's pools run in parallel blocks.
  const ordered = [...matches].sort((a, b) => {
    if (a.categoryId !== b.categoryId) return a.categoryId.localeCompare(b.categoryId);
    return a.order - b.order;
  });

  const horizon = dayEnd.getTime() + 4 * 60 * MINUTE; // allow overrun placement, but flag it

  for (const match of ordered) {
    let best: { court: number; start: number } | null = null;

    for (let court = 0; court < courtCount; court++) {
      let start = courtFreeAt[court];
      for (const playerId of match.playerIds) {
        const free = playerFreeAt.get(playerId);
        if (free != null && free > start) start = free;
      }
      if (start + slotMinutes * MINUTE > horizon) continue;
      if (!best || start < best.start) best = { court, start };
    }

    if (!best) {
      unscheduled.push(match.id);
      continue;
    }

    const end = best.start + slotMinutes * MINUTE;
    courtFreeAt[best.court] = end;
    for (const playerId of match.playerIds) {
      playerFreeAt.set(playerId, end + restGapMinutes * MINUTE);
    }
    slots.push({
      matchId: match.id,
      courtNumber: best.court + 1,
      start: new Date(best.start),
      end: new Date(end),
      categoryId: match.categoryId,
      overrun: end > dayEnd.getTime(),
    });
  }

  const totalCourtMinutes = ((dayEnd.getTime() - dayStart.getTime()) / MINUTE) * courtCount;
  const usedMinutes = slots.length * slotMinutes;
  return {
    slots: slots.sort((a, b) => a.start.getTime() - b.start.getTime()),
    unscheduled,
    utilization: totalCourtMinutes > 0 ? usedMinutes / totalCourtMinutes : 0,
    overrun: slots.some((s) => s.overrun) || unscheduled.length > 0,
  };
}

export interface RestGapViolation {
  playerId: string;
  matchA: string;
  matchB: string;
  gapMinutes: number;
}

/** Re-checks an existing (possibly hand-edited) schedule for rest-gap breaches. */
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
      const gap = (sorted[i].start.getTime() - sorted[i - 1].end.getTime()) / MINUTE;
      if (gap < restGapMinutes) {
        violations.push({
          playerId,
          matchA: sorted[i - 1].matchId,
          matchB: sorted[i].matchId,
          gapMinutes: Math.round(gap),
        });
      }
    }
  }
  return violations;
}
