-- ============================================================================
-- The tournament window, atomic creation, and playing days inside the window
-- ============================================================================
--
-- Three decisions, one migration, because each is only coherent with the others.
--
-- 1. A tournament is created complete or not at all. `create_tournament` used to make a
--    bare `upcoming` row after the first wizard step and let `save_tournament_*` fill it
--    in, so a half-made tournament was public in Explore for as long as its host took to
--    finish. It now takes everything the tournament cannot exist without - name, window,
--    timezone, at least one event - and writes it in one transaction.
--
-- 2. The dates a tournament promises are separate from the days it plays on. The
--    *window* (`starts_on`, `ends_on`) is chosen at creation and is what the public sees.
--    *Playing days* (`tournament_days`) are chosen later, when the schedule is built, must
--    lie inside the window, and need not be consecutive. Neither is capped: the old limit
--    of seven days was a UI convenience that had been copied into two CHECK constraints
--    and two RPCs, and it is removed from all of them.
--
-- 3. `tournament_starts_at` / `tournament_ends_at` are the window, not the earliest and
--    latest playing day. The start is 00:00 of `starts_on` in the venue's timezone, which
--    is the one instant the registration deadline and the first-match gate both refer to.
--    Deriving it from `tournament_days` made it NULL for a tournament with no days yet,
--    which is now a normal state.
--
-- The window is written only by `create_tournament` and `update_tournament_window`: the
-- columns are deliberately not in the authenticated UPDATE grant.

-------------------------------------------------------------------------------
-- 1. The window columns
-------------------------------------------------------------------------------
--
-- Nullable first, backfilled, then constrained - the order every earlier backfill in
-- this repository uses, so the constraint never meets an old row it would reject.
-- A tournament that has days gets exactly their span, which is what its window already
-- was in effect. One with none (a draft that was never finished) gets the date it was
-- created on, in UTC so an unrecognised timezone cannot fail the backfill.

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS starts_on date,
  ADD COLUMN IF NOT EXISTS ends_on date;

UPDATE public.tournaments t
SET starts_on = COALESCE(
      (SELECT min(d.date) FROM public.tournament_days d WHERE d.tournament_id = t.id),
      (t.created_at AT TIME ZONE 'UTC')::date
    ),
    ends_on = COALESCE(
      (SELECT max(d.date) FROM public.tournament_days d WHERE d.tournament_id = t.id),
      (t.created_at AT TIME ZONE 'UTC')::date
    )
WHERE t.starts_on IS NULL OR t.ends_on IS NULL;

ALTER TABLE public.tournaments
  ALTER COLUMN starts_on SET NOT NULL,
  ALTER COLUMN ends_on SET NOT NULL;

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_window_order;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_window_order CHECK (starts_on <= ends_on);

COMMENT ON COLUMN public.tournaments.starts_on IS
  'First date of the tournament window, in the venue timezone. The window is what the public sees; playing days are chosen inside it when the schedule is built. Not in the authenticated UPDATE grant: written by create_tournament and update_tournament_window only.';
COMMENT ON COLUMN public.tournaments.ends_on IS
  'Last date of the tournament window. See starts_on.';

-------------------------------------------------------------------------------
-- 2. Lift the seven-day caps
-------------------------------------------------------------------------------
--
-- `day_count` is a denormalised summary the setup list reads and keeps its floor of one
-- (the writers use GREATEST(count, 1)), so a tournament with no playing days yet still
-- satisfies it. `day_number` keeps its floor and loses its ceiling.

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_day_count_check;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_day_count_check CHECK (day_count >= 1);

ALTER TABLE public.tournament_days DROP CONSTRAINT IF EXISTS tournament_days_day_number_check;
ALTER TABLE public.tournament_days
  ADD CONSTRAINT tournament_days_day_number_check CHECK (day_number >= 1);

