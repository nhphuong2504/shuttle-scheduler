-- Reporting a result: who is allowed to, against what state, and from which read.
--
-- WHAT WAS WRONG
--
-- 1. A MATCH WITH ONE UNKNOWN SIDE COULD TAKE A SCORE.
--
--    `report_tier_draw_result` resolved the winner from the side the games decided:
--
--      v_winner := CASE WHEN v_side = 'a' THEN entrant_a_id ELSE entrant_b_id END;
--
--    and refused only when *that* name was null. So a semifinal still reading "Winner of
--    Quarterfinal 2" on side B could be reported if side A had a name - the score would be
--    stored, the bracket advanced, and the second entrant never existed. `report_draw_result`
--    has the same shape. Both now refuse until both sides are known.
--
-- 2. A VOID OR WALKOVER MATCH COULD BE OVERWRITTEN BY A SCORE.
--
--    The reporters write `status = 'reported'` unconditionally. Void and walkover are the
--    two states that say "this match was not played and will not be"; a score recorded over
--    one of them silently turns a decision into a result. Only `scheduled`, `in-progress`
--    and `reported` are reportable now - `reported` stays, because correcting a result is
--    telling the same state a different score.
--
-- 3. TWO DESKS COULD REPORT THE SAME MATCH AND THE LAST ONE WON SILENTLY.
--
--    The dialog already refuses when the match changed since it opened (`assertMatchUnchanged`
--    in src/lib/tournament/actions.ts), but that is a read followed by a write: two clients
--    can both pass it and both save. The reporters now take the expectation as an argument and
--    compare it against the row they have just locked:
--
--      p_expected_status text        - the status the dialog opened on (null = do not check)
--      p_expected_reported_at timestamptz - the result token it opened on
--
--    Both are nullable, and null means "this caller is not checking" - which is what every
--    integration fixture and every scripted caller passes. A single nullable timestamp
--    cannot express "expect NO result yet", because `null` already means "skip", so the
--    status carries the first entry: on `p_expected_status = 'reported'` the timestamp
--    becomes binding, and anywhere else the status comparison is the whole check.
--
--    The row is read with `FOR UPDATE` before the comparison, so the write that follows is
--    against the same row that was compared. `assertMatchUnchanged` stays on the client as
--    the friendly early message; this is the check that actually holds.
--
-- 4. THE LEGACY DRAW CHECKED THE WRONG THING.
--
--    `report_draw_result` refused "a game after the match was decided" by comparing each
--    game to the LAST one:
--
--      IF (wins_a >= needed OR wins_b >= needed) AND game <> p_games -> -1
--
--    With `21-19, 21-19, 21-19` the third row equals the last, so the comparison was false
--    and the extra game was accepted. It asks a question about position with a value, and
--    the value can repeat. The whole block is now `placement_check_games`, which counts the
--    rows it has seen against the total - the same counter the placement and knockout
--    reporters already use, so the legacy draw inherits the exact-margin rule from
--    `20261022020000` instead of keeping a fourth copy of it.
--
-- 5. A NON-WHOLE-NUMBER GAME FAILED AS A CAST ERROR.
--
--    `(game->>'a')::int` on `21.5` raises "invalid input syntax for type integer", which
--    reads as a server fault rather than a refused score. `placement_check_games` checks the
--    element is a whole number first and says so.
--
-- NOT CHANGED HERE
--
--   * A correction that would change who advances is still refused by the triggers in
--     `20261008040000_result_correction_guards.sql` - `guard_tier_draw_correction` raises
--     "The next round has already started from this result" and repairs the child while it
--     is still unplayed. The RPCs deliberately keep no second copy of that rule. What this
--     migration adds for the desk is the warning *before* the attempt.
--   * The legacy `report_pool_result` keeps its hardcoded 21/win-by-2 rule and its
--     unconditional status write. It is not on the configured-rule path, and the desk does
--     not offer it the score dialog for a match that is not scheduled or reported.
--   * `shift_live_schedule_after_match` and the reflow are untouched.

--------------------------------------------------------------------------------
-- 1. The shared report guard
--------------------------------------------------------------------------------

