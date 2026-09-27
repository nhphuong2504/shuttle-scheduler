-- Gate the stage reset behind an empty schedule.
--
-- `reset_placement_stage` (20260917050000) is the one reset that discards the **seed
-- order**. That order is not free-standing: round one is paired *from* it, so a bracket
-- that still exists is a bracket whose pairings only make sense against the seeding behind
-- it. Clearing the seeding while those rows survive leaves matches that still play and can
-- no longer explain why anyone faced anyone. That is the same hazard
-- `20260917090000_placement_seed_reorder.sql` closed for a hand reorder, one step further
-- on: there a stale order misreported a live bracket, here it is deleted out from under one.
--
-- So the order goes only once nothing depends on it, which means the schedule has to be
-- discarded first. `reset_placement_schedule` (20260926000000) does exactly that and keeps
-- the seeding, so the sequence is: clear the schedule on the Schedule tab, then clear the
-- seeding here. The two resets stay independent actions; this only fixes their order.
--
-- The gate is on the database rather than the button because the button is not the only
-- caller. `reset_placement_stage` is reachable over PostgREST by any admin session, and a
-- guard that lives only in the React tree is a guard the next caller does not have. The
-- Placement tab mirrors this refusal so the host is told before they press, not after.
--
-- `tier_draws` is checked as well as the two match tables: a draw row is the bracket
-- itself, and it can outlive its matches while a build is half-written. `tier_draw_matches`
-- is redundant with `tier_draws` through the cascade, but it is listed explicitly so the
-- gate reads as the exact set `reset_placement_schedule` clears — if that set ever grows,
-- the two functions should drift together rather than one silently admitting a state the
-- other still has work for.
--
-- Everything else about the function is unchanged from 20260917050000: admin-only, the
-- `live-schedule` advisory lock, the same deletes, the same counts returned, scoped to the
-- placement format's own tables. The `REVOKE`/`GRANT` pair is re-issued because
-- `CREATE OR REPLACE FUNCTION` restores the implicit EXECUTE grant to PUBLIC.

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

  -- Taken before the gate, not after. The check and the deletes have to be one decision:
  -- a build that slipped a round-one row in between them would be deleting rows the gate
  -- had just approved, which is the interleaving the lock exists to prevent.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));

  -- The gate. Anything here means the seed order is still load-bearing.
  IF EXISTS (
    SELECT 1 FROM public.placement_matches WHERE tournament_id = p_tournament_id
    UNION ALL
    SELECT 1 FROM public.tier_draws WHERE tournament_id = p_tournament_id
    UNION ALL
    SELECT 1 FROM public.tier_draw_matches WHERE tournament_id = p_tournament_id
  ) THEN
    RAISE EXCEPTION
      'Clear the schedule first: this reset discards the seed order, and the schedule still '
      'has matches or draws that depend on it. Use the Reset panel on the Schedule tab, which '
      'clears the schedule and keeps the seeding.';
  END IF;

  -- Brackets first: their rows reference the draws and each other. The cascade from
  -- `tier_draws` would cover the matches anyway, but deleting the leaves explicitly keeps
  -- the counts below meaningful rather than zero.
  DELETE FROM public.tier_draw_matches WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_tier_matches = ROW_COUNT;

  DELETE FROM public.tier_draws WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_draws = ROW_COUNT;

  DELETE FROM public.placement_matches WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_placement_matches = ROW_COUNT;

  -- The entrant rows stay: they mirror the registrations, so removing them would mean
  -- re-syncing a field that has not actually changed. Only the placement state on them is
  -- cleared, which is what returns the stage to its start. `seed` and `seed_locked_at` are
  -- the seeding this function exists to clear, and `excluded` is the waiver.
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