-------------------------------------------------------------------------------
-- 3. The derived instants are the window
-------------------------------------------------------------------------------
--
-- `AT TIME ZONE venue_timezone` is mandatory for the reason the original definitions
-- gave: a bare `date` is a wall clock, and casting it in the session zone (UTC on
-- Supabase) would put every boundary five or six hours out for a US venue.
--
-- The end is the instant the window closes - 00:00 of the day after `ends_on` - so
-- "past the last day" is a plain `now() >= tournament_ends_at(...)`.

CREATE OR REPLACE FUNCTION public.tournament_starts_at(p_tournament_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (t.starts_on::timestamp) AT TIME ZONE t.venue_timezone
  FROM public.tournaments t
  WHERE t.id = p_tournament_id;
$$;

CREATE OR REPLACE FUNCTION public.tournament_ends_at(p_tournament_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ((t.ends_on + 1)::timestamp) AT TIME ZONE t.venue_timezone
  FROM public.tournaments t
  WHERE t.id = p_tournament_id;
$$;

-------------------------------------------------------------------------------
-- 4. Readiness no longer asks about days
-------------------------------------------------------------------------------
--
-- Playing days are chosen when the schedule is built, so a tournament with none is
-- complete. `days` and `day_dates` therefore leave the checklist; the window is always
-- present and ordered (NOT NULL plus a CHECK), so it needs no check of its own.
--
-- `basics` asks for a name only. It also asked for a venue, which gated *starting*; with
-- no start gate and an optional venue field in the wizard, keeping it would make a
-- tournament with no venue permanently "not ready" and therefore never open for
-- registration. Still reads only `tournaments` and `categories`, so it stays independent
-- of participation.

CREATE OR REPLACE FUNCTION public.tournament_readiness_checks(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $checks$
DECLARE
  t public.tournaments%ROWTYPE;
  checks jsonb := '[]'::jsonb;
  category_total int;
  over_capped int;
BEGIN
  SELECT * INTO t FROM public.tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  SELECT count(*) INTO category_total
  FROM public.categories WHERE tournament_id = p_tournament_id;

  -- `category_caps` compares the cap against a constant, not against an entry
  -- count, which is the other half of staying independent of participation.
  SELECT count(*) INTO over_capped
  FROM public.categories c
  WHERE c.tournament_id = p_tournament_id
    AND c.max_entries IS NOT NULL
    AND c.max_entries < 2;

  checks := checks || jsonb_build_object(
    'id', 'basics',
    'label', 'Tournament has a name',
    'ok', t.name IS NOT NULL AND length(btrim(t.name)) > 0,
    'detail', CASE
      WHEN t.name IS NULL OR length(btrim(t.name)) = 0 THEN 'Give the tournament a name.'
      ELSE NULL
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'timezone',
    'label', 'Timezone is valid',
    'ok', EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = t.venue_timezone),
    'detail', CASE
      WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = t.venue_timezone) THEN NULL
      ELSE 'That timezone is not recognised.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'categories',
    'label', 'At least one event is switched on',
    'ok', category_total >= 1,
    'detail', CASE
      WHEN category_total >= 1 THEN NULL
      ELSE 'Add at least one event.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'category_caps',
    'label', 'Entry caps leave room for a pool',
    'ok', over_capped = 0,
    'detail', CASE
      WHEN over_capped = 0 THEN NULL
      ELSE over_capped || ' event(s) have a cap below 2.'
    END
  );

  RETURN jsonb_build_object(
    'ready', NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(checks) c
      WHERE (c->>'ok')::boolean = false
        AND COALESCE((c->>'blocking')::boolean, true)
    ),
    'checks', checks
  );
END;
$checks$;

-------------------------------------------------------------------------------
-- 5. Has anything been scheduled?
-------------------------------------------------------------------------------
--
-- One predicate for "a schedule exists", used to lock the timezone and (in a later
-- migration) to stop the registration deadline being extended under a built schedule.
-- A match with a time is a promise to somebody; a void match is not.

