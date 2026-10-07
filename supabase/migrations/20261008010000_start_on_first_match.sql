-- ============================================================================
-- A tournament starts when its first match starts
-- ============================================================================
--
-- `start_tournament` was a button nobody should have to press: the thing that makes a
-- tournament "in progress" is a match being played, and a host could press Start with no
-- match anywhere near ready, or forget to and leave a running tournament "upcoming". The
-- transition now happens where the fact does - inside the three RPCs that start a match.
--
--   upcoming -> in_progress   the first match started, from 00:00 of the window's first
--                             date in the venue timezone (`tournament_starts_at`)
--   in_progress -> completed  the host presses Complete, refused while a match is on court
--
-- Every other lifecycle rule stands. Scoring, resetting and rescheduling still require an
-- in-progress tournament (`assert_tournament_live`, unchanged), and a completed
-- tournament can never have a match started, platform admin or not.
--
-- ## Why the flip comes before the match update
--
-- The transition runs right after the guard and before the match row is touched. The match
-- update fires triggers (the desk activity log, realtime), and none of them may observe a
-- match on court inside a tournament that is still upcoming. If the start then fails - the
-- match is not scheduled, a court is busy, a player is resting - the function raises and the
-- transaction, the flip with it, is rolled back; a refused start never starts a tournament.
--
-- ## Why a shared lock
--
-- Completing and starting must not interleave: a Complete that decided "nothing is on
-- court" must not commit after a match has started. Starters take a *shared* advisory lock
-- on the tournament and Complete takes it *exclusively*, so any number of matches may
-- start together but never alongside a Complete. A row lock would not do: two first
-- matches would each hold the row shared and then both try to upgrade it to flip the
-- status, which is a deadlock.

-------------------------------------------------------------------------------
-- 1. The start guard
-------------------------------------------------------------------------------
--
-- Not `assert_tournament_live`: that one refuses an upcoming tournament, which is exactly
-- the state the first match starts in. Two states are allowed, one is not.

