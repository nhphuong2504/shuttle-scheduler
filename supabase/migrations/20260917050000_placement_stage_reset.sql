-- Reset the two-round placement stage back to its pristine state.
--
-- One deliberate, admin-only, irreversible action: it deletes every placement
-- match, every A/B/C/D draw, and clears the placement state on the entrants
-- (seed order, the lock, the derived tier, and the waived flags). What is left is
-- a registered field with nothing played and nothing scheduled, which is the state
-- the desk is in immediately after the entrants are synced — so "Shuffle & lock
-- seeds" is the next thing to press.
--
-- It is a separate RPC rather than a handful of deletes from the client for three
-- reasons:
--
--   * Ordering. `tier_draw_matches` and `tier_draws` both point at
--     `placement_entrants`, and `tier_draw_matches` points at itself. Doing this
--     from the client means four round trips that can fail halfway, leaving a
--     tournament with draws but no matches. One function is one transaction.
--   * Authorization. `placement_entrants` is writable by `admin`/`registrar` and
--     the match tables by `admin`/`scheduler`, so no single staff role could clear
--     both paths through the table policies. This is admin-only, which is the only
--     role that should be able to discard a played event by accident or on purpose.
--   * Locking. It takes the same advisory lock as the day writer and the live
--     reflow, so a reset cannot interleave with a build that is halfway through
--     writing slots.
--
-- Scoped to the placement format's own tables. The legacy round-robin tables are
-- untouched, which is what keeps the two formats independent.

CREATE OR REPLACE FUNCTION public.reset_placement_stage(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier_matches int := 0;
  v_draws int := 0;
  v_placement_matches int := 0;
  v_entrants int := 0;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can reset the placement stage';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = p_tournament_id) THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  -- Same lock key as `apply_placement_day_schedule` and
  -- `shift_live_schedule_after_match`, so a reset serialises against a build and
  -- against a result-driven reflow rather than deleting rows out from under them.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));

  -- Brackets first: their rows reference the draws and each other. The cascade
  -- from `tier_draws` would cover the matches anyway, but deleting the leaves
  -- explicitly keeps the counts below meaningful rather than zero.
  DELETE FROM public.tier_draw_matches WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_tier_matches = ROW_COUNT;

  DELETE FROM public.tier_draws WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_draws = ROW_COUNT;

  DELETE FROM public.placement_matches WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_placement_matches = ROW_COUNT;

  -- The entrant rows stay: they mirror the registrations, so removing them would
  -- mean re-syncing a field that has not actually changed. Only the placement
  -- state on them is cleared, which is what returns the stage to its start.
  UPDATE public.placement_entrants
  SET seed = NULL,
      seed_locked_at = NULL,
      tier = NULL,
      excluded = false
  WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_entrants = ROW_COUNT;

  RETURN jsonb_build_object(
    'placementMatches', v_placement_matches,
    'tierDraws', v_draws,
    'tierMatches', v_tier_matches,
    'entrants', v_entrants
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reset_placement_stage(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_placement_stage(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
