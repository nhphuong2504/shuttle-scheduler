-- ============================================================================
-- Make any tournament the active scope
-- ============================================================================
--
-- `activate_tournament` only accepts a Draft, which made activation one-way.
-- Activating a tournament clears `is_active` on the previous one, but nothing could
-- ever set it back: the old tournament stayed `in_progress` with no active scope, so
-- every page read an empty desk and the only recovery was hand-editing the table.
--
-- This adds the missing verb — point the active scope at a tournament that already
-- exists, whatever its status.
--
-- The readiness gate stays, but only for a draft. That gate answers "is this new
-- tournament configured enough to run?", which is a question about a tournament
-- nobody has used yet; an already-activated tournament was checked when it was first
-- activated, and re-selecting it must not re-run a check that later activity (a day
-- added mid-event, a court removed) could now fail.
--
-- `activate_tournament` becomes a thin delegate so exactly one function owns the
-- swap, and the two entry points cannot drift apart.

CREATE OR REPLACE FUNCTION public.set_active_tournament(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  r jsonb;
  blockers text;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  IF v_status = 'draft' THEN
    r := public.tournament_readiness(p_tournament_id);
    IF NOT COALESCE((r->>'ready')::boolean, false) THEN
      SELECT string_agg(c->>'label', '; ') INTO blockers
      FROM jsonb_array_elements(r->'checks') c
      WHERE (c->>'ok')::boolean = false;
      RAISE EXCEPTION 'The tournament is not ready: %', blockers;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournaments'));

  -- The partial unique index allows only one active tournament, so the previous
  -- scope is cleared in the same transaction that sets the new one.
  UPDATE public.tournaments SET is_active = false WHERE is_active;
  UPDATE public.tournaments
  SET status = 'in_progress', is_active = true
  WHERE id = p_tournament_id;
END;
$$;

-- The draft path is this function with the readiness gate above. Kept as its own
-- name because the wizard's Activate button and `activateTournament` call it.
CREATE OR REPLACE FUNCTION public.activate_tournament(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.set_active_tournament(p_tournament_id);
END;
$$;

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, so these revokes are what
-- actually keep anonymous callers out. `activate_tournament` is re-created above,
-- which silently restored that implicit grant; it has to be closed again here or
-- this migration would reopen the hole the auth-hardening migration closed.
REVOKE ALL ON FUNCTION public.set_active_tournament(uuid) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.activate_tournament(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_active_tournament(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_tournament(uuid) TO authenticated;
