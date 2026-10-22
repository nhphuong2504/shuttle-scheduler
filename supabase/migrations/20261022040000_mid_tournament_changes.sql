-- Changing a tournament after the schedule exists.
--
-- docs/roster-freeze.md listed four acts that only worked before the first match, because each
-- needed SQL that had never been run against a Postgres. This is that SQL. Each function does the
-- whole act in one transaction - the edit, every affected match, and the live reflow - so a
-- half-applied change cannot leave a withdrawn team still holding a court.
--
-- WHAT WAS WRONG
--
--   Withdrawing a team only set `teams.withdrawn`. `sync_placement_entrants` reconciled that into
--   `placement_entrants.excluded`, but it asserts the tournament is *configurable*, so once the
--   draw was built the flag was inert: the entrant stayed in the bracket and its matches stayed on
--   the schedule with a team that had gone home. The remedy was a walkover per match on the Desk.
--
--   A late team could not be added at all once seeds were locked, for the same reason.
--
--   A day could be edited but its matches did not move with it, and a court that failed was simply
--   removed from the day's set, leaving its matches pointing at a court the day no longer plays.
--
-- LOCK ORDER, WHICH IS NOT COSMETIC
--
-- Every function here takes `live-schedule` and then its own key *before* touching a row, matching
-- `report_placement_result` and the reflow itself. Locking rows first would let two moderators hold
-- one lock each and wait on the other, and Postgres would answer "deadlock detected" for a
-- withdrawal that was perfectly valid. See `20261022030000_report_guards.sql`.
--
-- WHAT THEY DELIBERATELY DO NOT DO
--
--   * They never edit a result. A match already reported keeps its score, even if the team that won
--     it then withdraws: that score is a fact about a game that was played.
--   * They refuse rather than guess when a match is on court. Taking a team out mid-match is a
--     retirement, which is its own decision (docs/cleanup-deferred.md).
--   * They do not re-seed or re-pair anything. A late add gets the last seed; whether that is fair
--     is the organiser's call, and every other entrant keeps the seed it had.