CREATE OR REPLACE FUNCTION public.tournament_has_schedule(p_tournament_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.placement_matches m
    WHERE m.tournament_id = p_tournament_id AND m.status <> 'void' AND m.scheduled_time IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.tier_draw_matches m
    WHERE m.tournament_id = p_tournament_id AND m.status <> 'void' AND m.scheduled_time IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.pool_matches m
    WHERE m.tournament_id = p_tournament_id AND m.status <> 'void' AND m.scheduled_time IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.draw_matches m
    WHERE m.tournament_id = p_tournament_id AND m.status <> 'void' AND m.scheduled_time IS NOT NULL
  );
$$;

-------------------------------------------------------------------------------
-- 6. Guards that hold for every writer
-------------------------------------------------------------------------------
--
-- Triggers rather than RPC checks, because both columns are written by more than one
-- path: `tournament_days` is editable straight from the Schedule page (an editor's RLS
-- policy is FOR ALL), and `venue_timezone` is in the editor UPDATE grant. A rule that
-- lives only in an RPC is a rule the table update walks around.

-- A playing day must lie inside the window.
CREATE OR REPLACE FUNCTION public.tournament_days_guard_window()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start date;
  v_end date;
BEGIN
  SELECT t.starts_on, t.ends_on INTO v_start, v_end
  FROM public.tournaments t WHERE t.id = NEW.tournament_id;

  IF v_start IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  IF NEW.date < v_start OR NEW.date > v_end THEN
    RAISE EXCEPTION '% is outside the tournament window (% to %)',
      to_char(NEW.date, 'FMMon FMDD'),
      to_char(v_start, 'FMMon FMDD'),
      to_char(v_end, 'FMMon FMDD');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tournament_days_guard_window ON public.tournament_days;
CREATE TRIGGER tournament_days_guard_window
  BEFORE INSERT OR UPDATE OF tournament_id, date
  ON public.tournament_days
  FOR EACH ROW
  EXECUTE FUNCTION public.tournament_days_guard_window();

-- Every match time is read in the venue's timezone, so it cannot change under a schedule.
CREATE OR REPLACE FUNCTION public.tournaments_guard_timezone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.venue_timezone IS DISTINCT FROM OLD.venue_timezone
     AND public.tournament_has_schedule(NEW.id) THEN
    RAISE EXCEPTION
      'The timezone cannot change once matches are scheduled: every match time is read in %.',
      OLD.venue_timezone;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tournaments_guard_timezone ON public.tournaments;
CREATE TRIGGER tournaments_guard_timezone
  BEFORE UPDATE OF venue_timezone
  ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.tournaments_guard_timezone();

-------------------------------------------------------------------------------
-- 7. create_tournament: one atomic entry point
-------------------------------------------------------------------------------
--
-- Replaces the bare-row version. The payload is everything the tournament cannot exist
-- without; anything missing raises and nothing is written, because the whole function is
-- one transaction. There is deliberately no second creation path (a `create_..._draft`
-- beside it is how an ownerless or half-built row would come back).
--
-- Payload:
--   name, format, notes, venue_name, venue_address, venue_timezone,
--   organizer_name, organizer_email, organizer_phone
--   starts_on, ends_on                      required, dates in the venue timezone
--   max_categories_per_player               optional, 1..5
--   categories                              required, at least one event
--   registration_opens_at/closes_at         optional, both or neither
--
-- Readiness is re-run at the end and its blockers are named, so a refusal explains
-- itself instead of surfacing as a constraint violation.

