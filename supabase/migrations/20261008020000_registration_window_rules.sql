-- ============================================================================
-- Registration window rules, and the playing-day span on the public reads
-- ============================================================================
--
-- Two small things that belong with the window and the lifecycle.
--
-- 1. The registration window is a different thing from the tournament window. It closes
--    before the tournament window opens - at or before 00:00 of `starts_on` in the venue
--    timezone, the same instant the first match may start from - so registering and playing
--    never overlap. Once it has opened its opening time is fixed; it can be extended up to
--    that bound or closed early; and once a schedule has been built it cannot be extended,
--    because the entrants the schedule was built for must not change under it.
--
-- 2. Explore, Home and My Tournaments need to say "should have started" and "past its last
--    day". Those are statements about the *plan*, not the window: a tournament whose window
--    runs 20-30 Oct but which only plays on the 25th is not late on the 20th. So the public
--    reads gain `play_starts_at` and `play_ends_at`, the first and last playing day, which
--    are the instants `tournament_starts_at` / `tournament_ends_at` used to be before they
--    became the window.

-------------------------------------------------------------------------------
-- 1. The playing-day span
-------------------------------------------------------------------------------
--
-- NULL while no playing days have been chosen, which is a normal state now. The same
-- `AT TIME ZONE venue_timezone` rule applies as everywhere a wall-clock day is compared
-- with an absolute time.

