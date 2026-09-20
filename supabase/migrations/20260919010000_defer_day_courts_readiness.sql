-- ============================================================================
-- Let a tournament activate before its courts exist
-- ============================================================================
--
-- Setup used to ask for the days, each day's hours, and the courts all at once,
-- because `save_tournament_days` is what materialises the venue's `courts` rows.
-- That is why the readiness gate demands "every day has at least one court": the
-- gate and the court-creation step were the same step.
--
-- Courts now belong to the first build on the Schedule page. To make that
-- possible without dead-ending activation, the per-day court check becomes
-- advisory: it is still reported, because a schedule genuinely cannot be built
-- without it, but it no longer holds the Draft -> In Progress transition back.
--
-- Every other check stays blocking. All of them hold with the defaults a new
-- draft is created with, so activating a fresh tournament now succeeds with an
-- empty court list and a warning, which is the intended flow.

CREATE OR REPLACE FUNCTION public.tournament_readiness(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.tournaments%ROWTYPE;
  checks jsonb := '[]'::jsonb;
  day_total int;
  days_without_courts int;
  bad_windows int;
  breaks_outside int;
  overlapping_breaks int;
  duplicate_dates int;
  category_total int;
  over_capped int;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO t FROM public.tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1 FROM public.tournament_day_courts dc WHERE dc.day_id = d.id
      )
    ),
    count(*) FILTER (WHERE d.end_time <= d.start_time)
  INTO day_total, days_without_courts, bad_windows
  FROM public.tournament_days d
  WHERE d.tournament_id = p_tournament_id;

  SELECT count(*) INTO duplicate_dates
  FROM (
    SELECT d.date
    FROM public.tournament_days d
    WHERE d.tournament_id = p_tournament_id
    GROUP BY d.date
    HAVING count(*) > 1
  ) dup;

  -- A break must sit inside its day, and two breaks must not overlap.
  SELECT count(*) INTO breaks_outside
  FROM public.tournament_day_breaks b
  JOIN public.tournament_days d ON d.id = b.day_id
  WHERE b.tournament_id = p_tournament_id
    AND (b.start_time < d.start_time OR b.end_time > d.end_time);

  SELECT count(*) INTO overlapping_breaks
  FROM (
    SELECT b.day_id,
           b.end_time,
           lead(b.start_time) OVER (PARTITION BY b.day_id ORDER BY b.start_time) AS next_start
    FROM public.tournament_day_breaks b
    WHERE b.tournament_id = p_tournament_id
  ) seq
  WHERE seq.next_start IS NOT NULL AND seq.next_start < seq.end_time;

  SELECT count(*) INTO category_total
  FROM public.categories WHERE tournament_id = p_tournament_id;

  SELECT count(*) INTO over_capped
  FROM public.categories c
  WHERE c.tournament_id = p_tournament_id
    AND c.max_entries IS NOT NULL
    AND c.max_entries < 2;

  checks := checks || jsonb_build_object(
    'id', 'basics',
    'label', 'Tournament name, venue and organizer are set',
    'ok', t.name IS NOT NULL AND length(btrim(t.name)) > 0 AND t.venue_name IS NOT NULL,
    'detail', CASE
      WHEN t.name IS NULL OR length(btrim(t.name)) = 0 THEN 'Give the tournament a name.'
      WHEN t.venue_name IS NULL THEN 'Add the venue name.'
      ELSE NULL
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'timezone',
    'label', 'Timezone is valid',
    'ok', EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = t.venue_timezone),
    'detail', CASE
      WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = t.venue_timezone) THEN NULL
      ELSE 'That timezone is not recognised.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'days',
    'label', 'At least one tournament day',
    'ok', day_total >= 1,
    'detail', CASE WHEN day_total >= 1 THEN NULL ELSE 'Add at least one day.' END
  );

  checks := checks || jsonb_build_object(
    'id', 'day_windows',
    'label', 'Every day ends after it starts',
    'ok', bad_windows = 0,
    'detail', CASE
      WHEN bad_windows = 0 THEN NULL
      ELSE bad_windows || ' day(s) have an end time before the start time.'
    END
  );

  -- Advisory: needed to build a schedule, not to activate a tournament whose
  -- courts are configured at the first build. `set_tournament_courts` is what
  -- satisfies this, and the Schedule page says so when it is missing.
  checks := checks || jsonb_build_object(
    'id', 'day_courts',
    'label', 'Every day has at least one court',
    'blocking', false,
    'ok', days_without_courts = 0,
    'detail', CASE
      WHEN days_without_courts = 0 THEN NULL
      ELSE days_without_courts || ' day(s) have no courts selected.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'day_dates',
    'label', 'No two days share a date',
    'ok', duplicate_dates = 0,
    'detail', CASE
      WHEN duplicate_dates = 0 THEN NULL
      ELSE 'Two days use the same date.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'day_breaks',
    'label', 'Breaks sit inside their day and do not overlap',
    'ok', breaks_outside = 0 AND overlapping_breaks = 0,
    'detail', CASE
      WHEN breaks_outside > 0 THEN breaks_outside || ' break(s) fall outside the day window.'
      WHEN overlapping_breaks > 0 THEN 'Two breaks overlap.'
      ELSE NULL
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'categories',
    'label', 'At least one event is switched on',
    'ok', category_total >= 1,
    'detail', CASE
      WHEN category_total >= 1 THEN NULL
      ELSE 'Add at least one event.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'category_caps',
    'label', 'Entry caps leave room for a pool',
    'ok', over_capped = 0,
    'detail', CASE
      WHEN over_capped = 0 THEN NULL
      ELSE over_capped || ' event(s) have a cap below 2.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'rules',
    'label', 'Match rules are valid',
    'ok', t.placement_best_of IN (1, 3, 5, 7, 9)
      AND t.knockout_best_of IN (1, 3, 5, 7, 9)
      AND t.placement_games_to BETWEEN 1 AND 99
      AND t.knockout_games_to BETWEEN 1 AND 99
      AND t.placement_win_by BETWEEN 1 AND 20
      AND t.knockout_win_by BETWEEN 1 AND 20
      AND t.group_slot_minutes > 0
      AND t.knockout_slot_minutes > 0
      AND t.group_rest_gap_minutes >= 0
      AND t.knockout_rest_gap_minutes >= 0,
    'detail', 'Check the scoring, duration and rest settings.'
  );

  -- `blocking` defaults to true, so a check that does not say otherwise is a
  -- hard requirement. Only an explicitly non-blocking check is skipped here.
  RETURN jsonb_build_object(
    'ready', NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(checks) c
      WHERE (c->>'ok')::boolean = false
        AND COALESCE((c->>'blocking')::boolean, true)
    ),
    'checks', checks
  );
END;
$$;

-- CREATE OR REPLACE restores the implicit EXECUTE grant to PUBLIC, which the
-- auth-hardening migration removed. Re-close it here, or this migration would
-- reopen the function to anonymous callers.
REVOKE ALL ON FUNCTION public.tournament_readiness(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.tournament_readiness(uuid) TO authenticated;
