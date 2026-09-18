-- ============================================================================
-- Seed reordering: tighten the `lock_placement_seeds` guard
-- ============================================================================
--
-- Apply after `20260917000000_placement_stage.sql` and
-- `20260917010000_placement_stage_rpcs.sql`.
--
-- No new function. `lock_placement_seeds` already accepts a full permutation of
-- the field — seeds 1..N, every non-waived team once — which is precisely what a
-- drag-to-reorder writes. The shuffle and the reorder differ only in who chose the
-- order, so they share one RPC and one validation path rather than growing a
-- second writer that could disagree with the first.
--
-- What changes is the GUARD, and it is a deliberate tightening. The original
-- version refused only a match that had been decided:
--
--   WHERE category_id = p_category_id AND status <> 'scheduled'
--
-- That was sufficient while the shuffle was the only caller, because the UI
-- already disabled the button once any match existed. It is not sufficient now
-- that rows can be dragged. Reordering after round one has been generated is not
-- a no-op: it permutes the seeds that round one was paired from, so the matches on
-- screen would keep their pairings while the seed numbers beside them changed —
-- the bracket would still be playable, and would simply be lying about why anyone
-- faced anyone. Since `placement_matches` are the sole output of the seed order,
-- "no matches yet" is the honest precondition, so the check is now any row at all.
--
-- The way back from a stage that already has matches is unchanged and stays
-- explicit: `reset_placement_stage` clears the matches, the draws and the seeds
-- together, and re-locking is available immediately afterwards.
--
-- This closes a gap rather than removing a capability. Nobody could reach the
-- looser path through the UI — the re-shuffle button is disabled while matches
-- exist — so the only behaviour that changes is that the RPC now refuses a state
-- the client was already refusing to ask for.

CREATE OR REPLACE FUNCTION public.lock_placement_seeds(
  p_category_id uuid,
  p_seeds jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_expected int;
  v_provided int;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'registrar', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  -- Any placement match at all, decided or not, for the reason in the header: the
  -- pairings on screen were generated from the order this call is about to
  -- replace, and there is no way to re-derive them here.
  IF EXISTS (
    SELECT 1 FROM public.placement_matches WHERE category_id = p_category_id
  ) THEN
    RAISE EXCEPTION
      'The seed order can only be changed while the placement stage is empty — this event already has placement matches';
  END IF;

  SELECT count(*) INTO v_expected
  FROM public.placement_entrants
  WHERE category_id = p_category_id AND NOT excluded;

  SELECT count(*) INTO v_provided
  FROM jsonb_array_elements(COALESCE(p_seeds, '[]'::jsonb));

  IF v_provided <> v_expected THEN
    RAISE EXCEPTION 'Expected % seeds but received %', v_expected, v_provided;
  END IF;

  -- Clear first so the partial unique index cannot trip on an intermediate state
  -- when seeds are being permuted. This is a permutation rather than an insert,
  -- so every seed is briefly NULL before the block below writes the new order.
  UPDATE public.placement_entrants
  SET seed = NULL, seed_locked_at = NULL
  WHERE category_id = p_category_id;

  -- `seed_locked_at` is refreshed on every write, so it reads as "when this order
  -- was last set" rather than "when the first one was". Nothing keys off its value
  -- — `set_placement_skill` only tests it for null — so a reorder moving it forward
  -- is a re-labelling, not a change in meaning.
  UPDATE public.placement_entrants e
  SET seed = (item->>'seed')::int,
      seed_locked_at = statement_timestamp()
  FROM jsonb_array_elements(p_seeds) AS item
  WHERE e.category_id = p_category_id
    AND e.team_id = (item->>'team_id')::uuid
    AND NOT e.excluded;

  IF EXISTS (
    SELECT 1 FROM public.placement_entrants
    WHERE category_id = p_category_id AND NOT excluded AND seed IS NULL
  ) THEN
    RAISE EXCEPTION 'Seeding left an entrant without a seed';
  END IF;
END;
$$;

-- CREATE OR REPLACE keeps the OID and therefore the existing ACL, but the revoke is
-- re-asserted rather than assumed: the header of the RPCs migration documents why,
-- and a fresh database that never ran the hardening migration depends on it.
REVOKE ALL ON FUNCTION public.lock_placement_seeds(uuid, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_placement_seeds(uuid, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