--------------------------------------------------------------------------------
-- 1. Withdrawing a team that still holds matches
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.withdraw_placement_team(p_team_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_category uuid;
  v_entrant uuid;
  v_on_court int;
  v_changed int := 0;
  v_draw uuid;
  m record;
  v_match uuid;
  affected uuid[] := '{}';
BEGIN
  SELECT t.tournament_id, t.category_id INTO v_tournament, v_category
  FROM public.teams t WHERE t.id = p_team_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown team';
  END IF;

  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- The day lock and the category key, in the order every other writer uses.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('placement:' || v_category::text));

  SELECT e.id INTO v_entrant
  FROM public.placement_entrants e
  WHERE e.category_id = v_category AND e.team_id = p_team_id;

  IF v_entrant IS NULL THEN
    RAISE EXCEPTION 'That team is not entered in this event';
  END IF;

  -- A team on court is mid-match. Taking it out now would leave a live match with nobody on the
  -- other side, which is a retirement rather than a withdrawal.
  SELECT count(*) INTO v_on_court
  FROM (
    SELECT id FROM public.placement_matches
    WHERE status = 'in-progress' AND (entrant_a_id = v_entrant OR entrant_b_id = v_entrant)
    UNION ALL
    SELECT id FROM public.tier_draw_matches
    WHERE status = 'in-progress' AND (entrant_a_id = v_entrant OR entrant_b_id = v_entrant)
  ) live;

  IF v_on_court > 0 THEN
    RAISE EXCEPTION
      'That team is on court right now (% match%). Finish or void the match first.',
      v_on_court, CASE WHEN v_on_court = 1 THEN '' ELSE 'es' END;
  END IF;

  UPDATE public.teams SET withdrawn = true WHERE id = p_team_id;

  -- Waived rather than deleted, so the recorded results and the place in the seed order both
  -- survive a reversal. `sync_placement_entrants` writes the same flag but is refused once the
  -- tournament is under way; this is the same decision taken later.
  UPDATE public.placement_entrants SET excluded = true WHERE id = v_entrant;

  -- Every unplayed placement match becomes a walkover for the opponent. `walkover` is already in
  -- both status CHECKs and already means "not played, decided", so no new status or vocabulary
  -- reaches the desk.
  FOR m IN
    SELECT id, entrant_a_id, entrant_b_id
    FROM public.placement_matches
    WHERE status = 'scheduled' AND (entrant_a_id = v_entrant OR entrant_b_id = v_entrant)
    ORDER BY scheduled_time NULLS LAST, id
    FOR UPDATE
  LOOP
    UPDATE public.placement_matches
    SET status = 'walkover',
        winner_id = CASE WHEN m.entrant_a_id = v_entrant THEN m.entrant_b_id ELSE m.entrant_a_id END,
        games = '[]'::jsonb,
        note = COALESCE(note || ' · ', '') || 'Opponent withdrew',
        reported_time = statement_timestamp(),
        ended_at = COALESCE(ended_at, statement_timestamp())
    WHERE id = m.id;
    affected := affected || m.id;
    v_changed := v_changed + 1;
  END LOOP;

  -- The bracket. A walkover awards the opponent, so the winner has to reach the next round, which
  -- is what `advance_tier_draw_locked` does for a reported result. Once per draw rather than once
  -- per match: it advances everything that is ready in that draw.
  FOR v_draw IN
    SELECT DISTINCT draw_id
    FROM public.tier_draw_matches
    WHERE entrant_a_id = v_entrant OR entrant_b_id = v_entrant
  LOOP
    FOR m IN
      SELECT id, entrant_a_id, entrant_b_id
      FROM public.tier_draw_matches
      WHERE draw_id = v_draw
        AND status = 'scheduled'
        AND (entrant_a_id = v_entrant OR entrant_b_id = v_entrant)
      ORDER BY round, slot
      FOR UPDATE
    LOOP
      UPDATE public.tier_draw_matches
      SET status = 'walkover',
          winner_id = CASE WHEN m.entrant_a_id = v_entrant THEN m.entrant_b_id ELSE m.entrant_a_id END,
          games = '[]'::jsonb,
          note = COALESCE(note || ' · ', '') || 'Opponent withdrew',
          reported_time = statement_timestamp(),
          ended_at = COALESCE(ended_at, statement_timestamp())
      WHERE id = m.id;
      affected := affected || m.id;
      v_changed := v_changed + 1;
    END LOOP;

    PERFORM public.advance_tier_draw_locked(v_draw);
  END LOOP;

  -- One reflow, after every row is in place, so it reads the finished picture rather than a
  -- half-updated one. Placement matches are attributed to the day by `scheduled_time`, so any one
  -- of the changed rows re-derives the same day.
  FOREACH v_match IN ARRAY affected
  LOOP
    PERFORM public.shift_live_schedule_after_match('placement_matches', v_match);
  END LOOP;

  RETURN v_changed;
END;
$function$;

COMMENT ON FUNCTION public.withdraw_placement_team(uuid) IS
  'Flags a team out of its event, waives its entrant, turns every unplayed match into a walkover for the opponent, advances the bracket and reflows the day. Refused while one of its matches is on court. Returns how many matches it converted.';

