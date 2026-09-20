-- ============================================================================
-- Add and remove playing days after activation
-- ============================================================================
--
-- The day count used to be fixed the moment a draft was activated.
-- `save_tournament_days` refuses anything that is not a draft, and the Schedule
-- page only ever updated the fields of a day that already existed, so going from
-- two days to three meant rebuilding the tournament. That is the wrong trade for
-- the case that actually comes up: a tournament runs long, and the host needs one
-- more day on the end.
--
-- Two things had to be true first.
--
-- 1. Day numbers have to follow their dates. `sliceRowsByDay` attributes a match
--    to "the last day that had already opened", which it finds by scanning the
--    day windows in `day_number` order and assuming their start times ascend
--    (day-plan.ts). That held while setup was the only writer, because
--    `buildDayRange` emits one row per date in order. It stopped holding the
--    moment a host could type a date by hand on the Schedule page: date the days
--    out of order and the scan files every match under a later day. Nothing
--    enforced it, so `tournament_days_guard_order` does, for every writer.
--
-- 2. A day is only removable while nothing is scheduled on it. Matches carry an
--    absolute `scheduled_time` and no day foreign key, so deleting a day that has
--    matches would not fail — it would silently re-attribute them, and the
--    tournament's official close would move underneath them. This mirrors
--    `set_tournament_courts`, which refuses to remove a court that holds a match
--    rather than letting `ON DELETE SET NULL` unassign it.

-------------------------------------------------------------------------------
-- Day numbers must follow dates
-------------------------------------------------------------------------------
--
-- A trigger rather than a constraint because the rule compares a row with its
-- siblings, which no CHECK can do, and rather than putting the validation in the
-- RPCs because the date is also editable through a plain table update from the
-- Schedule page (`updateTournamentDay`). One guard covers every writer.
--
-- Two comparisons, not one. Same-day collisions are caught by date, and ordering
-- is caught by looking for a neighbour on the wrong side: a day with a lower
-- number but a later date, or a higher number but an earlier date.
--
-- Only dates are compared. Start and end times are not this trigger's business:
-- `save_tournament_days` already rejects a day that ends before it starts, and the
-- client refuses the edit before sending it.

CREATE OR REPLACE FUNCTION public.tournament_days_guard_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tournament_days d
    WHERE d.tournament_id = NEW.tournament_id
      AND d.id <> NEW.id
      AND d.date = NEW.date
  ) THEN
    RAISE EXCEPTION 'Another day already uses %', NEW.date;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_days d
    WHERE d.tournament_id = NEW.tournament_id
      AND d.id <> NEW.id
      AND (
        (d.day_number < NEW.day_number AND d.date > NEW.date)
        OR (d.day_number > NEW.day_number AND d.date < NEW.date)
      )
  ) THEN
    RAISE EXCEPTION
      'Day % has to fall in date order: its date is on the wrong side of another day.',
      NEW.day_number;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tournament_days_guard_order ON public.tournament_days;
CREATE TRIGGER tournament_days_guard_order
  BEFORE INSERT OR UPDATE OF tournament_id, day_number, date
  ON public.tournament_days
  FOR EACH ROW
  EXECUTE FUNCTION public.tournament_days_guard_order();

-------------------------------------------------------------------------------
-- Add a day
-------------------------------------------------------------------------------
--
-- The date decides the position, not the caller: a day added between two existing
-- ones is numbered between them, so `day_number` stays the chronological order the
-- rest of the app reads. That is why the insert takes a date rather than a number.
--
-- The shift has two ordering requirements that are easy to get wrong.
--
--   * Existing rows are moved in *descending* number order, so each row's target
--     number has just been vacated. This has to be a loop: one multi-row UPDATE
--     gives no ordering guarantee, and stepping a row onto a number its neighbour
--     still holds trips the unique index on (tournament_id, day_number).
--   * The shift happens before the insert, so the new row's slot is free by the
--     time it arrives.
--
-- A day with no `tournament_day_courts` rows means "every court" to `courtsForDay`,
-- which is the right default for a day that has just been added: it can use the
-- whole venue until the host narrows it, exactly like a freshly activated
-- tournament. No rows are written here on purpose.
--
-- `day_count` is a denormalised summary the setup list reads, so it is kept in step.

