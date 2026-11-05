import { normalizeTournamentStatus } from "@/lib/auth/authorization";

/**
 * Where a reader opens a tournament: the players before it starts, the hall once it has.
 *
 * Before the first match nothing is on court, so the question is who is playing and Players
 * answers it - and is where a player picks themself to follow. From the first started match
 * on, Now does: what is on court, what is next, what just finished, and the results once the
 * tournament is complete. The stored status decides, not the clock: it moves when a match
 * starts or the host completes the tournament, so the answer is the same on the server and in
 * the browser.
 *
 * The Explore cards and the logo both read this, so the two ways into a tournament agree.
 */
export const READER_HOME_PLAYERS = "/tournaments/$tournamentId/players" as const;
export const READER_HOME_NOW = "/tournaments/$tournamentId/now" as const;

export type ReaderHome = typeof READER_HOME_PLAYERS | typeof READER_HOME_NOW;

export function readerHomeFor(status: unknown): ReaderHome {
  return normalizeTournamentStatus(status) === "upcoming" ? READER_HOME_PLAYERS : READER_HOME_NOW;
}

export const OPERATOR_HOME = "/tournaments/$tournamentId/desk" as const;

/**
 * Where a card opens a tournament for this caller: the reader's home, or the Desk for anyone
 * who may operate it - the same split the workspace logo makes, so an operator who opened a
 * card lands on a page their own nav names.
 */
export function tournamentHomeFor(summary: {
  status: unknown;
  access_level: string | null | undefined;
}): ReaderHome | typeof OPERATOR_HOME {
  return summary.access_level && summary.access_level !== "viewer"
    ? OPERATOR_HOME
    : readerHomeFor(summary.status);
}
