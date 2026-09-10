-- Incrementally reflow scheduled matches from the real end of a completed match.
-- Completed, in-progress, and walkover matches are immutable schedule anchors.

CREATE OR REPLACE FUNCTION public.shift_live_schedule_after_match(
  p_table text,
  p_match_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  source_court uuid;
  source_time timestamptz;
  source_end timestamptz;
  current_match record;
  blocking_match record;
  next_start timestamptz;
  previous_end timestamptz;
  iterations int := 0;
BEGIN
  IF p_table NOT IN ('pool_matches', 'draw_matches') THEN
    RAISE EXCEPTION 'Unsupported match table';
  END IF;

  -- Serialize result-driven changes with either day's full schedule writer.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));

  IF p_table = 'pool_matches' THEN
    SELECT court_id, scheduled_time, ended_at
    INTO source_court, source_time, source_end
    FROM public.pool_matches
    WHERE id = p_match_id
      AND status IN ('reported', 'walkover');
  ELSE
    SELECT court_id, scheduled_time, ended_at
    INTO source_court, source_time, source_end
    FROM public.draw_matches
    WHERE id = p_match_id
      AND status IN ('reported', 'walkover');
  END IF;

  -- Unscheduled completions cannot establish a court sequence.
  IF source_court IS NULL OR source_time IS NULL OR source_end IS NULL THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE live_schedule_work (
    match_table text NOT NULL,
    match_id uuid NOT NULL,
    court_id uuid NOT NULL,
    original_time timestamptz NOT NULL,
    shifted_time timestamptz NOT NULL,
    actual_start timestamptz,
    actual_end timestamptz,
    duration interval NOT NULL,
    rest_gap interval NOT NULL,
    status text NOT NULL,
    movable boolean NOT NULL,
    dirty boolean NOT NULL DEFAULT false,
    PRIMARY KEY (match_table, match_id)
  ) ON COMMIT DROP;

  CREATE INDEX live_schedule_work_court_time
    ON live_schedule_work (court_id, original_time, match_table, match_id);

  INSERT INTO live_schedule_work (
    match_table, match_id, court_id, original_time, shifted_time,
    actual_start, actual_end, duration, rest_gap, status, movable
  )
  SELECT
    'pool_matches',
    pm.id,
    pm.court_id,
    pm.scheduled_time,
    pm.scheduled_time,
    pm.started_at,
    pm.ended_at,
    make_interval(mins => settings.group_slot_minutes),
    make_interval(mins => settings.group_rest_gap_minutes),
    pm.status,
    pm.status = 'scheduled'
  FROM public.pool_matches pm
  CROSS JOIN LATERAL (
    SELECT group_slot_minutes, group_rest_gap_minutes
    FROM public.tournament_settings
    LIMIT 1
  ) settings
  WHERE pm.court_id IS NOT NULL
    AND pm.scheduled_time IS NOT NULL
    AND pm.status <> 'void'
  UNION ALL
  SELECT
    'draw_matches',
    dm.id,
    dm.court_id,
    dm.scheduled_time,
    dm.scheduled_time,
    dm.started_at,
    dm.ended_at,
    make_interval(mins => settings.knockout_slot_minutes),
    make_interval(mins => settings.knockout_rest_gap_minutes),
    dm.status,
    dm.status = 'scheduled'
  FROM public.draw_matches dm
  CROSS JOIN LATERAL (
    SELECT knockout_slot_minutes, knockout_rest_gap_minutes
    FROM public.tournament_settings
    LIMIT 1
  ) settings
  WHERE dm.court_id IS NOT NULL
    AND dm.scheduled_time IS NOT NULL
    AND dm.status <> 'void'
    AND COALESCE(dm.is_bye, false) = false;

  CREATE TEMP TABLE live_match_players (
    match_table text NOT NULL,
    match_id uuid NOT NULL,
    player_id uuid NOT NULL,
    PRIMARY KEY (match_table, match_id, player_id)
  ) ON COMMIT DROP;

  INSERT INTO live_match_players
  SELECT 'pool_matches', pm.id, player.player_id
  FROM public.pool_matches pm
  JOIN live_schedule_work work
    ON work.match_table = 'pool_matches' AND work.match_id = pm.id
  JOIN public.teams team
    ON team.id IN (pm.team_a_id, pm.team_b_id)
  CROSS JOIN LATERAL (
    VALUES (team.player_1_id), (team.player_2_id)
  ) player(player_id)
  WHERE player.player_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO live_match_players
  SELECT 'draw_matches', dm.id, player.player_id
  FROM public.draw_matches dm
  JOIN live_schedule_work work
    ON work.match_table = 'draw_matches' AND work.match_id = dm.id
  JOIN public.teams team
    ON team.id IN (dm.team_a_id, dm.team_b_id)
  CROSS JOIN LATERAL (
    VALUES (team.player_1_id), (team.player_2_id)
  ) player(player_id)
  WHERE player.player_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  CREATE INDEX live_match_players_player
    ON live_match_players (player_id, match_table, match_id);

  CREATE TEMP TABLE live_schedule_queue (
    match_table text NOT NULL,
    match_id uuid NOT NULL,
    PRIMARY KEY (match_table, match_id)
  ) ON COMMIT DROP;

  -- Every still-movable match after the completion on this court is in scope.
  INSERT INTO live_schedule_queue
  SELECT work.match_table, work.match_id
  FROM live_schedule_work work
  WHERE work.movable
    AND work.court_id = source_court
    AND (work.original_time, work.match_table, work.match_id::text)
      > (source_time, p_table, p_match_id::text);

  WHILE EXISTS (SELECT 1 FROM live_schedule_queue)
  LOOP
    iterations := iterations + 1;
    IF iterations > 10000 THEN
      RAISE EXCEPTION 'Live schedule propagation did not converge';
    END IF;

    SELECT work.*
    INTO current_match
    FROM live_schedule_queue queue
    JOIN live_schedule_work work
      ON work.match_table = queue.match_table
     AND work.match_id = queue.match_id
    ORDER BY work.original_time, work.match_table, work.match_id
    LIMIT 1;

    DELETE FROM live_schedule_queue
    WHERE match_table = current_match.match_table
      AND match_id = current_match.match_id;

    -- Preserve the court's existing sequence, but derive availability from the
    -- previous match's real end when known.
    SELECT CASE
      WHEN previous.actual_end IS NOT NULL THEN previous.actual_end
      WHEN previous.status = 'in-progress'
        THEN GREATEST(previous.shifted_time + previous.duration, statement_timestamp())
      ELSE previous.shifted_time + previous.duration
    END
    INTO previous_end
    FROM live_schedule_work previous
    WHERE previous.court_id = current_match.court_id
      AND (previous.original_time, previous.match_table, previous.match_id::text)
        < (current_match.original_time, current_match.match_table, current_match.match_id::text)
    ORDER BY previous.original_time DESC, previous.match_table DESC, previous.match_id DESC
    LIMIT 1;

    next_start := COALESCE(previous_end, current_match.shifted_time);

    -- Apply the same player-order/rest constraint used by the main scheduler.
    SELECT max(
      CASE
        WHEN previous.actual_end IS NOT NULL THEN previous.actual_end
        WHEN previous.status = 'in-progress'
          THEN GREATEST(previous.shifted_time + previous.duration, statement_timestamp())
        ELSE previous.shifted_time + previous.duration
      END + current_match.rest_gap
    )
    INTO previous_end
    FROM live_match_players mine
    JOIN live_match_players theirs ON theirs.player_id = mine.player_id
    JOIN live_schedule_work previous
      ON previous.match_table = theirs.match_table
     AND previous.match_id = theirs.match_id
    WHERE mine.match_table = current_match.match_table
      AND mine.match_id = current_match.match_id
      AND (previous.original_time, previous.match_table, previous.match_id::text)
        < (current_match.original_time, current_match.match_table, current_match.match_id::text);

    next_start := GREATEST(next_start, COALESCE(previous_end, next_start));

    -- A movable match may not be shifted through an immutable court or player
    -- window. If it cannot fit before that window (including player rest), put
    -- it immediately after the fixed match and check again.
    LOOP
      SELECT fixed.*,
        CASE
          WHEN fixed.actual_end IS NOT NULL THEN fixed.actual_end
          WHEN fixed.status = 'in-progress'
            THEN GREATEST(fixed.shifted_time + fixed.duration, statement_timestamp())
          ELSE fixed.shifted_time + fixed.duration
        END AS fixed_end
      INTO blocking_match
      FROM live_schedule_work fixed
      WHERE NOT fixed.movable
        AND fixed.match_id <> current_match.match_id
        AND (
          (
            fixed.court_id = current_match.court_id
            AND next_start < CASE
              WHEN fixed.actual_end IS NOT NULL THEN fixed.actual_end
              WHEN fixed.status = 'in-progress'
                THEN GREATEST(fixed.shifted_time + fixed.duration, statement_timestamp())
              ELSE fixed.shifted_time + fixed.duration
            END
            AND next_start + current_match.duration
              > COALESCE(fixed.actual_start, fixed.shifted_time)
          )
          OR EXISTS (
            SELECT 1
            FROM live_match_players mine
            JOIN live_match_players theirs ON theirs.player_id = mine.player_id
            WHERE mine.match_table = current_match.match_table
              AND mine.match_id = current_match.match_id
              AND theirs.match_table = fixed.match_table
              AND theirs.match_id = fixed.match_id
              AND next_start
                < CASE
                    WHEN fixed.actual_end IS NOT NULL THEN fixed.actual_end
                    WHEN fixed.status = 'in-progress'
                      THEN GREATEST(fixed.shifted_time + fixed.duration, statement_timestamp())
                    ELSE fixed.shifted_time + fixed.duration
                  END + current_match.rest_gap
              AND next_start + current_match.duration + current_match.rest_gap
                > COALESCE(fixed.actual_start, fixed.shifted_time)
          )
        )
      ORDER BY COALESCE(fixed.actual_start, fixed.shifted_time), fixed.match_table, fixed.match_id
      LIMIT 1;

      EXIT WHEN NOT FOUND;

      next_start := blocking_match.fixed_end
        + CASE
            WHEN EXISTS (
              SELECT 1
              FROM live_match_players mine
              JOIN live_match_players theirs ON theirs.player_id = mine.player_id
              WHERE mine.match_table = current_match.match_table
                AND mine.match_id = current_match.match_id
                AND theirs.match_table = blocking_match.match_table
                AND theirs.match_id = blocking_match.match_id
            )
            THEN current_match.rest_gap
            ELSE interval '0'
          END;
    END LOOP;

    IF next_start IS DISTINCT FROM current_match.shifted_time THEN
      UPDATE live_schedule_work
      SET shifted_time = next_start, dirty = true
      WHERE match_table = current_match.match_table
        AND match_id = current_match.match_id;

      -- Reflow the remainder of this court, preserving its sequence.
      INSERT INTO live_schedule_queue
      SELECT later.match_table, later.match_id
      FROM live_schedule_work later
      WHERE later.movable
        AND later.court_id = current_match.court_id
        AND (later.original_time, later.match_table, later.match_id::text)
          > (current_match.original_time, current_match.match_table, current_match.match_id::text)
      ON CONFLICT DO NOTHING;

      -- Only cross a court boundary when this move violates a later player's
      -- rest window. That conflicting match then reflows its own court.
      INSERT INTO live_schedule_queue
      SELECT DISTINCT later.match_table, later.match_id
      FROM live_match_players mine
      JOIN live_match_players theirs ON theirs.player_id = mine.player_id
      JOIN live_schedule_work later
        ON later.match_table = theirs.match_table
       AND later.match_id = theirs.match_id
      WHERE mine.match_table = current_match.match_table
        AND mine.match_id = current_match.match_id
        AND later.movable
        AND later.court_id <> current_match.court_id
        AND (later.original_time, later.match_table, later.match_id::text)
          > (current_match.original_time, current_match.match_table, current_match.match_id::text)
        AND later.shifted_time < next_start + current_match.duration + later.rest_gap
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  UPDATE public.pool_matches pm
  SET scheduled_time = work.shifted_time
  FROM live_schedule_work work
  WHERE work.match_table = 'pool_matches'
    AND work.match_id = pm.id
    AND work.dirty
    AND pm.status = 'scheduled';

  UPDATE public.draw_matches dm
  SET scheduled_time = work.shifted_time
  FROM live_schedule_work work
  WHERE work.match_table = 'draw_matches'
    AND work.match_id = dm.id
    AND work.dirty
    AND dm.status = 'scheduled';

  UPDATE public.pools pool
  SET scheduled_end = latest.scheduled_end
  FROM (
    SELECT pm.pool_id, max(pm.scheduled_time + settings.slot) AS scheduled_end
    FROM public.pool_matches pm
    CROSS JOIN LATERAL (
      SELECT make_interval(mins => group_slot_minutes) AS slot
      FROM public.tournament_settings
      LIMIT 1
    ) settings
    WHERE pm.status <> 'void'
      AND pm.scheduled_time IS NOT NULL
    GROUP BY pm.pool_id
  ) latest
  WHERE pool.id = latest.pool_id;
END;
$$;

REVOKE ALL ON FUNCTION public.shift_live_schedule_after_match(text, uuid)
FROM anon, authenticated, public;

CREATE OR REPLACE FUNCTION public.report_pool_result(p_match_id uuid, p_score_a int, p_score_b int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  winner uuid;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','scorer']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_score_a < 0 OR p_score_b < 0 OR p_score_a = p_score_b THEN
    RAISE EXCEPTION 'A group match needs a valid winning score';
  END IF;
  IF NOT ((p_score_a >= 21 AND p_score_a - p_score_b >= 2) OR (p_score_b >= 21 AND p_score_b - p_score_a >= 2)) THEN
    RAISE EXCEPTION 'Group games are race to 21, win by 2';
  END IF;
  SELECT CASE WHEN p_score_a > p_score_b THEN team_a_id ELSE team_b_id END
  INTO winner FROM public.pool_matches WHERE id = p_match_id;
  UPDATE public.pool_matches
  SET score_a = p_score_a,
      score_b = p_score_b,
      winner_id = winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;
  PERFORM public.shift_live_schedule_after_match('pool_matches', p_match_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.report_draw_result(p_match_id uuid, p_games jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  wins_a int := 0;
  wins_b int := 0;
  game jsonb;
  sa int;
  sb int;
  winner uuid;
  draw uuid;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','scorer']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF jsonb_array_length(p_games) < 2 OR jsonb_array_length(p_games) > 3 THEN
    RAISE EXCEPTION 'Knockouts are best of three';
  END IF;
  FOR game IN SELECT * FROM jsonb_array_elements(p_games)
  LOOP
    sa := (game->>'a')::int;
    sb := (game->>'b')::int;
    IF sa < 0 OR sb < 0 OR sa = sb THEN
      RAISE EXCEPTION 'Each game needs a valid winning score';
    END IF;
    IF NOT ((sa >= 21 AND sa - sb >= 2) OR (sb >= 21 AND sb - sa >= 2)) THEN
      RAISE EXCEPTION 'Games are race to 21, win by 2';
    END IF;
    IF sa > sb THEN wins_a := wins_a + 1; ELSE wins_b := wins_b + 1; END IF;
    IF (wins_a >= 2 OR wins_b >= 2) AND game <> p_games -> -1 THEN
      RAISE EXCEPTION 'Do not enter games after the match is decided';
    END IF;
  END LOOP;
  IF wins_a < 2 AND wins_b < 2 THEN
    RAISE EXCEPTION 'A side must win two games';
  END IF;
  SELECT CASE WHEN wins_a >= 2 THEN team_a_id ELSE team_b_id END, draw_id
  INTO winner, draw
  FROM public.draw_matches WHERE id = p_match_id;
  IF winner IS NULL THEN
    RAISE EXCEPTION 'That side has no team assigned yet';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('draw:' || draw::text));
  UPDATE public.draw_matches
  SET games = p_games,
      winner_id = winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;
  PERFORM public.advance_draw_locked(draw);
  PERFORM public.shift_live_schedule_after_match('draw_matches', p_match_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_match_exception(
  p_table text,
  p_match_id uuid,
  p_status text,
  p_winner_id uuid,
  p_note text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','scorer']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_status NOT IN ('walkover','void') THEN
    RAISE EXCEPTION 'Unsupported exception status';
  END IF;
  IF p_table = 'pool_matches' THEN
    UPDATE public.pool_matches
    SET status = p_status,
        winner_id = CASE WHEN p_status = 'void' THEN NULL ELSE p_winner_id END,
        note = p_note,
        reported_time = statement_timestamp(),
        ended_at = COALESCE(ended_at, statement_timestamp())
    WHERE id = p_match_id;
  ELSIF p_table = 'draw_matches' THEN
    UPDATE public.draw_matches
    SET status = p_status,
        winner_id = CASE WHEN p_status = 'void' THEN NULL ELSE p_winner_id END,
        note = p_note,
        reported_time = statement_timestamp(),
        ended_at = COALESCE(ended_at, statement_timestamp())
    WHERE id = p_match_id;
    IF p_status = 'walkover' THEN
      PERFORM public.advance_draw_locked(
        (SELECT draw_id FROM public.draw_matches WHERE id = p_match_id)
      );
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported match table';
  END IF;

  IF p_status = 'walkover' THEN
    PERFORM public.shift_live_schedule_after_match(p_table, p_match_id);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.report_pool_result(uuid, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_draw_result(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_match_exception(text, uuid, text, uuid, text) TO authenticated;
