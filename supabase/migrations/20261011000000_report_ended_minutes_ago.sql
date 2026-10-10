--------------------------------------------------------------------------------
-- report_placement_result / report_tier_draw_result - "ended N minutes ago"
--------------------------------------------------------------------------------
--
-- The desk enters a result when it gets to it, which is not always when the match
-- finished. Both report RPCs stamped the finish as `COALESCE(ended_at,
-- statement_timestamp())`, so a result entered fifteen minutes late recorded the
-- match as running fifteen minutes long - and the reflow, which reads `ended_at`,
-- pushed every later match on that court back by a delay that never happened.
--
-- The fix is a relative offset, never an absolute instant. A browser's wall clock
-- drifts from the server's, so "it ended at 10:05" would be a client timestamp the
-- database had no reason to trust; "it ended thirty minutes ago" is arithmetic on
-- `statement_timestamp()`, so it is server-authoritative by construction.
--
-- One optional parameter, `p_ended_minutes_ago integer DEFAULT 0`:
--
--   * greater than zero - the finish is `statement_timestamp() - N minutes`, and it
--     OVERWRITES whatever `ended_at` already held. This is the late-entry correction;
--     `shift_live_schedule_after_match` then reads that resolved finish and reflows.
--   * zero, the default - the old `COALESCE(ended_at, statement_timestamp())` is kept
--     exactly, so a caller that does not pass the parameter behaves as before and a
--     test fixture that pre-wrote a virtual `ended_at` (service role) is still
--     respected rather than overwritten.
--
-- Adding a parameter with a default would leave the two-argument signature in place
-- as an overload: PostgREST resolves a two-key body against the best candidate and
-- refuses to choose between `(uuid, jsonb)` and `(uuid, jsonb, integer DEFAULT 0)`.
-- So both old signatures are dropped first, in the same transaction, and the new
-- three-argument signature is created fresh - which is also why the grants are
-- re-issued below: `DROP FUNCTION` takes its privileges with it.
--
-- Scope: only the two current-format reporters. The legacy round-robin pair
-- (`report_pool_result`, `report_draw_result`) and the walkover/void path
-- (`resolve_match_exception`) stamp their finish the same way and are NOT changed
-- here; a late entry on those formats still records the entry time. `shift_live_schedule_after_match`
-- is untouched - it already reads whatever `ended_at` the report wrote.

DROP FUNCTION IF EXISTS public.report_placement_result(uuid, jsonb);
DROP FUNCTION IF EXISTS public.report_tier_draw_result(uuid, jsonb);

