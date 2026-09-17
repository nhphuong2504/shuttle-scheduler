-- ---------------------------------------------------------------------------
-- Live schedule reflow for the two-round placement format.
--
-- Two things happen here, and the first is the reason the second exists.
--
-- 1. `shift_live_schedule_after_match` learns about `placement_matches` and
--    `tier_draw_matches`.
--
--    Until now, reporting a placement result moved nothing. Every other match on
--    that court stayed at its planned time, so a placement round that ran 20
--    minutes long silently ate the gap before the next match, and the desk only
--    found out when the day ended late. The round-robin path has reflowed since
--    `20260910120000_live_schedule_time_shift.sql`; this closes the same gap for
--    the format that replaced it.
--
--    The change is deliberately additive. The function is ~350 lines of reflow
--    algorithm -- court sequencing, player rest windows, immutable windows,
--    cross-court propagation -- and none of it is format-specific. Rewriting it
--    would have put a working, load-bearing path at risk to add two tables to a
--    `UNION ALL`. So the body is unchanged: five additions at five anchors (a
--    wider table guard, a fourth arm on the source-row lookup, two union branches,
--    two player-lookup inserts, two write-backs) and not one edit to the logic
--    between them. `scripts/verify-placement-shift-migration.ps1` proves that, by
--    requiring every line of the original function to appear in this one, in
--    order, with only the three deliberate one-line rewrites standing in for it.
--
--    The source-row lookup is the addition worth not missing. It was a two-way
--    `IF ... ELSE`, so without a fourth arm a placement match would have been
--    looked up in `draw_matches`, found nothing, and returned early on
--    `source_court IS NULL` -- the reflow would have silently done nothing at all,
--    which is the worst available failure mode.
--
--    Why that is safe rather than merely cautious: every branch is scoped to
--    `source_tournament`, and a tournament has exactly one format. For a
--    round-robin tournament the two new branches match zero rows, and for a
--    placement tournament the two legacy branches do. The two sets of tables can
--    never both contribute to one reflow, so neither format can perturb the other.
--
-- 2. `report_placement_result` and `report_tier_draw_result` call it.
--
--    Without this the first change would be dead code. Note the ordering in the
--    knockout case: advance the bracket first, then reflow, because advancing can
--    create a match that is now ready to play and a reflow that ran first would
--    not know about it.
--
-- Not covered: `start_placement_match`. Marking a match in progress is a
-- statement about the present, not an event that reschedules the day; the legacy
-- path draws the same line.
-- ---------------------------------------------------------------------------
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
  source_tournament uuid;
  current_match record;
  blocking_match record;
  next_start timestamptz;
  previous_end timestamptz;
  iterations int := 0;
