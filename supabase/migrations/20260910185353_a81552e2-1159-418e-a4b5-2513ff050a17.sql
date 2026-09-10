DROP FUNCTION IF EXISTS public.assert_match_eligible(text, uuid, uuid, timestamptz, boolean);
DROP FUNCTION IF EXISTS public.start_match_safe(text, uuid, uuid);

CREATE OR REPLACE FUNCTION public.assert_match_eligible(p_table text, p_match_id uuid, p_court_id uuid, p_start timestamp with time zone, p_allow_push boolean DEFAULT false, p_ignore_rest boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  candidate_players uuid[];
  candidate_duration interval;
  candidate_rest interval;
  candidate_end timestamptz;
BEGIN
  IF p_table = 'pool_matches' THEN
    SELECT
      ARRAY(
        SELECT DISTINCT player_id
        FROM (
          SELECT team.player_1_id AS player_id
          FROM public.teams team
          WHERE team.id IN (match.team_a_id, match.team_b_id)
          UNION ALL
          SELECT team.player_2_id
          FROM public.teams team
          WHERE team.id IN (match.team_a_id, match.team_b_id)
        ) players
        WHERE player_id IS NOT NULL
      ),
      make_interval(mins => settings.group_slot_minutes),
      make_interval(mins => settings.group_rest_gap_minutes)
    INTO candidate_players, candidate_duration, candidate_rest
    FROM public.pool_matches match
    CROSS JOIN LATERAL (
      SELECT group_slot_minutes, group_rest_gap_minutes
      FROM public.tournament_settings
      LIMIT 1
    ) settings
    WHERE match.id = p_match_id
      AND match.status = 'scheduled';
  ELSIF p_table = 'draw_matches' THEN
    SELECT
      ARRAY(
        SELECT DISTINCT player_id
        FROM (
          SELECT team.player_1_id AS player_id
          FROM public.teams team
          WHERE team.id IN (match.team_a_id, match.team_b_id)
          UNION ALL
          SELECT team.player_2_id
          FROM public.teams team
          WHERE team.id IN (match.team_a_id, match.team_b_id)
        ) players
        WHERE player_id IS NOT NULL
      ),
      make_interval(mins => settings.knockout_slot_minutes),
      make_interval(mins => settings.knockout_rest_gap_minutes)
    INTO candidate_players, candidate_duration, candidate_rest
    FROM public.draw_matches match
    CROSS JOIN LATERAL (
      SELECT knockout_slot_minutes, knockout_rest_gap_minutes
      FROM public.tournament_settings
      LIMIT 1
    ) settings
    WHERE match.id = p_match_id
      AND match.status = 'scheduled'
      AND COALESCE(match.is_bye, false) = false;
  ELSE
    RAISE EXCEPTION 'Unsupported match table';
  END IF;

  IF candidate_duration IS NULL THEN
    RAISE EXCEPTION 'Only a scheduled match can be moved or started';
  END IF;
  IF COALESCE(array_length(candidate_players, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Both sides must be assigned before this match can start';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.courts WHERE id = p_court_id) THEN
    RAISE EXCEPTION 'Select a valid court';
  END IF;

  IF p_ignore_rest THEN
    candidate_rest := make_interval(mins => 0);
  END IF;

  candidate_end := p_start + candidate_duration;

  IF EXISTS (
    WITH settings AS (
      SELECT
        make_interval(mins => group_slot_minutes) AS group_slot,
        make_interval(mins => knockout_slot_minutes) AS draw_slot
      FROM public.tournament_settings
      LIMIT 1
    ),
    occupied AS (
      SELECT
        'pool_matches'::text AS match_table,
        match.id,
        match.status,
        match.court_id,
        COALESCE(match.started_at, match.scheduled_time) AS starts_at,
        CASE
          WHEN match.ended_at IS NOT NULL THEN match.ended_at
          WHEN match.status = 'in-progress'
            THEN GREATEST(
              COALESCE(match.started_at, match.scheduled_time) + settings.group_slot,
              statement_timestamp()
            )
          ELSE match.scheduled_time + settings.group_slot
        END AS ends_at,
        match.team_a_id,
        match.team_b_id
      FROM public.pool_matches match
      CROSS JOIN settings
      WHERE match.status <> 'void'
        AND match.court_id IS NOT NULL
        AND match.scheduled_time IS NOT NULL
      UNION ALL
      SELECT
        'draw_matches',
        match.id,
        match.status,
        match.court_id,
        COALESCE(match.started_at, match.scheduled_time),
        CASE
          WHEN match.ended_at IS NOT NULL THEN match.ended_at
          WHEN match.status = 'in-progress'
            THEN GREATEST(
              COALESCE(match.started_at, match.scheduled_time) + settings.draw_slot,
              statement_timestamp()
            )
          ELSE match.scheduled_time + settings.draw_slot
        END,
        match.team_a_id,
        match.team_b_id
      FROM public.draw_matches match
      CROSS JOIN settings
      WHERE match.status <> 'void'
        AND COALESCE(match.is_bye, false) = false
        AND match.court_id IS NOT NULL
        AND match.scheduled_time IS NOT NULL
    )
    SELECT 1
    FROM occupied
    WHERE NOT (match_table = p_table AND id = p_match_id)
      AND (NOT p_allow_push OR status <> 'scheduled')
      AND court_id = p_court_id
      AND p_start < ends_at
      AND candidate_end > starts_at
  ) THEN
    RAISE EXCEPTION 'That court is occupied during the requested time';
  END IF;

  IF EXISTS (
    WITH settings AS (
      SELECT
        make_interval(mins => group_slot_minutes) AS group_slot,
        make_interval(mins => knockout_slot_minutes) AS draw_slot
      FROM public.tournament_settings
      LIMIT 1
    ),
    occupied AS (
      SELECT
        'pool_matches'::text AS match_table,
        match.id,
        match.status,
        COALESCE(match.started_at, match.scheduled_time) AS starts_at,
        CASE
          WHEN match.ended_at IS NOT NULL THEN match.ended_at
          WHEN match.status = 'in-progress'
            THEN GREATEST(
              COALESCE(match.started_at, match.scheduled_time) + settings.group_slot,
              statement_timestamp()
            )
          ELSE match.scheduled_time + settings.group_slot
        END AS ends_at,
        match.team_a_id,
        match.team_b_id
      FROM public.pool_matches match
      CROSS JOIN settings
      WHERE match.status <> 'void'
        AND match.scheduled_time IS NOT NULL
      UNION ALL
      SELECT
        'draw_matches',
        match.id,
        match.status,
        COALESCE(match.started_at, match.scheduled_time),
        CASE
          WHEN match.ended_at IS NOT NULL THEN match.ended_at
          WHEN match.status = 'in-progress'
            THEN GREATEST(
              COALESCE(match.started_at, match.scheduled_time) + settings.draw_slot,
              statement_timestamp()
            )
          ELSE match.scheduled_time + settings.draw_slot
        END,
        match.team_a_id,
        match.team_b_id
      FROM public.draw_matches match
      CROSS JOIN settings
      WHERE match.status <> 'void'
        AND COALESCE(match.is_bye, false) = false
        AND match.scheduled_time IS NOT NULL
    )
    SELECT 1
    FROM occupied
    WHERE NOT (match_table = p_table AND id = p_match_id)
      AND (NOT p_allow_push OR status <> 'scheduled')
      AND p_start < ends_at + candidate_rest
      AND candidate_end + candidate_rest > starts_at
      AND EXISTS (
        SELECT 1
        FROM public.teams team
        JOIN unnest(candidate_players) AS candidate(player_id)
          ON candidate.player_id IN (team.player_1_id, team.player_2_id)
        WHERE team.id IN (occupied.team_a_id, occupied.team_b_id)
      )
  ) THEN
    IF p_ignore_rest THEN
      RAISE EXCEPTION 'A player is already busy in another match';
    ELSE
      RAISE EXCEPTION 'A player is busy or has not completed the required rest gap';
    END IF;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_match_safe(p_table text, p_match_id uuid, p_court_id uuid, p_ignore_rest boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));
  PERFORM public.assert_match_eligible(
    p_table,
    p_match_id,
    p_court_id,
    statement_timestamp(),
    true,
    p_ignore_rest
  );

  IF p_table = 'pool_matches' THEN
    UPDATE public.pool_matches
    SET status = 'in-progress',
        started_at = statement_timestamp(),
        court_id = p_court_id
    WHERE id = p_match_id
      AND status = 'scheduled';
  ELSIF p_table = 'draw_matches' THEN
    UPDATE public.draw_matches
    SET status = 'in-progress',
        started_at = statement_timestamp(),
        court_id = p_court_id
    WHERE id = p_match_id
      AND status = 'scheduled';
  ELSE
    RAISE EXCEPTION 'Unsupported match table';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_match_eligible(text, uuid, uuid, timestamptz, boolean, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.start_match_safe(text, uuid, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_match_safe(text, uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.assert_match_eligible(text, uuid, uuid, timestamptz, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_match_eligible(text, uuid, uuid, timestamptz, boolean, boolean) TO service_role;