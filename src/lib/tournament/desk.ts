import type { CourtState } from "@/lib/tournament/court-state";

const MINUTE = 60_000;

/**
 * Which family a desk match belongs to.
 *
 * `pool` and `draw` are the round-robin format. `placement` is a two-round
 * placement match (round one or round two) and `tier` is an A/B/C/D bracket match.
 * They are separate members rather than being folded into the existing two because
 * the two formats keep separate tables, separate RPCs and separate scoring rules —
 * a desk card has to know which of those to reach for.
 */
export type DeskMatchKind = "pool" | "draw" | "placement" | "tier";

/**
 * Which configured timings a match is measured with.
 *
 * The placement rounds are played at the group pace and the tier brackets at the
 * knockout pace, which is exactly how the placement scheduler lays them out. This
 * is the single place that mapping lives, so the court board, the overrun alert and
 * the start check cannot disagree about it.
 */
export type DeskPhase = "group" | "knockout";

export function deskKindPhase(kind: DeskMatchKind): DeskPhase {
  return kind === "pool" || kind === "placement" ? "group" : "knockout";
}

/** The database table behind a desk match, for the table-scoped RPCs. */
export function deskKindTable(kind: DeskMatchKind): string {
  switch (kind) {
    case "pool":
      return "pool_matches";
    case "draw":
      return "draw_matches";
    case "placement":
      return "placement_matches";
    case "tier":
      return "tier_draw_matches";
  }
}

/** True for the two kinds that belong to the two-round placement format. */
export function isPlacementKind(kind: DeskMatchKind): boolean {
  return kind === "placement" || kind === "tier";
}

/**
 * Which configured scoring rule a kind is played under.
 *
 * `legacy` is the round-robin pool rule: a single game to 21, enforced by
 * `report_pool_result`, which has no equivalent in the placement format. The
 * placement rounds and the brackets each read their own tournament settings, so a
 * placement match can be best of three while a pool match cannot.
 */
export type DeskScoringStage = "legacy" | "placement" | "knockout";

export function deskKindScoringStage(kind: DeskMatchKind): DeskScoringStage {
  if (kind === "pool") return "legacy";
  return kind === "placement" ? "placement" : "knockout";
}

export interface DeskMatchModel {
  id: string;
  kind: DeskMatchKind;
  courtId: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  scheduled: string | null;
  playerIds: string[];
}

export interface MatchReadiness {
  state: "ready" | "resting" | "player-busy" | "teams-missing";
  readyAt: number | null;
  playerId: string | null;
  blockingMatchId: string | null;
  blockingCourtId: string | null;
  remainingMinutes: number;
}

export interface DeskCourtState<TMatch extends DeskMatchModel = DeskMatchModel> {
  courtId: string;
  /**
   * Imported from `court-state.ts` rather than restated.
   *
   * The union used to be written out here and again in the pill that drew it and
   * again in the tile's ternary chain - three copies of a five-value set, none of
   * which could notice the others changing. The vocabulary now has one definition
   * and this is a consumer of it, so a sixth state cannot be derived without
   * gaining a label and a token treatment.
   */
  state: CourtState;
  playing: TMatch | null;
  next: TMatch | null;
  readiness: MatchReadiness | null;
  elapsedMinutes: number | null;
  varianceMinutes: number | null;
}

export interface OperationalKpis {
  activeCourts: number;
  waitingCourts: number;
  idleCourts: number;
  completedMatches: number;
  remainingMatches: number;
  overrunCourts: number;
  projectedFinish: number | null;
}

