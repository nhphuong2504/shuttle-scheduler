-- ---------------------------------------------------------------------------
-- The live reflow only ever pushes matches later, stays inside their own day, and
-- holds any match it cannot place safely instead of writing a time that breaks the day.
--
-- Reporting a result calls `shift_live_schedule_after_match`, which since
-- `20261008040000` is a wrapper around `shift_live_schedule_core`. The core was a
-- working 350-line algorithm, but it had five defects that a late result exposed:
--
-- 1. IT PULLED MATCHES EARLIER. `next_start := COALESCE(previous_end, shifted_time)`
--    with no floor at the match's own published time. Whenever the previous match
--    finished early, or simply had slack behind it, every match behind it on the
--    court was dragged forward - erasing the deliberate gaps between rounds and,
--    on a rebuilt day, moving unplayed matches to a time that had already passed.
--    The reflow exists to absorb a *late* finish, so it must never move a match
--    earlier than it was published.
--
-- 2. IT DID NOT KNOW ABOUT DAYS. The queue was "every still-scheduled match after
--    the source on this court", with no day filter, so the first match of day two
--    on a court was dragged back toward the end of day one. A match belongs to the
--    last day whose window had opened when it did - the same rule `sliceRowsByDay`
--    uses in the client - so the queue is now scoped to the source's own day.
--
-- 3. IT DID NOT READ `prerequisite_ids`. A placement match that waits for other
--    matches (a make-up fixture for an entrant who was carried) could be shifted to
--    a start before the matches it is explicitly ordered behind, and a dependent
--    sitting on another court was not shifted at all - the queue was seeded only with
--    the source's own court. It is now seeded with the source's dependents too.
--
-- 4. THE BREAK PASS WAS A SEPARATE, LATER STEP. `20261008040000` pushed a match out
--    of a break *after* the core had finished, without re-checking player rest, and
--    without enforcing the day's closing time at all. Breaks and the closing time
--    are now part of the shifting loop itself.
--
-- 5. THE SOURCE NEVER REACHED A CO-PLAYER ON ANOTHER COURT. The initial queue was the
--    source's own court, plus the matches that *wait on* it. A match that merely
--    shares a player with the source - that player's next game, published on another
--    court - entered the queue only after some *other* match had moved, so the
--    source's own overrun could leave a reported result and a scheduled match, same
--    player, overlapping in time. The queue is now also seeded with the source's
--    co-players on the same day, on any court.
--
-- The remedy is a rewrite of the core, because the five defects are all in the same
-- arithmetic. The rewrite is deliberately conservative about writing:
--
--   * every match is given a start with
--       GREATEST(its own published time, the previous match's real end,
--                the player's rest window, its prerequisites' end)
--     so a match can only ever move later, never earlier;
--   * a break is a wall the loop moves a match wholly past, and the day's closing
--     time is enforced inside the same loop;
--   * atomicity is *per chain*, not per run. A match that the reflow would move
--     past the day's close is **held**: it keeps its published time, and so does
--     every still-movable match after it on the same court and day, because that
--     court's order cannot be preserved any further. A match that is *not* being
--     moved is never held, even when its published time already crosses the close -
--     the reflow did not create that spill, and freezing a court over a time it did
--     not set is not its job. A held match pushes nothing -
--     no shared player, no dependent on another court - so the rest of the day, and
--     every unrelated chain, still reflows and is written in the same transaction.
--     The held rows and their predecessors end up overlapping on purpose, and
--     `schedule_conflicts` reports that rather than it being papered over. A held
--     run is surfaced with `RAISE NOTICE` (ids and reason only) and never with
--     `RAISE EXCEPTION`, so the caller's saved result is never rolled back;
--   * the name and signature of both `shift_live_schedule_core` and the
--     `shift_live_schedule_after_match` wrapper are unchanged, so every caller
--     (`report_placement_result`, `report_tier_draw_result`, the walkover paths)
--     keeps working.
--
-- Closing time is enforced on *every* day, including the tournament's last. The
-- planner treats its cutoff as a soft objective term, so a complete schedule that
-- runs long can still win; a reflow may not *create* that spill, so a cascade that
-- would do so stops at the held match and warns instead. "Create" is literal: the
-- close is only consulted for a match the reflow is moving, so a match that was
-- already published past the close is left as it stands and reported by
-- `schedule_conflicts` as `past_closing` instead. The two rules disagree on
-- purpose; see `docs/scheduling-decisions.md` for the planner's side.
--
-- `clear_breaks_after_reflow` is superseded by the loop and dropped: keeping it
-- defined but unused would leave the very pass this migration is replacing sitting
-- in the schema for the next reader to call by mistake.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tournament_day_at(
  p_tournament_id uuid,
  p_at timestamptz
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- The day a wall-clock instant belongs to: the last day whose window had already
  -- opened when it did, or the first day when it precedes every window. This is the
  -- database twin of `sliceRowsByDay` in the client, and the two must agree.
  SELECT COALESCE(
    (
      SELECT d.id
      FROM public.tournament_days d
      JOIN public.tournaments t ON t.id = d.tournament_id
      WHERE d.tournament_id = p_tournament_id
        AND ((d.date + d.start_time) AT TIME ZONE t.venue_timezone) <= p_at
      ORDER BY ((d.date + d.start_time) AT TIME ZONE t.venue_timezone) DESC
      LIMIT 1
    ),
    (
      SELECT d.id
      FROM public.tournament_days d
      WHERE d.tournament_id = p_tournament_id
      ORDER BY d.date, d.day_number
      LIMIT 1
    )
  );
$$;

REVOKE ALL ON FUNCTION public.tournament_day_at(uuid, timestamptz)
  FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.tournament_day_at(uuid, timestamptz) TO service_role;

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

  -- Every still-movable match after the completion on this court AND on the same
  -- day. The day filter is the fix for defect 2: without it, day two's first match
  -- was dragged back to the end of day one.
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
    -- last match cannot be mistaken for this day's predecessor.
    SELECT CASE
      WHEN previous.actual_end IS NOT NULL THEN previous.actual_end
      WHEN previous.status = 'in-progress'
        THEN GREATEST(previous.shifted_time + previous.duration, statement_timestamp())
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

    -- Dependency ordering: the match may not start before every prerequisite
    -- (a placement match's `prerequisite_ids`, a knockout's parents) has finished.
    SELECT max(
      CASE
        WHEN prereq.actual_end IS NOT NULL THEN prereq.actual_end
        WHEN prereq.status = 'in-progress'
          THEN GREATEST(prereq.shifted_time + prereq.duration, statement_timestamp())
        ELSE prereq.shifted_time + prereq.duration
      END
    )
    INTO v_prereq_end
    FROM live_schedule_work prereq
    WHERE prereq.match_id = ANY(current_match.prereq_ids);

    next_start := GREATEST(next_start, v_prereq_end);

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

REVOKE ALL ON FUNCTION public.shift_live_schedule_core(text, uuid)
  FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.shift_live_schedule_core(text, uuid) TO service_role;

-- The wrapper keeps its name and signature, but the break pass is gone: breaks are
-- now part of the loop above, which also re-checks player rest and the closing time.
CREATE OR REPLACE FUNCTION public.shift_live_schedule_after_match(
  p_table text,
  p_match_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.shift_live_schedule_core(p_table, p_match_id);
END;
$$;

-- Internal: called only from the SECURITY DEFINER report/walkover functions.
REVOKE ALL ON FUNCTION public.shift_live_schedule_after_match(text, uuid)
  FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.shift_live_schedule_after_match(text, uuid) TO service_role;

-- Superseded by the loop. Dropped rather than left defined-but-unused, because a
-- reader who finds it will assume it is still on the path.
DROP FUNCTION IF EXISTS public.clear_breaks_after_reflow(uuid);

DO $verify$
BEGIN
  IF to_regprocedure('public.clear_breaks_after_reflow(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'M3: clear_breaks_after_reflow still exists';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'shift_live_schedule_core'
      AND p.prosrc LIKE '%GREATEST(current_match.shifted_time, previous_end)%'
  ) THEN
    RAISE EXCEPTION 'M3: the reflow core does not floor a match at its own published time';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'shift_live_schedule_core'
      AND p.prosrc LIKE '%held = true%'
      AND p.prosrc LIKE '%would run past closing time%'
  ) THEN
    RAISE EXCEPTION 'M3: the reflow core does not hold a match that would run past closing time';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'shift_live_schedule_core'
      AND p.prosrc LIKE '%AND next_start IS DISTINCT FROM current_match.shifted_time%'
  ) THEN
    RAISE EXCEPTION 'M3: the reflow holds a match it did not move';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'shift_live_schedule_core'
      AND p.prosrc LIKE '%work.day_id = v_day_id%'
  ) THEN
    RAISE EXCEPTION 'M3: the reflow queue is not scoped to the source day';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'shift_live_schedule_core'
      AND p.prosrc LIKE '%prereq.match_id = ANY(current_match.prereq_ids)%'
  ) THEN
    RAISE EXCEPTION 'M3: the reflow core does not respect prerequisites';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'shift_live_schedule_core'
      AND p.prosrc LIKE '%p_match_id = ANY(work.prereq_ids)%'
  ) THEN
    RAISE EXCEPTION 'M3: the reflow does not seed a dependent match on another court';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'shift_live_schedule_core'
      AND p.prosrc LIKE '%mine.match_id = p_match_id%'
  ) THEN
    RAISE EXCEPTION 'M3: the reflow does not seed a co-player match on another court';
  END IF;

  IF has_function_privilege('authenticated', 'public.shift_live_schedule_after_match(text, uuid)', 'execute') THEN
    RAISE EXCEPTION 'M3: the reflow wrapper must not be a client RPC';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
