-- Fix: a knockout day could not be written by `apply_placement_day_schedule`.
--
-- The function reads its slot payload in a loop, and the loop variable was called
-- `slot`. `tier_draw_matches` has a real column of that name, so inside the UPDATE
-- that writes a knockout slot, `slot->>'match_id'` was ambiguous between the
-- variable and the column, and Postgres rejected the whole statement:
--
--   column reference "slot" is ambiguous
--
-- The placement branch never failed, because `placement_matches` has no `slot`
-- column. That is why a build could generate the A/B/C/D draws and then write
-- nothing at all: the placement call committed, the knockout call raised, and the
-- client surfaced the error as a failed rebuild with the knockouts still unscheduled.
--
-- The variable is renamed rather than the reference qualified, because the payload
-- is read identically in both branches and only one of the two tables collides.
-- Everything else below is identical to the definition in
-- 20260917010000_placement_stage_rpcs.sql; this replaces it in place.
--
-- `p_stage` is 'placement' or 'knockout'. `p_slots` is
-- `[{ "match_id", "scheduled_time", "court_id" }]`.
CREATE OR REPLACE FUNCTION public.apply_placement_day_schedule(
  p_tournament_id uuid,
  p_stage text,
  p_slots jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slot_json jsonb;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_stage NOT IN ('placement', 'knockout') THEN
    RAISE EXCEPTION 'Unknown stage %', p_stage;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = p_tournament_id) THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  -- Same lock key as the legacy writer, so a rebuild of either format is
  -- serialised against the other and against result-driven shifts.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));

  IF p_stage = 'placement' THEN
    UPDATE public.placement_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE tournament_id = p_tournament_id AND status = 'scheduled';
  ELSE
    UPDATE public.tier_draw_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE tournament_id = p_tournament_id AND status = 'scheduled' AND NOT is_bye;
  END IF;

  FOR v_slot_json IN SELECT * FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb))
  LOOP
    IF p_stage = 'placement' THEN
      UPDATE public.placement_matches
      SET scheduled_time = (v_slot_json->>'scheduled_time')::timestamptz,
          court_id = NULLIF(v_slot_json->>'court_id', '')::uuid
      WHERE id = (v_slot_json->>'match_id')::uuid
        AND tournament_id = p_tournament_id
        AND status = 'scheduled';
    ELSE
      UPDATE public.tier_draw_matches
      SET scheduled_time = (v_slot_json->>'scheduled_time')::timestamptz,
          court_id = NULLIF(v_slot_json->>'court_id', '')::uuid
      WHERE id = (v_slot_json->>'match_id')::uuid
        AND tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND NOT is_bye;
    END IF;
  END LOOP;

  -- The same completeness check the legacy writer makes: a rebuild that leaves an
  -- assigned match without a court or a time has silently dropped a match, and
  -- failing the transaction is better than persisting a half-built day.
  IF p_stage = 'placement' THEN
    IF EXISTS (
      SELECT 1 FROM public.placement_matches
      WHERE tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Placement rebuild left assigned matches without a court or time';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.tier_draw_matches
      WHERE tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND NOT is_bye
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Knockout rebuild left assigned matches without a court or time';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_placement_day_schedule(uuid, text, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_placement_day_schedule(uuid, text, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
