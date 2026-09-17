-- Moving a placement-stage match by hand, from the desk.
--
-- `start_placement_match`, `report_placement_result` and `reset_placement_result`
-- already cover starting, scoring and correcting a match on the new tables. Moving
-- one was the gap: `reschedule_live_match` only accepts `pool_matches` and
-- `draw_matches`, and it guards the move through `assert_match_eligible`, which
-- resolves players from `team_a_id` / `team_b_id` directly.
--
-- A placement match has no team columns. It carries entrant ids, and an entrant is
-- what points at a team, so the player list needs one more hop. Rather than widen
-- that shared function -- which would mean editing three duplicated occupancy CTEs
-- inside the guarantee for the live round-robin format, and would cut across the
-- separation between the two formats -- the placement format gets its own
-- occupancy helper and its own move.
--
-- Why the guards matter, rather than being ceremony: the two rounds of a placement
-- stage are not independent. Round two is generated from the round-one winners and
-- losers, and for an odd field the held entrant plays two make-up matches whose
-- opponents were picked from those sets. A match moved on top of another player's
-- slot, or inside their rest gap, produces a round two that is correct on paper and
-- impossible on court. So the move refuses a court clash and a player clash, and it
-- measures both with the right duration for the stage: the group timings for the
-- placement rounds, the knockout timings for the A/B/C/D brackets.

-------------------------------------------------------------------------------
-- 1. Occupancy across the placement format, with players already resolved
-------------------------------------------------------------------------------