-- One answer to "may this result be written to this row?", so the two reporters cannot drift
-- apart the way the score predicate did. Internal: both entry points are SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.assert_reportable_match(
  p_status text,
  p_side_a uuid,
  p_side_b uuid,
  p_reported_time timestamptz,
  p_expected_status text,
  p_expected_reported_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
BEGIN
  -- The dialog's snapshot against the row as it stands. Checked first: a caller whose match
  -- has moved on should be told to reload, not handed a complaint about a score it no longer
  -- means to send.
  IF p_expected_status IS NOT NULL AND p_status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION
      'This match changed to "%" while you were entering the result. Close this window and reopen the match to see the latest.',
      p_status;
  END IF;

  -- A correction leaves the status at `reported`, so status alone cannot see a second desk
  -- correcting the same result. `reported_time` moves on every report, which can.
  IF p_expected_status = 'reported'
    AND p_expected_reported_at IS NOT NULL
    AND p_reported_time IS DISTINCT FROM p_expected_reported_at THEN
    RAISE EXCEPTION
      'This result was changed while you were entering it. Close this window and reopen the match to see the latest.';
  END IF;

  -- Void and walkover are decisions, not pending results, and nothing overwrites one with a
  -- score. A bye is the same: it was awarded, never played.
  IF p_status IS DISTINCT FROM 'scheduled'
    AND p_status IS DISTINCT FROM 'in-progress'
    AND p_status IS DISTINCT FROM 'reported' THEN
    RAISE EXCEPTION 'This match is marked "%" and takes no score', p_status;
  END IF;

  -- A side that is still "Winner of Quarterfinal 2" has no team to credit, and a result
  -- stored against it would name a winner the bracket never produced.
  IF p_side_a IS NULL OR p_side_b IS NULL THEN
    RAISE EXCEPTION 'This match is still waiting for one of its sides, so it has no score yet';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_reportable_match(text, uuid, uuid, timestamptz, text, timestamptz)
  FROM PUBLIC, anon, authenticated;

--------------------------------------------------------------------------------
-- 2. placement_check_games: say "whole number" instead of failing the cast
--------------------------------------------------------------------------------

-- Same body as `20261022000000_game_point_cap.sql`, with the element type checked before the
-- cast. Everything else - the shared predicate, the counters, the messages - is unchanged.
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
    -- Checked before the cast, so a decimal or a string is a refused score rather than a
    -- Postgres type error. A missing key is a malformed game and is refused the same way.
    IF jsonb_typeof(game -> 'a') IS DISTINCT FROM 'number'
       OR jsonb_typeof(game -> 'b') IS DISTINCT FROM 'number'
       OR (game ->> 'a') !~ '^-?[0-9]+$'
       OR (game ->> 'b') !~ '^-?[0-9]+$' THEN
      RAISE EXCEPTION 'Each game needs a whole number of points';
    END IF;
    -- A number the `int` type cannot hold would fail the cast below, which reads as a
    -- server fault rather than a refused score. Any real game is far inside this bound.
    IF (game ->> 'a')::numeric > 2147483647 OR (game ->> 'b')::numeric > 2147483647 THEN
      RAISE EXCEPTION 'A game score is too large to record';
    END IF;
    sa := (game->>'a')::int;
    sb := (game->>'b')::int;
    IF sa < 0 OR sb < 0 OR sa = sb THEN
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
    -- Counted, not compared: the position is what decides, and the value can repeat.
    IF (wins_a >= needed OR wins_b >= needed) AND seen < total THEN
      RAISE EXCEPTION 'Do not enter games after the match is decided';
    END IF;
  END LOOP;

  IF wins_a >= needed AND wins_b < needed THEN RETURN 'a'; END IF;
  IF wins_b >= needed AND wins_a < needed THEN RETURN 'b'; END IF;
  RAISE EXCEPTION 'A side must win % games', needed;
END;
$$;

--------------------------------------------------------------------------------
-- 3. The two configured-rule reporters
--------------------------------------------------------------------------------
--
-- A parameter with a default would leave the three-argument signature in place as an
-- overload, and PostgREST refuses to choose between `(uuid, jsonb, int)` and
-- `(uuid, jsonb, int DEFAULT 0, text DEFAULT NULL, timestamptz DEFAULT NULL)`. Both are
-- dropped first, in the same transaction, so each name has exactly one definition - which is
-- also why the grants are re-issued below: `DROP FUNCTION` takes its privileges with it.

DROP FUNCTION IF EXISTS public.report_placement_result(uuid, jsonb, integer);
DROP FUNCTION IF EXISTS public.report_tier_draw_result(uuid, jsonb, integer);

CREATE OR REPLACE FUNCTION public.report_placement_result(
  p_match_id uuid,
  p_games jsonb,
  p_ended_minutes_ago integer DEFAULT 0,
  p_expected_status text DEFAULT NULL,
  p_expected_reported_at timestamptz DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- The most a finish may be backdated. Twelve hours covers the honest worst case - a
  -- result entered at close for a match that finished that morning - while still
  -- refusing a typo like 7000, whose resolved finish would land before the fixture's
  -- own day and reflow the schedule from a time that never existed. Named rather than
  -- inlined so the ceiling is one edit, and mirrored by MAX_ENDED_MINUTES_AGO in
  -- src/lib/tournament/placement-actions.ts so the desk refuses the same number.
  c_max_minutes_ago constant integer := 720;
  v_tournament uuid;
  v_status text;
  v_side_a uuid;
  v_side_b uuid;
  v_reported_time timestamptz;
  v_side text;
  v_winner uuid;
  v_started_at timestamptz;
  v_ended_at timestamptz;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_placement_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  -- Input before data: a negative offset would resolve a finish in the future.
  IF p_ended_minutes_ago < 0 THEN
    RAISE EXCEPTION 'A finish time cannot be in the future';
  END IF;
  IF p_ended_minutes_ago > c_max_minutes_ago THEN
    RAISE EXCEPTION 'A finish more than % minutes ago cannot be recorded', c_max_minutes_ago;
  END IF;

  -- The row is locked for the whole decision, so the expectation is compared against, and
  -- the result written to, the same version of the row.
  SELECT tournament_id, status, entrant_a_id, entrant_b_id, reported_time, started_at, ended_at
  INTO v_tournament, v_status, v_side_a, v_side_b, v_reported_time, v_started_at, v_ended_at
  FROM public.placement_matches
  WHERE id = p_match_id
  FOR UPDATE;

  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  PERFORM public.assert_reportable_match(
    v_status, v_side_a, v_side_b, v_reported_time, p_expected_status, p_expected_reported_at
  );

  SELECT public.placement_check_games(
    p_games, t.placement_games_to, t.placement_win_by, t.placement_best_of
  ) INTO v_side
  FROM public.tournaments t WHERE t.id = v_tournament;

  v_winner := CASE WHEN v_side = 'a' THEN v_side_a ELSE v_side_b END;

  -- Resolve the finish. A non-zero offset is an explicit "this ended N minutes ago"
  -- and overrides whatever is stored; zero keeps the old COALESCE, so a fixture that
  -- preset ended_at is still respected rather than replaced with the wall clock.
  IF p_ended_minutes_ago > 0 THEN
    v_ended_at := statement_timestamp() - make_interval(mins => p_ended_minutes_ago);
  ELSE
    v_ended_at := COALESCE(v_ended_at, statement_timestamp());
  END IF;

  -- A finish before the match started describes no real span, and would feed the
  -- reflow a negative duration. Only checked when the match has a start: a result
  -- reported without ever starting has no window to be inside.
  IF v_started_at IS NOT NULL AND v_ended_at < v_started_at THEN
    RAISE EXCEPTION 'The finish time is before the match started';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('placement:' || (SELECT category_id FROM public.placement_matches WHERE id = p_match_id)::text));

  UPDATE public.placement_matches
  SET games = p_games,
      winner_id = v_winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = v_ended_at
  WHERE id = p_match_id;

  PERFORM public.shift_live_schedule_after_match('placement_matches', p_match_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.report_tier_draw_result(
  p_match_id uuid,
  p_games jsonb,
  p_ended_minutes_ago integer DEFAULT 0,
  p_expected_status text DEFAULT NULL,
  p_expected_reported_at timestamptz DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- See report_placement_result: same ceiling, same reason, same client twin.
  c_max_minutes_ago constant integer := 720;
  v_tournament uuid;
  v_status text;
  v_side_a uuid;
  v_side_b uuid;
  v_reported_time timestamptz;
  v_draw uuid;
  v_side text;
  v_winner uuid;
  v_started_at timestamptz;
  v_ended_at timestamptz;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_tier_draw_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  IF p_ended_minutes_ago < 0 THEN
    RAISE EXCEPTION 'A finish time cannot be in the future';
  END IF;
  IF p_ended_minutes_ago > c_max_minutes_ago THEN
    RAISE EXCEPTION 'A finish more than % minutes ago cannot be recorded', c_max_minutes_ago;
  END IF;

  SELECT tournament_id, draw_id, status, entrant_a_id, entrant_b_id,
         reported_time, started_at, ended_at
  INTO v_tournament, v_draw, v_status, v_side_a, v_side_b,
       v_reported_time, v_started_at, v_ended_at
  FROM public.tier_draw_matches
  WHERE id = p_match_id
  FOR UPDATE;

  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  PERFORM public.assert_reportable_match(
    v_status, v_side_a, v_side_b, v_reported_time, p_expected_status, p_expected_reported_at
  );

  SELECT public.placement_check_games(
    p_games, t.knockout_games_to, t.knockout_win_by, t.knockout_best_of
  ) INTO v_side
  FROM public.tournaments t WHERE t.id = v_tournament;

  v_winner := CASE WHEN v_side = 'a' THEN v_side_a ELSE v_side_b END;

  IF p_ended_minutes_ago > 0 THEN
    v_ended_at := statement_timestamp() - make_interval(mins => p_ended_minutes_ago);
  ELSE
    v_ended_at := COALESCE(v_ended_at, statement_timestamp());
  END IF;

  IF v_started_at IS NOT NULL AND v_ended_at < v_started_at THEN
    RAISE EXCEPTION 'The finish time is before the match started';
  END IF;

  UPDATE public.tier_draw_matches
  SET games = p_games,
      winner_id = v_winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = v_ended_at
  WHERE id = p_match_id;

  -- Advance first, then reflow. Advancing may create a match that is now ready to
  -- play, and reflowing before it existed would leave that match out of the
  -- ordering it just joined.
  PERFORM public.advance_tier_draw_locked(v_draw);
  PERFORM public.shift_live_schedule_after_match('tier_draw_matches', p_match_id);
END;
$function$;

--------------------------------------------------------------------------------
-- 4. report_draw_result: one checker for the games, and both sides required
--------------------------------------------------------------------------------

-- The validation block is replaced by `placement_check_games`, so the legacy draw shares the
-- rule, the cap and the counter with the configured-rule reporters instead of repeating them.
-- The rest of the body - ownership, liveness, the winner, the advance, the reflow - is
-- unchanged.
CREATE OR REPLACE FUNCTION public.report_draw_result(p_match_id uuid, p_games jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_status text;
  v_team_a uuid;
  v_team_b uuid;
  v_is_bye boolean;
  v_side text;
  v_winner uuid;
  v_draw uuid;
  games_to int;
  win_by int;
  best_of int;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament('draw_matches', p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  SELECT dm.tournament_id, dm.draw_id, dm.status, dm.team_a_id, dm.team_b_id, dm.is_bye
  INTO v_tournament, v_draw, v_status, v_team_a, v_team_b, v_is_bye
  FROM public.draw_matches dm WHERE dm.id = p_match_id
  FOR UPDATE;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  -- A bye is stored as a reported row with one side, so it would otherwise read as "a match
  -- waiting for its opponent" rather than as a decision the draw already made.
  IF v_is_bye THEN
    RAISE EXCEPTION 'A bye is decided by the draw, not by a score';
  END IF;

  -- The same status and both-sides guard as the configured-rule reporters. No expectation is
  -- compared here: the legacy draw dialog keeps its status check on the client.
  PERFORM public.assert_reportable_match(v_status, v_team_a, v_team_b, NULL, NULL, NULL);

  SELECT knockout_games_to, knockout_win_by, knockout_best_of
  INTO games_to, win_by, best_of
  FROM public.tournaments WHERE id = v_tournament;

  v_side := public.placement_check_games(p_games, games_to, win_by, best_of);

  v_winner := CASE WHEN v_side = 'a' THEN v_team_a ELSE v_team_b END;

  PERFORM pg_advisory_xact_lock(hashtext('draw:' || v_draw::text));
  UPDATE public.draw_matches
  SET games = p_games,
      winner_id = v_winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;
  PERFORM public.advance_draw_locked(v_draw);
  PERFORM public.shift_live_schedule_after_match('draw_matches', p_match_id);
END;
$function$;

--------------------------------------------------------------------------------
-- 5. Grants and verification
--------------------------------------------------------------------------------

COMMENT ON FUNCTION public.report_placement_result(uuid, jsonb, integer, text, timestamptz) IS
  'Records a placement result under the placement rule, then reflows the day. p_ended_minutes_ago > 0 backdates the finish to statement_timestamp() - N minutes (overwriting any stored ended_at); 0 keeps COALESCE(ended_at, now()) so a pre-set ended_at survives. N must be 0..720, and the resolved finish may not precede started_at. p_expected_status / p_expected_reported_at are the dialog snapshot: when given, the row is locked and the result is refused if it has moved on.';

COMMENT ON FUNCTION public.report_tier_draw_result(uuid, jsonb, integer, text, timestamptz) IS
  'Records a knockout result under the knockout rule, advances the bracket, then reflows. p_ended_minutes_ago > 0 backdates the finish to statement_timestamp() - N minutes (overwriting any stored ended_at); 0 keeps COALESCE(ended_at, now()) so a pre-set ended_at survives. N must be 0..720, and the resolved finish may not precede started_at. p_expected_status / p_expected_reported_at are the dialog snapshot: when given, the row is locked and the result is refused if it has moved on.';

REVOKE ALL ON FUNCTION public.report_placement_result(uuid, jsonb, integer, text, timestamptz)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.report_placement_result(uuid, jsonb, integer, text, timestamptz)
  TO authenticated;
REVOKE ALL ON FUNCTION public.report_tier_draw_result(uuid, jsonb, integer, text, timestamptz)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.report_tier_draw_result(uuid, jsonb, integer, text, timestamptz)
  TO authenticated;

DO $verify$
BEGIN
  -- One definition per name. Two would be an ambiguous PostgREST call, which fails at
  -- runtime for every desk rather than here.
  IF to_regprocedure('public.report_placement_result(uuid, jsonb, integer)') IS NOT NULL
     OR to_regprocedure('public.report_tier_draw_result(uuid, jsonb, integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'The three-argument report signatures must be gone, not shadowed';
  END IF;

  IF has_function_privilege('anon', 'public.report_placement_result(uuid, jsonb, integer, text, timestamptz)', 'execute')
     OR has_function_privilege('anon', 'public.report_tier_draw_result(uuid, jsonb, integer, text, timestamptz)', 'execute') THEN
    RAISE EXCEPTION 'The report RPCs must not be executable by anon';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.report_placement_result(uuid, jsonb, integer, text, timestamptz)', 'execute')
     OR NOT has_function_privilege('authenticated', 'public.report_tier_draw_result(uuid, jsonb, integer, text, timestamptz)', 'execute') THEN
    RAISE EXCEPTION 'The report RPCs must be executable by authenticated';
  END IF;

  -- The guard is an internal: it takes a row's status and sides, and nothing a client should
  -- be able to ask about someone else's match.
  IF has_function_privilege('authenticated', 'public.assert_reportable_match(text, uuid, uuid, timestamptz, text, timestamptz)', 'execute')
     OR has_function_privilege('anon', 'public.assert_reportable_match(text, uuid, uuid, timestamptz, text, timestamptz)', 'execute') THEN
    RAISE EXCEPTION 'assert_reportable_match must not be executable by a client role';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
