-- ---------------------------------------------------------------------------
-- Starting a match is where the desk can get it wrong, and until now the database
-- only guarded the lifecycle. Three things change, all of them on the start path:
--
-- 1. TWO HARD PHYSICAL CHECKS. A match cannot be started if one of its players is
--    already on court in another match of the same tournament, or if the target
--    court already has a match in progress. These are facts about the room, not
--    about the published times, so they are read from the rows the desk is actually
--    running - all four match tables, exactly as `shift_live_schedule_core` resolves
--    players. The desk already knows both, but only the client-side
--    `checkStartConstraints` was enforcing them, and two desks can race through a
--    stale browser. `assert_can_start_match` is the one server-side implementation,
--    shared by `start_placement_match`, `start_tier_draw_match` and `start_match_safe`.
--
-- 2. SHORT REST, OPT-IN AS A BLOCK. Short rest stays a warning by default - the
--    desk sees it and decides - but a tournament may ask for it to be a hard block
--    with `tournaments.block_start_on_short_rest` (default false). When it is on,
--    `assert_can_start_match` refuses a start that would put a player back on court
--    inside their stage's rest gap. The check uses the stage's own gap (group for a
--    pool or a placement round, knockout for a bracket) and the player's most
--    recently finished match. There is deliberately no UI for the setting yet.
--
-- 3. A LATE OR RELOCATED START REFLOWS THE DAY. `shift_live_schedule_core` used to
--    accept only a finished source (`reported`, `walkover`), so a match that started
--    late - or was started on a different court than it was published on - changed
--    nothing for the rest of the day. It now accepts an `in-progress` source too, and
--    both start RPCs run it after the match is on court. The reflow still only ever
--    pushes matches later and still never raises (a held chain is a NOTICE).
--
-- ## The two checks, and why they are one function
--
-- The player and court scans are the same question against four tables, and resolving
-- a placement or bracket match's players needs the entrant -> team -> player hop,
-- which is easy to get subtly different in three copies. `assert_can_start_match` is
-- that one copy. It is called *after* the row has been marked `in-progress`, because
-- it reads the candidate's own court and players back from the row - and it excludes
-- the candidate by `(match_table, match_id)` from both scans, so it cannot see itself.
--
-- ## The in-progress source: where it stands on its court
--
-- A finished source reflows from its published time, and the loop reads its real span
-- from `started_at`/`ended_at`. An in-progress source has no end yet, so the loop uses
-- its *expected* finish, `COALESCE(started_at, scheduled_time) + duration` floored at
-- `statement_timestamp()` - the same expectation `assert_match_eligible` uses. For
-- that to matter, every place the loop asked "when did this match actually finish?"
-- for an in-progress row had to stop reading the published slot and start reading the
-- actual start (`previous`, `prereq` and `fixed`); otherwise a match that began
-- twenty minutes late reflowed as though it began on time.
--
-- `source_time` - the key the court queue is seeded with - is the *earlier* of the
-- source's published time and its actual start, not just the actual start. The queue
-- is seeded by `(original_time, match_table, match_id) > (source_time, ...)`, and
-- `original_time` is always the published time, so:
--
--   * using the actual start alone drops the court's own next match when the start is
--     late - that match is published between its old slot and the actual start, so it
--     falls behind the boundary and is never reached;
--   * using the published time alone drops a match on the *next* court when a match
--     moved to a court where its old published time sits late in the day - the target
--     court's earlier matches fall before the boundary and are never reached.
--
-- The minimum is the only boundary that reaches both, and it is safe on both sides
-- because the loop floors every match at its own published time: a match the boundary
-- reaches but nothing actually pushes keeps its time untouched. A match that a moved
-- source now sits on top of is caught by the loop's time-overlap "fixed window" test,
-- which does not depend on the ordering at all.
-- ---------------------------------------------------------------------------

-------------------------------------------------------------------------------
-- 1. The tournament setting
-------------------------------------------------------------------------------
--
-- Default false: the desk's warning is the whole rule until a tournament opts in.
-- No UI and no RPC writes it yet; it is a data switch the enforcement below reads.

ALTER TABLE public.tournaments
  ADD COLUMN block_start_on_short_rest boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tournaments.block_start_on_short_rest IS
  'When true, starting a match is refused if it would break a player''s rest gap. Default false: short rest is a desk warning only.';

-------------------------------------------------------------------------------
-- 2. The shared start check
-------------------------------------------------------------------------------
--
-- Called from the three start RPCs after the match row is marked in-progress. It
-- raises, which rolls the whole start (and the lifecycle flip) back.