CREATE OR REPLACE FUNCTION public.create_tournament(p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
  v_name text;
  v_format text;
  v_notes text;
  v_profile uuid;
  v_tz text;
  v_starts date;
  v_ends date;
  v_max_cats int;
  v_cats jsonb;
  item jsonb;
  idx int := 0;
  v_code text;
  v_entry text;
  v_gender text;
  blockers text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to create a tournament';
  END IF;

  SELECT p.id INTO v_profile
  FROM public.profiles p
  WHERE p.user_id = auth.uid();

  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'Your profile is not linked yet - sign in again';
  END IF;

  v_name := NULLIF(btrim(COALESCE(p_payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'A tournament needs a name';
  END IF;

  v_format := COALESCE(NULLIF(p_payload->>'format', ''), 'two_round_placement');
  IF v_format NOT IN ('round_robin', 'two_round_placement') THEN
    RAISE EXCEPTION 'Unsupported competition format';
  END IF;

  v_tz := COALESCE(NULLIF(btrim(COALESCE(p_payload->>'venue_timezone', '')), ''), 'America/Chicago');
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    RAISE EXCEPTION 'Unknown timezone: %', v_tz;
  END IF;

  IF NULLIF(btrim(COALESCE(p_payload->>'starts_on', '')), '') IS NULL THEN
    RAISE EXCEPTION 'Choose the day the tournament starts';
  END IF;
  IF NULLIF(btrim(COALESCE(p_payload->>'ends_on', '')), '') IS NULL THEN
    RAISE EXCEPTION 'Choose the day the tournament ends';
  END IF;
  v_starts := (p_payload->>'starts_on')::date;
  v_ends := (p_payload->>'ends_on')::date;
  IF v_ends < v_starts THEN
    RAISE EXCEPTION 'The tournament cannot end before it starts';
  END IF;

  v_max_cats := NULLIF(p_payload->>'max_categories_per_player', '')::int;
  IF v_max_cats IS NOT NULL AND v_max_cats NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'The category cap must be between 1 and 5';
  END IF;

  v_cats := COALESCE(p_payload->'categories', '[]'::jsonb);
  IF jsonb_typeof(v_cats) <> 'array' THEN
    RAISE EXCEPTION 'Events must be a list';
  END IF;

  v_notes := public.notes_trim(p_payload->>'notes');

  INSERT INTO public.tournaments (
    name, format, notes,
    venue_name, venue_address, venue_timezone,
    organizer_name, organizer_email, organizer_phone,
    starts_on, ends_on, day_count,
    max_categories_per_player,
    registration_opens_at, registration_closes_at,
    owner_profile_id
  )
  VALUES (
    v_name, v_format, v_notes,
    NULLIF(btrim(COALESCE(p_payload->>'venue_name', '')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'venue_address', '')), ''),
    v_tz,
    NULLIF(btrim(COALESCE(p_payload->>'organizer_name', '')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'organizer_email', '')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'organizer_phone', '')), ''),
    v_starts, v_ends, 1,
    COALESCE(v_max_cats, 2),
    NULLIF(btrim(COALESCE(p_payload->>'registration_opens_at', '')), '')::timestamptz,
    NULLIF(btrim(COALESCE(p_payload->>'registration_closes_at', '')), '')::timestamptz,
    v_profile
  )
  RETURNING id INTO new_id;

  FOR item IN SELECT * FROM jsonb_array_elements(v_cats)
  LOOP
    idx := idx + 1;
    v_code := NULLIF(btrim(COALESCE(item->>'code', '')), '');
    IF v_code IS NULL THEN
      RAISE EXCEPTION 'Event % needs a code', idx;
    END IF;

    v_entry := COALESCE(NULLIF(item->>'entry_type', ''), 'individual');
    IF v_entry NOT IN ('individual', 'pair') THEN
      RAISE EXCEPTION 'Event % has an unsupported entry type', v_code;
    END IF;

    v_gender := COALESCE(NULLIF(item->>'gender', ''), 'open');
    IF v_gender NOT IN ('men', 'women', 'mixed', 'open') THEN
      RAISE EXCEPTION 'Event % has an unsupported gender', v_code;
    END IF;

    INSERT INTO public.categories (
      tournament_id, code, name, entry_type, sort_order, active, max_entries, gender
    )
    VALUES (
      new_id,
      v_code,
      COALESCE(NULLIF(btrim(COALESCE(item->>'name', '')), ''), v_code),
      v_entry,
      COALESCE((item->>'sort_order')::int, idx),
      COALESCE((item->>'active')::boolean, true),
      NULLIF(item->>'max_entries', '')::int,
      v_gender
    );
  END LOOP;

  -- Both after the writes, so they read what was just inserted.
  PERFORM public.assert_registration_window(new_id);

  IF NOT public.tournament_is_ready(new_id) THEN
    SELECT string_agg(c->>'label', '; ') INTO blockers
    FROM jsonb_array_elements(public.tournament_readiness_checks(new_id)->'checks') c
    WHERE (c->>'ok')::boolean = false
      AND COALESCE((c->>'blocking')::boolean, true);
    RAISE EXCEPTION 'The tournament is not complete: %', blockers;
  END IF;

  -- Same transaction, so the creator cannot land on somebody else's tournament
  -- between the two statements.
  UPDATE public.profiles
  SET current_tournament_id = new_id
  WHERE user_id = auth.uid();

  RETURN new_id;
END;
$$;

COMMENT ON FUNCTION public.create_tournament(jsonb) IS
  'The only way a tournament comes into being: name, window, timezone and at least one event, written in one transaction. No draft row exists. Playing days are added later, inside the window.';

-------------------------------------------------------------------------------
-- 8. update_tournament_window
-------------------------------------------------------------------------------
--
-- What may move, and when:
--   * the last date may move later at any time before completion - it only adds room;
--   * the first date is locked once the tournament is in progress, because the first-match
--     gate and the registration deadline have both already been measured from it;
--   * either date may not move so as to leave a playing day outside the window, and the
--     first date may not move past the registration deadline.
--
-- Serialised with the day writers on the same per-tournament lock, so a day cannot be
-- added at the instant the window shrinks past it.

CREATE OR REPLACE FUNCTION public.update_tournament_window(
  p_tournament_id uuid,
  p_starts_on date,
  p_ends_on date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.tournaments%ROWTYPE;
  v_stray record;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

  IF p_starts_on IS NULL OR p_ends_on IS NULL THEN
    RAISE EXCEPTION 'Choose both dates';
  END IF;
  IF p_ends_on < p_starts_on THEN
    RAISE EXCEPTION 'The tournament cannot end before it starts';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament-days:' || p_tournament_id::text));

  SELECT * INTO t FROM public.tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  IF t.status <> 'upcoming' AND p_starts_on <> t.starts_on THEN
    RAISE EXCEPTION
      'The tournament has started, so its first day (%) cannot move. The last day can still be extended.',
      to_char(t.starts_on, 'FMMon FMDD');
  END IF;

  SELECT d.day_number, d.date INTO v_stray
  FROM public.tournament_days d
  WHERE d.tournament_id = p_tournament_id
    AND (d.date < p_starts_on OR d.date > p_ends_on)
  ORDER BY d.day_number
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Day % (%) would fall outside the window. Remove it or move it first.',
      v_stray.day_number, to_char(v_stray.date, 'FMMon FMDD');
  END IF;

  UPDATE public.tournaments
  SET starts_on = p_starts_on, ends_on = p_ends_on
  WHERE id = p_tournament_id;

  -- The first date moving earlier can pass the registration deadline.
  PERFORM public.assert_registration_window(p_tournament_id);
END;
$$;

COMMENT ON FUNCTION public.update_tournament_window(uuid, date, date) IS
  'Moves the tournament window. The last date may move later until completion; the first date is locked once in progress. Refused if a playing day would fall outside, or if the first date would pass the registration deadline.';

-------------------------------------------------------------------------------
-- 9. Playing-day writers: no cap, no last-day floor, window enforced by the trigger
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_tournament_day(
  p_tournament_id uuid,
  p_date date,
  p_start_time time without time zone DEFAULT '09:00:00'::time without time zone,
  p_end_time time without time zone DEFAULT '18:30:00'::time without time zone
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_exists boolean;
  v_target int;
  v_new_id uuid;
  v_row record;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

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

  -- The window check is the tournament_days_guard_window trigger, so the table and this
  -- function cannot disagree about it.
  INSERT INTO public.tournament_days
    (tournament_id, day_number, date, start_time, end_time)
  VALUES
    (p_tournament_id, v_target, p_date, COALESCE(p_start_time, '09:00'::time), COALESCE(p_end_time, '18:30'::time))
  RETURNING id INTO v_new_id;

  UPDATE public.tournaments
  SET day_count = GREATEST((SELECT count(*) FROM public.tournament_days WHERE tournament_id = p_tournament_id), 1)
  WHERE id = p_tournament_id;

  RETURN v_new_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.remove_tournament_day(p_tournament_id uuid, p_day_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_day public.tournament_days%ROWTYPE;
  v_tz text;
  v_next_start timestamptz;
  v_start timestamptz;
  v_matches int;
  v_row record;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

  PERFORM pg_advisory_xact_lock(hashtext('tournament-days:' || p_tournament_id::text));

  SELECT * INTO v_day
  FROM public.tournament_days
  WHERE id = p_day_id AND tournament_id = p_tournament_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown day';
  END IF;

  -- A tournament may have no playing days: they are chosen when the schedule is built.
  -- What cannot happen is removing a day that something is scheduled on.

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
  SET day_count = GREATEST((SELECT count(*) FROM public.tournament_days WHERE tournament_id = p_tournament_id), 1)
  WHERE id = p_tournament_id;
END;
$function$;

-- Wholesale replacement of the days is only safe while nothing is scheduled on them: it
-- deletes every row and re-creates them, and a match carries an absolute time and no
-- foreign key to its day, so it would not fail - it would silently re-attribute the matches.
-- The 7-day ceiling is gone with the others.
CREATE OR REPLACE FUNCTION public.save_tournament_days(p_tournament_id uuid, p_days jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  item jsonb;
  idx int := 0;
  new_day_id uuid;
  max_court int := 0;
  c jsonb;
  br jsonb;
  v_start time;
  v_end time;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_configurable(p_tournament_id);

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  IF public.tournament_has_schedule(p_tournament_id) THEN
    RAISE EXCEPTION
      'Matches are already scheduled, so the days cannot be replaced. Add or remove a day instead.';
  END IF;

  p_days := COALESCE(p_days, '[]'::jsonb);
  IF jsonb_typeof(p_days) <> 'array' THEN
    RAISE EXCEPTION 'Days must be a list';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament-days:' || p_tournament_id::text));

  SELECT COALESCE(max((day_court.value)::int), 0) INTO max_court
  FROM jsonb_array_elements(p_days) d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d->'courts', '[]'::jsonb)) AS day_court;
  IF max_court > 64 THEN
    RAISE EXCEPTION 'A tournament can have at most 64 courts';
  END IF;

  -- Breaks and day-court rows cascade from tournament_days.
  DELETE FROM public.tournament_days WHERE tournament_id = p_tournament_id;
  DELETE FROM public.courts WHERE tournament_id = p_tournament_id;

  FOR i IN 1 .. max_court LOOP
    INSERT INTO public.courts (tournament_id, number) VALUES (p_tournament_id, i);
  END LOOP;

  FOR item IN SELECT * FROM jsonb_array_elements(p_days)
  LOOP
    idx := idx + 1;

    IF NULLIF(item->>'date', '') IS NULL THEN
      RAISE EXCEPTION 'Day % needs a date', idx;
    END IF;

    v_start := COALESCE(NULLIF(item->>'start_time', '')::time, '09:00');
    v_end := COALESCE(NULLIF(item->>'end_time', '')::time, '18:30');
    IF v_end <= v_start THEN
      RAISE EXCEPTION 'Day % must end after it starts', idx;
    END IF;

    INSERT INTO public.tournament_days (tournament_id, day_number, date, start_time, end_time)
    VALUES (p_tournament_id, idx, (item->>'date')::date, v_start, v_end)
    RETURNING id INTO new_day_id;

    FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(item->'courts', '[]'::jsonb))
    LOOP
      INSERT INTO public.tournament_day_courts (tournament_id, day_id, court_id)
      SELECT p_tournament_id, new_day_id, ct.id
      FROM public.courts ct
      WHERE ct.tournament_id = p_tournament_id
        AND ct.number = (c)::int
      ON CONFLICT (day_id, court_id) DO NOTHING;
    END LOOP;

    FOR br IN SELECT * FROM jsonb_array_elements(COALESCE(item->'breaks', '[]'::jsonb))
    LOOP
      IF NULLIF(br->>'start_time', '') IS NULL OR NULLIF(br->>'end_time', '') IS NULL THEN
        RAISE EXCEPTION 'A break on day % needs a start and an end', idx;
      END IF;
      IF (br->>'end_time')::time <= (br->>'start_time')::time THEN
        RAISE EXCEPTION 'A break on day % must end after it starts', idx;
      END IF;
      INSERT INTO public.tournament_day_breaks (
        tournament_id, day_id, label, start_time, end_time
      )
      VALUES (
        p_tournament_id, new_day_id,
        NULLIF(btrim(COALESCE(br->>'label', '')), ''),
        (br->>'start_time')::time,
        (br->>'end_time')::time
      );
    END LOOP;
  END LOOP;

  -- day_count has a floor of 1, so an emptied tournament keeps a placeholder value.
  UPDATE public.tournaments
  SET day_count = GREATEST(idx, 1),
      court_count = GREATEST(max_court, 1)
  WHERE id = p_tournament_id;

  PERFORM public.assert_registration_window(p_tournament_id);
END;
$function$;

-------------------------------------------------------------------------------
-- 10. Privileges
-------------------------------------------------------------------------------
--
-- CREATE OR REPLACE FUNCTION restores the implicit EXECUTE grant to PUBLIC for a
-- function that is re-created, so every one of these repeats the revoke/grant pair.
-- Helpers and trigger functions are service_role only; the client surface is
-- authenticated only.

DO $privileges$
DECLARE
  f text;
  internals text[] := array[
    'tournament_starts_at(uuid)',
    'tournament_ends_at(uuid)',
    'tournament_readiness_checks(uuid)',
    'tournament_has_schedule(uuid)',
    'tournament_days_guard_window()',
    'tournaments_guard_timezone()'
  ];
  client text[] := array[
    'create_tournament(jsonb)',
    'update_tournament_window(uuid, date, date)',
    'add_tournament_day(uuid, date, time without time zone, time without time zone)',
    'remove_tournament_day(uuid, uuid)',
    'save_tournament_days(uuid, jsonb)'
  ];
BEGIN
  FOREACH f IN ARRAY internals LOOP
    EXECUTE format('revoke all on function public.%s from anon, authenticated, public', f);
    EXECUTE format('grant execute on function public.%s to service_role', f);
  END LOOP;
  FOREACH f IN ARRAY client LOOP
    EXECUTE format('revoke all on function public.%s from public, anon', f);
    EXECUTE format('grant execute on function public.%s to authenticated', f);
  END LOOP;
END;
$privileges$;

-------------------------------------------------------------------------------
-- 11. Verify
-------------------------------------------------------------------------------

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tournaments'
      AND column_name IN ('starts_on', 'ends_on') AND is_nullable = 'NO'
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'M1: tournaments.starts_on / ends_on must exist and be NOT NULL';
  END IF;

  IF EXISTS (SELECT 1 FROM public.tournaments WHERE starts_on > ends_on) THEN
    RAISE EXCEPTION 'M1: a tournament has its window the wrong way round';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.tournament_days d
    JOIN public.tournaments t ON t.id = d.tournament_id
    WHERE d.date < t.starts_on OR d.date > t.ends_on
  ) THEN
    RAISE EXCEPTION 'M1: a playing day lies outside its tournament window';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tournament_days_guard_window' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M1: the window guard on tournament_days was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'tournaments_guard_timezone' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M1: the timezone guard on tournaments was not created';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname IN ('tournaments_day_count_check', 'tournament_days_day_number_check')
      AND pg_get_constraintdef(oid) LIKE '%<= 7%'
  ) THEN
    RAISE EXCEPTION 'M1: a seven-day ceiling is still in force';
  END IF;

  IF has_function_privilege('anon', 'public.create_tournament(jsonb)', 'execute') THEN
    RAISE EXCEPTION 'M1: create_tournament must not be executable by anon';
  END IF;
  IF has_function_privilege('authenticated', 'public.tournament_has_schedule(uuid)', 'execute') THEN
    RAISE EXCEPTION 'M1: tournament_has_schedule is an internal helper';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