function asTime(value: string | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function scheduleVarianceMinutes(match: DeskMatchModel): number | null {
  const scheduled = asTime(match.scheduled);
  const started = asTime(match.startedAt);
  if (scheduled == null || started == null) return null;
  return Math.round((started - scheduled) / MINUTE);
}

export function getMatchReadiness(
  match: DeskMatchModel,
  allMatches: DeskMatchModel[],
  restGapMinutes: number,
  now: number,
): MatchReadiness {
  if (!match.playerIds.length) {
    return {
      state: "teams-missing",
      readyAt: null,
      playerId: null,
      blockingMatchId: null,
      blockingCourtId: null,
      remainingMinutes: 0,
    };
  }

  for (const playerId of match.playerIds) {
    const conflict = allMatches.find(
      (other) =>
        other.id !== match.id &&
        other.status === "in-progress" &&
        other.playerIds.includes(playerId),
    );
    if (conflict) {
      return {
        state: "player-busy",
        readyAt: null,
        playerId,
        blockingMatchId: conflict.id,
        blockingCourtId: conflict.courtId,
        remainingMinutes: 0,
      };
    }
  }

  let latestReadyAt = 0;
  let restingPlayer: string | null = null;
  let previousMatchId: string | null = null;
  for (const playerId of match.playerIds) {
    const latest = allMatches
      .filter(
        (other) =>
          other.id !== match.id && other.endedAt != null && other.playerIds.includes(playerId),
      )
      .sort((a, b) => (asTime(b.endedAt) ?? 0) - (asTime(a.endedAt) ?? 0))[0];
    const ended = asTime(latest?.endedAt ?? null);
    if (ended == null) continue;
    const readyAt = ended + restGapMinutes * MINUTE;
    if (readyAt > latestReadyAt) {
      latestReadyAt = readyAt;
      restingPlayer = playerId;
      previousMatchId = latest?.id ?? null;
    }
  }

  if (latestReadyAt > now) {
    return {
      state: "resting",
      readyAt: latestReadyAt,
      playerId: restingPlayer,
      blockingMatchId: previousMatchId,
      blockingCourtId: null,
      remainingMinutes: Math.max(1, Math.ceil((latestReadyAt - now) / MINUTE)),
    };
  }

  return {
    state: "ready",
    readyAt: Math.max(latestReadyAt, now),
    playerId: null,
    blockingMatchId: null,
    blockingCourtId: null,
    remainingMinutes: 0,
  };
}

export function deriveCourtState<TMatch extends DeskMatchModel>(
  courtId: string,
  allMatches: TMatch[],
  slotMinutesFor: (match: TMatch) => number,
  restGapFor: (match: TMatch) => number,
  now: number,
): DeskCourtState<TMatch> {
  const playing =
    allMatches.find((match) => match.courtId === courtId && match.status === "in-progress") ?? null;
  const next =
    allMatches
      .filter(
        (match) =>
          match.courtId === courtId &&
          match.status === "scheduled" &&
          asTime(match.scheduled) != null,
      )
      .sort((a, b) => (asTime(a.scheduled) ?? 0) - (asTime(b.scheduled) ?? 0))[0] ?? null;

  if (playing) {
    const started = asTime(playing.startedAt);
    const elapsedMinutes =
      started == null ? null : Math.max(0, Math.floor((now - started) / MINUTE));
    return {
      courtId,
      state:
        elapsedMinutes != null && elapsedMinutes > slotMinutesFor(playing) ? "overrun" : "playing",
      playing,
      next,
      readiness: next ? getMatchReadiness(next, allMatches, restGapFor(next), now) : null,
      elapsedMinutes,
      varianceMinutes: scheduleVarianceMinutes(playing),
    };
  }

  if (!next) {
    return {
      courtId,
      state: "idle",
      playing: null,
      next: null,
      readiness: null,
      elapsedMinutes: null,
      varianceMinutes: null,
    };
  }

  const readiness = getMatchReadiness(next, allMatches, restGapFor(next), now);
  return {
    courtId,
    state: readiness.state === "ready" ? "free-ready" : "free-blocked",
    playing: null,
    next,
    readiness,
    elapsedMinutes: null,
    varianceMinutes: null,
  };
}

export function projectedFinishFromRemaining<TMatch extends DeskMatchModel>(
  matches: TMatch[],
  slotMinutesFor: (match: TMatch) => number,
  now: number,
): number | null {
  let latest: number | null = null;
  for (const match of matches) {
    if (match.status !== "scheduled" && match.status !== "in-progress") continue;
    const slotMs = slotMinutesFor(match) * MINUTE;
    let start: number | null = null;
    if (match.status === "in-progress") {
      const anchor = asTime(match.startedAt) ?? asTime(match.scheduled);
      start = anchor != null ? Math.max(anchor, now) : now;
    } else {
      start = asTime(match.scheduled);
    }
    if (start == null) continue;
    const end = start + slotMs;
    latest = latest == null ? end : Math.max(latest, end);
  }
  return latest;
}

export function finishStatusLabel(projectedMs: number | null, targetMs: number | null): string {
  if (projectedMs == null || targetMs == null) return "—";
  const deltaMinutes = Math.round((projectedMs - targetMs) / MINUTE);
  if (deltaMinutes === 0) return "On target";
  if (deltaMinutes > 0) return `${deltaMinutes} min behind`;
  return `${Math.abs(deltaMinutes)} min ahead`;
}

export function getOperationalKpis<TMatch extends DeskMatchModel>(
  courtStates: DeskCourtState<TMatch>[],
  matches: TMatch[],
  slotMinutesFor: (match: TMatch) => number,
  now: number = Date.now(),
  /**
   * The tournament-wide forecast from the finish estimator, when one is available.
   *
   * `undefined` keeps the legacy behaviour: the latest end among matches that already have a
   * time, which is a floor because an unplaced match cannot move it. `null` means the estimator
   * could not name a finish at all, and is passed through as such rather than falling back to a
   * floor that would read as "on target" for a tournament that cannot finish.
   */
  estimatedFinishMs?: number | null,
): OperationalKpis {
  const projectedFinish =
    estimatedFinishMs === undefined
      ? projectedFinishFromRemaining(matches, slotMinutesFor, now)
      : estimatedFinishMs;

  return {
    activeCourts: courtStates.filter(
      (court) => court.state === "playing" || court.state === "overrun",
    ).length,
    waitingCourts: courtStates.filter((court) => court.state === "free-blocked").length,
    idleCourts: courtStates.filter((court) => court.state === "idle").length,
    completedMatches: matches.filter((match) => ["reported", "walkover"].includes(match.status))
      .length,
    remainingMatches: matches.filter((match) => ["scheduled", "in-progress"].includes(match.status))
      .length,
    overrunCourts: courtStates.filter((court) => court.state === "overrun").length,
    projectedFinish,
  };
}

export function upcomingMatches<TMatch extends DeskMatchModel>(
  matches: TMatch[],
  now: number,
  horizonMinutes = 60,
): TMatch[] {
  const horizon = now + horizonMinutes * MINUTE;
  return matches
    .filter((match) => {
      const scheduled = asTime(match.scheduled);
      return match.status === "scheduled" && scheduled != null && scheduled <= horizon;
    })
    .sort((a, b) => (asTime(a.scheduled) ?? 0) - (asTime(b.scheduled) ?? 0));
}
