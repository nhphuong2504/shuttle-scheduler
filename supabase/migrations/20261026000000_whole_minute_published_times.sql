-- Published times are whole minutes, a reflow writes only a move worth announcing, and the conflict
-- report names only what the plan itself gets wrong.
--
-- Viet Nam Open 2026 (analysis/viet-nam-open-2026, Wave 3 item 3.3):
--
--   * 307 of the 309 times the reflow wrote carried seconds (14:03:14), and 186 of the 309 moves were
--     under a minute. The board changed after almost every result, and the activity log was mostly
--     noise.
--   * Replaying the two days minute by minute, `schedule_conflicts` raised 64 conflicts. 62 were a
--     match still on court running past its slot; 61 cleared on their own when that match's result
--     ran the reflow. The organiser's "N matches need schedule review" came and went every few
--     minutes, each time pointing at a rebuild.
--
-- Four changes:
--
--   1. `schedule_shift_threshold()` - one number, 2 minutes, for "a move worth writing". The reflow
--      and the conflict report read it here, and the planner's TypeScript mirror is pinned to it by
--      `db-invariants.test.ts`, so the three cannot drift apart.
--   2. `ceil_to_minute()` - rounding UP, never to nearest: a start rounded down could begin before
--      a court is free or a player has rested.
--   3. `shift_live_schedule_core` - a match the floors move is published on a whole minute, and a
--      move smaller than the threshold (from the published time) is computed but not written. The
--      cascade still follows the computed time. A row nothing moved keeps its stored time exactly.
--   4. `schedule_conflicts` - a match on court occupies its planned span (its real start plus one
--      slot), not "until now": running long is the Desk's Overrun, not a fault in the plan, and the
--      reflow re-times its successors when the result lands. `past_closing` is reported only for a
--      match that has not started. Where one side is a real time (a start or a finish), a gap under
--      the threshold is the reflow's tolerance, not a conflict; two published times are still
--      compared strictly. Each row now names the other match, the player and the minutes, so the
--      screen can say what is wrong instead of only which kind.
--
-- Existing rows keep their seconds; nothing is backfilled, because a tournament under way would see
-- its times change for no reason. Previous bodies: `20261023000000_prerequisite_order.sql` (reflow)
-- and `20261018000000_conflict_overrun_alignment.sql` (conflicts). See
-- docs/scheduling-decisions.md section 33.

CREATE OR REPLACE FUNCTION public.schedule_shift_threshold()
RETURNS interval
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT interval '2 minutes' $$;

COMMENT ON FUNCTION public.schedule_shift_threshold() IS
  'The smallest move of a published time worth writing, and the tolerance schedule_conflicts gives a published time against a real one. Mirrored by SCHEDULE_SHIFT_THRESHOLD_MS in src/lib/tournament/published-time.ts.';

-- STABLE rather than IMMUTABLE because `date_trunc` on a timestamptz is: a minute boundary does not
-- depend on the session's time zone for any zone with a whole-minute offset, which is every zone a
-- venue can be in today.
CREATE OR REPLACE FUNCTION public.ceil_to_minute(p_time timestamptz)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_time IS NULL THEN NULL
    WHEN p_time = date_trunc('minute', p_time) THEN p_time
    ELSE date_trunc('minute', p_time) + interval '1 minute'
  END
$$;

