-- Reporting and correcting a result: what it may change downstream.
--
-- Three problems, found by reviewing what a reported result does to the rest of a tournament.
--
-- 1. CORRECTING A RESULT LEFT THE NEXT ROUND STALE.
--
--    `reset_placement_result` and `reset_tier_draw_result` refuse once a later round was
--    built from the result, but the report functions did not: the desk offers "correct" on a
--    reported match, and re-reporting with a different winner updated only that row.
--    `advance_tier_draw_locked` returns early when the next round exists, so a corrected
--    quarter-final left the semi-final holding the old entrant. Round two and the draws
--    have the same shape.
--
--    The guards are triggers on the match tables rather than edits to the four report
--    functions, so a correction is covered however it arrives and the long, already-applied
--    bodies stay as they are. They fire only on a correction: an already-reported row whose
--    winner (or, for pools, score) changes to another non-null value. A first report and a
--    reset (winner becomes NULL) are untouched.
--
--      knockout (tier_draw_matches)  the next-round match is repaired in place while it is
--                                    still unplayed, refused once it has started
--      legacy knockout (draw_matches) same: repaired in place while unplayed, refused once
--                                    the child match has started
--      placement round one           refused once round two exists - it was derived from the
--                                    winner and loser sets
--      pool matches                  refused once draws exist for the category
--
-- 2. THE LIVE REFLOW DID NOT KNOW ABOUT BREAKS.
--
--    `shift_live_schedule_after_match` pushes later matches on a court after a late finish
--    but reads neither `tournament_day_breaks` nor the day's hours, so a pushed match could
--    land inside a break. The function is ~350 lines of load-bearing algorithm, so it is not
--    rewritten: it is renamed to `shift_live_schedule_core` and a wrapper with the original
--    name and signature calls it, then moves any still-scheduled match that overlaps a break
--    to the break's end and pushes the matches behind it on that court. Every caller keeps
--    working unchanged.
--
--    Known limits of that pass: it keeps each court's order but does not re-check a player's
--    rest window for the matches it pushes, and it does not enforce the day's closing time
--    (a match that cannot fit stays late rather than being dropped).
--
-- 3. THE REFLOW WAS CALLABLE BY ANY SIGNED-IN USER.
--
--    It was granted to `authenticated` by `20260916010000` and checks no tournament rights,
--    so any account could reflow any tournament by match id. It is only ever called from
--    SECURITY DEFINER functions, which do not need the grant.

-------------------------------------------------------------------------------
-- 2. Break-aware reflow
-------------------------------------------------------------------------------

ALTER FUNCTION public.shift_live_schedule_after_match(text, uuid)
  RENAME TO shift_live_schedule_core;

REVOKE ALL ON FUNCTION public.shift_live_schedule_core(text, uuid)
  FROM anon, authenticated, PUBLIC;

