-- Atomic desk operations and a lightweight activity trail.

CREATE TABLE IF NOT EXISTS public.desk_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  actor_id uuid,
  action text NOT NULL,
  match_table text NOT NULL,
  match_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS desk_activity_recent_idx
  ON public.desk_activity (occurred_at DESC);

ALTER TABLE public.desk_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff read desk activity" ON public.desk_activity;
CREATE POLICY "staff read desk activity"
ON public.desk_activity
FOR SELECT TO authenticated
USING (public.current_staff_role() IS NOT NULL);

REVOKE ALL ON public.desk_activity FROM anon, public;
GRANT SELECT ON public.desk_activity TO authenticated;
GRANT ALL ON public.desk_activity TO service_role;

CREATE OR REPLACE FUNCTION public.record_desk_match_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  action_name text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    action_name := CASE
      WHEN NEW.status = 'in-progress' THEN 'started'
      WHEN NEW.status = 'reported' THEN 'reported'
      WHEN NEW.status = 'walkover' THEN 'walkover'
      WHEN NEW.status = 'void' THEN 'voided'
      WHEN NEW.status = 'scheduled' THEN 'reset'
      ELSE 'status-changed'
    END;
  ELSIF NEW.court_id IS DISTINCT FROM OLD.court_id THEN
    action_name := 'court-moved';
  ELSIF NEW.scheduled_time IS DISTINCT FROM OLD.scheduled_time THEN
    action_name := 'time-shifted';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.desk_activity (
    actor_id,
    action,
    match_table,
    match_id,
    details
  )
  VALUES (
    auth.uid(),
    action_name,
    TG_TABLE_NAME,
    NEW.id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'from_status', OLD.status,
        'to_status', NEW.status,
        'from_court_id', OLD.court_id,
        'to_court_id', NEW.court_id,
        'from_time', OLD.scheduled_time,
        'to_time', NEW.scheduled_time,
        'note', NEW.note
      )
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pool_matches_desk_activity ON public.pool_matches;
CREATE TRIGGER pool_matches_desk_activity
AFTER UPDATE OF status, court_id, scheduled_time ON public.pool_matches
FOR EACH ROW EXECUTE FUNCTION public.record_desk_match_activity();

DROP TRIGGER IF EXISTS draw_matches_desk_activity ON public.draw_matches;
CREATE TRIGGER draw_matches_desk_activity
AFTER UPDATE OF status, court_id, scheduled_time ON public.draw_matches
FOR EACH ROW EXECUTE FUNCTION public.record_desk_match_activity();

CREATE OR REPLACE FUNCTION public.assert_match_eligible(
  p_table text,
  p_match_id uuid,
  p_court_id uuid,
  p_start timestamptz,
  p_allow_push boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    RAISE EXCEPTION 'A player is busy or has not completed the required rest gap';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_match_eligible(text, uuid, uuid, timestamptz, boolean)
FROM anon, authenticated, public;

CREATE OR REPLACE FUNCTION public.start_match_safe(
  p_table text,
  p_match_id uuid,
  p_court_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    true
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
$$;

CREATE OR REPLACE FUNCTION public.reschedule_live_match(
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
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));
  IF p_scheduled_time < statement_timestamp() - interval '1 minute' THEN
    RAISE EXCEPTION 'A scheduled match cannot be moved into the past';
  END IF;
  PERFORM public.assert_match_eligible(
    p_table,
    p_match_id,
    p_court_id,
    p_scheduled_time,
    false
  );

  IF p_table = 'pool_matches' THEN
    UPDATE public.pool_matches
    SET court_id = p_court_id,
        scheduled_time = p_scheduled_time
    WHERE id = p_match_id
      AND status = 'scheduled';
  ELSIF p_table = 'draw_matches' THEN
    UPDATE public.draw_matches
    SET court_id = p_court_id,
        scheduled_time = p_scheduled_time
    WHERE id = p_match_id
      AND status = 'scheduled';
  ELSE
    RAISE EXCEPTION 'Unsupported match table';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_match_with_note(
  p_table text,
  p_match_id uuid,
  p_note text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF length(trim(COALESCE(p_note, ''))) = 0 THEN
    RAISE EXCEPTION 'A correction note is required';
  END IF;
  PERFORM public.reset_and_repair_match(p_table, p_match_id);
  INSERT INTO public.desk_activity (
    actor_id,
    action,
    match_table,
    match_id,
    details
  )
  VALUES (
    auth.uid(),
    'correction-opened',
    p_table,
    p_match_id,
    jsonb_build_object('note', trim(p_note))
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.start_match_safe(text, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_live_match(text, uuid, uuid, timestamptz)
TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_match_with_note(text, uuid, text) TO authenticated;
