-- Clearing a placement result must also clear the start time.
--
-- `reset_tier_draw_result`, its counterpart for the A/B/C/D brackets, already sets
-- `started_at = NULL`, and so does `reset_and_repair_match` for the round-robin
-- tables. `reset_placement_result` was the one that did not, which left a placement
-- match in a state that is "scheduled" while still carrying a real start time.
--
-- That is not cosmetic, because two things read `started_at` unconditionally:
--
--   * `start_placement_match` starts from `COALESCE(started_at, statement_timestamp())`.
--     A match that was started, reset and started again therefore kept the ORIGINAL
--     start, so the desk showed it as enormously overrun the moment it restarted.
--   * `placement_occupied_matches`, added with the desk move, measures a match from
--     `COALESCE(started_at, scheduled_time)`. A stale start time makes a reset match
--     occupy a court from the wrong instant, so a hand-move could be refused against
--     a match that is no longer happening.
--
-- The whole point of a reset is to put the match back to a clean, replayable state,
-- so the start time goes with the result. Nothing else about the function changes.
CREATE OR REPLACE FUNCTION public.reset_placement_result(p_match_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_category uuid;
  v_stage text;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT category_id, stage INTO v_category, v_stage
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  -- Round two's make-up opponents are chosen from the round-one winner and loser
  -- sets, so a round-one result cannot be un-entered once round two exists: the
  -- pairings on screen were derived from it. Regenerating is the correct path.
  IF v_stage = 'round1' AND EXISTS (
    SELECT 1 FROM public.placement_matches
    WHERE category_id = v_category AND stage = 'round2'
  ) THEN
    RAISE EXCEPTION 'Round two was built from this result — regenerate round two instead';
  END IF;

  UPDATE public.placement_matches
  SET games = '[]'::jsonb,
      winner_id = NULL,
      status = 'scheduled',
      reported_time = NULL,
      -- The fix: without this, a restart inherits the original start time.
      started_at = NULL,
      ended_at = NULL
  WHERE id = p_match_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_placement_result(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_placement_result(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
