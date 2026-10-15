-- Additive placement: give newly ready matches a court and a time without touching anyone else.
--
-- `apply_placement_day_schedule` is a full-rebuild writer: it clears every `scheduled` row of a
-- stage and re-sets the lot. That is right for "rebuild the schedule", and wrong for "a knockout
-- slot just got its second team": it rewrites the whole unplayed queue and publishes a change
-- for every row. `place_ready_matches` is the other half. It only ever fills a court and a time
-- on a row that has neither, and it re-checks each slot on the server, so a plan computed from
-- stale data can place fewer matches but cannot double-book a court or a player.
--
-- Nothing below edits an applied migration.

CREATE OR REPLACE FUNCTION public.place_ready_matches(
  p_tournament_id uuid,
  p_stage text,
  p_slots jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_slot jsonb;
  v_table text;
  v_match uuid;
  v_court uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_slot_len interval;
  v_rest interval;
  v_status text;
  v_has_court boolean;
  v_has_time boolean;
  v_known boolean;
  v_players uuid[];
  v_placed jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_reason text;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

  IF p_stage NOT IN ('placement', 'knockout') THEN
    RAISE EXCEPTION 'Unknown stage %', p_stage;
  END IF;

  SELECT
    make_interval(mins => CASE WHEN p_stage = 'placement' THEN t.group_slot_minutes ELSE t.knockout_slot_minutes END),
    make_interval(mins => CASE WHEN p_stage = 'placement' THEN t.group_rest_gap_minutes ELSE t.knockout_rest_gap_minutes END)
  INTO v_slot_len, v_rest
  FROM public.tournaments t
  WHERE t.id = p_tournament_id;

  IF v_slot_len IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  v_table := CASE WHEN p_stage = 'placement' THEN 'placement_matches' ELSE 'tier_draw_matches' END;

  -- The same lock as the day writer, the result reflow and a hand-move, so none of them can
  -- interleave with a placement.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));

  FOR v_slot IN SELECT * FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb))
  LOOP
    v_match := (v_slot->>'match_id')::uuid;
    v_court := NULLIF(v_slot->>'court_id', '')::uuid;
    v_start := (v_slot->>'scheduled_time')::timestamptz;
    v_reason := NULL;

    IF v_court IS NULL OR v_start IS NULL THEN
      v_reason := 'incomplete';
    END IF;

    IF v_reason IS NULL THEN
      IF v_table = 'placement_matches' THEN
        SELECT m.status, m.court_id IS NOT NULL, m.scheduled_time IS NOT NULL,
               (m.entrant_a_id IS NOT NULL AND m.entrant_b_id IS NOT NULL)
        INTO v_status, v_has_court, v_has_time, v_known
        FROM public.placement_matches m
        WHERE m.id = v_match AND m.tournament_id = p_tournament_id;
      ELSE
        SELECT m.status, m.court_id IS NOT NULL, m.scheduled_time IS NOT NULL,
               (m.entrant_a_id IS NOT NULL AND m.entrant_b_id IS NOT NULL AND NOT m.is_bye)
        INTO v_status, v_has_court, v_has_time, v_known
        FROM public.tier_draw_matches m
        WHERE m.id = v_match AND m.tournament_id = p_tournament_id;
      END IF;

      IF v_status IS NULL THEN
        v_reason := 'unknown_match';
      ELSIF v_status <> 'scheduled' THEN
        v_reason := 'not_scheduled';
      ELSIF v_has_court OR v_has_time THEN
        -- Additive only: a match that already holds a slot is somebody's published time.
        v_reason := 'already_placed';
      ELSIF NOT v_known THEN
        v_reason := 'not_ready';
      ELSIF v_start < statement_timestamp() - interval '1 minute' THEN
        v_reason := 'in_the_past';
      ELSIF NOT EXISTS (
        SELECT 1 FROM public.courts WHERE id = v_court AND tournament_id = p_tournament_id
      ) THEN
        v_reason := 'bad_court';
      END IF;
    END IF;

    IF v_reason IS NULL THEN
      v_end := v_start + v_slot_len;

      SELECT side.player_ids INTO v_players
      FROM public.placement_occupied_matches(p_tournament_id) side
      WHERE side.match_table = v_table AND side.match_id = v_match;

      IF EXISTS (
        SELECT 1 FROM public.placement_occupied_matches(p_tournament_id) occupied
        WHERE NOT (occupied.match_table = v_table AND occupied.match_id = v_match)
          AND occupied.starts_at IS NOT NULL
          AND occupied.court_id = v_court
          AND v_start < occupied.ends_at
          AND v_end > occupied.starts_at
      ) THEN
        v_reason := 'court_busy';
      ELSIF COALESCE(array_length(v_players, 1), 0) > 0 AND EXISTS (
        SELECT 1 FROM public.placement_occupied_matches(p_tournament_id) occupied
        WHERE NOT (occupied.match_table = v_table AND occupied.match_id = v_match)
          AND occupied.starts_at IS NOT NULL
          AND v_start < occupied.ends_at + v_rest
          AND v_end + v_rest > occupied.starts_at
          AND occupied.player_ids && v_players
      ) THEN
        v_reason := 'player_busy';
      END IF;
    END IF;

    IF v_reason IS NULL THEN
      IF v_table = 'placement_matches' THEN
        UPDATE public.placement_matches
        SET court_id = v_court, scheduled_time = v_start
        WHERE id = v_match AND status = 'scheduled'
          AND court_id IS NULL AND scheduled_time IS NULL;
      ELSE
        UPDATE public.tier_draw_matches
        SET court_id = v_court, scheduled_time = v_start
        WHERE id = v_match AND status = 'scheduled' AND NOT is_bye
          AND court_id IS NULL AND scheduled_time IS NULL;
      END IF;

      IF FOUND THEN
        v_placed := v_placed || to_jsonb(v_match);
      ELSE
        v_reason := 'already_placed';
      END IF;
    END IF;

    IF v_reason IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('match_id', v_match, 'reason', v_reason);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('placed', v_placed, 'skipped', v_skipped);
END;
$function$;

REVOKE ALL ON FUNCTION public.place_ready_matches(uuid, text, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_ready_matches(uuid, text, jsonb) TO authenticated;

DO $verify$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'place_ready_matches') <> 1 THEN
    RAISE EXCEPTION 'place_ready_matches is missing or duplicated';
  END IF;
  IF has_function_privilege('anon', 'public.place_ready_matches(uuid, text, jsonb)', 'execute') THEN
    RAISE EXCEPTION 'place_ready_matches must not be callable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.place_ready_matches(uuid, text, jsonb)', 'execute') THEN
    RAISE EXCEPTION 'place_ready_matches must be callable by authenticated';
  END IF;
END;
$verify$;
