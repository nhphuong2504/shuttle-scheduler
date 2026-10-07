-- ============================================================================
-- Explore at scale: a paged, filtered, sorted read, and the counts beside it
-- ============================================================================
--
-- `tournament_summary` returns every tournament it is asked for, newest first, and stops at
-- 200. That is right for My Tournaments and the create flow's list, and it is wrong for a
-- public page that has to stay usable with a few thousand rows: it cannot be paged
-- coherently, it cannot be sorted by anything a visitor cares about, and past 200 rows it
-- stops without saying so.
--
-- Explore therefore gets its own pair of reads, and `tournament_summary` is left exactly as
-- it is. Adding parameters to it would create an overload with defaults, and PostgREST cannot
-- choose between overloads that differ only by defaulted arguments; a second function is the
-- change that cannot break the pages that already call the first.
--
--   explore_tournaments(...)        one page of cards, with the size of the whole result
--   explore_tournament_counts(...)  how many match per status, for the filter buttons
--
-- Both are reads, never gates. Both are granted to `anon`, because Explore is a public page
-- and every column is one the anonymous desk view already shows.
--
-- ## Why every argument is a closed vocabulary
--
-- `anon` can call these, so none of them takes a free-form value that reaches the query other
-- than the search term. `p_status`, `p_range` and `p_sort` are checked against a list and an
-- unknown word raises, like `tournament_summary` does for its status: a filter that quietly
-- answers "everything" for a typo is how a page ends up showing something other than what it
-- says it is showing. The page size is clamped, so a caller cannot ask for the whole table.
--
-- ## Why the order ends in `t.id`
--
-- A page is `LIMIT ... OFFSET ...`. Two rows that tie on every sort key may be returned in
-- either order by two calls, so a row can appear at the end of page one and again at the
-- start of page two, or be skipped. Ending every ordering with the primary key makes the
-- order total, which is what makes the pages add up.

-- ---------------------------------------------------------------------------
-- 1. One page of cards
-- ---------------------------------------------------------------------------
--
-- `p_range` keeps tournaments whose playing days overlap the window that starts now:
-- `week` is the next 7 days, `month` the next month, `quarter` the next three. A
-- tournament with no playing days yet has no dates to overlap and is left out of a dated
-- window rather than guessed into one. A finished tournament has already ended, so a window
-- never contains it; the page does not offer a window beside the Completed filter.
--
-- `p_sort`:
--   soonest   what is on or coming first. Live and upcoming events by start, then finished
--             ones by how recently they ended. This is the default, because it is the order
--             in which the three groups on the page are read.
--   newest    the order the rows were created in.
--   entries   the biggest events first.
--   name      A to Z.
--
-- `total_count` is the number of rows that match *before* the page is cut, taken in the same
-- statement as the page itself, so the "Showing 12 of 37" line and the rows beside it cannot
-- come from two different moments.
CREATE OR REPLACE FUNCTION public.explore_tournaments(
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
  total_count int
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
          m.t_starts IS NOT NULL
          AND m.t_starts <= v_window_end
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
    (count(*) OVER ())::int
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
  'One page of the public tournament list: the card fields of tournament_summary plus total_count, the size of the whole result. Filters: search term, status, registration open, a date window (week | month | quarter). Sorts: soonest | newest | entries | name, always ending in the id so pages add up. Page size is clamped to 50. A read, never a gate.';

-- ---------------------------------------------------------------------------
-- 2. The counts beside the filter buttons
-- ---------------------------------------------------------------------------
--
-- How many tournaments match the search, the registration filter and the date window, for
-- each of the three statuses. It ignores the status filter itself, because the point of the
-- buttons is to show what each one *would* give. Every status is always present, with a zero
-- where nothing matches, so the page never has to decide what a missing row means.
CREATE OR REPLACE FUNCTION public.explore_tournament_counts(
  p_query text DEFAULT NULL,
  p_registration_open boolean DEFAULT false,
  p_range text DEFAULT NULL
)
RETURNS TABLE (
  status text,
  total int
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
  v_window_end timestamptz;
BEGIN
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
      t.status AS t_status,
      public.tournament_starts_at(t.id) AS t_starts,
      public.tournament_ends_at(t.id) AS t_ends
    FROM public.tournaments t
    WHERE (
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
      AND (
        NOT coalesce(p_registration_open, false)
        OR public.tournament_registration_state(t.id) = 'open'
      )
  ),
  filtered AS (
    SELECT m.t_status
    FROM matched m
    WHERE v_window_end IS NULL
      OR (
        m.t_starts IS NOT NULL
        AND m.t_starts <= v_window_end
        AND coalesce(m.t_ends, m.t_starts) >= now()
      )
  )
  SELECT s.word, coalesce(c.n, 0)::int
  FROM (VALUES ('in_progress'), ('upcoming'), ('completed')) AS s(word)
  LEFT JOIN (
    SELECT f.t_status AS word, count(*)::int AS n FROM filtered f GROUP BY f.t_status
  ) c ON c.word = s.word
  ORDER BY CASE s.word WHEN 'in_progress' THEN 1 WHEN 'upcoming' THEN 2 ELSE 3 END;
END;
$$;

COMMENT ON FUNCTION public.explore_tournament_counts(text, boolean, text) IS
  'How many tournaments match the search, the registration filter and the date window, per status (in_progress, upcoming, completed, each always present). Ignores the status filter so the buttons can show what each would give. A read, never a gate.';

-- ---------------------------------------------------------------------------
-- 3. The executable surface
-- ---------------------------------------------------------------------------
--
-- `CREATE FUNCTION` grants EXECUTE to PUBLIC, so the implicit grant is closed first and then
-- re-issued to exactly the two roles that call these. Both are granted to `anon` on purpose:
-- Explore is a public page.

REVOKE ALL ON FUNCTION public.explore_tournaments(text, text, boolean, text, text, int, int)
  FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.explore_tournaments(text, text, boolean, text, text, int, int)
  TO anon, authenticated;

REVOKE ALL ON FUNCTION public.explore_tournament_counts(text, boolean, text)
  FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.explore_tournament_counts(text, boolean, text)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