CREATE OR REPLACE FUNCTION public.clear_breaks_after_reflow(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tz text;
  v_group interval;
  v_ko interval;
  m record;
  n record;
  v_prev_end timestamptz;
  v_guard int := 0;
BEGIN
  SELECT t.venue_timezone,
         make_interval(mins => t.group_slot_minutes),
         make_interval(mins => t.knockout_slot_minutes)
  INTO v_tz, v_group, v_ko
  FROM public.tournaments t WHERE t.id = p_tournament_id;

  IF v_tz IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tournament_day_breaks WHERE tournament_id = p_tournament_id
  ) THEN
    RETURN;
  END IF;

  DROP TABLE IF EXISTS break_work;
  CREATE TEMP TABLE break_work (
    tbl text NOT NULL,
    id uuid NOT NULL,
    court uuid NOT NULL,
    t timestamptz NOT NULL,
    dur interval NOT NULL,
    dirty boolean NOT NULL DEFAULT false,
    PRIMARY KEY (tbl, id)
  ) ON COMMIT DROP;

  INSERT INTO break_work (tbl, id, court, t, dur)
  SELECT 'pool_matches', id, court_id, scheduled_time, v_group
  FROM public.pool_matches
  WHERE tournament_id = p_tournament_id AND status = 'scheduled'
    AND court_id IS NOT NULL AND scheduled_time IS NOT NULL
  UNION ALL
  SELECT 'draw_matches', id, court_id, scheduled_time, v_ko
  FROM public.draw_matches
  WHERE tournament_id = p_tournament_id AND status = 'scheduled'
    AND court_id IS NOT NULL AND scheduled_time IS NOT NULL
    AND COALESCE(is_bye, false) = false
  UNION ALL
  SELECT 'placement_matches', id, court_id, scheduled_time, v_group
  FROM public.placement_matches
  WHERE tournament_id = p_tournament_id AND status = 'scheduled'
    AND court_id IS NOT NULL AND scheduled_time IS NOT NULL
  UNION ALL
  SELECT 'tier_draw_matches', id, court_id, scheduled_time, v_ko
  FROM public.tier_draw_matches
  WHERE tournament_id = p_tournament_id AND status = 'scheduled'
    AND court_id IS NOT NULL AND scheduled_time IS NOT NULL
    AND NOT is_bye;

  LOOP
    v_guard := v_guard + 1;
    IF v_guard > 5000 THEN
      RAISE EXCEPTION 'Break clearing did not converge';
    END IF;

    SELECT w.tbl, w.id, w.court, w.t, w.dur, x.be
    INTO m
    FROM break_work w
    JOIN public.tournament_days d
      ON d.tournament_id = p_tournament_id
     AND d.date = (w.t AT TIME ZONE v_tz)::date
    JOIN public.tournament_day_breaks br ON br.day_id = d.id
    CROSS JOIN LATERAL (
      SELECT ((d.date + br.start_time) AT TIME ZONE v_tz) AS bs,
             ((d.date + br.end_time) AT TIME ZONE v_tz) AS be
    ) x
    WHERE w.t < x.be AND w.t + w.dur > x.bs
    ORDER BY w.t, w.tbl, w.id
    LIMIT 1;

    EXIT WHEN NOT FOUND;

    UPDATE break_work SET t = m.be, dirty = true WHERE tbl = m.tbl AND id = m.id;
    v_prev_end := m.be + m.dur;

    -- Keep the court's order: whatever sat behind the moved match slides back as far as
    -- it must, and stops as soon as there is slack.
    FOR n IN
      SELECT tbl, id, t, dur
      FROM break_work
      WHERE court = m.court
        AND (t, tbl, id::text) > (m.t, m.tbl, m.id::text)
      ORDER BY t, tbl, id
    LOOP
      EXIT WHEN n.t >= v_prev_end;
      UPDATE break_work SET t = v_prev_end, dirty = true WHERE tbl = n.tbl AND id = n.id;
      v_prev_end := v_prev_end + n.dur;
    END LOOP;
  END LOOP;

  UPDATE public.pool_matches x SET scheduled_time = w.t
  FROM break_work w
  WHERE w.dirty AND w.tbl = 'pool_matches' AND w.id = x.id AND x.status = 'scheduled';

  UPDATE public.draw_matches x SET scheduled_time = w.t
  FROM break_work w
  WHERE w.dirty AND w.tbl = 'draw_matches' AND w.id = x.id AND x.status = 'scheduled';

  UPDATE public.placement_matches x SET scheduled_time = w.t
  FROM break_work w
  WHERE w.dirty AND w.tbl = 'placement_matches' AND w.id = x.id AND x.status = 'scheduled';

  UPDATE public.tier_draw_matches x SET scheduled_time = w.t
  FROM break_work w
  WHERE w.dirty AND w.tbl = 'tier_draw_matches' AND w.id = x.id AND x.status = 'scheduled';

  IF EXISTS (SELECT 1 FROM break_work WHERE dirty AND tbl = 'pool_matches') THEN
    UPDATE public.pools pool
    SET scheduled_end = latest.scheduled_end
    FROM (
      SELECT pm.pool_id, max(pm.scheduled_time + v_group) AS scheduled_end
      FROM public.pool_matches pm
      WHERE pm.status <> 'void'
        AND pm.scheduled_time IS NOT NULL
        AND pm.tournament_id = p_tournament_id
      GROUP BY pm.pool_id
    ) latest
    WHERE pool.id = latest.pool_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_breaks_after_reflow(uuid)
  FROM anon, authenticated, PUBLIC;

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
  v_tournament uuid;
BEGIN
  PERFORM public.shift_live_schedule_core(p_table, p_match_id);
  v_tournament := public.match_tournament(p_table, p_match_id);
  IF v_tournament IS NOT NULL THEN
    PERFORM public.clear_breaks_after_reflow(v_tournament);
  END IF;
END;
$$;

-- Internal: called only from the SECURITY DEFINER report/reset functions.
REVOKE ALL ON FUNCTION public.shift_live_schedule_after_match(text, uuid)
  FROM anon, authenticated, PUBLIC;

-------------------------------------------------------------------------------
-- 1. Correction guards
-------------------------------------------------------------------------------

