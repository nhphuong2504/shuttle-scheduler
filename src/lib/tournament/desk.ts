import type { CourtState } from "@/lib/tournament/court-state";
import { inProgressEnd } from "@/lib/tournament/in-progress";

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

/**
 * The match a player is on court in right now, other than `matchId`, if any.
 *
 * One of the two per-player facts behind readiness. The tile's readiness line and the
 * call dialog's player rows both read it, so the two cannot name a different reason.
 */
export function playerOnCourt<TMatch extends DeskMatchModel>(
  playerId: string,
  matchId: string,
  allMatches: readonly TMatch[],
): TMatch | null {
  return (
    allMatches.find(
      (other) =>
        other.id !== matchId && other.status === "in-progress" && other.playerIds.includes(playerId),
    ) ?? null
  );
}

/**
 * When a player's rest after their latest finished match ends, and which match that was.
 * Null when they have finished nothing else, so they have nothing to rest from.
 */
export function playerRestEnd(
  playerId: string,
  matchId: string,
  allMatches: readonly DeskMatchModel[],
  restGapMinutes: number,
): { readyAt: number; matchId: string } | null {
  const latest = allMatches
    .filter(
      (other) => other.id !== matchId && other.endedAt != null && other.playerIds.includes(playerId),
    )
    .sort((a, b) => (asTime(b.endedAt) ?? 0) - (asTime(a.endedAt) ?? 0))[0];
  const ended = asTime(latest?.endedAt ?? null);
  if (latest == null || ended == null) return null;
  return { readyAt: ended + restGapMinutes * MINUTE, matchId: latest.id };
}

/** Where one player of a queued match stands right now. */
export type PlayerStatus =
  | { kind: "on-court"; matchId: string; courtId: string | null }
  | { kind: "resting"; readyAt: number }
  | { kind: "free" };

/**
 * Every player's own answer to "can they play now", in the order readiness asks it: on
 * court elsewhere first, then resting. `getMatchReadiness` reports only the first player
 * in the way; this reports each of them.
 */
export function playerStatus(
  playerId: string,
  match: DeskMatchModel,
  allMatches: readonly DeskMatchModel[],
  restGapMinutes: number,
  now: number,
): PlayerStatus {
  const onCourt = playerOnCourt(playerId, match.id, allMatches);
  if (onCourt) return { kind: "on-court", matchId: onCourt.id, courtId: onCourt.courtId };
  const rest = playerRestEnd(playerId, match.id, allMatches, restGapMinutes);
  if (rest && rest.readyAt > now) return { kind: "resting", readyAt: rest.readyAt };
  return { kind: "free" };
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
    const conflict = playerOnCourt(playerId, match.id, allMatches);
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
    const rest = playerRestEnd(playerId, match.id, allMatches, restGapMinutes);
    if (rest && rest.readyAt > latestReadyAt) {
      latestReadyAt = rest.readyAt;
      restingPlayer = playerId;
      previousMatchId = rest.matchId;
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
    let end: number | null = null;
    if (match.status === "in-progress") {
      // The same model the planner and the database use: its slot, and no earlier than now once it overruns.
      const anchor = asTime(match.startedAt) ?? asTime(match.scheduled);
      end = inProgressEnd({ start: anchor ?? now, slotMs, now });
    } else {
      start = asTime(match.scheduled);
      end = start == null ? null : start + slotMs;
    }
    if (end == null) continue;
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
