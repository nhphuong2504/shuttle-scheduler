-- Harden apply_day_schedule: serialize with live desk ops and reject partial rebuilds.

CREATE OR REPLACE FUNCTION public.apply_day_schedule(p_day int, p_slots jsonb, p_pool_ends jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  slot jsonb;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:' || p_day::text));

  IF p_day = 1 THEN
    UPDATE public.pool_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE status = 'scheduled';
  ELSE
    UPDATE public.draw_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE status = 'scheduled' AND COALESCE(is_bye, false) = false;
  END IF;

  FOR slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    IF p_day = 1 THEN
      UPDATE public.pool_matches
      SET scheduled_time = (slot->>'scheduled_time')::timestamptz,
          court_id = NULLIF(slot->>'court_id','')::uuid
      WHERE id = (slot->>'match_id')::uuid
        AND status = 'scheduled';
    ELSE
      UPDATE public.draw_matches
      SET scheduled_time = (slot->>'scheduled_time')::timestamptz,
          court_id = NULLIF(slot->>'court_id','')::uuid
      WHERE id = (slot->>'match_id')::uuid
        AND status = 'scheduled';
    END IF;
  END LOOP;

  IF p_day = 1 THEN
    UPDATE public.pools p
    SET scheduled_end = (e.value)::timestamptz
    FROM jsonb_each_text(COALESCE(p_pool_ends, '{}'::jsonb)) e
    WHERE p.id::text = e.key;

    IF EXISTS (
      SELECT 1
      FROM public.pool_matches
      WHERE status = 'scheduled'
        AND team_a_id IS NOT NULL
        AND team_b_id IS NOT NULL
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Day 1 rebuild left assigned matches without a court or time';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM public.draw_matches
      WHERE status = 'scheduled'
        AND COALESCE(is_bye, false) = false
        AND team_a_id IS NOT NULL
        AND team_b_id IS NOT NULL
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Day 2 rebuild left assigned matches without a court or time';
    END IF;
  END IF;
END;
$$;