BEGIN
  IF p_table NOT IN ('pool_matches', 'draw_matches', 'placement_matches', 'tier_draw_matches') THEN
    RAISE EXCEPTION 'Unsupported match table';
  END IF;

  -- Serialize result-driven changes with either day's full schedule writer.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));

  IF p_table = 'pool_matches' THEN
    SELECT court_id, scheduled_time, ended_at, tournament_id
    INTO source_court, source_time, source_end, source_tournament
    FROM public.pool_matches
    WHERE id = p_match_id
      AND status IN ('reported', 'walkover');
  ELSIF p_table = 'draw_matches' THEN
    SELECT court_id, scheduled_time, ended_at, tournament_id
    INTO source_court, source_time, source_end, source_tournament
    FROM public.draw_matches
    WHERE id = p_match_id
      AND status IN ('reported', 'walkover');
  ELSIF p_table = 'placement_matches' THEN
    SELECT court_id, scheduled_time, ended_at, tournament_id
    INTO source_court, source_time, source_end, source_tournament
    FROM public.placement_matches
    WHERE id = p_match_id
      AND status IN ('reported', 'walkover');
  ELSE
    SELECT court_id, scheduled_time, ended_at, tournament_id
    INTO source_court, source_time, source_end, source_tournament
    FROM public.tier_draw_matches
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

  -- Only this tournament's matches are in scope for the reflow.
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
  JOIN public.tournaments settings ON settings.id = pm.tournament_id
  WHERE pm.tournament_id = source_tournament
    AND pm.court_id IS NOT NULL
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
  JOIN public.tournaments settings ON settings.id = dm.tournament_id
  WHERE dm.tournament_id = source_tournament
    AND dm.court_id IS NOT NULL
    AND dm.scheduled_time IS NOT NULL
    AND dm.status <> 'void'
    AND COALESCE(dm.is_bye, false) = false

  -- The two-round placement format's tables. For the columns this function
  -- reads they are structurally identical to the legacy pair: court, time,
  -- actual start and end, status. Only the entrant columns differ, and this
  -- function never touches those. A tournament has exactly one format, so on any
  -- given call exactly one pair of branches contributes rows and the other pair
  -- matches nothing -- which is what keeps this change additive rather than a
  -- behaviour change for the round-robin path.
  UNION ALL
  SELECT
    'placement_matches',
    pmet.id,
    pmet.court_id,
    pmet.scheduled_time,
    pmet.scheduled_time,
    pmet.started_at,
    pmet.ended_at,
    make_interval(mins => settings.group_slot_minutes),
    make_interval(mins => settings.group_rest_gap_minutes),
    pmet.status,
    pmet.status = 'scheduled'
  FROM public.placement_matches pmet
  JOIN public.tournaments settings ON settings.id = pmet.tournament_id
  WHERE pmet.tournament_id = source_tournament
    AND pmet.court_id IS NOT NULL
    AND pmet.scheduled_time IS NOT NULL
    AND pmet.status <> 'void'
  UNION ALL
  SELECT
    'tier_draw_matches',
    tdm.id,
    tdm.court_id,
    tdm.scheduled_time,
    tdm.scheduled_time,
    tdm.started_at,
    tdm.ended_at,
    make_interval(mins => settings.knockout_slot_minutes),
    make_interval(mins => settings.knockout_rest_gap_minutes),
    tdm.status,
    tdm.status = 'scheduled'
  FROM public.tier_draw_matches tdm
  JOIN public.tournaments settings ON settings.id = tdm.tournament_id
  WHERE tdm.tournament_id = source_tournament
    AND tdm.court_id IS NOT NULL
    AND tdm.scheduled_time IS NOT NULL
    AND tdm.status <> 'void'
    AND NOT tdm.is_bye;

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

  -- This is the one place the new tables are not structurally identical to the
  -- legacy ones. A placement match carries entrant ids, and an entrant is what
  -- points at a team, so resolving players needs one more hop. The rest-gap
  -- reflow is driven entirely by this table: get it wrong and the function would
  -- happily move a player's next match into their rest window.
  INSERT INTO live_match_players
  SELECT 'placement_matches', pmet.id, player.player_id
  FROM public.placement_matches pmet
  JOIN live_schedule_work work
    ON work.match_table = 'placement_matches' AND work.match_id = pmet.id
  JOIN public.placement_entrants entrant
    ON entrant.id IN (pmet.entrant_a_id, pmet.entrant_b_id)
  JOIN public.teams team
    ON team.id = entrant.team_id
  CROSS JOIN LATERAL (
    VALUES (team.player_1_id), (team.player_2_id)
  ) player(player_id)
  WHERE player.player_id IS NOT NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO live_match_players
  SELECT 'tier_draw_matches', tdm.id, player.player_id
  FROM public.tier_draw_matches tdm
  JOIN live_schedule_work work
    ON work.match_table = 'tier_draw_matches' AND work.match_id = tdm.id
  JOIN public.placement_entrants entrant
    ON entrant.id IN (tdm.entrant_a_id, tdm.entrant_b_id)
  JOIN public.teams team
    ON team.id = entrant.team_id
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

  UPDATE public.placement_matches pmet
  SET scheduled_time = work.shifted_time
  FROM live_schedule_work work
  WHERE work.match_table = 'placement_matches'
    AND work.match_id = pmet.id
    AND work.dirty
    AND pmet.status = 'scheduled';

  UPDATE public.tier_draw_matches tdm
  SET scheduled_time = work.shifted_time
  FROM live_schedule_work work
  WHERE work.match_table = 'tier_draw_matches'
    AND work.match_id = tdm.id
    AND work.dirty
    AND tdm.status = 'scheduled';

  UPDATE public.pools pool
  SET scheduled_end = latest.scheduled_end
  FROM (
    SELECT pm.pool_id, max(pm.scheduled_time + settings.slot) AS scheduled_end
    FROM public.pool_matches pm
    JOIN public.tournaments t ON t.id = pm.tournament_id
    CROSS JOIN LATERAL (
      SELECT make_interval(mins => t.group_slot_minutes) AS slot
    ) settings
    WHERE pm.status <> 'void'
      AND pm.scheduled_time IS NOT NULL
      AND pm.tournament_id = source_tournament
    GROUP BY pm.pool_id
  ) latest
  WHERE pool.id = latest.pool_id;