CREATE OR REPLACE FUNCTION public.tournament_play_starts_at(p_tournament_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT min((d.date + d.start_time) AT TIME ZONE t.venue_timezone)
  FROM public.tournament_days d
  JOIN public.tournaments t ON t.id = d.tournament_id
  WHERE d.tournament_id = p_tournament_id;
$$;

CREATE OR REPLACE FUNCTION public.tournament_play_ends_at(p_tournament_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT max((d.date + d.end_time) AT TIME ZONE t.venue_timezone)
  FROM public.tournament_days d
  JOIN public.tournaments t ON t.id = d.tournament_id
  WHERE d.tournament_id = p_tournament_id;
$$;

-------------------------------------------------------------------------------
-- 2. The registration window
-------------------------------------------------------------------------------
--
-- `tournament_starts_at` is now 00:00 of the first window date, so the bound already means
-- what it should; the definition is repeated for its message, which now names the instant a
-- host can act on instead of "the time the tournament starts".

CREATE OR REPLACE FUNCTION public.assert_registration_window(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_opens timestamptz;
  v_closes timestamptz;
  v_starts timestamptz;
  v_tz text;
BEGIN
  SELECT t.registration_opens_at, t.registration_closes_at, t.venue_timezone
  INTO v_opens, v_closes, v_tz
  FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  -- No window at all is valid. Half a window is not.
  IF (v_opens IS NULL) <> (v_closes IS NULL) THEN
    RAISE EXCEPTION
      'Set both the opening and the closing time of the registration window, or neither';
  END IF;
  IF v_opens IS NULL THEN
    RETURN;
  END IF;

  IF v_opens >= v_closes THEN
    RAISE EXCEPTION 'Registration must close after it opens';
  END IF;

  v_starts := public.tournament_starts_at(p_tournament_id);
  IF v_closes > v_starts THEN
    RAISE EXCEPTION
      'Registration must close before the tournament starts (% at 00:00). It is set to close %.',
      to_char(v_starts AT TIME ZONE v_tz, 'FMMon FMDD'),
      to_char(v_closes AT TIME ZONE v_tz, 'FMMon FMDD, HH24:MI');
  END IF;
END;
$$;

-- Guards every writer of the two columns: the editor UPDATE grant lets a client write them
-- directly, and `save_tournament_config` writes them too. A rule that lived only in the
-- dedicated RPC would be a rule those two walk around.
CREATE OR REPLACE FUNCTION public.tournaments_guard_registration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Writing the same values back (as a full config save does) is not a change.
  IF NEW.registration_opens_at IS NOT DISTINCT FROM OLD.registration_opens_at
     AND NEW.registration_closes_at IS NOT DISTINCT FROM OLD.registration_closes_at THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'upcoming' THEN
    RAISE EXCEPTION
      'Registration can no longer change: this tournament is %',
      replace(OLD.status, '_', ' ');
  END IF;

  -- Once open, the opening time is a statement people have relied on.
  IF OLD.registration_opens_at IS NOT NULL
     AND OLD.registration_opens_at <= now()
     AND NEW.registration_opens_at IS DISTINCT FROM OLD.registration_opens_at THEN
    RAISE EXCEPTION 'Registration has already opened, so its opening time cannot change';
  END IF;

  -- Extending - or turning registration on - under a built schedule would change who is
  -- playing after the matches were arranged around who was.
  IF NEW.registration_closes_at IS NOT NULL
     AND (OLD.registration_closes_at IS NULL OR NEW.registration_closes_at > OLD.registration_closes_at)
     AND public.tournament_has_schedule(OLD.id) THEN
    RAISE EXCEPTION
      'The schedule has been built, so registration cannot be extended. Reset the schedule first.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tournaments_guard_registration ON public.tournaments;
CREATE TRIGGER tournaments_guard_registration
  BEFORE UPDATE OF registration_opens_at, registration_closes_at
  ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.tournaments_guard_registration();

-- The one call that changes the window on its own. Extending, closing early ("close now"
-- is `p_closes = now()`) and switching registration off are all this; the rules above and
-- `assert_registration_window` decide which are allowed.
CREATE OR REPLACE FUNCTION public.set_registration_window(
  p_tournament_id uuid,
  p_opens timestamptz,
  p_closes timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_configurable(p_tournament_id);

  UPDATE public.tournaments
  SET registration_opens_at = p_opens,
      registration_closes_at = p_closes
  WHERE id = p_tournament_id;

  PERFORM public.assert_registration_window(p_tournament_id);
END;
$$;

COMMENT ON FUNCTION public.set_registration_window(uuid, timestamptz, timestamptz) IS
  'Sets the registration window while the tournament is upcoming. It must close at or before 00:00 of the first window date; once open its opening time is fixed; it cannot be extended once a schedule exists. Both times or neither.';

-------------------------------------------------------------------------------
-- 3. The public reads gain the playing-day span
-------------------------------------------------------------------------------
--
-- The return type changes, which CREATE OR REPLACE cannot do, so both are dropped and
-- re-created. Nothing in the database depends on either (they are read by the app through
-- PostgREST), and the grants are restored below.

DROP FUNCTION IF EXISTS public.tournament_summary(text, text, uuid[], int, int);

CREATE FUNCTION public.tournament_summary(
  p_query text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_ids uuid[] DEFAULT NULL,
  p_limit int DEFAULT 200,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  name text,
  venue_name text,
  status text,
  starts_at timestamptz,
  ends_at timestamptz,
  registration_state text,
  entry_count int,
  category_count int,
  access_level text,
  play_starts_at timestamptz,
  play_ends_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('upcoming', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'Unknown status filter: %', p_status;
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.name,
    t.venue_name,
    t.status,
    public.tournament_starts_at(t.id),
    public.tournament_ends_at(t.id),
    public.tournament_registration_state(t.id),
    (SELECT count(*)::int FROM public.teams tm WHERE tm.tournament_id = t.id),
    (SELECT count(*)::int FROM public.categories c WHERE c.tournament_id = t.id),
    CASE
      WHEN public.is_platform_admin() THEN 'admin'
      WHEN public.is_tournament_owner(t.id) THEN 'owner'
      WHEN public.is_tournament_editor(t.id) THEN 'editor'
      ELSE 'viewer'
    END,
    public.tournament_play_starts_at(t.id),
    public.tournament_play_ends_at(t.id)
  FROM public.tournaments t
  WHERE (p_ids IS NULL OR t.id = ANY (p_ids))
    AND (p_status IS NULL OR t.status = p_status)
    AND (
      v_query IS NULL
      OR t.name ILIKE '%' || v_query || '%'
      OR t.venue_name ILIKE '%' || v_query || '%'
      OR EXISTS (
        SELECT 1
        FROM public.categories c
        WHERE c.tournament_id = t.id
          AND (c.name ILIKE '%' || v_query || '%' OR c.code ILIKE '%' || v_query || '%')
      )
    )
  ORDER BY t.created_at DESC
  LIMIT coalesce(p_limit, 200)
  OFFSET greatest(coalesce(p_offset, 0), 0);
END;
$$;

COMMENT ON FUNCTION public.tournament_summary(text, text, uuid[], int, int) IS
  'The read behind My Tournaments and the create flow list: id, name, venue, status, the tournament window (starts_at, ends_at), the registration state, entry and event counts, the caller''s access level, and the first and last playing day (play_starts_at, play_ends_at, NULL until playing days are chosen). A read, never a gate. Exposes no readiness detail and no editor email.';

DROP FUNCTION IF EXISTS public.explore_tournaments(text, text, boolean, text, text, int, int);

CREATE FUNCTION public.explore_tournaments(
  p_query text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_registration_open boolean DEFAULT false,
  p_range text DEFAULT NULL,
  p_sort text DEFAULT 'soonest',
  p_limit int DEFAULT 12,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  name text,
  venue_name text,
  status text,
  starts_at timestamptz,
  ends_at timestamptz,
  registration_state text,
  entry_count int,
  category_count int,
  access_level text,
  total_count int,
  play_starts_at timestamptz,
  play_ends_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_sort text := coalesce(p_sort, 'soonest');
  v_limit int := least(greatest(coalesce(p_limit, 12), 1), 50);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_window_end timestamptz;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('upcoming', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'Unknown status filter: %', p_status;
  END IF;
  IF v_sort NOT IN ('soonest', 'newest', 'entries', 'name') THEN
    RAISE EXCEPTION 'Unknown sort: %', v_sort;
  END IF;
  IF p_range IS NOT NULL THEN
    v_window_end := CASE p_range
      WHEN 'week' THEN now() + interval '7 days'
      WHEN 'month' THEN now() + interval '1 month'
      WHEN 'quarter' THEN now() + interval '3 months'
      ELSE NULL
    END;
    IF v_window_end IS NULL THEN
      RAISE EXCEPTION 'Unknown range: %', p_range;
    END IF;
  END IF;

  RETURN QUERY
  WITH matched AS (
    SELECT
      t.id AS t_id,
      t.name AS t_name,
      t.venue_name AS t_venue,
      t.status AS t_status,
      t.created_at AS t_created,
      public.tournament_starts_at(t.id) AS t_starts,
      public.tournament_ends_at(t.id) AS t_ends,
      public.tournament_play_starts_at(t.id) AS t_play_starts,
      public.tournament_play_ends_at(t.id) AS t_play_ends,
      public.tournament_registration_state(t.id) AS t_registration,
      (SELECT count(*)::int FROM public.teams tm WHERE tm.tournament_id = t.id) AS t_entries,
      (SELECT count(*)::int FROM public.categories c WHERE c.tournament_id = t.id) AS t_events
    FROM public.tournaments t
    WHERE (p_status IS NULL OR t.status = p_status)
      AND (
        v_query IS NULL
        OR t.name ILIKE '%' || v_query || '%'
        OR t.venue_name ILIKE '%' || v_query || '%'
        OR EXISTS (
          SELECT 1
          FROM public.categories c
          WHERE c.tournament_id = t.id
            AND (c.name ILIKE '%' || v_query || '%' OR c.code ILIKE '%' || v_query || '%')
        )
      )
  ),
  filtered AS (
    SELECT m.*
    FROM matched m
    WHERE (NOT coalesce(p_registration_open, false) OR m.t_registration = 'open')
      AND (
        v_window_end IS NULL
        OR (
          m.t_starts <= v_window_end
          AND coalesce(m.t_ends, m.t_starts) >= now()
        )
      )
  )
  SELECT
    f.t_id,
    f.t_name,
    f.t_venue,
    f.t_status,
    f.t_starts,
    f.t_ends,
    f.t_registration,
    f.t_entries,
    f.t_events,
    CASE
      WHEN public.is_platform_admin() THEN 'admin'
      WHEN public.is_tournament_owner(f.t_id) THEN 'owner'
      WHEN public.is_tournament_editor(f.t_id) THEN 'editor'
      ELSE 'viewer'
    END,
    (count(*) OVER ())::int,
    f.t_play_starts,
    f.t_play_ends
  FROM filtered f
  ORDER BY
    CASE WHEN v_sort = 'soonest' AND f.t_status <> 'completed' THEN f.t_starts END ASC NULLS LAST,
    CASE WHEN v_sort = 'soonest' AND f.t_status = 'completed' THEN f.t_ends END DESC NULLS LAST,
    CASE WHEN v_sort = 'entries' THEN f.t_entries END DESC,
    CASE WHEN v_sort = 'name' THEN lower(f.t_name) END ASC,
    f.t_created DESC,
    f.t_id
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;

COMMENT ON FUNCTION public.explore_tournaments(text, text, boolean, text, text, int, int) IS
  'One page of the public tournament list: the card fields of tournament_summary plus total_count, the size of the whole result. Filters: search term, status, registration open, a date window (week | month | quarter) that the tournament window overlaps. Sorts: soonest | newest | entries | name, always ending in the id so pages add up. Page size is clamped to 50. A read, never a gate.';

-------------------------------------------------------------------------------
-- 4. Privileges
-------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.tournament_summary(text, text, uuid[], int, int) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.tournament_summary(text, text, uuid[], int, int) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.explore_tournaments(text, text, boolean, text, text, int, int) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.explore_tournaments(text, text, boolean, text, text, int, int) TO anon, authenticated;

DO $privileges$
DECLARE
  f text;
  internals text[] := array[
    'tournament_play_starts_at(uuid)',
    'tournament_play_ends_at(uuid)',
    'assert_registration_window(uuid)',
    'tournaments_guard_registration()'
  ];
BEGIN
  FOREACH f IN ARRAY internals LOOP
    EXECUTE format('revoke all on function public.%s from anon, authenticated, public', f);
    EXECUTE format('grant execute on function public.%s to service_role', f);
  END LOOP;
END;
$privileges$;

REVOKE ALL ON FUNCTION public.set_registration_window(uuid, timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_registration_window(uuid, timestamptz, timestamptz) TO authenticated;

-------------------------------------------------------------------------------
-- 5. Verify
-------------------------------------------------------------------------------

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tournaments_guard_registration' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M3: the registration guard on tournaments was not created';
  END IF;

  -- A public read must stay public and gain no more.
  IF NOT has_function_privilege('anon', 'public.explore_tournaments(text, text, boolean, text, text, int, int)', 'execute')
     OR NOT has_function_privilege('anon', 'public.tournament_summary(text, text, uuid[], int, int)', 'execute') THEN
    RAISE EXCEPTION 'M3: the public reads must remain executable by anon';
  END IF;
  IF has_function_privilege('anon', 'public.set_registration_window(uuid, timestamptz, timestamptz)', 'execute') THEN
    RAISE EXCEPTION 'M3: set_registration_window must not be executable by anon';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'explore_tournaments'
      AND pg_get_function_result(p.oid) LIKE '%play_starts_at%'
      AND pg_get_function_result(p.oid) LIKE '%play_ends_at%'
  ) THEN
    RAISE EXCEPTION 'M3: explore_tournaments does not return the playing-day span';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