--------------------------------------------------------------------------------
-- 2. Adding a team after seeds were locked, but before any match exists
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_placement_entrant(p_category_id uuid, p_team_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_team_category uuid;
  v_matches int;
  v_seed int;
  v_locked timestamptz;
  v_id uuid;
BEGIN
  SELECT c.tournament_id INTO v_tournament
  FROM public.categories c WHERE c.id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown event';
  END IF;

  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Before the draw, not after: once matches exist the pairing is a fact and a new entrant would
  -- have no opponent. Adding one after that is a re-draw, which is a different decision.
  PERFORM public.assert_tournament_configurable(v_tournament);

  SELECT t.category_id INTO v_team_category
  FROM public.teams t WHERE t.id = p_team_id;
  IF v_team_category IS NULL THEN
    RAISE EXCEPTION 'Unknown team';
  END IF;
  IF v_team_category <> p_category_id THEN
    RAISE EXCEPTION 'That team is entered in a different event';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  SELECT count(*) INTO v_matches
  FROM public.placement_matches WHERE category_id = p_category_id;
  IF v_matches > 0 THEN
    RAISE EXCEPTION
      'The draw is already built for this event, so a team cannot be added — reset the stage to change the field';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.placement_entrants
    WHERE category_id = p_category_id AND team_id = p_team_id
  ) THEN
    RAISE EXCEPTION 'That team is already entered in this event';
  END IF;

  -- A late team is the lowest seed. It is not re-ranked into the middle, because every existing
  -- entrant's seed is already published and moving one would silently change a matchup.
  SELECT max(seed), min(seed_locked_at) INTO v_seed, v_locked
  FROM public.placement_entrants WHERE category_id = p_category_id AND NOT excluded;

  INSERT INTO public.placement_entrants (tournament_id, category_id, team_id, seed, seed_locked_at)
  VALUES (
    v_tournament,
    p_category_id,
    p_team_id,
    COALESCE(v_seed, 0) + 1,
    -- Only locked when the category's seeds already were; otherwise it waits for the lock like
    -- every other entrant and can still be re-ordered by hand.
    v_locked
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.add_placement_entrant(uuid, uuid) IS
  'Adds a team to an event that has not been drawn yet, as the lowest seed. Refused once any placement match exists, and for a team from another event. Returns the new entrant id.';

--------------------------------------------------------------------------------
-- 3. Moving the rest of the tournament by whole days
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.shift_tournament_days(
  p_tournament_id uuid,
  p_from_date date,
  p_delta_days int
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tz text;
  v_played int;
  v_moved int := 0;
  v_tier_moved int := 0;
  v_boundary timestamptz;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

  IF p_delta_days IS NULL OR p_delta_days = 0 THEN
    RAISE EXCEPTION 'Choose how many days to move by';
  END IF;
  IF abs(p_delta_days) > 30 THEN
    RAISE EXCEPTION 'A tournament can only be moved by up to 30 days at a time';
  END IF;
  IF p_from_date IS NULL THEN
    RAISE EXCEPTION 'Choose the day the change starts from';
  END IF;

  SELECT t.venue_timezone INTO v_tz
  FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF v_tz IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('tournament-days:' || p_tournament_id::text));

  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_days
    WHERE tournament_id = p_tournament_id AND date = p_from_date
  ) THEN
    RAISE EXCEPTION 'That is not one of this tournament''s playing days';
  END IF;

  -- The start of the first moved day, as the venue means it. A wall clock compared to a
  -- `timestamptz` would be cast in the session's zone - UTC on Supabase - and land every match on
  -- the wrong side of the boundary for a US venue.
  v_boundary := (p_from_date::timestamp) AT TIME ZONE v_tz;

  -- Anything decided on or after the boundary is history, and history does not move: a score was
  -- recorded against the times that were published, so shifting those rows would rewrite a fact.
  SELECT count(*) INTO v_played
  FROM (
    SELECT id FROM public.placement_matches
    WHERE tournament_id = p_tournament_id
      AND scheduled_time >= v_boundary
      AND status NOT IN ('scheduled', 'void')
    UNION ALL
    SELECT id FROM public.tier_draw_matches
    WHERE tournament_id = p_tournament_id
      AND scheduled_time >= v_boundary
      AND status NOT IN ('scheduled', 'void', 'bye')
  ) played;

  IF v_played > 0 THEN
    RAISE EXCEPTION
      'Matches on those days have already been played or started (% of them), so the days cannot be moved',
      v_played;
  END IF;

  -- Window first, then the days: the day-window trigger reads the tournament row, so a day moved
  -- ahead of its window would fail the check on the way.
  UPDATE public.tournaments
  SET starts_on = starts_on + p_delta_days,
      ends_on = ends_on + p_delta_days
  WHERE id = p_tournament_id;

  UPDATE public.tournament_days
  SET date = date + p_delta_days
  WHERE tournament_id = p_tournament_id AND date >= p_from_date;

  -- The matches keep their wall-clock slot: the day moved, so the 10:00 match is still 10:00, just
  -- on the new date. Only the rows that have not been played are touched.
  --
  -- Shifted in the VENUE's zone, not the session's. `scheduled_time + interval '7 days'` preserves
  -- the wall clock of the *session* timezone - UTC on Supabase - so a shift across a DST boundary
  -- would move every match an hour on the venue's clock, which is exactly the thing this is
  -- supposed to preserve. Converting to the venue, adding whole days there, and converting back is
  -- the only form that keeps "10:00" meaning 10:00 to the people playing.
  UPDATE public.placement_matches
  SET scheduled_time =
    ((scheduled_time AT TIME ZONE v_tz) + make_interval(days => p_delta_days)) AT TIME ZONE v_tz
  WHERE tournament_id = p_tournament_id
    AND scheduled_time >= v_boundary
    AND status = 'scheduled';
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  UPDATE public.tier_draw_matches
  SET scheduled_time =
    ((scheduled_time AT TIME ZONE v_tz) + make_interval(days => p_delta_days)) AT TIME ZONE v_tz
  WHERE tournament_id = p_tournament_id
    AND scheduled_time >= v_boundary
    AND status = 'scheduled';
  GET DIAGNOSTICS v_tier_moved = ROW_COUNT;

  v_moved := v_moved + v_tier_moved;

  RETURN v_moved;
