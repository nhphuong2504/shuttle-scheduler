-- Keep live projected times truthful past the configured close. No data backfill:
-- existing rows move only on the next ordinary live reflow. New-match placement and
-- rebuild policies are unchanged. Court, player, prerequisite, break and day scope
-- checks are carried forward from 20261026000000_whole_minute_published_times.sql.

CREATE OR REPLACE FUNCTION public.shift_live_schedule_core(
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
  source_start timestamptz;
  source_status text;
  source_tournament uuid;
  v_tz text;
  v_day_id uuid;
  v_day_date date;
  v_break_end timestamptz;
  v_prereq_end timestamptz;
  current_match record;
  blocking_match record;
  next_start timestamptz;
  previous_end timestamptz;
  iterations int := 0;
  v_threshold interval := public.schedule_shift_threshold();
  v_rounded timestamptz;
BEGIN
  IF p_table NOT IN ('pool_matches', 'draw_matches', 'placement_matches', 'tier_draw_matches') THEN
    RAISE EXCEPTION 'Unsupported match table';
  END IF;

  -- Three global keys, taken in the same order every schedule writer takes them
  -- (`apply_day_schedule`, `apply_placement_day_schedule`, `start_match_safe` and the
  -- resets all take `live-schedule` and at least one `schedule:N`). They serialise
  -- every writer in the database against every other, which is what makes this reflow
  -- safe to run concurrently with a rebuild.
  --
  -- The per-tournament key below is currently redundant: the global keys are already
  -- held, so no second tournament can reach it at the same time. It is kept as the
  -- first half of a move to per-tournament locking that cannot happen until the
  -- writers above also stop taking the global keys - dropping the global keys here
  -- alone would break that mutual exclusion, not narrow it.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));

  IF p_table = 'pool_matches' THEN
    SELECT court_id, scheduled_time, ended_at, started_at, status, tournament_id
    INTO source_court, source_time, source_end, source_start, source_status, source_tournament
    FROM public.pool_matches
    WHERE id = p_match_id
      AND status IN ('reported', 'walkover', 'in-progress');
  ELSIF p_table = 'draw_matches' THEN
    SELECT court_id, scheduled_time, ended_at, started_at, status, tournament_id
    INTO source_court, source_time, source_end, source_start, source_status, source_tournament
    FROM public.draw_matches
    WHERE id = p_match_id
      AND status IN ('reported', 'walkover', 'in-progress');
  ELSIF p_table = 'placement_matches' THEN
    SELECT court_id, scheduled_time, ended_at, started_at, status, tournament_id
    INTO source_court, source_time, source_end, source_start, source_status, source_tournament
    FROM public.placement_matches
    WHERE id = p_match_id
      AND status IN ('reported', 'walkover', 'in-progress');
  ELSE
    SELECT court_id, scheduled_time, ended_at, started_at, status, tournament_id
    INTO source_court, source_time, source_end, source_start, source_status, source_tournament
    FROM public.tier_draw_matches
    WHERE id = p_match_id
      AND status IN ('reported', 'walkover', 'in-progress');
  END IF;

  -- Unscheduled completions cannot establish a court sequence, and a finished match
  -- with no end has no span to reflow from. An in-progress match does: its expected
  -- end is its actual start plus its slot, floored at now, which the loop derives from
  -- the work row (there is no `ended_at` to read here).
  IF source_court IS NULL OR source_time IS NULL THEN
    RETURN;
  END IF;
  IF source_end IS NULL AND source_status <> 'in-progress' THEN
    RETURN;
  END IF;

  -- Where an in-progress source stands on its court: the earlier of where it was
  -- published and where it actually began. See the header for why the minimum, and
  -- not the actual start alone, is the boundary the queue needs.
  IF source_status = 'in-progress' AND source_start IS NOT NULL THEN
    source_time := LEAST(source_time, source_start);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('live-schedule:' || source_tournament::text));

  SELECT t.venue_timezone INTO v_tz FROM public.tournaments t WHERE t.id = source_tournament;

  -- Scope the cascade to matches originally assigned to the source's day.
  -- Closing time is a warning, not a floor or a cap on the projected times.
  v_day_id := public.tournament_day_at(source_tournament, source_time);
  SELECT d.date
  INTO v_day_date
  FROM public.tournament_days d
  WHERE d.id = v_day_id;

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
    day_id uuid,
    prereq_ids uuid[] NOT NULL DEFAULT '{}',
    PRIMARY KEY (match_table, match_id)
  ) ON COMMIT DROP;

  CREATE INDEX live_schedule_work_court_time
    ON live_schedule_work (court_id, original_time, match_table, match_id);
  CREATE INDEX live_schedule_work_day
    ON live_schedule_work (day_id);

  -- Only this tournament's matches are in scope for the reflow. `day_id` and
  -- `prereq_ids` are additions over the previous definition: the first scopes the
  -- queue to the source's day, the second makes the ordering rule the generators
  -- declared (`prerequisite_ids`, or a knockout parent) part of the shift.
  INSERT INTO live_schedule_work (
    match_table, match_id, court_id, original_time, shifted_time,
    actual_start, actual_end, duration, rest_gap, status, movable, day_id, prereq_ids
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
    pm.status = 'scheduled',
    public.tournament_day_at(pm.tournament_id, pm.scheduled_time),
    ARRAY[]::uuid[]
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
    dm.status = 'scheduled',
    public.tournament_day_at(dm.tournament_id, dm.scheduled_time),
    ARRAY_REMOVE(ARRAY[dm.parent_a_id, dm.parent_b_id], NULL)
  FROM public.draw_matches dm
  JOIN public.tournaments settings ON settings.id = dm.tournament_id
  WHERE dm.tournament_id = source_tournament
    AND dm.court_id IS NOT NULL
    AND dm.scheduled_time IS NOT NULL
    AND dm.status <> 'void'
    AND COALESCE(dm.is_bye, false) = false
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
    pmet.status = 'scheduled',
    public.tournament_day_at(pmet.tournament_id, pmet.scheduled_time),
    pmet.prerequisite_ids
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
    tdm.status = 'scheduled',
    public.tournament_day_at(tdm.tournament_id, tdm.scheduled_time),
    ARRAY_REMOVE(ARRAY[tdm.parent_a_id, tdm.parent_b_id], NULL)
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

  -- Every still-movable match after the source on this court AND on the same
  -- day. The day filter is the fix for defect 2: without it, day two's first match
  -- was dragged back to the end of day one. `source_time` is the earlier of the
  -- source's published time and its actual start for an in-progress source, so a
  -- late start still reaches the court's next match and a move to an earlier court
  -- still reaches the target court's matches ahead of the old published time.
  INSERT INTO live_schedule_queue
  SELECT work.match_table, work.match_id
  FROM live_schedule_work work
  WHERE work.movable
    AND work.court_id = source_court
    AND (v_day_id IS NULL OR work.day_id = v_day_id)
    AND (work.original_time, work.match_table, work.match_id::text)
      > (source_time, p_table, p_match_id::text);

  -- A match that *waits on the source* is part of the cascade even when it is on
  -- another court: its prerequisite's end is a floor on its start, so one court's
  -- overrun is two courts' problem. This seed is deliberately not filtered on
  -- `original_time > source_time`, because the dependent the office published ahead
  -- of its prerequisite is exactly the row this fixes.
  INSERT INTO live_schedule_queue
  SELECT work.match_table, work.match_id
  FROM live_schedule_work work
  WHERE work.movable
    AND work.match_id <> p_match_id
    AND (v_day_id IS NULL OR work.day_id = v_day_id)
    AND p_match_id = ANY(work.prereq_ids)
  ON CONFLICT DO NOTHING;

  -- A match that *shares a player with the source* is part of the cascade even when it
  -- is on another court, and the two seeds above do not reach it: the court seed is the
  -- source's own court, and the dependent seed is only for a match that declares the
  -- source as a prerequisite. Without this one the source's own overrun never reached a
  -- co-player elsewhere - a shared match entered the queue only after some *other* match
  -- had moved - so a reported result could overlap the player's still-scheduled next
  -- game on another court. The loop's player-rest floor (`previous.actual_end +
  -- current_match.rest_gap`) is what then pushes the co-player behind the source's real
  -- end; this seed only has to put it in the queue.
  INSERT INTO live_schedule_queue
  SELECT DISTINCT work.match_table, work.match_id
  FROM live_schedule_work work
  JOIN live_match_players theirs
    ON theirs.match_table = work.match_table
   AND theirs.match_id = work.match_id
  JOIN live_match_players mine
    ON mine.player_id = theirs.player_id
   AND mine.match_table = p_table
   AND mine.match_id = p_match_id
  WHERE work.movable
    AND (v_day_id IS NULL OR work.day_id = v_day_id)
    AND (work.original_time, work.match_table, work.match_id::text)
      > (source_time, p_table, p_match_id::text)
  ON CONFLICT DO NOTHING;

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
    -- previous match's real end when known. Scoped to this day so a prior day's
    -- last match cannot be mistaken for this day's predecessor. An in-progress
    -- previous match has no end yet, so it is read from when it actually began.
    SELECT CASE
      WHEN previous.actual_end IS NOT NULL THEN previous.actual_end
      WHEN previous.status = 'in-progress'
        THEN GREATEST(COALESCE(previous.actual_start, previous.shifted_time) + previous.duration, statement_timestamp())
      ELSE previous.shifted_time + previous.duration
    END
    INTO previous_end
    FROM live_schedule_work previous
    WHERE previous.court_id = current_match.court_id
      AND previous.day_id = current_match.day_id
      AND (previous.original_time, previous.match_table, previous.match_id::text)
        < (current_match.original_time, current_match.match_table, current_match.match_id::text)
    ORDER BY previous.original_time DESC, previous.match_table DESC, previous.match_id DESC
    LIMIT 1;

    -- The floor at the match's own published time is defect 1's fix: the reflow may
    -- push a match later, never earlier. GREATEST ignores the NULL a court with no
    -- predecessor produces, which is the intended "no court bound" reading.
    next_start := GREATEST(current_match.shifted_time, previous_end);

    -- Apply the same player-order/rest constraint used by the main scheduler.
    SELECT max(
      CASE
        WHEN previous.actual_end IS NOT NULL THEN previous.actual_end
        WHEN previous.status = 'in-progress'
          THEN GREATEST(COALESCE(previous.actual_start, previous.shifted_time) + previous.duration, statement_timestamp())
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

    -- Dependency ordering: the match may not start before every prerequisite
    -- (a placement match's `prerequisite_ids`, a knockout's parents) has finished.
    SELECT max(
      CASE
        WHEN prereq.actual_end IS NOT NULL THEN prereq.actual_end
        WHEN prereq.status = 'in-progress'
          THEN GREATEST(COALESCE(prereq.actual_start, prereq.shifted_time) + prereq.duration, statement_timestamp())
        ELSE prereq.shifted_time + prereq.duration
      END
    )
    INTO v_prereq_end
    FROM live_schedule_work prereq
    WHERE prereq.match_id = ANY(current_match.prereq_ids)
      -- Not a prerequisite that sits *behind* this match on its own court. The court keeps its
      -- published order (the previous-match floor above), so waiting for a match that is queued after
      -- you on your own court is a contradiction no move can satisfy: each run pushed this match
      -- behind the prerequisite and the prerequisite behind this match, a slot plus rest later every
      -- time (+25 minutes at a 10-minute slot and 5 minutes' rest), indefinitely. The pair is left
      -- in its published order, and `schedule_conflicts` reports it as `before_prerequisite` for a
      -- rebuild to reorder.
      AND NOT (
        prereq.court_id = current_match.court_id
        AND prereq.day_id IS NOT DISTINCT FROM current_match.day_id
        AND (prereq.original_time, prereq.match_table, prereq.match_id::text)
          > (current_match.original_time, current_match.match_table, current_match.match_id::text)
      );

    next_start := GREATEST(next_start, v_prereq_end);

    -- The walls below (breaks, then immovable windows, then breaks again) are applied until
    -- the start stops moving. A match the floors moved is published on a whole minute,
    -- rounded UP so it can never start before a court is free or a player has rested, and
    -- the rounded start goes back through the walls, because a minute later may now touch a
    -- break or a fixed window. A match nothing moved keeps its stored time exactly, seconds
    -- and all: rounding an untouched row would read as an unnecessary move.
    LOOP
    -- A break is a wall the match may not overlap. Clamped before the immovable
    -- windows below so a fixed match sitting on the far side of a break is still
    -- respected, and re-checked after them.
    IF v_day_id IS NOT NULL THEN
      LOOP
        v_break_end := NULL;
        SELECT min((v_day_date + br.end_time) AT TIME ZONE v_tz)
        INTO v_break_end
        FROM public.tournament_day_breaks br
        WHERE br.day_id = v_day_id
          AND next_start < ((v_day_date + br.end_time) AT TIME ZONE v_tz)
          AND next_start + current_match.duration > ((v_day_date + br.start_time) AT TIME ZONE v_tz);
        EXIT WHEN v_break_end IS NULL;
        next_start := v_break_end;
      END LOOP;
    END IF;

    -- A movable match may not be shifted through an immutable court or player
    -- window. If it cannot fit before that window (including player rest), put
    -- it immediately after the fixed match and check again.
    LOOP
      SELECT fixed.*,
        CASE
          WHEN fixed.actual_end IS NOT NULL THEN fixed.actual_end
          WHEN fixed.status = 'in-progress'
            THEN GREATEST(COALESCE(fixed.actual_start, fixed.shifted_time) + fixed.duration, statement_timestamp())
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
                THEN GREATEST(COALESCE(fixed.actual_start, fixed.shifted_time) + fixed.duration, statement_timestamp())
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
                      THEN GREATEST(COALESCE(fixed.actual_start, fixed.shifted_time) + fixed.duration, statement_timestamp())
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

    -- The immovable window may have pushed the match into a break.
    IF v_day_id IS NOT NULL THEN
      LOOP
        v_break_end := NULL;
        SELECT min((v_day_date + br.end_time) AT TIME ZONE v_tz)
        INTO v_break_end
        FROM public.tournament_day_breaks br
        WHERE br.day_id = v_day_id
          AND next_start < ((v_day_date + br.end_time) AT TIME ZONE v_tz)
          AND next_start + current_match.duration > ((v_day_date + br.start_time) AT TIME ZONE v_tz);
        EXIT WHEN v_break_end IS NULL;
        next_start := v_break_end;
      END LOOP;
    END IF;

    EXIT WHEN next_start IS NOT DISTINCT FROM current_match.shifted_time;
    v_rounded := public.ceil_to_minute(next_start);
    EXIT WHEN v_rounded = next_start;
    next_start := v_rounded;
    END LOOP;

    -- Publish the actual delay even when its finish crosses closing time. The
    -- conflict report warns via past_closing; freezing this row would leave it
    -- overlapping its predecessor and stop the delay reaching the rest of the tail.
    IF next_start IS DISTINCT FROM current_match.shifted_time THEN
      -- The cascade always follows the computed time, so the matches behind this one are
      -- placed after where it will really be. Whether the row is *written* is a separate
      -- question: a move smaller than the threshold, measured from the published time, is
      -- not worth a changed board. The gap never accumulates, because every run measures from
      -- the stored time, so the row is written once the computed time is the threshold away.
      UPDATE live_schedule_work
      SET shifted_time = next_start,
          dirty = (next_start - current_match.original_time) >= v_threshold
      WHERE match_table = current_match.match_table
        AND match_id = current_match.match_id;

      -- Reflow the remainder of this court, preserving its sequence.
      INSERT INTO live_schedule_queue
      SELECT later.match_table, later.match_id
      FROM live_schedule_work later
      WHERE later.movable
        AND later.court_id = current_match.court_id
        AND later.day_id = current_match.day_id
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
        AND later.day_id = current_match.day_id
        AND (later.original_time, later.match_table, later.match_id::text)
          > (current_match.original_time, current_match.match_table, current_match.match_id::text)
        AND later.shifted_time < next_start + current_match.duration + later.rest_gap
      ON CONFLICT DO NOTHING;

      -- Cross a court boundary for a match that *waits on this one*: a prerequisite
      -- that just moved later drags its dependent with it, even on another court.
      INSERT INTO live_schedule_queue
      SELECT DISTINCT later.match_table, later.match_id
      FROM live_schedule_work later
      WHERE later.movable
        AND later.day_id = current_match.day_id
        AND current_match.match_id = ANY(later.prereq_ids)
        AND (later.original_time, later.match_table, later.match_id::text)
          > (current_match.original_time, current_match.match_table, current_match.match_id::text)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  -- A move under the threshold may stay unwritten only while its published time still agrees
  -- with every time this run *does* write. The threshold is a tolerance against real starts and
  -- finishes; between two published times there is none (`schedule_conflicts` compares those
  -- strictly). So a row whose stored time would overlap, on its court, a written row - or sit
  -- inside a shared player's rest from one, or start before a written prerequisite ends - is
  -- written after all. Writing it can expose the next row the same way, hence the loop; it ends
  -- because rows only ever become dirty.
  LOOP
    UPDATE live_schedule_work w
    SET dirty = true
    WHERE w.movable
      AND NOT w.dirty
      AND w.shifted_time IS DISTINCT FROM w.original_time
      AND EXISTS (
        SELECT 1
        FROM live_schedule_work o
        WHERE o.dirty
          AND (o.match_table, o.match_id) <> (w.match_table, w.match_id)
          AND (
            (
              o.court_id = w.court_id
              AND w.original_time < o.shifted_time + o.duration
              AND o.shifted_time < w.original_time + w.duration
            )
            OR (
              EXISTS (
                SELECT 1
                FROM live_match_players mine
                JOIN live_match_players theirs ON theirs.player_id = mine.player_id
                WHERE mine.match_table = w.match_table
                  AND mine.match_id = w.match_id
                  AND theirs.match_table = o.match_table
                  AND theirs.match_id = o.match_id
              )
              AND w.original_time < o.shifted_time + o.duration + w.rest_gap
              AND o.shifted_time < w.original_time + w.duration + o.rest_gap
            )
            OR (
              o.match_id = ANY(w.prereq_ids)
              AND w.original_time < o.shifted_time + o.duration
            )
          )
      );
    EXIT WHEN NOT FOUND;
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

REVOKE ALL ON FUNCTION public.shift_live_schedule_core(text, uuid) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.shift_live_schedule_core(text, uuid) TO service_role;

DO $verify$
DECLARE
  body text;
BEGIN
  SELECT prosrc INTO body FROM pg_proc
  WHERE oid = 'public.shift_live_schedule_core(text, uuid)'::regprocedure;
  IF body LIKE '%SET held = true%' OR body LIKE '%v_day_end%'
     OR body NOT LIKE '%public.ceil_to_minute(next_start)%'
     OR body NOT LIKE '%later.day_id = current_match.day_id%' THEN
    RAISE EXCEPTION 'Live reflow must propagate past closing while preserving minute rounding and day scope';
  END IF;
  IF has_function_privilege('authenticated', 'public.shift_live_schedule_core(text, uuid)', 'execute')
     OR has_function_privilege('anon', 'public.shift_live_schedule_core(text, uuid)', 'execute') THEN
    RAISE EXCEPTION 'shift_live_schedule_core must remain internal';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.shift_live_schedule_core(text, uuid)'::regprocedure
      AND prosecdef AND proconfig @> ARRAY['search_path=public']
  ) THEN
    RAISE EXCEPTION 'Live reflow must retain its security-definer search path';
  END IF;
END;
$verify$;
