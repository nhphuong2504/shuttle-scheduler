-- Reset the placement and knockout **schedule** without discarding the seeding.
--
-- `reset_placement_stage` (20260917050000) is one action that clears everything:
-- the matches, the draws and the entrant state — seed order, lock, tier and
-- waivers — so the stage returns to a registered field. That is the right scope for
-- the **Placement** tab, which owns the seed order: the whole point of a reset there
-- is to get back to "Shuffle & lock seeds".
--
-- It is the wrong scope for the **Schedule** tab. Scheduling is a later, separate
-- decision: the host locks seeds on the Placement tab, then builds days on the
-- Schedule tab. A rebuild of the schedule is a routine act — days change, a court is
-- lost, a stage is regenerated — and it must not silently destroy the seed order the
-- host set by hand, nor re-admit a withdrawn team by clearing its waiver. Before this
-- function, the only way back from a bad build was an action that took the seeding
-- with it, so "rebuild the schedule" and "start the tournament over" were the same
-- button.
--
-- So the two resets now differ by exactly one thing: what they do to
-- `placement_entrants`.
--
--   * `reset_placement_schedule` (this file) deletes the matches and the draws, and
--     clears only `tier`, which is derived from results that are being deleted. The
--     seed order (`seed`, `seed_locked_at`) and the waivers (`excluded`) survive.
--   * `reset_placement_stage` also clears those, returning the stage to a registered
--     field.
--
-- `tier` has to go even here, and it is worth being explicit about why it is not part
-- of "the seeding". The A/B/C/D draw is decided by the entrant's placement RECORD
-- (WW/WL/LW/LL), not by their seed — the seed only decides round-one pairings. Once
-- the matches are deleted there is no record left to derive a tier from, so a stored
-- tier would be a label with nothing behind it, and the next `apply_tier_draws` would
-- overwrite it anyway. Clearing it keeps the row honest in the window between the two.
--
-- The stage is left in a state the Schedule tab can actually build from. With the
-- seeds still locked and no round-one rows, `buildCategoryView` reads the stage as
-- `round1`, and `generateMissingStages` regenerates round one from the seed order.
-- That is the whole point: after this reset, "Build the schedule" rebuilds, and the
-- host has not lost the ordering they set.
--
-- Irreversible, and admin-only for the same reasons as `reset_placement_stage`: it is
-- the only role that should be able to discard a played event on purpose or by
-- accident. It takes the same `live-schedule` advisory lock as the day writer and the
-- live reflow, so it cannot interleave with a build halfway through writing slots.

CREATE OR REPLACE FUNCTION public.reset_placement_schedule(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier_matches int := 0;
  v_draws int := 0;
  v_placement_matches int := 0;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can reset the placement schedule';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = p_tournament_id) THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));

  -- Brackets first: their rows reference the draws and each other. The cascade from
  -- `tier_draws` would cover the matches anyway, but deleting the leaves explicitly
  -- keeps the counts below meaningful rather than zero.
  DELETE FROM public.tier_draw_matches WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_tier_matches = ROW_COUNT;

  DELETE FROM public.tier_draws WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_draws = ROW_COUNT;

  DELETE FROM public.placement_matches WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_placement_matches = ROW_COUNT;

  -- `seed`, `seed_locked_at` and `excluded` are deliberately NOT touched: they are the
  -- seeding this function exists to preserve. Only the derived tier goes, because the
  -- results it was derived from are the rows just deleted.
  UPDATE public.placement_entrants
  SET tier = NULL
  WHERE tournament_id = p_tournament_id
    AND tier IS NOT NULL;

  RETURN jsonb_build_object(
    'placementMatches', v_placement_matches,
    'tierDraws', v_draws,
    'tierMatches', v_tier_matches
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reset_placement_schedule(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_placement_schedule(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
