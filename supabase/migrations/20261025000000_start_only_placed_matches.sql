-- A placement or knockout match starts only where the schedule placed it.
--
-- `start_placement_match` and `start_tier_draw_match` started any `scheduled` row and then set
-- `court_id = COALESCE(p_court_id, court_id)`: a match with no court and no time could be started on
-- any court, and a placed match could be started on a court other than its own, moving it. The Desk
-- used both. An idle court offered the first ready match with no time ("Place on this court"), and on
-- Viet Nam Open 2026's second day that is how XD Draw C round 1 was started at 12:14 while the plan
-- had not placed it: it took Ly Van, whose published 12:21 match on court 2 then could not start, and
-- the reflow could not see the off-plan match because it reads only rows with a court and a time.
-- Court 2 stood empty for 99 minutes (analysis/viet-nam-open-2026/audit.md, anomaly A1).
--
-- The Desk no longer offers either (it starts a court's own next match from that court's tile), and
-- the Scores page no longer starts matches at all. These guards are the database's half: a client that
-- still sends either request is refused with a reason, rather than trusted.
--
--   * a match with no court or no published time is refused - it must be placed first;
--   * a court that differs from the match's own is refused - the match is started where it is.
--
-- "Is this the court's *next* match" is deliberately not checked here: which row is next is a reading
-- of the published order that the Desk owns, and the two physical facts above are what can be wrong
-- whatever the client believes. Everything else is the previous body unchanged (the start and the
-- tier bodies are `20261010000000_start_match_checks_and_reflow.sql` and
-- `20261016000000_full_knockout_bracket.sql`). Nothing applied is edited.

CREATE OR REPLACE FUNCTION public.assert_match_placed_for_start(
  p_court_id uuid,
  p_scheduled_time timestamptz,
  p_requested_court uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_number int;
BEGIN
  IF p_court_id IS NULL OR p_scheduled_time IS NULL THEN
    RAISE EXCEPTION 'This match has no court and time yet. Place it from the Schedule before starting it.';
  END IF;
  IF p_requested_court IS NOT NULL AND p_requested_court <> p_court_id THEN
    SELECT number INTO v_number FROM public.courts WHERE id = p_court_id;
    RAISE EXCEPTION 'This match is scheduled on Court %. Start it there.', COALESCE(v_number::text, '?');
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_match_placed_for_start(uuid, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.start_placement_match(p_match_id uuid, p_court_id uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_court uuid;
  v_time timestamptz;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_placement_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.lock_tournament_lifecycle_shared(v_tournament);
  PERFORM public.assert_tournament_can_start_match(v_tournament);
  -- Before the match is touched, so nothing the match update fires can see an upcoming
  -- tournament with a match on court. A start that then fails raises, and the whole
  -- transaction - this flip included - is rolled back.
  PERFORM public.mark_tournament_started(v_tournament);

  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));

  -- Read under the schedule locks, so a writer placing or moving the row cannot slip in between
  -- the check and the start.
  SELECT court_id, scheduled_time INTO v_court, v_time
  FROM public.placement_matches
  WHERE id = p_match_id AND status = 'scheduled';
  IF FOUND THEN
    PERFORM public.assert_match_placed_for_start(v_court, v_time, p_court_id);
  END IF;

  UPDATE public.placement_matches
  SET status = 'in-progress',
      started_at = COALESCE(started_at, statement_timestamp())
  WHERE id = p_match_id AND status = 'scheduled';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match is not ready to start';
  END IF;

  -- The row is on court now, so the check reads it back and the reflow has an
  -- in-progress source to push the rest of the day behind.
  PERFORM public.assert_can_start_match('placement_matches', p_match_id);
  PERFORM public.shift_live_schedule_after_match('placement_matches', p_match_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_tier_draw_match(p_match_id uuid, p_court_id uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_court uuid;
  v_time timestamptz;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_tier_draw_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.lock_tournament_lifecycle_shared(v_tournament);
  PERFORM public.assert_tournament_can_start_match(v_tournament);
  PERFORM public.mark_tournament_started(v_tournament);

  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));

  SELECT court_id, scheduled_time INTO v_court, v_time
  FROM public.tier_draw_matches
  WHERE id = p_match_id
    AND status = 'scheduled'
    AND NOT is_bye
    AND entrant_a_id IS NOT NULL
    AND entrant_b_id IS NOT NULL;
  IF FOUND THEN
    PERFORM public.assert_match_placed_for_start(v_court, v_time, p_court_id);
  END IF;

  -- Both sides must be known: the whole bracket exists from the draw, so a slot still
  -- waiting on a feeder is a row with `scheduled` status that is not a match yet.
  UPDATE public.tier_draw_matches
  SET status = 'in-progress',
      started_at = COALESCE(started_at, statement_timestamp())
  WHERE id = p_match_id
    AND status = 'scheduled'
    AND NOT is_bye
    AND entrant_a_id IS NOT NULL
    AND entrant_b_id IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match is not ready to start';
  END IF;

  PERFORM public.assert_can_start_match('tier_draw_matches', p_match_id);
  PERFORM public.shift_live_schedule_after_match('tier_draw_matches', p_match_id);
END;
$function$;

-- Self-check: both start functions consult the guard before they write, and neither moves a match.
DO $$
DECLARE
  v_name text;
  v_body text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['start_placement_match', 'start_tier_draw_match'] LOOP
    SELECT p.prosrc INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_body IS NULL OR position('assert_match_placed_for_start' IN v_body) = 0 THEN
      RAISE EXCEPTION '%: the start does not check that the match is placed', v_name;
    END IF;
    IF v_body ~ 'court_id\s*=\s*COALESCE' THEN
      RAISE EXCEPTION '%: the start still moves the match to the requested court', v_name;
    END IF;
  END LOOP;
END;
$$;