END;
$$;

-------------------------------------------------------------------------------
-- 2. Reporting a result now reflows the rest of the day
-------------------------------------------------------------------------------

-- Both report functions are redefined for one reason: to call the shift that
-- section 1 taught about the placement tables. Everything else about them is
-- unchanged, including their signatures, so this is a replace and not a new
-- overload.
--
-- Only the reporting path reflows, not `start_placement_match`. Live reflow is
-- about recovery: a match that finishes late pushes the rest of its court, and
-- that is a consequence of a *result*. Marking a match in progress is a statement
-- about what is happening, not an event that reschedules anything.

CREATE OR REPLACE FUNCTION public.report_placement_result(
  p_match_id uuid,
  p_games jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_side text;
  v_winner uuid;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT tournament_id INTO v_tournament
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT public.placement_check_games(
    p_games, t.placement_games_to, t.placement_win_by, t.placement_best_of
  ) INTO v_side
  FROM public.tournaments t WHERE t.id = v_tournament;

  SELECT CASE WHEN v_side = 'a' THEN entrant_a_id ELSE entrant_b_id END INTO v_winner
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_winner IS NULL THEN
    RAISE EXCEPTION 'That side has no entrant assigned yet';
  END IF;

  UPDATE public.placement_matches
  SET games = p_games,
      winner_id = v_winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;

  PERFORM public.shift_live_schedule_after_match('placement_matches', p_match_id);
END;
$$;

REVOKE ALL ON FUNCTION public.report_placement_result(uuid, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_placement_result(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.report_tier_draw_result(
  p_match_id uuid,
  p_games jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_draw uuid;
  v_side text;
  v_winner uuid;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT tournament_id, draw_id INTO v_tournament, v_draw
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT public.placement_check_games(
    p_games, t.knockout_games_to, t.knockout_win_by, t.knockout_best_of
  ) INTO v_side
  FROM public.tournaments t WHERE t.id = v_tournament;

  SELECT CASE WHEN v_side = 'a' THEN entrant_a_id ELSE entrant_b_id END INTO v_winner
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_winner IS NULL THEN
    RAISE EXCEPTION 'That side has no entrant assigned yet';
  END IF;

  UPDATE public.tier_draw_matches
  SET games = p_games,
      winner_id = v_winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;

  -- Advance first, then reflow. Advancing may create a match that is now ready to
  -- play, and reflowing before it existed would leave that match out of the
  -- ordering it just joined.
  PERFORM public.advance_tier_draw_locked(v_draw);
  PERFORM public.shift_live_schedule_after_match('tier_draw_matches', p_match_id);
END;
$$;

REVOKE ALL ON FUNCTION public.report_tier_draw_result(uuid, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_tier_draw_result(uuid, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';