-- A match must never be placed after one that waits on it, and the live reflow must never chase a
-- prerequisite that sits behind it on its own court.
--
-- Viet Nam Open 2026, Men's Doubles (desk_activity): the held entrant's second make-up match, which
-- waits for the first (`prerequisite_ids`), was placed at 11:35 on court 1; twenty minutes later the
-- first was placed at 11:50 on the same court, behind it. `place_ready_matches` checked the court and
-- the players and nothing else, and the planner treats a published time as an anchor it cannot go
-- earlier than. Every result reported afterwards ran the reflow, which keeps each court's order (a
-- match may not start before the one ahead of it ends) *and* each prerequisite's order (a match may not
-- start before its prerequisites end). For this pair the two cannot both hold, so each run pushed the
-- second behind the first and then the first behind the second: one slot plus the entrant's rest, 25
-- minutes at a 10-minute slot and 5 minutes' rest, per result - seven results, 11:50 -> 14:45 - until a
-- rebuild re-ordered them. Matches that share a player with the pair were pushed in lockstep.
--
-- Two changes, both new bodies of existing functions (nothing applied is edited):
--
--   1. `place_ready_matches` refuses, per slot and with a reason instead of failing the batch,
--        * `prerequisite_unplaced` - a prerequisite holds no time yet (and has not been reported),
--        * `before_prerequisite`   - a prerequisite would not be over by the start,
--        * `after_dependent`       - a match that waits for this one already starts before it ends.
--      Slots are taken earliest first, so a prerequisite and its dependent sent together are checked
--      in the order they would be played. Placement matches only: knockouts are ordered by bracket.
--   2. `shift_live_schedule_core` stops treating a prerequisite queued *behind* a match on that
--      match's own court as a floor. Everything else about the reflow, including a dependent that was
--      published ahead of a prerequisite on *another* court, is unchanged.
--
-- The client mirrors (1): `planPlacementSchedule({ mode: "place-ready" })` leaves such a match
-- unplaced as `out_of_order`, and a rebuild no longer pins a match that still waits on an unplayed
-- one. The first function body is `20261017000000_place_ready_matches.sql`, the second is
-- `20261010000000_start_match_checks_and_reflow.sql`; see docs/scheduling-decisions.md section 31.

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
  v_order_reason text;
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

  -- Earliest first, whatever order the client sent: a prerequisite placed earlier in this very call
  -- has to be on the books when its dependent is checked below.
  FOR v_slot IN
    SELECT e.value
    FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb)) AS e
    ORDER BY (e.value->>'scheduled_time')::timestamptz NULLS LAST, e.value->>'match_id'
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

      -- Order, in both directions. Court and player checks cannot see that two matches of one
      -- entrant are a sequence ("my second make-up waits for my first"), and the planner's anchors
      -- cannot give a movable prerequisite a deadline. Viet Nam Open 2026: the second make-up was
      -- published at 11:35 and the first placed at 11:50 on the same court; the live reflow, which
      -- keeps a court's order *and* a prerequisite's order, then pushed the pair 25 minutes later on
      -- every result for seven results. Knockout matches are ordered by their bracket, not by
      -- `prerequisite_ids`, so only placement matches are checked.
      IF v_reason IS NULL AND v_table = 'placement_matches' THEN
        -- Forward: everything this match waits for must be placed and over before it starts.
        -- A reported or walkover prerequisite is over whether or not it ever held a slot.
        SELECT CASE
                 WHEN bool_or(pre.status NOT IN ('reported', 'walkover') AND occupied.ends_at IS NULL)
                   THEN 'prerequisite_unplaced'
                 WHEN bool_or(occupied.ends_at > v_start) THEN 'before_prerequisite'
               END
        INTO v_order_reason
        FROM public.placement_matches me
        JOIN public.placement_matches pre
          ON pre.id = ANY(me.prerequisite_ids) AND pre.status <> 'void'
        LEFT JOIN public.placement_occupied_matches(p_tournament_id) occupied
          ON occupied.match_table = 'placement_matches' AND occupied.match_id = pre.id
        WHERE me.id = v_match;

        -- Reverse: nothing that already holds a time may be waiting for this match to end after
        -- it has started.
        IF v_order_reason IS NULL AND EXISTS (
          SELECT 1
          FROM public.placement_matches dep
          JOIN public.placement_occupied_matches(p_tournament_id) occupied
            ON occupied.match_table = 'placement_matches' AND occupied.match_id = dep.id
          WHERE dep.tournament_id = p_tournament_id
            AND dep.status <> 'void'
            AND v_match = ANY(dep.prerequisite_ids)
            AND occupied.starts_at IS NOT NULL
            AND occupied.starts_at < v_end
        ) THEN
          v_order_reason := 'after_dependent';
        END IF;

        v_reason := v_order_reason;
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

REVOKE ALL ON FUNCTION public.place_ready_matches(uuid, text, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_ready_matches(uuid, text, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.shift_live_schedule_core(text, uuid) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.shift_live_schedule_core(text, uuid) TO service_role;

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
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'place_ready_matches'
      AND p.prosrc LIKE '%''prerequisite_unplaced''%'
      AND p.prosrc LIKE '%''before_prerequisite''%'
      AND p.prosrc LIKE '%''after_dependent''%'
      AND p.prosrc LIKE '%ORDER BY (e.value->>''scheduled_time'')::timestamptz%'
  ) THEN
    RAISE EXCEPTION 'place_ready_matches does not check prerequisite order in both directions';
  END IF;

  IF has_function_privilege('authenticated', 'public.shift_live_schedule_core(text, uuid)', 'execute')
     OR has_function_privilege('anon', 'public.shift_live_schedule_core(text, uuid)', 'execute') THEN
    RAISE EXCEPTION 'shift_live_schedule_core is internal and must not be a client RPC';
  END IF;
  -- The in-progress handling from 20261010 must survive the new body.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'shift_live_schedule_core'
      AND p.prosrc LIKE '%source_status = ''in-progress''%'
      AND p.prosrc LIKE '%COALESCE(prereq.actual_start, prereq.shifted_time)%'
      AND p.prosrc LIKE '%prereq.court_id = current_match.court_id%'
  ) THEN
    RAISE EXCEPTION 'the reflow core lost its in-progress handling or the inverted-prerequisite rule';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