END;
$function$;

COMMENT ON FUNCTION public.shift_tournament_days(uuid, date, int) IS
  'Moves the window, every playing day from p_from_date onward, and their unplayed matches by p_delta_days. Refused once any match from that day onward has been played or started, because a recorded result belongs to the time it was played at.';

--------------------------------------------------------------------------------
-- 4. Reassigning a court that has failed
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reassign_court_matches(
  p_tournament_id uuid,
  p_day_id uuid,
  p_from_court_id uuid,
  p_to_court_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tz text;
  v_date date;
  v_start timestamptz;
  v_end timestamptz;
  v_on_court int;
  v_target_busy int;
  v_moved int := 0;
  v_tier_moved int := 0;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

  IF p_from_court_id = p_to_court_id THEN
    RAISE EXCEPTION 'Choose a different court to move the matches to';
  END IF;

  SELECT t.venue_timezone INTO v_tz
  FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF v_tz IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  SELECT d.date INTO v_date
  FROM public.tournament_days d
  WHERE d.id = p_day_id AND d.tournament_id = p_tournament_id;
  IF v_date IS NULL THEN
    RAISE EXCEPTION 'That is not one of this tournament''s days';
  END IF;

  -- Both courts must belong to the tournament.
  IF NOT EXISTS (
    SELECT 1 FROM public.courts
    WHERE id = p_from_court_id AND tournament_id = p_tournament_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.courts
    WHERE id = p_to_court_id AND tournament_id = p_tournament_id
  ) THEN
    RAISE EXCEPTION 'Both courts must belong to this tournament';
  END IF;

  -- A day with no `tournament_day_courts` rows plays on every court; otherwise the target must be
  -- one of the courts that day uses, or the move would put a match on a court the day does not run.
  IF EXISTS (
    SELECT 1 FROM public.tournament_day_courts WHERE day_id = p_day_id
  ) AND NOT EXISTS (
    SELECT 1 FROM public.tournament_day_courts
    WHERE day_id = p_day_id AND court_id = p_to_court_id
  ) THEN
    RAISE EXCEPTION 'That court is not in use on this day — add it to the day first';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('tournament-courts:' || p_tournament_id::text));

  -- The day's territory, in the venue's zone: its own opening to the next day's opening, and
  -- infinity for the last day, which is the one allowed to overrun.
  v_start := (v_date::timestamp) AT TIME ZONE v_tz;
  SELECT min(expected_start) INTO v_end
  FROM (
    SELECT (((d.date::timestamp) AT TIME ZONE v_tz)) AS expected_start
    FROM public.tournament_days d
    WHERE d.tournament_id = p_tournament_id AND d.date > v_date
  ) later;
  v_end := COALESCE(v_end, 'infinity'::timestamptz);

  -- A match already being played cannot be moved mid-game; the desk can void it if the court is
  -- genuinely unusable.
  SELECT count(*) INTO v_on_court
  FROM (
    SELECT id FROM public.placement_matches
    WHERE court_id = p_from_court_id AND status = 'in-progress'
      AND scheduled_time >= v_start AND scheduled_time < v_end
    UNION ALL
    SELECT id FROM public.tier_draw_matches
    WHERE court_id = p_from_court_id AND status = 'in-progress'
      AND scheduled_time >= v_start AND scheduled_time < v_end
  ) live;

  IF v_on_court > 0 THEN
    RAISE EXCEPTION 'A match is being played on that court, so it cannot be reassigned';
  END IF;

  -- The target court must be free for the whole day: moving work onto a court that already has a
  -- schedule would create exactly the overlap conflicts this app spends its time removing.
  SELECT count(*) INTO v_target_busy
  FROM (
    SELECT id FROM public.placement_matches
    WHERE court_id = p_to_court_id AND status = 'scheduled'
      AND scheduled_time >= v_start AND scheduled_time < v_end
    UNION ALL
    SELECT id FROM public.tier_draw_matches
    WHERE court_id = p_to_court_id AND status = 'scheduled'
      AND scheduled_time >= v_start AND scheduled_time < v_end
  ) busy;

  IF v_target_busy > 0 THEN
    RAISE EXCEPTION
      'That court already has % scheduled match% on this day',
      v_target_busy, CASE WHEN v_target_busy = 1 THEN '' ELSE 'es' END;
  END IF;

  UPDATE public.placement_matches
  SET court_id = p_to_court_id
  WHERE court_id = p_from_court_id
    AND status = 'scheduled'
    AND scheduled_time >= v_start AND scheduled_time < v_end;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  UPDATE public.tier_draw_matches
  SET court_id = p_to_court_id
  WHERE court_id = p_from_court_id
    AND status = 'scheduled'
    AND scheduled_time >= v_start AND scheduled_time < v_end;
  GET DIAGNOSTICS v_tier_moved = ROW_COUNT;

  v_moved := v_moved + v_tier_moved;

  RETURN v_moved;
