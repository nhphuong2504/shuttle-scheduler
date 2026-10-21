import type { GameScore } from "@/lib/tournament/format";

/**
 * Which side a reported score says won, for marking it in a list.
 *
 * This reads the result, it does not judge it: the score was already accepted against the
 * match's rule when it was reported, so the side that took more games won. A tie - no games,
 * or a score that does not decide - marks nobody rather than guessing.
 */
export function sideThatWon(games: readonly GameScore[] | null | undefined): "a" | "b" | null {
  if (!games?.length) return null;
  let a = 0;
  let b = 0;
  for (const game of games) {
    if (game.a > game.b) a++;
    else if (game.b > game.a) b++;
  }
  return a === b ? null : a > b ? "a" : "b";
}
