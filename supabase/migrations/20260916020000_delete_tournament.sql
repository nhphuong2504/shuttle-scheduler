-- ============================================================================
-- Delete a tournament of any status
-- ============================================================================
--
-- `delete_tournament_draft` only removes a Draft, which is deliberate: it backs
-- the wizard's "Discard draft" button, where deleting an activated tournament
-- would be a mistake. That guard is a dead end for a host who has activated a
-- tournament by mistake, or who wants to clear out a finished one, so this adds
-- an explicitly destructive sibling that removes a tournament whatever its
-- status — including the active one.
--
-- The two are kept separate rather than merged: one refuses, the other does not,
-- and that difference is the whole safety story for the wizard button.
--
-- Everything that belongs to a tournament already hangs off it with
-- ON DELETE CASCADE — days, courts, categories, players, teams, pools, entries,
-- matches, draws, results, and the per-day court and break rows — so the cascade
-- does the bulk of the work. The one exception is handled below.

CREATE OR REPLACE FUNCTION public.delete_tournament(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exists boolean;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Same lock key as create/activate/delete_draft, so deleting cannot interleave
  -- with an activation that is mid-flight. Taken before the existence check so
  -- the check and the delete are inside one serialised section.
  PERFORM pg_advisory_xact_lock(hashtext('tournaments'));

  SELECT true INTO v_exists FROM public.tournaments WHERE id = p_tournament_id;
  IF v_exists IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  -- `desk_activity` is a global audit trail keyed by `match_id`; it carries no
  -- `tournament_id` and no foreign key to tournaments, so its rows would outlive
  -- the tournament and keep appearing on the desk as activity for matches that
  -- no longer exist. Clear this tournament's rows before the matches cascade
  -- away and the link is lost.
  DELETE FROM public.desk_activity
  WHERE match_id IN (
    SELECT id FROM public.pool_matches WHERE tournament_id = p_tournament_id
    UNION ALL
    SELECT id FROM public.draw_matches WHERE tournament_id = p_tournament_id
  );

  DELETE FROM public.tournaments WHERE id = p_tournament_id;
END;
$$;

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, so this revoke is what
-- actually keeps anonymous callers out. Every new RPC must repeat it; the
-- hardening migration could only close the functions that existed when it ran.
REVOKE ALL ON FUNCTION public.delete_tournament(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_tournament(uuid) TO authenticated;
