-- ============================================================================
-- Set how many courts the venue has
-- ============================================================================
--
-- The setup wizard used to derive the `courts` rows from the day payload, which
-- is why it had to ask for courts before the tournament was even active. Courts
-- now belong to the first build on the Schedule page, so the venue needs a verb
-- of its own.
--
-- `save_tournament_days` cannot serve this: it refuses anything that is not a
-- draft, and it rewrites the day rows as a side effect. This only touches the
-- `courts` rows and the `court_count` summary.
--
-- Per-day court assignments are deliberately left alone. With no rows for a day,
-- `courtsForDay` reads it as "every court", which is exactly the state a fresh
-- venue should be in: adding courts makes them available everywhere until a host
-- says otherwise on the Schedule page.

CREATE OR REPLACE FUNCTION public.set_tournament_courts(
  p_tournament_id uuid,
  p_count int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_in_use int;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  IF p_count IS NULL OR p_count < 1 OR p_count > 64 THEN
    RAISE EXCEPTION 'A venue has between 1 and 64 courts';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament-courts:' || p_tournament_id::text));

  -- A court is `ON DELETE SET NULL` from every match, so removing one that is in
  -- use would unassign a live match rather than fail: the desk would lose the
  -- court a match is on and the schedule would quietly grow a hole. Refuse the
  -- shrink instead, and name the court so the host can move the match first.
  SELECT count(*) INTO v_in_use
  FROM public.courts c
  WHERE c.tournament_id = p_tournament_id
    AND c.number > p_count
    AND (
      EXISTS (
        SELECT 1 FROM public.placement_matches m
        WHERE m.court_id = c.id AND m.status <> 'void'
      )
      OR EXISTS (
        SELECT 1 FROM public.tier_draw_matches m
        WHERE m.court_id = c.id AND m.status <> 'void'
      )
      OR EXISTS (
        SELECT 1 FROM public.pool_matches m
        WHERE m.court_id = c.id AND m.status <> 'void'
      )
      OR EXISTS (
        SELECT 1 FROM public.draw_matches m
        WHERE m.court_id = c.id AND m.status <> 'void'
      )
    );

  IF v_in_use > 0 THEN
    RAISE EXCEPTION
      'Cannot remove % court(s): they still hold a match. Move those matches first.',
      v_in_use;
  END IF;

  -- Shrink first, then fill the gaps, so the pool is always numbered 1..p_count
  -- without ever colliding on the per-tournament unique number.
  DELETE FROM public.courts
  WHERE tournament_id = p_tournament_id
    AND number > p_count;

  INSERT INTO public.courts (tournament_id, number)
  SELECT p_tournament_id, series.n
  FROM generate_series(1, p_count) AS series(n)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.courts c
    WHERE c.tournament_id = p_tournament_id
      AND c.number = series.n
  );

  UPDATE public.tournaments
  SET court_count = p_count
  WHERE id = p_tournament_id;
END;
$$;

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default; keep anonymous callers out.
REVOKE ALL ON FUNCTION public.set_tournament_courts(uuid, int) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_tournament_courts(uuid, int) TO authenticated;
