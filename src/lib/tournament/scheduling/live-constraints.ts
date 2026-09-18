/**
 * Live start-time constraints for the desk.
 *
 * These are deliberately *not* part of the core: they answer "can this match start right now,
 * given what is physically happening", while the core answers "where does this match belong in a
 * plan". Keeping them here stops the core from needing live match status.
 */

const MINUTE = 60_000;

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

/** Which configured rest gap a match kind uses. */
export function restGapForKind(
  kind: "group" | "knockout",
  groupMinutes: number,
  knockoutMinutes: number,
): number {
  return kind === "group" ? groupMinutes : knockoutMinutes;
}
