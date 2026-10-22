-- A game ends on the point it is won, so its margin is exact.
--
-- WHAT WAS WRONG
--
-- The predicate knew a floor and a margin: the winner reached `games_to` and led by at least
-- `win_by`. "At least" is the bug. A game stops the instant it is won, so a score that was
-- already over is not a score: `25-10` was stored, though the game ended at 21-10; `24-21`
-- was stored, though it ended at 23-21. Nothing about the desk made those reachable - they
-- are what a fumbled keystroke or a misread pad produces - and storing one corrupts the
-- standings, the head-to-head and every later placement that reads the result.
--
-- WHAT LEGAL NOW MEANS
--
-- With `high` and `low` the two sides:
--
--   * `high = games_to` and `low <= games_to - win_by` - the winner stopped at the target,
--     which is only possible when the loser never reached deuce;
--   * `win_by > 1`, `high > games_to`, `high - low = win_by` - past the target the game ended
--     on the exact point that opened the margin, so 22-20 and 29-27 are games and 25-10 is
--     not;
--   * the cap: `high = cap` and `low = cap - 1` - 29-29 is deuce, and 30-29 is how a 21-point
--     game ends.
--
-- The `win_by > 1` guard on the second branch is not decoration. With a margin of one the
-- first point at the target has won the game, so a score past the target is unreachable -
-- and an unguarded `high - low = 1` would accept 22-21 under the 21-point rule.
--
-- NO CEILING FOR AN UNCAPPED RULE
--
-- `game_point_cap` still answers NULL for everything that is not the 21-point win-by-2 game,
-- and this function does not add a second bound for those rules: a 15-point deuce that runs
-- to 40-38 is a real game and keeps being one. What stops an absurd score there is the exact
-- margin, and what stops one being typed at all is the two-digit field
-- (`parseScoreInput` in src/lib/tournament/score-entry.ts).
--
-- WHERE IT LANDS
--
-- Only `game_score_is_legal` changes. Every writer already asks it - `placement_check_games`
-- (and so `report_placement_result` and `report_tier_draw_result`), `report_draw_result` and
-- `report_pool_result` - so the placement, knockout, pool and legacy draw paths all inherit
-- the rule here, and the next change to it still has one place to land. The signature is
-- unchanged, so `CREATE OR REPLACE` keeps the existing grants and the verify block at the
-- foot of `20261022000000_game_point_cap.sql` still holds.
--
-- Mirrored by `isLegalGameScoreFor` in src/lib/tournament/format.ts; the shared case table in
-- src/lib/tournament/game-rule-cases.test-helpers.ts is answered by both sides, and
-- `integration/score-cap.test.ts` asks Postgres the same questions.

CREATE OR REPLACE FUNCTION public.game_score_is_legal(
  p_a int,
  p_b int,
  p_games_to int,
  p_win_by int
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_a IS NULL OR p_b IS NULL THEN false
    WHEN p_a < 0 OR p_b < 0 OR p_a = p_b THEN false
    -- Nothing above the cap is a game: the ceiling is a ceiling.
    WHEN cap.points IS NOT NULL AND GREATEST(p_a, p_b) > cap.points THEN false
    -- The winner stopped at the target, having never let the loser reach deuce.
    WHEN GREATEST(p_a, p_b) = p_games_to
      AND LEAST(p_a, p_b) <= p_games_to - p_win_by THEN true
    -- Past the target, the game ended on the exact point that opened the margin. Guarded on
    -- p_win_by > 1: a game won by a single point is over at the target, never past it.
    WHEN p_win_by > 1
      AND GREATEST(p_a, p_b) > p_games_to
      AND GREATEST(p_a, p_b) - LEAST(p_a, p_b) = p_win_by THEN true
    -- At the cap, the point that reaches it takes the game at cap-1.
    WHEN cap.points IS NOT NULL
      AND GREATEST(p_a, p_b) = cap.points
      AND LEAST(p_a, p_b) = cap.points - 1 THEN true
    ELSE false
  END
  FROM (SELECT public.game_point_cap(p_games_to, p_win_by) AS points) AS cap;
$function$;

COMMENT ON FUNCTION public.game_score_is_legal(int, int, int, int) IS
  'True when one game is a score a game can stop on: at the target by a full margin, or past it by exactly the margin, or at the cap against cap-1. Mirrored by isLegalGameScoreFor() in src/lib/tournament/format.ts.';

-- The arithmetic above is the whole change and it cannot be observed from TypeScript alone,
-- so it is checked here as well: a wrong CASE would otherwise reach production as a rule
-- nobody could read. These are the same cases as the shared table in
-- game-rule-cases.test-helpers.ts, which is what keeps the two copies answering alike.
DO $verify$
DECLARE
  case_row record;
  answered boolean;
BEGIN
  FOR case_row IN
    SELECT * FROM (VALUES
      (21, 0, true), (21, 19, true), (22, 20, true), (29, 27, true),
      (30, 28, true), (30, 29, true),
      (25, 10, false), (30, 0, false), (24, 21, false), (29, 21, false),
      (22, 5, false), (31, 29, false), (100, 98, false)
    ) AS cases(a, b, legal)
  LOOP
    answered := public.game_score_is_legal(case_row.a, case_row.b, 21, 2);
    IF answered IS DISTINCT FROM case_row.legal THEN
      RAISE EXCEPTION 'game_score_is_legal(%, %, 21, 2) answered %, expected %',
        case_row.a, case_row.b, answered, case_row.legal;
    END IF;
  END LOOP;

  IF public.game_score_is_legal(22, 21, 21, 1) THEN
    RAISE EXCEPTION 'A game won by one point is over at 21; 22-21 must not be legal';
  END IF;
END
$verify$;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.game_score_is_legal(int, int, int, int)', 'execute')
     OR has_function_privilege('authenticated', 'public.game_score_is_legal(int, int, int, int)', 'execute') THEN
    RAISE EXCEPTION 'game_score_is_legal must not be executable by a client role';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