-- Knockout (placement format): repair the next-round match while it is unplayed.
CREATE OR REPLACE FUNCTION public.guard_tier_draw_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next record;
BEGIN
  SELECT id, status INTO v_next
  FROM public.tier_draw_matches
  WHERE draw_id = NEW.draw_id
    AND round = NEW.round + 1
    AND slot = (NEW.slot + 1) / 2;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_next.status <> 'scheduled' THEN
    RAISE EXCEPTION 'The next round has already started from this result, so the winner cannot be changed';
  END IF;

  IF NEW.slot % 2 = 1 THEN
    UPDATE public.tier_draw_matches SET entrant_a_id = NEW.winner_id WHERE id = v_next.id;
  ELSE
    UPDATE public.tier_draw_matches SET entrant_b_id = NEW.winner_id WHERE id = v_next.id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_tier_draw_correction() FROM anon, authenticated, PUBLIC;

DROP TRIGGER IF EXISTS tier_draw_matches_correction ON public.tier_draw_matches;
CREATE TRIGGER tier_draw_matches_correction
AFTER UPDATE OF winner_id ON public.tier_draw_matches
FOR EACH ROW
WHEN (
  OLD.status = 'reported'
  AND OLD.winner_id IS NOT NULL
  AND NEW.winner_id IS NOT NULL
  AND NEW.winner_id IS DISTINCT FROM OLD.winner_id
)
EXECUTE FUNCTION public.guard_tier_draw_correction();

-- Legacy knockout: `advance_draw_locked` only looks at the newest round, so it never repairs
-- an older one. Repair an unplayed child here; refuse once it has started.
CREATE OR REPLACE FUNCTION public.guard_draw_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.draw_matches c
    WHERE (c.parent_a_id = NEW.id OR c.parent_b_id = NEW.id)
      AND c.status <> 'scheduled'
  ) THEN
    RAISE EXCEPTION 'The next round has already started from this result, so the winner cannot be changed';
  END IF;

  UPDATE public.draw_matches SET team_a_id = NEW.winner_id WHERE parent_a_id = NEW.id;
  UPDATE public.draw_matches SET team_b_id = NEW.winner_id WHERE parent_b_id = NEW.id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_draw_correction() FROM anon, authenticated, PUBLIC;

DROP TRIGGER IF EXISTS draw_matches_correction ON public.draw_matches;
CREATE TRIGGER draw_matches_correction
AFTER UPDATE OF winner_id ON public.draw_matches
FOR EACH ROW
WHEN (
  OLD.status = 'reported'
  AND OLD.winner_id IS NOT NULL
  AND NEW.winner_id IS NOT NULL
  AND NEW.winner_id IS DISTINCT FROM OLD.winner_id
)
EXECUTE FUNCTION public.guard_draw_correction();

-- Placement round one: round two was derived from the winner/loser sets.
CREATE OR REPLACE FUNCTION public.guard_placement_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.stage = 'round1' AND EXISTS (
    SELECT 1 FROM public.placement_matches
    WHERE category_id = NEW.category_id AND stage = 'round2'
  ) THEN
    RAISE EXCEPTION 'Round two was built from this result — regenerate round two to change the winner';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_placement_correction() FROM anon, authenticated, PUBLIC;

DROP TRIGGER IF EXISTS placement_matches_correction ON public.placement_matches;
CREATE TRIGGER placement_matches_correction
AFTER UPDATE OF winner_id ON public.placement_matches
FOR EACH ROW
WHEN (
  OLD.status = 'reported'
  AND OLD.winner_id IS NOT NULL
  AND NEW.winner_id IS NOT NULL
  AND NEW.winner_id IS DISTINCT FROM OLD.winner_id
)
EXECUTE FUNCTION public.guard_placement_correction();

-- Pools: the draws were seeded from these standings.
CREATE OR REPLACE FUNCTION public.guard_pool_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.pools p
    JOIN public.draws d ON d.category_id = p.category_id
    WHERE p.id = NEW.pool_id
  ) THEN
    RAISE EXCEPTION 'Draws were generated from these standings — regenerate the draws to change a group result';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_pool_correction() FROM anon, authenticated, PUBLIC;

DROP TRIGGER IF EXISTS pool_matches_correction ON public.pool_matches;
CREATE TRIGGER pool_matches_correction
AFTER UPDATE OF winner_id, score_a, score_b ON public.pool_matches
FOR EACH ROW
WHEN (
  OLD.status = 'reported'
  AND NEW.status = 'reported'
  AND (NEW.winner_id IS DISTINCT FROM OLD.winner_id
       OR NEW.score_a IS DISTINCT FROM OLD.score_a
       OR NEW.score_b IS DISTINCT FROM OLD.score_b)
)
EXECUTE FUNCTION public.guard_pool_correction();
