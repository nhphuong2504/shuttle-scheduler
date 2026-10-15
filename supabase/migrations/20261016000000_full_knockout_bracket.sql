-- Full knockout bracket from the draw.
--
-- Until now `apply_tier_draws` created round one of each A/B/C/D bracket, and
-- `advance_tier_draw_locked` created each later round once the previous one was decided.
-- That left a viewer with no path to the final until it was nearly upon them.
--
-- From this migration the draw creates EVERY round and EVERY slot at once. Later rounds start
-- with no entrants (a bye's winner is advanced at once); a result fills the winner into the
-- child slot that already exists, and a slot with both sides known becomes schedulable.
--
-- Child rule, shared with `guard_tier_draw_correction`: the winner of round r slot s goes to
-- round r+1 slot (s+1)/2, as side A when s is odd and side B when s is even.
--
-- Nothing below edits an applied migration; every function is replaced here.

--------------------------------------------------------------------------------
-- 1. fill_tier_bracket - create the missing rounds, link parents, advance winners
--------------------------------------------------------------------------------
--
-- Idempotent. `apply_tier_draws` calls it after inserting the payload (which may or may not
-- carry later rounds), and the backfill at the end of this file calls it for every draw that
-- already exists. Internal: reachable only from other SECURITY DEFINER functions.

CREATE OR REPLACE FUNCTION public.fill_tier_bracket(p_draw_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_size int;
  v_rounds int := 0;
  v_n int;
  v_round int;
BEGIN
  SELECT tournament_id, bracket_size INTO v_tournament, v_size
  FROM public.tier_draws WHERE id = p_draw_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown tier draw';
  END IF;

  -- A champion-only or empty draw has no bracket to fill.
  IF v_size <= 1 THEN
    RETURN;
  END IF;

  v_n := v_size;
  WHILE v_n > 1 LOOP
    v_n := v_n / 2;
    v_rounds := v_rounds + 1;
  END LOOP;

  FOR v_round IN 2 .. v_rounds LOOP
    INSERT INTO public.tier_draw_matches (
      tournament_id, draw_id, round, slot, is_bye, status
    )
    SELECT v_tournament, p_draw_id, v_round, s, false, 'scheduled'
    FROM generate_series(1, v_size / (1 << v_round)) AS s
    ON CONFLICT (draw_id, round, slot) DO NOTHING;
  END LOOP;

  -- Link every match above round one to the two matches that feed it.
  UPDATE public.tier_draw_matches c
  SET parent_a_id = a.id,
      parent_b_id = b.id
  FROM public.tier_draw_matches a, public.tier_draw_matches b
  WHERE c.draw_id = p_draw_id
    AND c.round > 1
    AND a.draw_id = p_draw_id AND a.round = c.round - 1 AND a.slot = 2 * c.slot - 1
    AND b.draw_id = p_draw_id AND b.round = c.round - 1 AND b.slot = 2 * c.slot
    AND (c.parent_a_id IS DISTINCT FROM a.id OR c.parent_b_id IS DISTINCT FROM b.id);

  -- Byes (and anything already decided) move up.
  PERFORM public.advance_tier_draw_locked(p_draw_id);
END;
$$;

REVOKE ALL ON FUNCTION public.fill_tier_bracket(uuid) FROM anon, authenticated, PUBLIC;

--------------------------------------------------------------------------------
-- 2. advance_tier_draw_locked - fill the existing child slot, never create rows
--------------------------------------------------------------------------------
--
-- Called after every reported result and from `fill_tier_bracket`. Idempotent: it only ever
-- writes a winner into a child that has not started, and only when the value differs.
-- Settles the draw (`champion_id`) when the final has a winner.

CREATE OR REPLACE FUNCTION public.advance_tier_draw_locked(p_draw_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_final int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tier-draw:' || p_draw_id::text));

  SELECT tournament_id INTO v_tournament FROM public.tier_draws WHERE id = p_draw_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown tier draw';
  END IF;

  -- Odd slots feed side A of the child, even slots side B.
  UPDATE public.tier_draw_matches c
  SET entrant_a_id = p.winner_id
  FROM public.tier_draw_matches p
  WHERE p.draw_id = p_draw_id
    AND c.draw_id = p_draw_id
    AND c.round = p.round + 1
    AND c.slot = (p.slot + 1) / 2
    AND p.slot % 2 = 1
    AND p.winner_id IS NOT NULL
    AND c.status = 'scheduled'
    AND c.entrant_a_id IS DISTINCT FROM p.winner_id;

  UPDATE public.tier_draw_matches c
  SET entrant_b_id = p.winner_id
  FROM public.tier_draw_matches p
  WHERE p.draw_id = p_draw_id
    AND c.draw_id = p_draw_id
    AND c.round = p.round + 1
    AND c.slot = (p.slot + 1) / 2
    AND p.slot % 2 = 0
    AND p.winner_id IS NOT NULL
    AND c.status = 'scheduled'
    AND c.entrant_b_id IS DISTINCT FROM p.winner_id;

  SELECT max(round) INTO v_final FROM public.tier_draw_matches WHERE draw_id = p_draw_id;
  IF v_final IS NULL THEN
    RETURN;
  END IF;

  -- A decided final settles the draw.
  UPDATE public.tier_draws d
  SET champion_id = m.winner_id
  FROM public.tier_draw_matches m
  WHERE d.id = p_draw_id
    AND m.draw_id = p_draw_id
    AND m.round = v_final
    AND m.winner_id IS NOT NULL
    AND d.bracket_size > 1
    AND d.champion_id IS DISTINCT FROM m.winner_id;
END;
$$;

--------------------------------------------------------------------------------
-- 3. apply_tier_draws - same gates, then the whole bracket
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_tier_draws(p_category_id uuid, p_tiers jsonb, p_draws jsonb, p_force boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_required int;
  v_draw jsonb;
  v_match jsonb;
  v_draw_id uuid;
  v_champion uuid;
  v_short int;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_category(p_category_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  v_required := public.placement_required_matches(p_category_id);

  IF NOT p_force THEN
    SELECT count(*) INTO v_short
    FROM public.placement_entrants e
    WHERE e.category_id = p_category_id
      AND NOT e.excluded
      AND public.placement_decided_matches(p_category_id, e.id) < v_required;

    IF v_short > 0 THEN
      RAISE EXCEPTION
        'Every entrant needs % placement matches before draws — % still short',
        v_required, v_short;
    END IF;

    IF EXISTS (SELECT 1 FROM public.tier_draws WHERE category_id = p_category_id) THEN
      RAISE EXCEPTION 'Tier draws already exist for this category';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tier_draw_matches m
    JOIN public.tier_draws d ON d.id = m.draw_id
    WHERE d.category_id = p_category_id
      AND m.status IN ('in-progress', 'reported', 'walkover')
  ) THEN
    RAISE EXCEPTION 'Tier draws have already been played for this category';
  END IF;

  DELETE FROM public.desk_activity
  WHERE match_id IN (
    SELECT m.id FROM public.tier_draw_matches m
    JOIN public.tier_draws d ON d.id = m.draw_id
    WHERE d.category_id = p_category_id
  );
  DELETE FROM public.tier_draws WHERE category_id = p_category_id;

  UPDATE public.placement_entrants
  SET tier = NULL
  WHERE category_id = p_category_id;

  UPDATE public.placement_entrants e
  SET tier = item->>'tier'
  FROM jsonb_array_elements(COALESCE(p_tiers, '[]'::jsonb)) AS item
  WHERE e.category_id = p_category_id
    AND e.team_id = (item->>'team_id')::uuid
    AND item->>'tier' IN ('A', 'B', 'C', 'D');

  FOR v_draw IN SELECT value FROM jsonb_array_elements(COALESCE(p_draws, '[]'::jsonb))
  LOOP
    -- An empty tier gets no draw at all: a bracket needs at least one entrant, and
    -- the `bracket_size >= 1` check would reject a placeholder row anyway.
    IF COALESCE((v_draw->>'entrant_count')::int, 0) = 0 THEN
      CONTINUE;
    END IF;

    SELECT NULLIF(v_draw->>'champion_team_id', '')::uuid INTO v_champion;

    INSERT INTO public.tier_draws (
      tournament_id, category_id, tier, bracket_size, entrant_count, champion_id
    )
    VALUES (
      v_tournament,
      p_category_id,
      v_draw->>'tier',
      COALESCE((v_draw->>'bracket_size')::int, 0),
      COALESCE((v_draw->>'entrant_count')::int, 0),
      (SELECT id FROM public.placement_entrants
        WHERE category_id = p_category_id AND team_id = v_champion)
    )
    RETURNING id INTO v_draw_id;

    FOR v_match IN SELECT value FROM jsonb_array_elements(COALESCE(v_draw->'matches', '[]'::jsonb))
    LOOP
      INSERT INTO public.tier_draw_matches (
        tournament_id, draw_id, round, slot,
        entrant_a_id, entrant_b_id, winner_id, is_bye, status
      )
      VALUES (
        v_tournament,
        v_draw_id,
        (v_match->>'round')::int,
        (v_match->>'slot')::int,
        (SELECT id FROM public.placement_entrants
          WHERE category_id = p_category_id
            AND team_id = NULLIF(v_match->>'entrant_a_team_id', '')::uuid),
        (SELECT id FROM public.placement_entrants
          WHERE category_id = p_category_id
            AND team_id = NULLIF(v_match->>'entrant_b_team_id', '')::uuid),
        (SELECT id FROM public.placement_entrants
          WHERE category_id = p_category_id
            AND team_id = NULLIF(v_match->>'winner_team_id', '')::uuid),
        COALESCE((v_match->>'is_bye')::boolean, false),
        CASE WHEN COALESCE((v_match->>'is_bye')::boolean, false) THEN 'bye' ELSE 'scheduled' END
      );
    END LOOP;

    -- A real first-round match with a missing entrant would be a silently broken
    -- bracket, so it is rejected rather than left to fail at the desk. Later rounds are
    -- expected to have empty sides: they fill in as results arrive.
    IF EXISTS (
      SELECT 1 FROM public.tier_draw_matches
      WHERE draw_id = v_draw_id AND round = 1 AND NOT is_bye
        AND (entrant_a_id IS NULL OR entrant_b_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'A first-round % match is missing an entrant', v_draw->>'tier';
    END IF;

    -- The payload may carry every round or only the first; either way the bracket ends up
    -- complete, linked to its parents, with byes already advanced.
    PERFORM public.fill_tier_bracket(v_draw_id);
  END LOOP;
END;
$function$;

--------------------------------------------------------------------------------
-- 4. reset_tier_draw_result - undo a result, unless the next match has begun
--------------------------------------------------------------------------------
--
-- The child slot always exists now, so "a later round exists" no longer means anything.
-- What matters is whether the child has started: if not, the winner is withdrawn from it
-- (and the child, now missing a side, loses its court and time); if so, refuse.

CREATE OR REPLACE FUNCTION public.reset_tier_draw_result(p_match_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draw uuid;
  v_round int;
  v_slot int;
  v_bye boolean;
  v_tournament uuid;
  v_child record;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_tier_draw_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  SELECT draw_id, round, slot, is_bye INTO v_draw, v_round, v_slot, v_bye
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_draw IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT id, status INTO v_child
  FROM public.tier_draw_matches
  WHERE draw_id = v_draw AND round = v_round + 1 AND slot = (v_slot + 1) / 2;

  -- The next match already began from this result, so it cannot be withdrawn in place.
  IF FOUND AND NOT v_bye AND v_child.status <> 'scheduled' THEN
    RAISE EXCEPTION 'The next match has already started from this result';
  END IF;

  UPDATE public.tier_draw_matches
  SET games = '[]'::jsonb,
      winner_id = CASE WHEN is_bye THEN winner_id ELSE NULL END,
      status = CASE WHEN is_bye THEN 'bye' ELSE 'scheduled' END,
      reported_time = NULL,
      ended_at = NULL,
      started_at = NULL
  WHERE id = p_match_id;

  IF NOT v_bye THEN
    IF v_child.id IS NOT NULL THEN
      -- The child now lacks this side, so it is no longer schedulable: clear the slot too.
      IF v_slot % 2 = 1 THEN
        UPDATE public.tier_draw_matches
        SET entrant_a_id = NULL, court_id = NULL, scheduled_time = NULL
        WHERE id = v_child.id;
      ELSE
        UPDATE public.tier_draw_matches
        SET entrant_b_id = NULL, court_id = NULL, scheduled_time = NULL
        WHERE id = v_child.id;
      END IF;
    ELSE
      -- No child means this was the final: the draw has no champion any more.
      UPDATE public.tier_draws SET champion_id = NULL WHERE id = v_draw;
    END IF;
  END IF;
END;
$function$;

--------------------------------------------------------------------------------
-- 5. start_tier_draw_match - refuse a match that is missing a side
--------------------------------------------------------------------------------

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

  -- Both sides must be known: the whole bracket exists from the draw, so a slot still
  -- waiting on a feeder is a row with `scheduled` status that is not a match yet.
  UPDATE public.tier_draw_matches
  SET status = 'in-progress',
      started_at = COALESCE(started_at, statement_timestamp()),
      court_id = COALESCE(p_court_id, court_id)
  WHERE id = p_match_id
    AND status = 'scheduled'
    AND NOT is_bye
    AND entrant_a_id IS NOT NULL
    AND entrant_b_id IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match is not ready to start';
  END IF;

  PERFORM public.assert_can_start_match('tier_draw_matches', p_match_id);
  PERFORM public.shift_live_schedule_after_match('tier_draw_matches', p_match_id);
END;
$function$;

--------------------------------------------------------------------------------
-- 6. apply_placement_day_schedule - completeness only for schedulable matches
--------------------------------------------------------------------------------
--
-- Identical to the previous body except the knockout completeness check, which now ignores
-- slots with an undecided side: they have no court or time to lose.

CREATE OR REPLACE FUNCTION public.apply_placement_day_schedule(p_tournament_id uuid, p_stage text, p_slots jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_slot_json jsonb;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);
  IF p_stage NOT IN ('placement', 'knockout') THEN
    RAISE EXCEPTION 'Unknown stage %', p_stage;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = p_tournament_id) THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  -- Same lock key as the legacy writer, so a rebuild of either format is
  -- serialised against the other and against result-driven shifts.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));

  IF p_stage = 'placement' THEN
    UPDATE public.placement_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE tournament_id = p_tournament_id AND status = 'scheduled';
  ELSE
    UPDATE public.tier_draw_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE tournament_id = p_tournament_id AND status = 'scheduled' AND NOT is_bye;
  END IF;

  FOR v_slot_json IN SELECT * FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb))
  LOOP
    IF p_stage = 'placement' THEN
      UPDATE public.placement_matches
      SET scheduled_time = (v_slot_json->>'scheduled_time')::timestamptz,
          court_id = NULLIF(v_slot_json->>'court_id', '')::uuid
      WHERE id = (v_slot_json->>'match_id')::uuid
        AND tournament_id = p_tournament_id
        AND status = 'scheduled';
    ELSE
      UPDATE public.tier_draw_matches
      SET scheduled_time = (v_slot_json->>'scheduled_time')::timestamptz,
          court_id = NULLIF(v_slot_json->>'court_id', '')::uuid
      WHERE id = (v_slot_json->>'match_id')::uuid
        AND tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND NOT is_bye;
    END IF;
  END LOOP;

  -- The same completeness check the legacy writer makes: a rebuild that leaves an
  -- assigned match without a court or a time has silently dropped a match, and
  -- failing the transaction is better than persisting a half-built day.
  IF p_stage = 'placement' THEN
    IF EXISTS (
      SELECT 1 FROM public.placement_matches
      WHERE tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Placement rebuild left assigned matches without a court or time';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.tier_draw_matches
      WHERE tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND NOT is_bye
        AND entrant_a_id IS NOT NULL
        AND entrant_b_id IS NOT NULL
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Knockout rebuild left assigned matches without a court or time';
    END IF;
  END IF;
END;
$function$;

--------------------------------------------------------------------------------
-- 7. The sample tournaments - keep the one-call reset producing full brackets
--------------------------------------------------------------------------------
--
-- `seed_demo_tournaments()` (20261015010000) writes tier rows round by round, which is the old
-- shape. Its body is not edited (an applied migration is never edited): it is renamed, and a
-- wrapper with the same name, signature and privileges calls it and then completes every demo
-- bracket. Callers (`scripts/demo-tournaments.mjs`, the integration suite) are unchanged.

ALTER FUNCTION public.seed_demo_tournaments() RENAME TO seed_demo_tournaments_rows;

CREATE OR REPLACE FUNCTION public.seed_demo_tournaments()
RETURNS TABLE (
  tournament text,
  status text,
  venue text,
  dates text,
  entries int,
  events int,
  stage text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draw uuid;
BEGIN
  RETURN QUERY SELECT * FROM public.seed_demo_tournaments_rows();

  FOR v_draw IN
    SELECT d.id FROM public.tier_draws d
    JOIN public.tournaments t ON t.id = d.tournament_id
    WHERE t.is_demo AND d.bracket_size > 1
  LOOP
    PERFORM public.fill_tier_bracket(v_draw);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_demo_tournaments_rows() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seed_demo_tournaments() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_demo_tournaments() TO service_role;

--------------------------------------------------------------------------------
-- 8. Backfill - give every existing draw its full bracket
--------------------------------------------------------------------------------
--
-- Idempotent: a draw that already has every round only gets its parents linked and any
-- decided winner re-asserted into a child that has not started.

DO $$
DECLARE
  v_draw uuid;
BEGIN
  FOR v_draw IN SELECT id FROM public.tier_draws WHERE bracket_size > 1
  LOOP
    PERFORM public.fill_tier_bracket(v_draw);
  END LOOP;
END;
$$;

DO $verify$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fill_tier_bracket') <> 1 THEN
    RAISE EXCEPTION 'fill_tier_bracket is missing or duplicated';
  END IF;
  IF has_function_privilege('authenticated', 'public.fill_tier_bracket(uuid)', 'execute')
     OR has_function_privilege('anon', 'public.fill_tier_bracket(uuid)', 'execute') THEN
    RAISE EXCEPTION 'fill_tier_bracket must not be callable from a client';
  END IF;
  -- Every bracket now has size - 1 slots, one final, and every slot above round one is linked.
  IF EXISTS (
    SELECT 1 FROM public.tier_draws d
    WHERE d.bracket_size > 1
      AND (SELECT count(*) FROM public.tier_draw_matches m WHERE m.draw_id = d.id) <> d.bracket_size - 1
  ) THEN
    RAISE EXCEPTION 'A tier draw is missing slots after the backfill';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tier_draw_matches
    WHERE round > 1 AND (parent_a_id IS NULL OR parent_b_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'A knockout slot above round one has no parents';
  END IF;
END;
$verify$;
