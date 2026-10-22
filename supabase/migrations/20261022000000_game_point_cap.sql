-- A 21-point game stops at 30.
--
-- WHAT WAS WRONG
--
-- Every validator knew only a floor and a margin: a side reaches `games_to` and leads by
-- `win_by`. Badminton's deuce ends at 30 - 29-29 is deuce, and the next point wins 30-29 -
-- so the cap is the second way to win a game, not a detail of how the score is displayed.
-- Without it, `31-29` and `211-19` were accepted and stored as results that cannot happen.
-- The browser fixture already claimed the cap ("30-29, the cap in badminton") while the code
-- refused the very score the fixture drew, which is how the gap was found.
--
-- WHY IT IS DERIVED RATHER THAN STORED
--
-- The cap belongs to the 21-point, win-by-2 rule. A tournament that plays to 15 or 11 has no
-- official ceiling, and `win_by = 1` has no deuce to end, so a fourth column would be a
-- number that means nothing for most rows. `game_point_cap` answers the question from the
-- rule, and `gamePointCap` in src/lib/tournament/scoring.ts answers it identically on the
-- client: a score the dialog accepts and the RPC refuses is worse than either rule alone.
--
-- WHAT THIS REPLACES
--
-- The predicate was written out three times - inside `placement_check_games`,
-- `report_draw_result` and `report_pool_result` - which is how the three could drift. They
-- now share `game_score_is_legal`, so the next change to what a legal game is has one place
-- to land. The placement and knockout report RPCs inherit it through `placement_check_games`;
-- their signatures and bodies are untouched.

-- The hard ceiling a rule stops at, or NULL when it has none.
CREATE OR REPLACE FUNCTION public.game_point_cap(p_games_to int, p_win_by int)
RETURNS int
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_games_to = 21 AND p_win_by = 2 THEN 30 END;
$function$;

COMMENT ON FUNCTION public.game_point_cap(int, int) IS
  'The score a game stops at: 30 for the 21-point win-by-2 game, NULL for every other rule. Mirrored by gamePointCap() in src/lib/tournament/scoring.ts.';

-- One answer to "is this a legal game?", shared by every writer.
--
-- `p_a`/`p_b` are the two sides; the higher one must have reached the target and either led
-- by the margin or taken the cap at cap-1. A score above the cap is never legal, which is
-- what stops a fumbled keystroke from being stored.
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
    WHEN cap.points IS NOT NULL AND GREATEST(p_a, p_b) > cap.points THEN false
    WHEN GREATEST(p_a, p_b) >= p_games_to
      AND GREATEST(p_a, p_b) - LEAST(p_a, p_b) >= p_win_by THEN true
    WHEN cap.points IS NOT NULL
      AND GREATEST(p_a, p_b) = cap.points
      AND LEAST(p_a, p_b) = cap.points - 1 THEN true
    ELSE false
  END
  FROM (SELECT public.game_point_cap(p_games_to, p_win_by) AS points) AS cap;
$function$;

COMMENT ON FUNCTION public.game_score_is_legal(int, int, int, int) IS
  'True when one game is a legal result under a rule, including the cap (30-29 for a 21-point game). Mirrored by isLegalGameScoreFor() in src/lib/tournament/format.ts.';