CREATE OR REPLACE FUNCTION public.assert_can_start_match(
  p_table text,
  p_match_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_court uuid;
  v_court_number int;
  v_rest_gap interval;
  v_block_rest boolean;
  v_name text;
BEGIN
  IF p_table NOT IN ('pool_matches', 'draw_matches', 'placement_matches', 'tier_draw_matches') THEN
    RAISE EXCEPTION 'Unsupported match table';
  END IF;

  v_tournament := public.match_tournament(p_table, p_match_id);
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  -- The stage's own rest gap, and whether this tournament blocks on short rest. A pool
  -- and a placement round use the group timings; a knockout bracket uses the knockout
  -- timings - the same split `shift_live_schedule_core` gives each table.
  SELECT CASE WHEN p_table IN ('pool_matches', 'placement_matches')
              THEN make_interval(mins => t.group_rest_gap_minutes)
              ELSE make_interval(mins => t.knockout_rest_gap_minutes) END,
         t.block_start_on_short_rest
  INTO v_rest_gap, v_block_rest
  FROM public.tournaments t
  WHERE t.id = v_tournament;

  -- The candidate's court, as the start has just set it.
  IF p_table = 'pool_matches' THEN
    SELECT court_id INTO v_court FROM public.pool_matches WHERE id = p_match_id;
  ELSIF p_table = 'draw_matches' THEN
    SELECT court_id INTO v_court FROM public.draw_matches WHERE id = p_match_id;
  ELSIF p_table = 'placement_matches' THEN
    SELECT court_id INTO v_court FROM public.placement_matches WHERE id = p_match_id;
  ELSE
    SELECT court_id INTO v_court FROM public.tier_draw_matches WHERE id = p_match_id;
  END IF;

  -- Only what this check can care about: matches on court now, and matches a player
  -- finished recently enough to still be inside their rest gap. Resolving players for
  -- all four tables is the reflow's own resolution.
  DROP TABLE IF EXISTS pg_temp.start_check_players;
  CREATE TEMP TABLE start_check_players (
    match_table text NOT NULL,
    match_id uuid NOT NULL,
    status text NOT NULL,
    court_id uuid,
    ended_at timestamptz,
    player_id uuid NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO start_check_players
  SELECT 'pool_matches', m.id, m.status, m.court_id, m.ended_at, player.player_id
  FROM public.pool_matches m
  JOIN public.teams team ON team.id IN (m.team_a_id, m.team_b_id)
  CROSS JOIN LATERAL (VALUES (team.player_1_id), (team.player_2_id)) player(player_id)
  WHERE m.tournament_id = v_tournament
    AND player.player_id IS NOT NULL
    AND (m.status = 'in-progress'
         OR (m.ended_at IS NOT NULL AND m.ended_at > statement_timestamp() - v_rest_gap))
  UNION ALL
  SELECT 'draw_matches', m.id, m.status, m.court_id, m.ended_at, player.player_id
  FROM public.draw_matches m
  JOIN public.teams team ON team.id IN (m.team_a_id, m.team_b_id)
  CROSS JOIN LATERAL (VALUES (team.player_1_id), (team.player_2_id)) player(player_id)
  WHERE m.tournament_id = v_tournament
    AND player.player_id IS NOT NULL
    AND (m.status = 'in-progress'
         OR (m.ended_at IS NOT NULL AND m.ended_at > statement_timestamp() - v_rest_gap))
  UNION ALL
  SELECT 'placement_matches', m.id, m.status, m.court_id, m.ended_at, player.player_id
  FROM public.placement_matches m
  JOIN public.placement_entrants entrant ON entrant.id IN (m.entrant_a_id, m.entrant_b_id)
  JOIN public.teams team ON team.id = entrant.team_id
  CROSS JOIN LATERAL (VALUES (team.player_1_id), (team.player_2_id)) player(player_id)
  WHERE m.tournament_id = v_tournament
    AND player.player_id IS NOT NULL
    AND (m.status = 'in-progress'
         OR (m.ended_at IS NOT NULL AND m.ended_at > statement_timestamp() - v_rest_gap))
  UNION ALL
  SELECT 'tier_draw_matches', m.id, m.status, m.court_id, m.ended_at, player.player_id
  FROM public.tier_draw_matches m
  JOIN public.placement_entrants entrant ON entrant.id IN (m.entrant_a_id, m.entrant_b_id)
  JOIN public.teams team ON team.id = entrant.team_id
  CROSS JOIN LATERAL (VALUES (team.player_1_id), (team.player_2_id)) player(player_id)
  WHERE m.tournament_id = v_tournament
    AND player.player_id IS NOT NULL
    AND (m.status = 'in-progress'
         OR (m.ended_at IS NOT NULL AND m.ended_at > statement_timestamp() - v_rest_gap));

  -- (b) The court is free. Read from the match rows, not the player projection, so a
  -- match with an unresolvable side still counts as occupying its court.
  IF v_court IS NOT NULL AND EXISTS (
    SELECT 1
    FROM (
      SELECT 'pool_matches'::text AS match_table, id, court_id, status FROM public.pool_matches WHERE tournament_id = v_tournament
      UNION ALL
      SELECT 'draw_matches', id, court_id, status FROM public.draw_matches WHERE tournament_id = v_tournament
      UNION ALL
      SELECT 'placement_matches', id, court_id, status FROM public.placement_matches WHERE tournament_id = v_tournament
      UNION ALL
      SELECT 'tier_draw_matches', id, court_id, status FROM public.tier_draw_matches WHERE tournament_id = v_tournament
    ) on_court
    WHERE on_court.status = 'in-progress'
      AND on_court.court_id = v_court
      AND NOT (on_court.match_table = p_table AND on_court.id = p_match_id)
  ) THEN
    SELECT number INTO v_court_number FROM public.courts WHERE id = v_court;
    RAISE EXCEPTION 'Court % already has a match in progress',
      COALESCE(v_court_number::text, '(unknown)');
  END IF;

  -- (a) No player of this match is already on court in another match.
  SELECT p.name INTO v_name
  FROM start_check_players mine
  JOIN start_check_players theirs
    ON theirs.player_id = mine.player_id
   AND theirs.status = 'in-progress'
   AND NOT (theirs.match_table = p_table AND theirs.match_id = p_match_id)
  JOIN public.players p ON p.id = mine.player_id
  WHERE mine.match_table = p_table AND mine.match_id = p_match_id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% is already playing in another match', v_name;
  END IF;

  -- (c) Short rest blocks only when the tournament has opted in. The most recent
  -- finish is the one that matters: an earlier one is behind it by definition. The
  -- candidate is excluded for the same reason it is in (a): it is starting now, so it
  -- cannot be its own previous match.
  IF v_block_rest THEN
    SELECT p.name INTO v_name
    FROM start_check_players mine
    JOIN start_check_players theirs
      ON theirs.player_id = mine.player_id
     AND theirs.ended_at IS NOT NULL
     AND theirs.ended_at > statement_timestamp() - v_rest_gap
     AND NOT (theirs.match_table = p_table AND theirs.match_id = p_match_id)
    JOIN public.players p ON p.id = mine.player_id
    WHERE mine.match_table = p_table AND mine.match_id = p_match_id
    ORDER BY theirs.ended_at DESC
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION '% has not had the required % minutes of rest',
        v_name, (EXTRACT(epoch FROM v_rest_gap) / 60)::int;
    END IF;
  END IF;
END;
$$;

-------------------------------------------------------------------------------
-- 3. The three start RPCs
-------------------------------------------------------------------------------
--
-- Each takes the same global schedule keys `start_match_safe` already took, before
-- the physical check, so two concurrent starts cannot both pass it on a stale read -
-- the second sees the first's committed row and is refused. The keys are taken
-- lifecycle first, then live-schedule, then schedule:1/:2, the order every schedule
-- writer uses.

CREATE OR REPLACE FUNCTION public.start_placement_match(p_match_id uuid, p_court_id uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_placement_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.lock_tournament_lifecycle_shared(v_tournament);
  PERFORM public.assert_tournament_can_start_match(v_tournament);
  -- Before the match is touched, so nothing the match update fires can see an upcoming
  -- tournament with a match on court. A start that then fails raises, and the whole
  -- transaction - this flip included - is rolled back.
  PERFORM public.mark_tournament_started(v_tournament);

  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));

  UPDATE public.placement_matches
  SET status = 'in-progress',
      started_at = COALESCE(started_at, statement_timestamp()),
      court_id = COALESCE(p_court_id, court_id)
  WHERE id = p_match_id AND status = 'scheduled';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match is not ready to start';
  END IF;

  -- The row is on court now, so the check reads it back and the reflow has an
  -- in-progress source to push the rest of the day behind.
  PERFORM public.assert_can_start_match('placement_matches', p_match_id);
  PERFORM public.shift_live_schedule_after_match('placement_matches', p_match_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_tier_draw_match(p_match_id uuid, p_court_id uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_tier_draw_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.lock_tournament_lifecycle_shared(v_tournament);
  PERFORM public.assert_tournament_can_start_match(v_tournament);
  PERFORM public.mark_tournament_started(v_tournament);

  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));

  UPDATE public.tier_draw_matches
  SET status = 'in-progress',
      started_at = COALESCE(started_at, statement_timestamp()),
      court_id = COALESCE(p_court_id, court_id)
  WHERE id = p_match_id AND status = 'scheduled' AND NOT is_bye;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match is not ready to start';
  END IF;

  PERFORM public.assert_can_start_match('tier_draw_matches', p_match_id);
  PERFORM public.shift_live_schedule_after_match('tier_draw_matches', p_match_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_match_safe(p_table text, p_match_id uuid, p_court_id uuid, p_ignore_rest boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament(p_table, p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.lock_tournament_lifecycle_shared(v_tournament);
  PERFORM public.assert_tournament_can_start_match(v_tournament);
  PERFORM public.mark_tournament_started(v_tournament);
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

  -- The physical checks the legacy path did not split out, plus the reflow that a
  -- late start now earns. `assert_match_eligible` above still owns the published-time
  -- window and the desk's per-match rest override; this owns "is the room actually
  -- free", plus the tournament's own rest block, which is a host decision and so is
  -- deliberately not overridable match by match.
  PERFORM public.assert_can_start_match(p_table, p_match_id);
  PERFORM public.shift_live_schedule_after_match(p_table, p_match_id);
END;
$function$;

-------------------------------------------------------------------------------
-- 4. The reflow core, now accepting an in-progress source
-------------------------------------------------------------------------------
--
-- Body unchanged from `20261009010000_safe_live_schedule_reflow.sql` except:
--   * the four source reads also accept `status = 'in-progress'` and read `started_at`
--     and `status`;
--   * the early return distinguishes a finished match with no end (still nothing to
--     reflow from) from an in-progress match (which has an expected end);
--   * an in-progress source's `source_time` is the earlier of its published time and
--     its actual start - see the header;
--   * every in-progress duration expression uses `COALESCE(actual_start, shifted_time)`
--     so a match that began late reflows from when it actually began.

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

-------------------------------------------------------------------------------
-- 5. Privileges
-------------------------------------------------------------------------------
--
-- `CREATE OR REPLACE FUNCTION` restores the implicit PUBLIC grant on every function
-- re-created above, so each is re-closed here. `assert_can_start_match` is internal:
-- it is called only from the SECURITY DEFINER start RPCs.

REVOKE ALL ON FUNCTION public.assert_can_start_match(text, uuid) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_can_start_match(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.start_placement_match(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.start_placement_match(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.start_tier_draw_match(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.start_tier_draw_match(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.start_match_safe(text, uuid, uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.start_match_safe(text, uuid, uuid, boolean) TO authenticated;

REVOKE ALL ON FUNCTION public.shift_live_schedule_core(text, uuid) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.shift_live_schedule_core(text, uuid) TO service_role;

-------------------------------------------------------------------------------
-- 6. Verify
-------------------------------------------------------------------------------

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tournaments'
      AND column_name = 'block_start_on_short_rest'
      AND data_type = 'boolean' AND is_nullable = 'NO'
      AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'M5: tournaments.block_start_on_short_rest is missing or not a NOT NULL boolean defaulting to false';
  END IF;

  -- The shared check is one function, off the client surface.
  IF to_regprocedure('public.assert_can_start_match(text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'M5: assert_can_start_match does not exist';
  END IF;
  IF has_function_privilege('authenticated', 'public.assert_can_start_match(text, uuid)', 'execute') THEN
    RAISE EXCEPTION 'M5: assert_can_start_match is internal and must not be a client RPC';
  END IF;

  -- Each start RPC runs the shared physical check and then the reflow.
  IF (
    SELECT count(DISTINCT p.proname)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('start_placement_match', 'start_tier_draw_match', 'start_match_safe')
      AND p.prosrc LIKE '%assert_can_start_match(%'
      AND p.prosrc LIKE '%shift_live_schedule_after_match(%'
  ) <> 3 THEN
    RAISE EXCEPTION 'M5: a start RPC is missing the physical check or the reflow';
  END IF;

  -- The check itself still scans all four match tables and both arms.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'assert_can_start_match'
      AND p.prosrc LIKE '%pool_matches%'
      AND p.prosrc LIKE '%draw_matches%'
      AND p.prosrc LIKE '%placement_matches%'
      AND p.prosrc LIKE '%tier_draw_matches%'
      AND p.prosrc LIKE '%already has a match in progress%'
      AND p.prosrc LIKE '%is already playing in another match%'
      AND p.prosrc LIKE '%block_start_on_short_rest%'
  ) THEN
    RAISE EXCEPTION 'M5: assert_can_start_match does not cover both physical checks and the rest setting';
  END IF;

  -- The reflow accepts an in-progress source and reads the actual start.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'shift_live_schedule_core'
      AND p.prosrc LIKE '%''in-progress''%'
      AND p.prosrc LIKE '%COALESCE(previous.actual_start, previous.shifted_time)%'
      AND p.prosrc LIKE '%COALESCE(prereq.actual_start, prereq.shifted_time)%'
      AND p.prosrc LIKE '%COALESCE(fixed.actual_start, fixed.shifted_time)%'
      AND p.prosrc LIKE '%source_status = ''in-progress''%'
  ) THEN
    RAISE EXCEPTION 'M5: the reflow core does not handle an in-progress source from its actual start';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