REVOKE ALL ON FUNCTION public.schedule_shift_threshold() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.schedule_shift_threshold() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ceil_to_minute(timestamptz) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.ceil_to_minute(timestamptz) TO authenticated, service_role;

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
  v_day_end timestamptz;
  v_break_end timestamptz;
  v_prereq_end timestamptz;
  v_held_list text;
  v_held_count int;
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

  -- The source's own day. Everything the reflow cascades must stay inside it.
  v_day_id := public.tournament_day_at(source_tournament, source_time);
  SELECT d.date, ((d.date + d.end_time) AT TIME ZONE v_tz)
  INTO v_day_date, v_day_end
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
    -- A held match keeps its published time: it could not be made to fit before the
    -- day's close, so it is never marked dirty and never written. See the header.
    held boolean NOT NULL DEFAULT false,
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

    -- A held match is skipped however it reached the queue: its own court's tail, a
    -- shared player on another court, or a dependent of a moved prerequisite. It
    -- keeps its published time and pushes nothing, so a dependent or a co-player the
    -- queue brought in here is left for an independent, non-held reason to move.
    IF current_match.held THEN
      CONTINUE;
    END IF;

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
    -- and all: rounding an untouched row would read as a move and, near the close, hold it.
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

    -- Closing time, exercised on every day including the tournament's last. A match
    -- the reflow would move past the close is *held*: it keeps its published time,
    -- and so does every still-movable match after it on the same court and day,
    -- because that court's order can no longer be preserved. Held rows are never
    -- marked dirty, so the write below leaves them alone, and they push nothing - the
    -- loop continues with the rest of the day. The conflict this creates (a held
    -- match left overlapping its shifted predecessor) is intentional and is what
    -- `schedule_conflicts` reports.
    --
    -- `next_start IS DISTINCT FROM current_match.shifted_time` is what makes this the
    -- reflow's spill and not one it merely found. When the two are equal the match
    -- was not moved - its published time already crosses the close - so there is
    -- nothing to hold: it is left exactly as it was, not dirty, and its own court's
    -- tail still reflows behind whatever the other floors decided. Holding it would
    -- freeze a court over a time this run did not set. That a published time crosses
    -- the close is reported by `schedule_conflicts` as `past_closing`, which reads the
    -- rows rather than this cascade.
    IF v_day_end IS NOT NULL
      AND next_start IS DISTINCT FROM current_match.shifted_time
      AND next_start + current_match.duration > v_day_end THEN
      UPDATE live_schedule_work
      SET held = true
      WHERE NOT held
        AND movable
        AND day_id = current_match.day_id
        AND court_id = current_match.court_id
        AND (original_time, match_table, match_id::text)
          >= (current_match.original_time, current_match.match_table, current_match.match_id::text);

      -- The tail just held is removed from the queue. It also cannot be re-added by a
      -- held match, because a held match never reaches the propagation block below.
      DELETE FROM live_schedule_queue q
      USING live_schedule_work w
      WHERE w.held
        AND w.match_table = q.match_table
        AND w.match_id = q.match_id;

      CONTINUE;
    END IF;

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
      AND NOT w.held
      AND NOT w.dirty
      AND w.shifted_time IS DISTINCT FROM w.original_time
      AND EXISTS (
        SELECT 1
        FROM live_schedule_work o
        WHERE o.dirty
          AND NOT o.held
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

  -- Held matches are reported, not written. Held rows were never marked dirty, so the
  -- writes below already skip them; this notice names them and the one reason. The
  -- caller's saved result is already committed, so a notice is the right channel - an
  -- exception here would roll the result back.
  SELECT count(*),
         string_agg(
           format('%s/%s', w.match_table, w.match_id::text),
           ', ' ORDER BY w.original_time, w.match_table, w.match_id
         )
  INTO v_held_count, v_held_list
  FROM live_schedule_work w
  WHERE w.held;

  IF v_held_count > 0 THEN
    RAISE NOTICE 'Live reflow held % match(es) that would run past closing time: %',
      v_held_count, v_held_list;
  END IF;

  UPDATE public.pool_matches pm
    SET scheduled_time = work.shifted_time
  FROM live_schedule_work work
  WHERE work.match_table = 'pool_matches'
    AND work.match_id = pm.id
    AND work.dirty
    AND NOT work.held
    AND pm.status = 'scheduled';

  UPDATE public.draw_matches dm
  SET scheduled_time = work.shifted_time
  FROM live_schedule_work work
  WHERE work.match_table = 'draw_matches'
    AND work.match_id = dm.id
    AND work.dirty
    AND NOT work.held
    AND dm.status = 'scheduled';

  UPDATE public.placement_matches pmet
  SET scheduled_time = work.shifted_time
  FROM live_schedule_work work
  WHERE work.match_table = 'placement_matches'
    AND work.match_id = pmet.id
    AND work.dirty
    AND NOT work.held
    AND pmet.status = 'scheduled';

  UPDATE public.tier_draw_matches tdm
  SET scheduled_time = work.shifted_time
  FROM live_schedule_work work
  WHERE work.match_table = 'tier_draw_matches'
    AND work.match_id = tdm.id
    AND work.dirty
    AND NOT work.held
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

-- The return type gains four columns, which CREATE OR REPLACE cannot do, so the function is dropped
-- and created again; its grants are re-asserted below. Nothing in the database calls it.
DROP FUNCTION IF EXISTS public.schedule_conflicts(uuid);

CREATE FUNCTION public.schedule_conflicts(p_tournament_id uuid)
RETURNS TABLE (
  match_table text,
  match_id uuid,
  court_id uuid,
  scheduled_time timestamptz,
  ended_at timestamptz,
  conflict_kind text,
  detail text,
  -- The match on the other side of the conflict: the one sharing the court, the one the player
  -- comes off, or the one this match waits on. NULL for `break` and `past_closing`.
  related_match_table text,
  related_match_id uuid,
  -- The player who is short of rest (`rest_shortfall` only).
  player_id uuid,
  -- How bad it is, in whole minutes rounded up: the overlap, the missing rest, the time past the
  -- close, or how early it starts before the match it waits on.
  minutes integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tolerance interval := public.schedule_shift_threshold();
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = p_tournament_id) THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  RETURN QUERY
  WITH settings AS (
    SELECT t.venue_timezone AS tz
    FROM public.tournaments t
    WHERE t.id = p_tournament_id
  ),
  m AS (
    SELECT
      'pool_matches'::text AS mt,
      pm.id AS mid,
      pm.court_id AS cid,
      pm.scheduled_time AS sched,
      pm.started_at AS started,
      pm.ended_at AS ended,
      pm.status AS st,
      (pm.scheduled_time + make_interval(mins => t.group_slot_minutes)) AS planned_end,
      make_interval(mins => t.group_rest_gap_minutes) AS rest_gap,
      ARRAY[]::uuid[] AS prereqs
    FROM public.pool_matches pm
    JOIN public.tournaments t ON t.id = pm.tournament_id
    WHERE pm.tournament_id = p_tournament_id
      AND pm.status <> 'void'
      AND pm.court_id IS NOT NULL
      AND pm.scheduled_time IS NOT NULL
    UNION ALL
    SELECT
      'draw_matches',
      dm.id,
      dm.court_id,
      dm.scheduled_time,
      dm.started_at,
      dm.ended_at,
      dm.status,
      (dm.scheduled_time + make_interval(mins => t.knockout_slot_minutes)),
      make_interval(mins => t.knockout_rest_gap_minutes),
      ARRAY_REMOVE(ARRAY[dm.parent_a_id, dm.parent_b_id], NULL)
    FROM public.draw_matches dm
    JOIN public.tournaments t ON t.id = dm.tournament_id
    WHERE dm.tournament_id = p_tournament_id
      AND dm.status <> 'void'
      AND COALESCE(dm.is_bye, false) = false
      AND dm.court_id IS NOT NULL
      AND dm.scheduled_time IS NOT NULL
    UNION ALL
    SELECT
      'placement_matches',
      pmet.id,
      pmet.court_id,
      pmet.scheduled_time,
      pmet.started_at,
      pmet.ended_at,
      pmet.status,
      (pmet.scheduled_time + make_interval(mins => t.group_slot_minutes)),
      make_interval(mins => t.group_rest_gap_minutes),
      pmet.prerequisite_ids
    FROM public.placement_matches pmet
    JOIN public.tournaments t ON t.id = pmet.tournament_id
    WHERE pmet.tournament_id = p_tournament_id
      AND pmet.status <> 'void'
      AND pmet.court_id IS NOT NULL
      AND pmet.scheduled_time IS NOT NULL
    UNION ALL
    SELECT
      'tier_draw_matches',
      tdm.id,
      tdm.court_id,
      tdm.scheduled_time,
      tdm.started_at,
      tdm.ended_at,
      tdm.status,
      (tdm.scheduled_time + make_interval(mins => t.knockout_slot_minutes)),
      make_interval(mins => t.knockout_rest_gap_minutes),
      ARRAY_REMOVE(ARRAY[tdm.parent_a_id, tdm.parent_b_id], NULL)
    FROM public.tier_draw_matches tdm
    JOIN public.tournaments t ON t.id = tdm.tournament_id
    WHERE tdm.tournament_id = p_tournament_id
      AND tdm.status <> 'void'
      AND NOT tdm.is_bye
      AND tdm.court_id IS NOT NULL
      AND tdm.scheduled_time IS NOT NULL
  ),
  eff AS (
    SELECT
      m.*,
      COALESCE(m.started, m.sched) AS eff_start,
      -- The span the plan gives the match. A finished match took what it took. A match on court
      -- holds its real start plus one slot - deliberately not "until now": a match running long is
      -- the Desk's Overrun, and the reflow re-times everything behind it when the result lands, so
      -- reporting its successors as conflicts while it runs only reported the delay, minute by
      -- minute. A match not yet started holds its published time plus one slot.
      CASE
        WHEN m.ended IS NOT NULL THEN m.ended
        WHEN m.st = 'in-progress' THEN COALESCE(m.started, m.sched) + (m.planned_end - m.sched)
        ELSE m.planned_end
      END AS eff_end,
      public.tournament_day_at(p_tournament_id, m.sched) AS day_id,
      -- The one predicate every actionable conflict shares: only a match the desk can still move
      -- is worth reporting. Named so the intent is checkable.
      (m.st = 'scheduled') AS is_scheduled
    FROM m
  ),
  players AS (
    SELECT 'pool_matches'::text AS mt, pm.id AS mid, player.player_id AS pid
    FROM public.pool_matches pm
    JOIN public.teams team ON team.id IN (pm.team_a_id, pm.team_b_id)
    CROSS JOIN LATERAL (VALUES (team.player_1_id), (team.player_2_id)) player(player_id)
    WHERE pm.tournament_id = p_tournament_id AND player.player_id IS NOT NULL
    UNION ALL
    SELECT 'draw_matches', dm.id, player.player_id
    FROM public.draw_matches dm
    JOIN public.teams team ON team.id IN (dm.team_a_id, dm.team_b_id)
    CROSS JOIN LATERAL (VALUES (team.player_1_id), (team.player_2_id)) player(player_id)
    WHERE dm.tournament_id = p_tournament_id AND player.player_id IS NOT NULL
    UNION ALL
    SELECT 'placement_matches', pmet.id, player.player_id
    FROM public.placement_matches pmet
    JOIN public.placement_entrants entrant ON entrant.id IN (pmet.entrant_a_id, pmet.entrant_b_id)
    JOIN public.teams team ON team.id = entrant.team_id
    CROSS JOIN LATERAL (VALUES (team.player_1_id), (team.player_2_id)) player(player_id)
    WHERE pmet.tournament_id = p_tournament_id AND player.player_id IS NOT NULL
    UNION ALL
    SELECT 'tier_draw_matches', tdm.id, player.player_id
    FROM public.tier_draw_matches tdm
    JOIN public.placement_entrants entrant ON entrant.id IN (tdm.entrant_a_id, tdm.entrant_b_id)
    JOIN public.teams team ON team.id = entrant.team_id
    CROSS JOIN LATERAL (VALUES (team.player_1_id), (team.player_2_id)) player(player_id)
    WHERE tdm.tournament_id = p_tournament_id AND player.player_id IS NOT NULL
  ),
  rest_seq AS (
    SELECT
      p.pid,
      e.mt,
      e.mid,
      e.cid,
      e.sched,
      e.ended,
      e.eff_start,
      e.rest_gap,
      e.is_scheduled,
      lag(e.eff_end) OVER w AS prev_end,
      lag(e.mt) OVER w AS prev_mt,
      lag(e.mid) OVER w AS prev_mid,
      lag(e.is_scheduled) OVER w AS prev_scheduled
    FROM players p
    JOIN eff e ON e.mt = p.mt AND e.mid = p.mid
    WINDOW w AS (PARTITION BY p.pid ORDER BY e.eff_start, e.mid)
  ),
  -- Each overlapping court pair once, both sides carried, so a conflict can be reported against
  -- whichever side (or sides) is still scheduled. The ordering tuple means no pair is produced
  -- twice.
  overlap_pairs AS (
    SELECT
      a.mt AS a_mt, a.mid AS a_mid, a.cid AS a_cid, a.sched AS a_sched, a.ended AS a_ended,
      a.is_scheduled AS a_scheduled,
      b.mt AS b_mt, b.mid AS b_mid, b.cid AS b_cid, b.sched AS b_sched, b.ended AS b_ended,
      b.is_scheduled AS b_scheduled,
      LEAST(a.eff_end, b.eff_end) - GREATEST(a.eff_start, b.eff_start) AS overlap
    FROM eff a
    JOIN eff b
      ON a.cid = b.cid
     AND (a.mt, a.mid::text) < (b.mt, b.mid::text)
     AND a.eff_start < b.eff_end
     AND b.eff_start < a.eff_end
  ),
  conflicts AS (
    -- Two published times are compared strictly: an overlap between them is the plan's own
    -- mistake, however small. Against a real start or finish, an overlap under the threshold is
    -- the reflow declining to announce a move that small (`shift_live_schedule_core`).
    SELECT
      p.a_mt AS mt, p.a_mid AS mid, p.a_cid AS cid, p.a_sched AS sched, p.a_ended AS ended,
      'court_overlap'::text AS kind,
      format('Overlaps another match on the same court (%s)', left(p.b_mid::text, 8)) AS detail,
      p.b_mt AS rel_mt, p.b_mid AS rel_mid, NULL::uuid AS pid, p.overlap AS amount
    FROM overlap_pairs p
    WHERE p.a_scheduled
      AND (p.b_scheduled OR p.overlap >= v_tolerance)

    UNION ALL

    SELECT
      p.b_mt, p.b_mid, p.b_cid, p.b_sched, p.b_ended,
      'court_overlap'::text,
      format('Overlaps another match on the same court (%s)', left(p.a_mid::text, 8)),
      p.a_mt, p.a_mid, NULL::uuid, p.overlap
    FROM overlap_pairs p
    WHERE p.b_scheduled
      AND (p.a_scheduled OR p.overlap >= v_tolerance)

    UNION ALL

    SELECT
      r.mt, r.mid, r.cid, r.sched, r.ended,
      'rest_shortfall'::text,
      format('Only %s of the required rest', to_char(r.eff_start - r.prev_end, 'FMHH24:MI')),
      r.prev_mt, r.prev_mid, r.pid, (r.prev_end + r.rest_gap) - r.eff_start
    FROM rest_seq r
    WHERE r.is_scheduled
      AND r.prev_end IS NOT NULL
      AND r.eff_start < r.prev_end + r.rest_gap
      AND (r.prev_scheduled OR (r.prev_end + r.rest_gap) - r.eff_start >= v_tolerance)

    UNION ALL

    SELECT
      e.mt, e.mid, e.cid, e.sched, e.ended,
      'break'::text,
      format('Overlaps the %s break on %s', COALESCE(br.label, 'scheduled'), d.date),
      NULL::text, NULL::uuid, NULL::uuid,
      LEAST(e.planned_end, (d.date + br.end_time) AT TIME ZONE s.tz)
        - GREATEST(e.sched, (d.date + br.start_time) AT TIME ZONE s.tz)
    FROM eff e
    JOIN settings s ON true
    JOIN public.tournament_days d ON d.id = e.day_id
    JOIN public.tournament_day_breaks br ON br.day_id = d.id
    WHERE e.is_scheduled
      AND e.sched < ((d.date + br.end_time) AT TIME ZONE s.tz)
      AND e.planned_end > ((d.date + br.start_time) AT TIME ZONE s.tz)

    UNION ALL

    -- A match already on court cannot be moved, so it is not reported however late it runs.
    SELECT
      e.mt, e.mid, e.cid, e.sched, e.ended,
      'past_closing'::text,
      format('Finishes after the %s close on %s', to_char(d.end_time, 'HH24:MI'), d.date),
      NULL::text, NULL::uuid, NULL::uuid,
      e.eff_end - ((d.date + d.end_time) AT TIME ZONE s.tz)
    FROM eff e
    JOIN settings s ON true
    JOIN public.tournament_days d ON d.id = e.day_id
    WHERE e.is_scheduled
      AND e.eff_end > ((d.date + d.end_time) AT TIME ZONE s.tz)

    UNION ALL

    SELECT
      e.mt, e.mid, e.cid, e.sched, e.ended,
      'before_prerequisite'::text,
      format('Starts before the match it waits on (%s) has finished', left(pre.mid::text, 8)),
      pre.mt, pre.mid, NULL::uuid, pre.eff_end - e.eff_start
    FROM eff e
    JOIN eff pre ON pre.mid = ANY(e.prereqs)
    WHERE e.is_scheduled
      AND e.eff_start < pre.eff_end
      AND (pre.is_scheduled OR pre.eff_end - e.eff_start >= v_tolerance)
  )
  -- One row per (match, kind), as before; where a kind has several partners the worst is named.
  SELECT DISTINCT ON (c.mt, c.mid, c.kind)
    c.mt AS match_table,
    c.mid AS match_id,
    c.cid AS court_id,
    c.sched AS scheduled_time,
    c.ended AS ended_at,
    c.kind AS conflict_kind,
    c.detail,
    c.rel_mt AS related_match_table,
    c.rel_mid AS related_match_id,
    c.pid AS player_id,
    GREATEST(1, ceil(extract(epoch FROM c.amount) / 60))::integer AS minutes
  FROM conflicts c
  ORDER BY c.mt, c.mid, c.kind, c.amount DESC, c.rel_mid NULLS LAST, c.pid NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_conflicts(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.schedule_conflicts(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.shift_live_schedule_core(text, uuid) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.shift_live_schedule_core(text, uuid) TO service_role;

DO $verify$
BEGIN
  IF public.schedule_shift_threshold() <> interval '2 minutes' THEN
    RAISE EXCEPTION 'schedule_shift_threshold must be 2 minutes (mirrored in published-time.ts)';
  END IF;
  IF public.ceil_to_minute('2026-10-24 14:03:14+00'::timestamptz) <> '2026-10-24 14:04:00+00'::timestamptz
     OR public.ceil_to_minute('2026-10-24 14:03:00+00'::timestamptz) <> '2026-10-24 14:03:00+00'::timestamptz THEN
    RAISE EXCEPTION 'ceil_to_minute must round up to the minute and leave a whole minute alone';
  END IF;

  IF has_function_privilege('authenticated', 'public.shift_live_schedule_core(text, uuid)', 'execute')
     OR has_function_privilege('anon', 'public.shift_live_schedule_core(text, uuid)', 'execute') THEN
    RAISE EXCEPTION 'shift_live_schedule_core is internal and must not be a client RPC';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'shift_live_schedule_core'
      AND p.prosrc LIKE '%source_status = ''in-progress''%'
      AND p.prosrc LIKE '%COALESCE(prereq.actual_start, prereq.shifted_time)%'
      AND p.prosrc LIKE '%prereq.court_id = current_match.court_id%'
      AND p.prosrc LIKE '%public.ceil_to_minute(next_start)%'
      AND p.prosrc LIKE '%>= v_threshold%'
  ) THEN
    RAISE EXCEPTION 'the reflow core lost its in-progress handling, its prerequisite rule, or its whole-minute rounding';
  END IF;

  IF has_function_privilege('anon', 'public.schedule_conflicts(uuid)', 'execute') THEN
    RAISE EXCEPTION 'schedule_conflicts must not be callable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.schedule_conflicts(uuid)', 'execute') THEN
    RAISE EXCEPTION 'schedule_conflicts must be callable by authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'schedule_conflicts'
      AND p.prosrc LIKE '%can_edit_tournament%'
      AND p.prosrc LIKE '%court_overlap%'
      AND p.prosrc LIKE '%rest_shortfall%'
      AND p.prosrc LIKE '%past_closing%'
      AND p.prosrc LIKE '%before_prerequisite%'
      AND p.prosrc LIKE '%v_tolerance%'
  ) THEN
    RAISE EXCEPTION 'schedule_conflicts lost its guard, a conflict kind, or its tolerance';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
