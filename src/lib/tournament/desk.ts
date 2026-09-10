const MINUTE = 60_000;

export type DeskMatchKind = "pool" | "draw";

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
  state: "playing" | "overrun" | "free-ready" | "free-blocked" | "idle";
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
          other.id !== match.id &&
          other.endedAt != null &&
          other.playerIds.includes(playerId),
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
    allMatches.find((match) => match.courtId === courtId && match.status === "in-progress") ??
    null;
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
        elapsedMinutes != null && elapsedMinutes > slotMinutesFor(playing)
          ? "overrun"
          : "playing",
      playing,
      next,
      readiness: next
        ? getMatchReadiness(next, allMatches, restGapFor(next), now)
        : null,
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

export function getOperationalKpis<TMatch extends DeskMatchModel>(
  courtStates: DeskCourtState<TMatch>[],
  matches: TMatch[],
  slotMinutesFor: (match: TMatch) => number,
): OperationalKpis {
  const scheduled = matches.filter(
    (match) => match.status === "scheduled" && asTime(match.scheduled) != null,
  );
  const projectedFinish = scheduled.reduce<number | null>((latest, match) => {
    const start = asTime(match.scheduled);
    if (start == null) return latest;
    const finish = start + slotMinutesFor(match) * MINUTE;
    return Math.max(latest ?? finish, finish);
  }, null);

  return {
    activeCourts: courtStates.filter(
      (court) => court.state === "playing" || court.state === "overrun",
    ).length,
    waitingCourts: courtStates.filter((court) => court.state === "free-blocked").length,
    idleCourts: courtStates.filter((court) => court.state === "idle").length,
    completedMatches: matches.filter((match) =>
      ["reported", "walkover"].includes(match.status),
    ).length,
    remainingMatches: matches.filter((match) =>
      ["scheduled", "in-progress"].includes(match.status),
    ).length,
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
      return (
        match.status === "scheduled" &&
        scheduled != null &&
        scheduled <= horizon
      );
    })
    .sort((a, b) => (asTime(a.scheduled) ?? 0) - (asTime(b.scheduled) ?? 0));
}
