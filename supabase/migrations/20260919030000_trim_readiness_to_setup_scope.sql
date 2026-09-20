-- ============================================================================
-- Scope the activation checklist to what setup actually asks for
-- ============================================================================
--
-- Setup was reduced to four inputs: the basics, a date range, the events and the
-- fixed format. The venue's courts, each day's hours and breaks, match lengths and
-- scoring rules all moved to the Schedule page, where they are configured at the
-- first build and validated on every write.
--
-- `tournament_readiness` was still checking those moved fields. That was survivable
-- while only the court check was advisory, but it left the review step reporting on
-- settings the wizard never asked about:
--
--   * "Every day has at least one court" could not pass before activation, by
--     design, so it was a permanent advisory on a screen whose whole job is to say
--     what still has to be fixed.
--   * "Every day ends after it starts" and "Breaks sit inside their day" are true by
--     construction: `buildDayRange` emits the 09:00-18:30 default for every day and
--     no breaks at all, so both rows were always green.
--   * "Match rules are valid" only ever read the column defaults, because rules are
--     edited after activation.
--
-- The deeper problem is *when* this function runs. It is consulted when a draft is
-- activated, and at that moment every Schedule-owned field still holds its default.
-- So none of those checks could catch anything real, while the write paths that do
-- own those fields already validate on the way in:
--
--   * `save_tournament_draft` rejects an unknown timezone and an even best-of.
--   * `save_tournament_days` rejects a day whose end time is not after its start.
--   * `updateTournamentMatchSettings` re-validates every scoring bound.
--   * `updateTournamentTimings` keeps slots positive and rest gaps non-negative.
--
-- The rule for what survives: a check has to validate something this wizard collects,
-- or something derived from what it collects. A check over a field the organizer sets
-- later is either always green here or always red here, and neither one is a verdict on
-- the draft. The six that remain are each blocking, so the checklist is all-or-nothing
-- again, and a green checklist means "this draft is complete".

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

  SELECT count(*) INTO day_total
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

  SELECT count(*) INTO category_total
  FROM public.categories WHERE tournament_id = p_tournament_id;

  SELECT count(*) INTO over_capped
  FROM public.categories c
  WHERE c.tournament_id = p_tournament_id
    AND c.max_entries IS NOT NULL
    AND c.max_entries < 2;

  -- The label says name and venue because that is all this reads. Organizer details
  -- are explicitly for the host's reference, so they must not gate activation.
  checks := checks || jsonb_build_object(
    'id', 'basics',
    'label', 'Tournament name and venue are set',
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
    'id', 'day_dates',
    'label', 'No two days share a date',
    'ok', duplicate_dates = 0,
    'detail', CASE
      WHEN duplicate_dates = 0 THEN NULL
      ELSE 'Two days use the same date.'
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

  -- `blocking` is still honoured and still defaults to true, so a check added later
  -- can be advisory without touching this expression. Nothing is advisory today.
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