CREATE OR REPLACE FUNCTION public.add_tournament_day(
  p_tournament_id uuid,
  p_date date,
  p_start_time time DEFAULT '09:00',
  p_end_time time DEFAULT '18:30'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exists boolean;
  v_total int;
  v_target int;
  v_new_id uuid;
  v_row record;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT true INTO v_exists FROM public.tournaments WHERE id = p_tournament_id;
  IF v_exists IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  IF p_date IS NULL THEN
    RAISE EXCEPTION 'Choose a date for the new day';
  END IF;

  -- Serialise with every other day mutation for this tournament. Without it two
  -- concurrent adds can compute the same target number and race on the unique
  -- (tournament_id, day_number) index.
  PERFORM pg_advisory_xact_lock(hashtext('tournament-days:' || p_tournament_id::text));

  SELECT count(*) INTO v_total
  FROM public.tournament_days
  WHERE tournament_id = p_tournament_id;

  IF v_total >= 7 THEN
    RAISE EXCEPTION 'A tournament can have at most 7 days';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_days
    WHERE tournament_id = p_tournament_id AND date = p_date
  ) THEN
    RAISE EXCEPTION 'Another day already uses %', p_date;
  END IF;

  -- Its rank among the existing dates: 1 + however many fall before it.
  SELECT count(*) + 1 INTO v_target
  FROM public.tournament_days
  WHERE tournament_id = p_tournament_id AND date < p_date;

  -- Descending, so the slot at v_target is free by the time the row below it moves.
  FOR v_row IN
    SELECT d.id, d.day_number
    FROM public.tournament_days d
    WHERE d.tournament_id = p_tournament_id
      AND d.day_number >= v_target
    ORDER BY d.day_number DESC
  LOOP
    UPDATE public.tournament_days
    SET day_number = v_row.day_number + 1
    WHERE id = v_row.id;
  END LOOP;

  INSERT INTO public.tournament_days
    (tournament_id, day_number, date, start_time, end_time)
  VALUES
    (p_tournament_id, v_target, p_date, COALESCE(p_start_time, '09:00'::time), COALESCE(p_end_time, '18:30'::time))
  RETURNING id INTO v_new_id;

  UPDATE public.tournaments
  SET day_count = (SELECT count(*) FROM public.tournament_days WHERE tournament_id = p_tournament_id)
  WHERE id = p_tournament_id;

  RETURN v_new_id;
END;
$$;

-------------------------------------------------------------------------------
-- Remove a day
-------------------------------------------------------------------------------
--
-- Refuses two things.
--
--   * The last remaining day, because a tournament with no days has no capacity
--     and no official close to measure against.
--   * A day with anything scheduled on it. The day's "territory" is the half-open
--     span from its own opening to the next day's opening, which is the same rule
--     `sliceRowsByDay` attributes by; for the final day it runs to infinity,
--     because the last day is the one allowed to overrun. Checking the window
--     instead would miss a match placed after its own day's closing time, which is
--     a legitimate row.
--
-- The order of the two writes is the mirror of `add_tournament_day`: the row goes
-- first, then the rows after it are pulled down in *ascending* order, so each one
-- moves into a slot the delete or the previous move has already freed. Again a
-- loop, for the same reason: a single multi-row UPDATE has no ordering guarantee.
--
-- The window is read in the venue's timezone. `date + start_time` is a wall clock,
-- and comparing a wall clock to a `timestamptz` column would silently cast it using
-- the session's timezone — UTC on Supabase — which is five or six hours off for a
-- US venue and would put every match on the wrong side of a boundary. `AT TIME
-- ZONE venue_timezone` converts the wall clock the way the venue means it. No other
-- SQL in this repo compares a day window to `scheduled_time`, so this is the first
-- place the conversion has been needed.