-- Placement (and, through it, knockout) results. The body is the previous definition with the
-- inline predicate replaced; the messages gain the cap, because "Games are to 21, win by 2"
-- does not explain why 31-29 was refused.
CREATE OR REPLACE FUNCTION public.placement_check_games(
  p_games jsonb,
  p_games_to int,
  p_win_by int,
  p_best_of int
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  wins_a int := 0;
  wins_b int := 0;
  game jsonb;
  sa int;
  sb int;
  needed int;
  played int;
  seen int := 0;
  total int;
  cap int;
BEGIN
  needed := (p_best_of + 1) / 2;
  played := jsonb_array_length(COALESCE(p_games, '[]'::jsonb));
  total := played;
  cap := public.game_point_cap(p_games_to, p_win_by);

  IF played < 1 THEN
    RAISE EXCEPTION 'Enter at least one game';
  END IF;
  IF played > p_best_of THEN
    RAISE EXCEPTION 'This match is best of %', p_best_of;
  END IF;
  IF played < needed THEN
    RAISE EXCEPTION 'This match is best of % — a side must win % games', p_best_of, needed;
  END IF;

  FOR game IN SELECT * FROM jsonb_array_elements(p_games)
  LOOP
    seen := seen + 1;
    sa := (game->>'a')::int;
    sb := (game->>'b')::int;
    IF sa IS NULL OR sb IS NULL OR sa < 0 OR sb < 0 OR sa = sb THEN
      RAISE EXCEPTION 'Each game needs a valid winning score';
    END IF;
    IF NOT public.game_score_is_legal(sa, sb, p_games_to, p_win_by) THEN
      IF cap IS NOT NULL AND GREATEST(sa, sb) > cap THEN
        RAISE EXCEPTION 'A game stops at % points', cap;
      ELSIF p_win_by = 1 THEN
        RAISE EXCEPTION 'Games are to %', p_games_to;
      ELSE
        RAISE EXCEPTION 'Games are to %, win by %', p_games_to, p_win_by;
      END IF;
    END IF;
    IF sa > sb THEN wins_a := wins_a + 1; ELSE wins_b := wins_b + 1; END IF;
    IF (wins_a >= needed OR wins_b >= needed) AND seen < total THEN
      RAISE EXCEPTION 'Do not enter games after the match is decided';
    END IF;
  END LOOP;

  IF wins_a >= needed AND wins_b < needed THEN RETURN 'a'; END IF;
  IF wins_b >= needed AND wins_a < needed THEN RETURN 'b'; END IF;
  RAISE EXCEPTION 'A side must win % games', needed;
END;
$$;

-- The legacy round-robin engine. Its rule stays hardcoded at 21/2 (the format is reachable
-- but not created), so it now asks the shared predicate instead of repeating the arithmetic.
CREATE OR REPLACE FUNCTION public.report_pool_result(p_match_id uuid, p_score_a integer, p_score_b integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  winner uuid;
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament('pool_matches', p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);
  IF p_score_a < 0 OR p_score_b < 0 OR p_score_a = p_score_b THEN
    RAISE EXCEPTION 'A group match needs a valid winning score';
  END IF;
  IF NOT public.game_score_is_legal(p_score_a, p_score_b, 21, 2) THEN
    IF GREATEST(p_score_a, p_score_b) > 30 THEN
      RAISE EXCEPTION 'A game stops at 30 points';
    END IF;
    RAISE EXCEPTION 'Group games are race to 21, win by 2';
  END IF;
  SELECT CASE WHEN p_score_a > p_score_b THEN team_a_id ELSE team_b_id END
  INTO winner FROM public.pool_matches WHERE id = p_match_id;
  UPDATE public.pool_matches
  SET score_a = p_score_a,
      score_b = p_score_b,
      winner_id = winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;
  PERFORM public.shift_live_schedule_after_match('pool_matches', p_match_id);
END;
$function$;

-- The legacy A/B/C/D draw engine, kept for a round-robin tournament. Same body, shared
-- predicate, plus the cap in the message.
CREATE OR REPLACE FUNCTION public.report_draw_result(p_match_id uuid, p_games jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  wins_a int := 0;
  wins_b int := 0;
  game jsonb;
  sa int;
  sb int;
  winner uuid;
  draw uuid;
  v_tournament uuid;
  games_to int;
  win_by int;
  best_of int;
  needed int;
  played int;
  cap int;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament('draw_matches', p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  SELECT dm.tournament_id INTO v_tournament
  FROM public.draw_matches dm WHERE dm.id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT knockout_games_to, knockout_win_by, knockout_best_of
  INTO games_to, win_by, best_of
  FROM public.tournaments WHERE id = v_tournament;

  needed := (best_of + 1) / 2;
  played := jsonb_array_length(p_games);
  cap := public.game_point_cap(games_to, win_by);

  IF played < 1 THEN
    RAISE EXCEPTION 'Enter at least one game';
  END IF;
  IF played > best_of THEN
    RAISE EXCEPTION 'This match is best of %', best_of;
  END IF;
  IF played < needed THEN
    RAISE EXCEPTION 'This match is best of % — a side must win % games', best_of, needed;
  END IF;

  FOR game IN SELECT * FROM jsonb_array_elements(p_games)
  LOOP
    sa := (game->>'a')::int;
    sb := (game->>'b')::int;
    IF sa < 0 OR sb < 0 OR sa = sb THEN
      RAISE EXCEPTION 'Each game needs a valid winning score';
    END IF;
    IF NOT public.game_score_is_legal(sa, sb, games_to, win_by) THEN
      IF cap IS NOT NULL AND GREATEST(sa, sb) > cap THEN
        RAISE EXCEPTION 'A game stops at % points', cap;
      ELSIF win_by = 1 THEN
        RAISE EXCEPTION 'Games are to %', games_to;
      ELSE
        RAISE EXCEPTION 'Games are to %, win by %', games_to, win_by;
      END IF;
    END IF;
    IF sa > sb THEN wins_a := wins_a + 1; ELSE wins_b := wins_b + 1; END IF;
    IF (wins_a >= needed OR wins_b >= needed) AND game <> p_games -> -1 THEN
      RAISE EXCEPTION 'Do not enter games after the match is decided';
    END IF;
  END LOOP;

  IF wins_a < needed AND wins_b < needed THEN
    RAISE EXCEPTION 'A side must win % games', needed;
  END IF;

  SELECT CASE WHEN wins_a >= needed THEN team_a_id ELSE team_b_id END, draw_id
  INTO winner, draw
  FROM public.draw_matches WHERE id = p_match_id;
  IF winner IS NULL THEN
    RAISE EXCEPTION 'That side has no team assigned yet';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('draw:' || draw::text));
  UPDATE public.draw_matches
  SET games = p_games,
      winner_id = winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;
  PERFORM public.advance_draw_locked(draw);
  PERFORM public.shift_live_schedule_after_match('draw_matches', p_match_id);
END;
$function$;

-- The helpers are callers' internals, not an API: every entry point that uses them is
-- SECURITY DEFINER, so no role needs to execute them directly.
REVOKE ALL ON FUNCTION public.game_point_cap(int, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.game_score_is_legal(int, int, int, int) FROM PUBLIC, anon, authenticated;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.game_score_is_legal(int, int, int, int)', 'execute')
     OR has_function_privilege('authenticated', 'public.game_score_is_legal(int, int, int, int)', 'execute')
     OR has_function_privilege('anon', 'public.game_point_cap(int, int)', 'execute') THEN
    RAISE EXCEPTION 'Score-cap helpers must not be executable by a client role';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
