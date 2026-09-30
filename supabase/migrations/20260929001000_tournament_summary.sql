-- ===========================================================================
-- 20260929001000_tournament_summary.sql
--
-- Phase 2 S5. One read behind Explore, My Tournaments and the create flow's
-- tournament list.
--
-- ## Why this file exists outside Section 4's three-migration plan
--
-- The plan groups the phase into three migration files and says the timestamps group
-- by concern rather than by execution order. This is a fourth, and it is deliberate:
-- S5 ships Explore, which needs a tournament read that does not exist yet, and both
-- later files are *after* it in concern. It is timestamped between S1's identity canon
-- and S8/S9's registration work so the fresh-database order matches the incremental
-- one (S5 -> S8/S9 -> S12) rather than inverting it. Section 4's three files keep
-- their names and their independence.
--
-- ## What it replaces
--
-- The client used to read the whole `tournaments` table and derive everything a card
-- needs in the browser: the status word, the start and end, the entry count, and
-- whether the caller may edit it. Four derivations in the browser is four places for
-- the answer to drift from the database - and a card that says "not ready" beside a
-- tournament the start RPC accepts is the failure mode that matters.
--
-- `tournament_summary` returns one row per tournament in the shape a card draws, so
-- Explore, My Tournaments and the create flow cannot disagree about any of it. It is a
-- read, never a gate: the predicates it summarises remain the authority, exactly as
-- `tournament_access` documents for itself.
--
-- ## What it deliberately does not expose
--
-- No readiness detail (the per-check checklist is an editor's view, and the boolean is
-- already available where it is wanted), and no editor email. A summary is a public
-- shape: Explore is readable without a session, so every column here is a fact the
-- anonymous desk view could already see.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The registration window as one word
-- ---------------------------------------------------------------------------
--
-- The Register button and the window copy read this, so the client never re-derives
-- the rule from two timestamps and cannot disagree with the RPC that enforces it.
--
-- It mirrors `assert_registration_not_shut` and `submit_tournament_registration`
-- exactly, including their order: the lifecycle first, then the window, then
-- readiness. That order is the order the person experiences - a shut window is not a
-- configuration problem on their side - and `not_offered` is a distinct answer from
-- `closed` because "this event does not take requests" and "you missed it" are
-- different sentences.
--
-- `opens_soon` is deliberately not called `opens_soon`-only: it means "a window is
-- configured and has not opened yet", which is the only case where waiting helps.
--
-- S9 adds gates to `submit_tournament_registration` (a resolved profile, active
-- categories, a partner who differs, the per-player cap). Those are per-caller, so
-- they cannot be part of a tournament-level state; if a later step adds a
-- tournament-level gate it must extend this function in the same migration.
CREATE OR REPLACE FUNCTION public.tournament_registration_state(p_tournament_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_opens timestamptz;
  v_closes timestamptz;
BEGIN
  SELECT t.status, t.registration_opens_at, t.registration_closes_at
  INTO v_status, v_opens, v_closes
  FROM public.tournaments t
  WHERE t.id = p_tournament_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  -- The lifecycle answers before the window does: a running tournament is not
  -- "closed for registration", it has started.
  IF v_status = 'completed' THEN
    RETURN 'completed';
  END IF;
  IF v_status = 'in_progress' THEN
    RETURN 'started';
  END IF;

  -- No window is the documented way to say "this tournament takes no requests", so it
  -- is answered before readiness: a tournament with nothing configured is not
  -- half-ready, it simply does not offer registration.
  IF v_opens IS NULL OR v_closes IS NULL THEN
    RETURN 'not_offered';
  END IF;

  IF NOT public.tournament_is_ready(p_tournament_id) THEN
    RETURN 'not_ready';
  END IF;

  IF now() < v_opens THEN
    RETURN 'opens_soon';
  END IF;
  IF now() > v_closes THEN
    RETURN 'closed';
  END IF;

  RETURN 'open';
END;
$$;

COMMENT ON FUNCTION public.tournament_registration_state(uuid) IS
  'The registration window as one of not_offered | not_ready | opens_soon | open | closed | started | completed. Computed from the same predicates submit_tournament_registration consults, so the button and the RPC cannot disagree.';

-- ---------------------------------------------------------------------------
-- 2. The summary read
-- ---------------------------------------------------------------------------
--
-- One row per tournament, in the shape a card draws. `p_query` matches the name, the
-- venue or one of the tournament's events - the three things a person remembers about
-- a tournament they are looking for. `p_status` filters on the lifecycle word and is
-- validated rather than ignored: a filter that quietly answers "all" for a typo is how
-- a page shows something other than what it says it is showing.
--
-- `p_ids` restricts to a set, which is what makes My Tournaments one read instead of
-- one read per row plus a client-side join. An empty array is a legitimate "nothing to
-- show" and returns no rows.
--
-- `access_level` is the caller's relationship to the row: admin, owner, editor or
-- viewer. It is presentation only - every write still re-checks on the server - and it
-- exists so a card can decide what to offer without a second call per tournament.
--
-- The counts are `teams` (the entry, per I3) and `categories` (the events). Neither
-- reads a derived table: `placement_entrants` mirrors the entries and is cleared by a
-- stage reset, so counting it would make a card's number depend on whether somebody had
-- run generation.
CREATE OR REPLACE FUNCTION public.tournament_summary(
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
  access_level text
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
    END
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
  -- Newest first, which is the order the create flow's list and Explore both want: a
  -- tournament somebody just made has to be the one at the top of the page.
  ORDER BY t.created_at DESC
  LIMIT coalesce(p_limit, 200)
  OFFSET greatest(coalesce(p_offset, 0), 0);
END;
$$;

COMMENT ON FUNCTION public.tournament_summary(text, text, uuid[], int, int) IS
  'The read behind Explore, My Tournaments and the create flow list: id, name, venue, status, the derived start and end, the registration state, entry and event counts, and the caller''s access level. A read, never a gate. Exposes no readiness detail and no editor email.';

-- ---------------------------------------------------------------------------
-- 3. The executable surface
-- ---------------------------------------------------------------------------
--
-- `CREATE OR REPLACE FUNCTION` restores the implicit EXECUTE grant to PUBLIC, so both
-- have to be closed explicitly even though neither existed before. `tournament_summary`
-- is granted to `anon` on purpose: Explore is a public page, and every column it returns
-- is a fact the anonymous desk view already shows.

REVOKE ALL ON FUNCTION public.tournament_registration_state(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.tournament_registration_state(uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.tournament_summary(text, text, uuid[], int, int)
  FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.tournament_summary(text, text, uuid[], int, int)
  TO anon, authenticated;