-- Every placement-format match that could occupy a court or a player, with its
-- resolved player list and its real end time. Both guards below are simple
-- interval tests over this, instead of repeating a four-branch union twice.
--
-- An in-progress match is modelled as ending no earlier than now, so a match that
-- has overrun still blocks the court until it is reported. A bye is excluded
-- because a bye is never played on a court.
--
-- Deliberately NOT filtered to matches that already have a time. A match with no
-- `scheduled_time` has a NULL `starts_at`, so it clashes with nothing, and callers
-- filter on `starts_at` themselves. Keeping it in the set is what lets the move
-- resolve the players of a match it is about to place for the first time.
CREATE OR REPLACE FUNCTION public.placement_occupied_matches(p_tournament_id uuid)
RETURNS TABLE (
  match_table text,
  match_id uuid,
  court_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  player_ids uuid[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH settings AS (
    SELECT
      make_interval(mins => t.group_slot_minutes) AS group_slot,
      make_interval(mins => t.knockout_slot_minutes) AS knockout_slot
    FROM public.tournaments t
    WHERE t.id = p_tournament_id
  ),
  seated AS (
    SELECT
      'placement_matches'::text AS match_table,
      m.id AS match_id,
      m.court_id,
      COALESCE(m.started_at, m.scheduled_time) AS starts_at,
      CASE
        WHEN m.ended_at IS NOT NULL THEN m.ended_at
        WHEN m.status = 'in-progress'
          THEN GREATEST(
            COALESCE(m.started_at, m.scheduled_time) + s.group_slot,
            statement_timestamp()
          )
        ELSE m.scheduled_time + s.group_slot
      END AS ends_at,
      m.entrant_a_id,
      m.entrant_b_id
    FROM public.placement_matches m
    CROSS JOIN settings s
    WHERE m.tournament_id = p_tournament_id
      AND m.status <> 'void'
    UNION ALL
    SELECT
      'tier_draw_matches',
      m.id,
      m.court_id,
      COALESCE(m.started_at, m.scheduled_time),
      CASE
        WHEN m.ended_at IS NOT NULL THEN m.ended_at
        WHEN m.status = 'in-progress'
          THEN GREATEST(
            COALESCE(m.started_at, m.scheduled_time) + s.knockout_slot,
            statement_timestamp()
          )
        ELSE m.scheduled_time + s.knockout_slot
      END,
      m.entrant_a_id,
      m.entrant_b_id
    FROM public.tier_draw_matches m
    CROSS JOIN settings s
    WHERE m.tournament_id = p_tournament_id
      AND m.status <> 'void'
      AND COALESCE(m.is_bye, false) = false
  )
  SELECT
    seated.match_table,
    seated.match_id,
    seated.court_id,
    seated.starts_at,
    seated.ends_at,
    -- The extra hop the legacy tables do not need: entrant -> team -> the two
    -- player slots. Both sides are unioned so a doubles pair contributes both
    -- players, and DISTINCT collapses a player who somehow holds both.
    ARRAY(
      SELECT DISTINCT side.player_id
      FROM (
        SELECT team.player_1_id AS player_id
        FROM public.placement_entrants entrant
        JOIN public.teams team ON team.id = entrant.team_id
        WHERE entrant.id IN (seated.entrant_a_id, seated.entrant_b_id)
        UNION ALL
        SELECT team.player_2_id
        FROM public.placement_entrants entrant
        JOIN public.teams team ON team.id = entrant.team_id
        WHERE entrant.id IN (seated.entrant_a_id, seated.entrant_b_id)
      ) side
      WHERE side.player_id IS NOT NULL
    ) AS player_ids
  FROM seated;
$$;

REVOKE ALL ON FUNCTION public.placement_occupied_matches(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.placement_occupied_matches(uuid) TO authenticated;

-------------------------------------------------------------------------------
-- 2. The move itself
-------------------------------------------------------------------------------

-- One function for both placement tables, because the body is identical apart from
-- the duration and the bye guard. `p_table` is therefore validated rather than
-- trusted: it is interpolated into nothing, but it is the key the exclusion uses to
-- avoid clashing a match with itself.
CREATE OR REPLACE FUNCTION public.reschedule_placement_match(
  p_table text,
  p_match_id uuid,
  p_court_id uuid,
  p_scheduled_time timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_status text;
  v_players uuid[];
  v_slot interval;
  v_rest interval;
  v_end timestamptz;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_table NOT IN ('placement_matches', 'tier_draw_matches') THEN
    RAISE EXCEPTION 'Unsupported match table';
  END IF;
  IF p_court_id IS NULL THEN
    RAISE EXCEPTION 'Select a court before moving the match';
  END IF;
  IF p_scheduled_time IS NULL THEN
    RAISE EXCEPTION 'A scheduled time is required';
  END IF;

  -- The same lock as the day writer and the result reflow, so a hand-move cannot
  -- interleave with either.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));

  IF p_scheduled_time < statement_timestamp() - interval '1 minute' THEN
    RAISE EXCEPTION 'A scheduled match cannot be moved into the past';
  END IF;

  IF p_table = 'placement_matches' THEN
    SELECT
      m.tournament_id,
      m.status,
      make_interval(mins => t.group_slot_minutes),
      make_interval(mins => t.group_rest_gap_minutes)
    INTO v_tournament, v_status, v_slot, v_rest
    FROM public.placement_matches m
    JOIN public.tournaments t ON t.id = m.tournament_id
    WHERE m.id = p_match_id;
  ELSE
    SELECT
      m.tournament_id,
      m.status,
      make_interval(mins => t.knockout_slot_minutes),
      make_interval(mins => t.knockout_rest_gap_minutes)
    INTO v_tournament, v_status, v_slot, v_rest
    FROM public.tier_draw_matches m
    JOIN public.tournaments t ON t.id = m.tournament_id
    WHERE m.id = p_match_id;
  END IF;

  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;
  IF v_status <> 'scheduled' THEN
    RAISE EXCEPTION 'Only a match that has not started can be moved';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.courts WHERE id = p_court_id AND tournament_id = v_tournament
  ) THEN
    RAISE EXCEPTION 'Select a valid court';
  END IF;

  -- A match with an unassigned side is not movable: it has no players to clash, so
  -- letting it through would put a placeholder on a court.
  SELECT side.player_ids INTO v_players
  FROM public.placement_occupied_matches(v_tournament) side
  WHERE side.match_table = p_table AND side.match_id = p_match_id;

  IF v_players IS NULL OR COALESCE(array_length(v_players, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Both sides must be assigned before this match can be moved';
  END IF;

  v_end := p_scheduled_time + v_slot;

  IF EXISTS (
    SELECT 1
    FROM public.placement_occupied_matches(v_tournament) occupied
    WHERE NOT (occupied.match_table = p_table AND occupied.match_id = p_match_id)
      AND occupied.starts_at IS NOT NULL
      AND occupied.court_id = p_court_id
      AND p_scheduled_time < occupied.ends_at
      AND v_end > occupied.starts_at
  ) THEN
    RAISE EXCEPTION 'That court is occupied during the requested time';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.placement_occupied_matches(v_tournament) occupied
    WHERE NOT (occupied.match_table = p_table AND occupied.match_id = p_match_id)
      AND occupied.starts_at IS NOT NULL
      -- Half-open overlap on both sides of the rest gap: the candidate must start
      -- at least the rest gap after the other match ends, and the other match must
      -- start at least the rest gap after the candidate ends.
      AND p_scheduled_time < occupied.ends_at + v_rest
      AND v_end + v_rest > occupied.starts_at
      AND occupied.player_ids && v_players
  ) THEN
    RAISE EXCEPTION 'A player is busy or has not completed the required rest gap';
  END IF;

  IF p_table = 'placement_matches' THEN
    UPDATE public.placement_matches
    SET court_id = p_court_id,
        scheduled_time = p_scheduled_time
    WHERE id = p_match_id
      AND status = 'scheduled';
  ELSE
    UPDATE public.tier_draw_matches
    SET court_id = p_court_id,
        scheduled_time = p_scheduled_time
    WHERE id = p_match_id
      AND status = 'scheduled'
      AND NOT is_bye;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match could not be moved';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.reschedule_placement_match(text, uuid, uuid, timestamptz)
FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.reschedule_placement_match(text, uuid, uuid, timestamptz)
TO authenticated;

NOTIFY pgrst, 'reload schema';