CREATE OR REPLACE FUNCTION public.remove_tournament_day(
  p_tournament_id uuid,
  p_day_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day public.tournament_days%ROWTYPE;
  v_total int;
  v_tz text;
  v_next_start timestamptz;
  v_start timestamptz;
  v_matches int;
  v_row record;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament-days:' || p_tournament_id::text));

  SELECT * INTO v_day
  FROM public.tournament_days
  WHERE id = p_day_id AND tournament_id = p_tournament_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown day';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.tournament_days
  WHERE tournament_id = p_tournament_id;

  IF v_total <= 1 THEN
    RAISE EXCEPTION 'A tournament needs at least one day';
  END IF;

  SELECT venue_timezone INTO v_tz
  FROM public.tournaments WHERE id = p_tournament_id;

  v_start := ((v_day.date + v_day.start_time) AT TIME ZONE v_tz);

  SELECT ((d.date + d.start_time) AT TIME ZONE v_tz) INTO v_next_start
  FROM public.tournament_days d
  WHERE d.tournament_id = p_tournament_id
    AND d.day_number > v_day.day_number
  ORDER BY d.day_number
  LIMIT 1;

  SELECT count(*) INTO v_matches
  FROM (
    SELECT COALESCE(m.scheduled_time, m.started_at) AS at
    FROM public.placement_matches m
    WHERE m.tournament_id = p_tournament_id AND m.status <> 'void'
    UNION ALL
    SELECT COALESCE(m.scheduled_time, m.started_at)
    FROM public.tier_draw_matches m
    WHERE m.tournament_id = p_tournament_id AND m.status <> 'void'
    UNION ALL
    SELECT COALESCE(m.scheduled_time, m.started_at)
    FROM public.pool_matches m
    WHERE m.tournament_id = p_tournament_id AND m.status <> 'void'
    UNION ALL
    SELECT COALESCE(m.scheduled_time, m.started_at)
    FROM public.draw_matches m
    WHERE m.tournament_id = p_tournament_id AND m.status <> 'void'
  ) scheduled
  WHERE scheduled.at IS NOT NULL
    AND scheduled.at >= v_start
    AND (v_next_start IS NULL OR scheduled.at < v_next_start);

  IF v_matches > 0 THEN
    RAISE EXCEPTION
      'Day % still has % match(es) on it. Clear or move them before removing the day.',
      v_day.day_number, v_matches;
  END IF;

  -- Day courts and breaks are ON DELETE CASCADE, so they go with it.
  DELETE FROM public.tournament_days WHERE id = p_day_id;

  -- Ascending, so each row steps into the slot the delete just freed.
  FOR v_row IN
    SELECT d.id, d.day_number
    FROM public.tournament_days d
    WHERE d.tournament_id = p_tournament_id
      AND d.day_number > v_day.day_number
    ORDER BY d.day_number
  LOOP
    UPDATE public.tournament_days
    SET day_number = v_row.day_number - 1
    WHERE id = v_row.id;
  END LOOP;

  UPDATE public.tournaments
  SET day_count = (SELECT count(*) FROM public.tournament_days WHERE tournament_id = p_tournament_id)
  WHERE id = p_tournament_id;
END;
$$;

-- CREATE OR REPLACE restores the implicit EXECUTE grant to PUBLIC, which the
-- auth-hardening migration removed. Re-close it or these would reopen to anon.
REVOKE ALL ON FUNCTION public.add_tournament_day(uuid, date, time, time) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_tournament_day(uuid, date, time, time) TO authenticated;

REVOKE ALL ON FUNCTION public.remove_tournament_day(uuid, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_tournament_day(uuid, uuid) TO authenticated;
