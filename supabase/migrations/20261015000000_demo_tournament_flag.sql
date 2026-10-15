-- ============================================================================
-- Demo tournaments: an explicit flag, and the two public reads that carry it
-- ============================================================================
--
-- Explore is empty on a fresh project, which makes the product look unfinished to the
-- one audience that has nothing else to judge it by: a visitor deciding whether this is
-- worth signing up for. Sample tournaments fix that, and this migration is the part of
-- the mechanism that has to live in the schema: a way to say "this row is sample data"
-- that the app can read, and that nothing else can be mistaken for.
--
-- ## Why a column rather than a naming convention
--
-- The obvious alternative is a convention - a reserved venue, an organizer email at a
-- domain nobody owns, a prefix on the name - and every one of them is a rule that a
-- later edit silently breaks. Somebody renames the venue, or the naming convention is
-- applied by hand once and forgotten, and the sample row is then indistinguishable from
-- real data in exactly the place that matters: the query that counts.
--
-- `is_demo` is a column the *schema* holds, so:
--
--   * a read can filter on it without parsing a name;
--   * a client cannot set it - it is withheld from the editor UPDATE grant below, and
--     INSERT on `tournaments` is already revoked from anon and authenticated, so only
--     the service role ever writes it;
--   * "re-seed" and "remove" are `WHERE is_demo`, which cannot miss a row and cannot
--     touch a real one.
--
-- ## Why `players` gets one too
--
-- `players` is the one global table - no `tournament_id`, one row per person ever
-- entered. A sample roster therefore cannot be removed by deleting the sample
-- tournaments: the people would survive with nothing referencing them, indistinguishable
-- from walk-ins a real desk added. The same argument applies to the roster search, which
-- spans every tournament on the platform: without a marker, a real organiser typing
-- "Kevin" would be offered the sample Kevin. The flag is what makes both removable and
-- excludable.
--
-- ## What this deliberately does not do
--
-- It seeds nothing. The data lives in `20261015010000_demo_tournament_seed.sql`, which
-- defines the functions but runs none of them, so pushing this branch to production
-- leaves production with an empty column and an uncalled function. Seeding production is
-- a separate, deliberate act.

-------------------------------------------------------------------------------
-- 1. The flag
-------------------------------------------------------------------------------

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tournaments.is_demo IS
  'True for a sample tournament created by seed_demo_tournaments(). Never holds real data; excluded from usage figures and removable wholesale by remove_demo_tournaments(). Withheld from the editor UPDATE grant, so a client can neither set nor clear it.';

-- Partial, because almost every row is false and a full index on a boolean is not
-- selective. The reads filter `WHERE is_demo`, which this answers directly.
CREATE INDEX IF NOT EXISTS tournaments_demo_idx
  ON public.tournaments (is_demo) WHERE is_demo;

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.players.is_demo IS
  'True for a sample person created by seed_demo_tournaments(). Excluded from search_players, so the sample roster cannot be offered to a real organiser filling a real draw, and deleted wholesale by remove_demo_tournaments().';

CREATE INDEX IF NOT EXISTS players_demo_idx
  ON public.players (is_demo) WHERE is_demo;

-------------------------------------------------------------------------------
-- 2. The two public reads carry the flag
-------------------------------------------------------------------------------
--
-- Explore has to draw the label, and the workspace header has to state it, so the fact
-- has to survive the read the app actually uses. Both functions return an explicit
-- `RETURNS TABLE`, which `CREATE OR REPLACE` cannot change, so both are dropped and
-- re-created exactly as `20261008020000` last left them plus the one column. Their
-- bodies are otherwise unchanged on purpose: this migration is meant to be readable as
-- a diff of one column, not a rewrite of the ordering or the filters.
--
-- Nothing in the database depends on either function (the app reads them through
-- PostgREST), and the grants are restored in section 4.

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
  play_ends_at timestamptz,
  is_demo boolean
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
    public.tournament_play_ends_at(t.id),
    t.is_demo
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
  'The read behind My Tournaments and the create flow list: id, name, venue, status, the tournament window (starts_at, ends_at), the registration state, entry and event counts, the caller''s access level, the first and last playing day (play_starts_at, play_ends_at, NULL until playing days are chosen), and is_demo, the sample-data marker. A read, never a gate. Exposes no readiness detail and no editor email.';

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
  play_ends_at timestamptz,
  is_demo boolean
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
      t.is_demo AS t_is_demo,
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
    f.t_play_ends,
    f.t_is_demo
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
  'One page of the public tournament list: the card fields of tournament_summary plus total_count, the size of the whole result, and is_demo. Filters: search term, status, registration open, a date window (week | month | quarter) that the tournament window overlaps. Sorts: soonest | newest | entries | name, always ending in the id so pages add up. Page size is clamped to 50. A read, never a gate.';