CREATE OR REPLACE FUNCTION public.report_placement_result(
  p_match_id uuid,
  p_games jsonb,
  p_ended_minutes_ago integer DEFAULT 0
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

  SELECT tournament_id INTO v_tournament
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT public.placement_check_games(
    p_games, t.placement_games_to, t.placement_win_by, t.placement_best_of
  ) INTO v_side
  FROM public.tournaments t WHERE t.id = v_tournament;

  SELECT CASE WHEN v_side = 'a' THEN entrant_a_id ELSE entrant_b_id END,
         started_at
    INTO v_winner, v_started_at
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_winner IS NULL THEN
    RAISE EXCEPTION 'That side has no entrant assigned yet';
  END IF;

  -- Resolve the finish. A non-zero offset is an explicit "this ended N minutes ago"
  -- and overrides whatever is stored; zero keeps the old COALESCE, so a fixture that
  -- preset ended_at is still respected rather than replaced with the wall clock.
  IF p_ended_minutes_ago > 0 THEN
    v_ended_at := statement_timestamp() - make_interval(mins => p_ended_minutes_ago);
  ELSE
    SELECT COALESCE(ended_at, statement_timestamp()) INTO v_ended_at
    FROM public.placement_matches WHERE id = p_match_id;
  END IF;

  -- A finish before the match started describes no real span, and would feed the
  -- reflow a negative duration. Only checked when the match has a start: a result
  -- reported without ever starting has no window to be inside.
  IF v_started_at IS NOT NULL AND v_ended_at < v_started_at THEN
    RAISE EXCEPTION 'The finish time is before the match started';
  END IF;

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
  p_ended_minutes_ago integer DEFAULT 0
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

  SELECT tournament_id, draw_id INTO v_tournament, v_draw
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT public.placement_check_games(
    p_games, t.knockout_games_to, t.knockout_win_by, t.knockout_best_of
  ) INTO v_side
  FROM public.tournaments t WHERE t.id = v_tournament;

  SELECT CASE WHEN v_side = 'a' THEN entrant_a_id ELSE entrant_b_id END,
         started_at
    INTO v_winner, v_started_at
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_winner IS NULL THEN
    RAISE EXCEPTION 'That side has no entrant assigned yet';
  END IF;

  IF p_ended_minutes_ago > 0 THEN
    v_ended_at := statement_timestamp() - make_interval(mins => p_ended_minutes_ago);
  ELSE
    SELECT COALESCE(ended_at, statement_timestamp()) INTO v_ended_at
    FROM public.tier_draw_matches WHERE id = p_match_id;
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

COMMENT ON FUNCTION public.report_placement_result(uuid, jsonb, integer) IS
  'Records a placement result under the placement rule, then reflows the day. p_ended_minutes_ago > 0 backdates the finish to statement_timestamp() - N minutes (overwriting any stored ended_at); 0 keeps COALESCE(ended_at, now()) so a pre-set ended_at survives. N must be 0..720, and the resolved finish may not precede started_at.';

COMMENT ON FUNCTION public.report_tier_draw_result(uuid, jsonb, integer) IS
  'Records a knockout result under the knockout rule, advances the bracket, then reflows. p_ended_minutes_ago > 0 backdates the finish to statement_timestamp() - N minutes (overwriting any stored ended_at); 0 keeps COALESCE(ended_at, now()) so a pre-set ended_at survives. N must be 0..720, and the resolved finish may not precede started_at.';

-- Fresh functions arrive with the default EXECUTE to PUBLIC; the old two-argument
-- grants went with the DROP. Restore the same authenticated-only surface.
REVOKE ALL ON FUNCTION public.report_placement_result(uuid, jsonb, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.report_placement_result(uuid, jsonb, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.report_tier_draw_result(uuid, jsonb, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.report_tier_draw_result(uuid, jsonb, integer) TO authenticated;

--------------------------------------------------------------------------------
-- Verify
--------------------------------------------------------------------------------
DO $verify$
BEGIN
  -- The overload is gone. A two-argument signature left beside the three-argument one
  -- is what makes PostgREST return "Could not choose the best candidate function" for a
  -- body that only sends p_match_id and p_games.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'report_placement_result') <> 1 THEN
    RAISE EXCEPTION 'M6: report_placement_result must exist exactly once (no leftover overload)';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'report_tier_draw_result') <> 1 THEN
    RAISE EXCEPTION 'M6: report_tier_draw_result must exist exactly once (no leftover overload)';
  END IF;

  -- Each carries the parameter, the default and the three behaviours.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'report_placement_result'
      AND p.pronargdefaults >= 1
      AND 'p_ended_minutes_ago' = ANY (p.proargnames)
      AND p.prosrc LIKE '%make_interval(mins => p_ended_minutes_ago)%'
      AND p.prosrc LIKE '%COALESCE(ended_at, statement_timestamp())%'
      AND p.prosrc LIKE '%cannot be in the future%'
      AND p.prosrc LIKE '%c_max_minutes_ago%'
      AND p.prosrc LIKE '%is before the match started%'
  ) THEN
    RAISE EXCEPTION 'M6: report_placement_result is missing the offset, its default or its checks';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'report_tier_draw_result'
      AND p.pronargdefaults >= 1
      AND 'p_ended_minutes_ago' = ANY (p.proargnames)
      AND p.prosrc LIKE '%make_interval(mins => p_ended_minutes_ago)%'
      AND p.prosrc LIKE '%COALESCE(ended_at, statement_timestamp())%'
      AND p.prosrc LIKE '%cannot be in the future%'
      AND p.prosrc LIKE '%c_max_minutes_ago%'
      AND p.prosrc LIKE '%is before the match started%'
  ) THEN
    RAISE EXCEPTION 'M6: report_tier_draw_result is missing the offset, its default or its checks';
  END IF;

  -- Access is unchanged: authenticated may call both, anon may not.
  IF has_function_privilege('anon', 'public.report_placement_result(uuid, jsonb, integer)', 'execute') THEN
    RAISE EXCEPTION 'M6: report_placement_result must not be executable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.report_placement_result(uuid, jsonb, integer)', 'execute') THEN
    RAISE EXCEPTION 'M6: report_placement_result must be executable by authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.report_tier_draw_result(uuid, jsonb, integer)', 'execute') THEN
    RAISE EXCEPTION 'M6: report_tier_draw_result must not be executable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.report_tier_draw_result(uuid, jsonb, integer)', 'execute') THEN
    RAISE EXCEPTION 'M6: report_tier_draw_result must be executable by authenticated';
  END IF;
END;
$verify$;

-- PostgREST caches the schema; the signature changed, so its cache is stale.
NOTIFY pgrst, 'reload schema';