END;
$function$;

COMMENT ON FUNCTION public.reassign_court_matches(uuid, uuid, uuid, uuid) IS
  'Moves one day''s unstarted matches off a failed court onto another court that day already uses and that is free. Refused while the source court is playing, and when the target already has matches that day.';

--------------------------------------------------------------------------------
-- Grants and verification
--------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.withdraw_placement_team(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.withdraw_placement_team(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.add_placement_entrant(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.add_placement_entrant(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.shift_tournament_days(uuid, date, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.shift_tournament_days(uuid, date, int) TO authenticated;
REVOKE ALL ON FUNCTION public.reassign_court_matches(uuid, uuid, uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reassign_court_matches(uuid, uuid, uuid, uuid) TO authenticated;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.withdraw_placement_team(uuid)', 'execute')
     OR has_function_privilege('anon', 'public.add_placement_entrant(uuid, uuid)', 'execute')
     OR has_function_privilege('anon', 'public.shift_tournament_days(uuid, date, int)', 'execute')
     OR has_function_privilege('anon', 'public.reassign_court_matches(uuid, uuid, uuid, uuid)', 'execute') THEN
    RAISE EXCEPTION 'Mid-tournament RPCs must not be executable by anon';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.withdraw_placement_team(uuid)', 'execute') THEN
    RAISE EXCEPTION 'withdraw_placement_team must be executable by authenticated';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