-------------------------------------------------------------------------------
-- 3. The roster search stops answering with sample people
-------------------------------------------------------------------------------
--
-- `search_players` is the one read that spans every tournament on the platform: the desk
-- searching for a person to enter. It is editor-only, and a real tournament's editor is
-- exactly who must not be offered a sample person - adding "the Kevin from the demo" to a
-- real draw is the leak the flag exists to prevent. `tournament_players` needs no such
-- treatment: it is scoped to one tournament, and a sample person is only ever on a sample
-- tournament's teams.
--
-- The body is `20261009000000`'s with one predicate added; the grants it set are restored
-- below.

CREATE OR REPLACE FUNCTION public.search_players(
  p_tournament_id uuid,
  p_query text,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (id uuid, name text, gender text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query text := btrim(COALESCE(p_query, ''));
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Two characters or more: a single letter matches a third of the roster and is a listing, not a
  -- search. The caller gets an empty answer rather than an error, so a half-typed box is quiet.
  IF char_length(v_query) < 2 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.name, p.gender
  FROM public.players p
  -- `%`, `_` and the escape character are literal in what somebody types.
  WHERE p.name ILIKE '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    AND NOT p.is_demo
  ORDER BY p.name, p.id
  LIMIT least(greatest(COALESCE(p_limit, 20), 1), 50);
END;
$$;

COMMENT ON FUNCTION public.search_players(uuid, text, integer) IS
  'Name search over the global roster for the desk adding an entry. Editors of the tournament only; at least two characters; at most 50 rows; never returns sample people (players.is_demo).';

-------------------------------------------------------------------------------
-- 4. Privileges
-------------------------------------------------------------------------------
--
-- The two reads stay public, exactly as before. The flag itself is not a privilege: it is
-- withheld from the editor UPDATE grant, so no client can write it, and the verify block
-- asserts that rather than trusting it.

REVOKE ALL ON FUNCTION public.tournament_summary(text, text, uuid[], int, int) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.tournament_summary(text, text, uuid[], int, int) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.explore_tournaments(text, text, boolean, text, text, int, int) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.explore_tournaments(text, text, boolean, text, text, int, int) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.search_players(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_players(uuid, text, integer) TO authenticated;

-------------------------------------------------------------------------------
-- 5. Verify
-------------------------------------------------------------------------------

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tournaments'
      AND column_name = 'is_demo' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'D1: tournaments.is_demo is missing or nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'players'
      AND column_name = 'is_demo' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'D1: players.is_demo is missing or nullable';
  END IF;

  -- A public read must stay public, and must carry the flag.
  IF NOT has_function_privilege('anon', 'public.explore_tournaments(text, text, boolean, text, text, int, int)', 'execute')
     OR NOT has_function_privilege('anon', 'public.tournament_summary(text, text, uuid[], int, int)', 'execute') THEN
    RAISE EXCEPTION 'D1: the public reads must remain executable by anon';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'explore_tournaments'
      AND pg_get_function_result(p.oid) LIKE '%is_demo%'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'tournament_summary'
      AND pg_get_function_result(p.oid) LIKE '%is_demo%'
  ) THEN
    RAISE EXCEPTION 'D1: the public reads do not return is_demo';
  END IF;

  -- The flag is the schema's, not the client's. A column grant would let an editor mark a
  -- real tournament as sample data (or a sample one as real), which is the distinction the
  -- whole mechanism rests on.
  IF has_column_privilege('authenticated', 'public.tournaments', 'is_demo', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.players', 'is_demo', 'UPDATE') THEN
    RAISE EXCEPTION 'D1: is_demo must not be writable by a client';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
