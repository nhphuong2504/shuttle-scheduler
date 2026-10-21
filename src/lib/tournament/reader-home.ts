import { normalizeTournamentStatus } from "@/lib/auth/authorization";

/**
 * Where a reader opens a tournament: the roster before it starts, the scores once it has.
 *
 * A reader comes to find a match and see its score. Before the first match there are no
 * scores, so the question is who is playing and Entries answers it; from the first started
 * match on, Scores does - its search finds a player's matches and their results. The stored
 * status decides, not the clock: it moves when a match starts or the host completes the
 * tournament, so the answer is the same on the server and in the browser.
 *
 * The Explore cards and the logo both read this, so the two ways into a tournament agree.
 */
export const READER_HOME_ENTRIES = "/tournaments/$tournamentId/entries" as const;
export const READER_HOME_SCORES = "/tournaments/$tournamentId/scores" as const;

export type ReaderHome = typeof READER_HOME_ENTRIES | typeof READER_HOME_SCORES;

export function readerHomeFor(status: unknown): ReaderHome {
  return normalizeTournamentStatus(status) === "upcoming" ? READER_HOME_ENTRIES : READER_HOME_SCORES;
}