CREATE OR REPLACE FUNCTION public.assert_tournament_can_start_match(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state text := public.tournament_lifecycle_state(p_tournament_id);
  v_starts timestamptz;
  v_tz text;
BEGIN
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_state = 'completed' THEN
    RAISE EXCEPTION 'This tournament is completed, so no match can be started';
  END IF;

  -- In progress has already crossed the line; only an upcoming tournament is measured.
  IF v_state = 'upcoming' THEN
    SELECT t.venue_timezone INTO v_tz FROM public.tournaments t WHERE t.id = p_tournament_id;
    v_starts := public.tournament_starts_at(p_tournament_id);
    IF now() < v_starts THEN
      RAISE EXCEPTION
        'Matches can be started from % (venue time)',
        to_char(v_starts AT TIME ZONE v_tz, 'FMMon FMDD, HH24:MI');
    END IF;
  END IF;
END;
$$;

-- The transition itself. Idempotent: it only ever moves an upcoming tournament forward,
-- so the second of two concurrent first matches finds nothing to do. Written by a
-- SECURITY DEFINER function because `status` is not in the authenticated UPDATE grant.
CREATE OR REPLACE FUNCTION public.mark_tournament_started(p_tournament_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.tournaments
  SET status = 'in_progress'
  WHERE id = p_tournament_id AND status = 'upcoming';
$$;

-- The shared half of the lifecycle lock. Taken first, before any lock a start RPC already
-- takes, so the order is the same everywhere: lifecycle, then the rest.
CREATE OR REPLACE FUNCTION public.lock_tournament_lifecycle_shared(p_tournament_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_advisory_xact_lock_shared(hashtext('lifecycle:' || p_tournament_id::text));
$$;

-------------------------------------------------------------------------------
-- 2. The three RPCs that start a match
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.start_placement_match(p_match_id uuid, p_court_id uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
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

  UPDATE public.placement_matches
  SET status = 'in-progress',
      started_at = COALESCE(started_at, statement_timestamp()),
      court_id = COALESCE(p_court_id, court_id)
  WHERE id = p_match_id AND status = 'scheduled';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match is not ready to start';
  END IF;
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
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_tier_draw_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.lock_tournament_lifecycle_shared(v_tournament);
  PERFORM public.assert_tournament_can_start_match(v_tournament);
  PERFORM public.mark_tournament_started(v_tournament);

  UPDATE public.tier_draw_matches
  SET status = 'in-progress',
      started_at = COALESCE(started_at, statement_timestamp()),
      court_id = COALESCE(p_court_id, court_id)
  WHERE id = p_match_id AND status = 'scheduled' AND NOT is_bye;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match is not ready to start';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_match_safe(p_table text, p_match_id uuid, p_court_id uuid, p_ignore_rest boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament(p_table, p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.lock_tournament_lifecycle_shared(v_tournament);
  PERFORM public.assert_tournament_can_start_match(v_tournament);
  PERFORM public.mark_tournament_started(v_tournament);
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));
  PERFORM public.assert_match_eligible(
    p_table,
    p_match_id,
    p_court_id,
    statement_timestamp(),
    true,
    p_ignore_rest
  );

  IF p_table = 'pool_matches' THEN
    UPDATE public.pool_matches
    SET status = 'in-progress',
        started_at = statement_timestamp(),
        court_id = p_court_id
    WHERE id = p_match_id
      AND status = 'scheduled';
  ELSIF p_table = 'draw_matches' THEN
    UPDATE public.draw_matches
    SET status = 'in-progress',
        started_at = statement_timestamp(),
        court_id = p_court_id
    WHERE id = p_match_id
      AND status = 'scheduled';
  ELSE
    RAISE EXCEPTION 'Unsupported match table';
  END IF;
END;
$function$;

-------------------------------------------------------------------------------
-- 3. There is no start_tournament
-------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.start_tournament(uuid);

-------------------------------------------------------------------------------
-- 4. Completing
-------------------------------------------------------------------------------
--
-- Refused while any match is on court: a game in progress is real, and Complete locks
-- every result. Unplayed matches do not block it - a tournament may be cut short for
-- weather or withdrawals - but the host is shown how many, which is what
-- `tournament_completion_check` is for. The exclusive lifecycle lock makes the check and
-- the write one decision against any match starting at the same moment.

CREATE OR REPLACE FUNCTION public.complete_tournament(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state text;
  v_on_court int;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Exclusive: waits for every starting match, and holds off any new one.
  PERFORM pg_advisory_xact_lock(hashtext('lifecycle:' || p_tournament_id::text));
  PERFORM pg_advisory_xact_lock(hashtext('tournaments'));

  SELECT status INTO v_state FROM public.tournaments WHERE id = p_tournament_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_state = 'upcoming' THEN
    RAISE EXCEPTION 'A tournament can only be completed once it has started';
  END IF;
  IF v_state = 'completed' THEN
    RAISE EXCEPTION 'This tournament is already completed';
  END IF;

  v_on_court := (public.tournament_completion_counts(p_tournament_id)->>'on_court')::int;
  IF v_on_court > 0 THEN
    RAISE EXCEPTION
      '% match(es) are still being played. Finish or cancel them before completing the tournament.',
      v_on_court;
  END IF;

  -- No reverse transition: a mis-completion is corrected by a platform admin through
  -- the repair paths, not by a reopen RPC.
  UPDATE public.tournaments SET status = 'completed' WHERE id = p_tournament_id;
END;
$$;

COMMENT ON FUNCTION public.complete_tournament(uuid) IS
  'in_progress -> completed, for an owner, an editor or a platform admin. Refused while a match is on court. Serialised against starting matches by the lifecycle lock. Deliberately irreversible.';

-- What is left to play, as plain counts. Statuses: scheduled (unplayed), in-progress
-- (on court); reported, walkover, bye and void are settled.
CREATE OR REPLACE FUNCTION public.tournament_completion_counts(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH m AS (
    SELECT status FROM public.placement_matches WHERE tournament_id = p_tournament_id
    UNION ALL SELECT status FROM public.tier_draw_matches WHERE tournament_id = p_tournament_id
    UNION ALL SELECT status FROM public.pool_matches WHERE tournament_id = p_tournament_id
    UNION ALL SELECT status FROM public.draw_matches WHERE tournament_id = p_tournament_id
  )
  SELECT jsonb_build_object(
    'on_court', count(*) FILTER (WHERE status = 'in-progress'),
    'unplayed', count(*) FILTER (WHERE status = 'scheduled'),
    'total',    count(*) FILTER (WHERE status NOT IN ('void', 'bye'))
  )
  FROM m;
$$;

-- The editor-facing read behind the Complete dialog.
CREATE OR REPLACE FUNCTION public.tournament_completion_check(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN public.tournament_completion_counts(p_tournament_id);
END;
$$;

COMMENT ON FUNCTION public.tournament_completion_check(uuid) IS
  'For an editor: {on_court, unplayed, total} match counts. The Complete dialog blocks on on_court and warns on unplayed. A read, never a gate - complete_tournament enforces on_court itself.';

-------------------------------------------------------------------------------
-- 5. Privileges
-------------------------------------------------------------------------------

DO $privileges$
DECLARE
  f text;
  internals text[] := array[
    'assert_tournament_can_start_match(uuid)',
    'mark_tournament_started(uuid)',
    'lock_tournament_lifecycle_shared(uuid)',
    'tournament_completion_counts(uuid)'
  ];
  client text[] := array[
    'start_placement_match(uuid, uuid)',
    'start_tier_draw_match(uuid, uuid)',
    'start_match_safe(text, uuid, uuid, boolean)',
    'complete_tournament(uuid)',
    'tournament_completion_check(uuid)'
  ];
BEGIN
  FOREACH f IN ARRAY internals LOOP
    EXECUTE format('revoke all on function public.%s from anon, authenticated, public', f);
    EXECUTE format('grant execute on function public.%s to service_role', f);
  END LOOP;
  FOREACH f IN ARRAY client LOOP
    EXECUTE format('revoke all on function public.%s from public, anon', f);
    EXECUTE format('grant execute on function public.%s to authenticated', f);
  END LOOP;
END;
$privileges$;

-------------------------------------------------------------------------------
-- 6. Verify
-------------------------------------------------------------------------------

DO $verify$
DECLARE
  f record;
BEGIN
  IF to_regprocedure('public.start_tournament(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'M2: start_tournament still exists';
  END IF;

  -- The three start RPCs no longer demand an in-progress tournament, and each one is
  -- the thing that flips it.
  FOR f IN
    SELECT p.proname, p.prosrc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('start_placement_match', 'start_tier_draw_match', 'start_match_safe')
  LOOP
    IF f.prosrc LIKE '%assert_tournament_live(%' THEN
      RAISE EXCEPTION 'M2: % still requires an in-progress tournament', f.proname;
    END IF;
    IF f.prosrc NOT LIKE '%assert_tournament_can_start_match(%'
       OR f.prosrc NOT LIKE '%mark_tournament_started(%'
       OR f.prosrc NOT LIKE '%lock_tournament_lifecycle_shared(%' THEN
      RAISE EXCEPTION 'M2: % is missing the start guard, the lock or the transition', f.proname;
    END IF;
  END LOOP;

  -- Complete takes the exclusive half of the same lock.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'complete_tournament'
      AND p.prosrc LIKE '%hashtext(''lifecycle:''%'
      AND p.prosrc LIKE '%tournament_completion_counts(%'
  ) THEN
    RAISE EXCEPTION 'M2: complete_tournament must take the lifecycle lock and check the matches on court';
  END IF;

  -- The guard must not consult the platform role: a completed tournament never has a
  -- match started, whoever is asking.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'assert_tournament_can_start_match'
      AND p.prosrc LIKE '%is_platform_admin%'
  ) THEN
    RAISE EXCEPTION 'M2: assert_tournament_can_start_match must not consult the platform role';
  END IF;

  IF has_function_privilege('authenticated', 'public.mark_tournament_started(uuid)', 'execute') THEN
    RAISE EXCEPTION 'M2: mark_tournament_started is the transition and must not be a client RPC';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
