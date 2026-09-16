-- Tournament creation flow (admin-only).
--
-- Turns a tournament into a drafted, reviewable configuration:
--   * Draft -> In Progress lifecycle, with only In Progress tournaments active.
--   * Identity / venue / organizer / timezone fields.
--   * A tournament-wide maximum number of categories per player.
--   * Per-stage scoring rules, kept separate from scheduling duration.
--   * Per-day court availability and optional break windows.
--
-- The engine that generates placement matches and A/B/C/D draws is NOT part of
-- this migration; scheduling is intentionally disabled while it is built. The
-- legacy round-robin surface (pools, pool_entries, standings) is left in place
-- and untouched.
--
-- Non-destructive: pre-existing tournaments are backfilled to the round-robin
-- format and In Progress status, so a live database keeps working.

-------------------------------------------------------------------------------
-- 1. tournaments: lifecycle, identity, organizer and match rules
-------------------------------------------------------------------------------

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'two_round_placement',
  ADD COLUMN IF NOT EXISTS venue_name text,
  ADD COLUMN IF NOT EXISTS venue_address text,
  ADD COLUMN IF NOT EXISTS organizer_name text,
  ADD COLUMN IF NOT EXISTS organizer_email text,
  ADD COLUMN IF NOT EXISTS organizer_phone text,
  ADD COLUMN IF NOT EXISTS max_categories_per_player int NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS placement_games_to int NOT NULL DEFAULT 21,
  ADD COLUMN IF NOT EXISTS placement_win_by int NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS placement_best_of int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS knockout_games_to int NOT NULL DEFAULT 21,
  ADD COLUMN IF NOT EXISTS knockout_win_by int NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS knockout_best_of int NOT NULL DEFAULT 3;

-- Every tournament that existed before this migration was created under the old
-- instant-activation behaviour, so it is In Progress and keeps the old format.
UPDATE public.tournaments SET status = 'in_progress' WHERE status = 'draft';
UPDATE public.tournaments SET format = 'round_robin' WHERE format = 'two_round_placement';

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_status_check;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_status_check
  CHECK (status IN ('draft', 'in_progress', 'completed'));

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_format_check;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_format_check
  CHECK (format IN ('round_robin', 'two_round_placement'));

-- Only an In Progress tournament may be the active scope, so a half-finished
-- draft can never drive the desk, registration or scheduling.
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_active_status_check;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_active_status_check
  CHECK (NOT is_active OR status = 'in_progress');

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_max_categories_check;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_max_categories_check
  CHECK (max_categories_per_player BETWEEN 1 AND 5);

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_scoring_check;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_scoring_check CHECK (
    placement_games_to BETWEEN 1 AND 99
    AND knockout_games_to BETWEEN 1 AND 99
    AND placement_win_by BETWEEN 1 AND 20
    AND knockout_win_by BETWEEN 1 AND 20
    AND placement_best_of IN (1, 3, 5, 7, 9)
    AND knockout_best_of IN (1, 3, 5, 7, 9)
  );

CREATE INDEX IF NOT EXISTS tournaments_status_idx ON public.tournaments (status);

-------------------------------------------------------------------------------
-- 2. categories: event metadata (gender) so events are data-driven, not code
-------------------------------------------------------------------------------

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS gender text NOT NULL DEFAULT 'open';

UPDATE public.categories SET gender = 'men'   WHERE code IN ('MS', 'MD') AND gender = 'open';
UPDATE public.categories SET gender = 'women' WHERE code IN ('WS', 'WD') AND gender = 'open';
UPDATE public.categories SET gender = 'mixed' WHERE code = 'XD'         AND gender = 'open';

ALTER TABLE public.categories DROP CONSTRAINT IF EXISTS categories_gender_check;
ALTER TABLE public.categories
  ADD CONSTRAINT categories_gender_check
  CHECK (gender IN ('men', 'women', 'mixed', 'open'));

-- A mixed event only makes sense as a pair, which keeps entry validation sane.
ALTER TABLE public.categories DROP CONSTRAINT IF EXISTS categories_mixed_pair_check;
ALTER TABLE public.categories
  ADD CONSTRAINT categories_mixed_pair_check
  CHECK (gender <> 'mixed' OR entry_type = 'pair');

-------------------------------------------------------------------------------
-- 3. Per-day court availability and breaks
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tournament_day_courts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  day_id uuid NOT NULL REFERENCES public.tournament_days(id) ON DELETE CASCADE,
  court_id uuid NOT NULL REFERENCES public.courts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day_id, court_id)
);
CREATE INDEX IF NOT EXISTS tournament_day_courts_day_idx
  ON public.tournament_day_courts (day_id);
CREATE INDEX IF NOT EXISTS tournament_day_courts_tournament_idx
  ON public.tournament_day_courts (tournament_id);

GRANT SELECT ON public.tournament_day_courts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tournament_day_courts TO authenticated;
GRANT ALL ON public.tournament_day_courts TO service_role;
ALTER TABLE public.tournament_day_courts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tournament_day_courts public read" ON public.tournament_day_courts;
CREATE POLICY "tournament_day_courts public read" ON public.tournament_day_courts
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "tournament_day_courts staff write" ON public.tournament_day_courts;
CREATE POLICY "tournament_day_courts staff write" ON public.tournament_day_courts
  FOR ALL TO authenticated
  USING (public.has_staff_role(ARRAY['admin','scheduler']))
  WITH CHECK (public.has_staff_role(ARRAY['admin','scheduler']));

CREATE TABLE IF NOT EXISTS public.tournament_day_breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  day_id uuid NOT NULL REFERENCES public.tournament_days(id) ON DELETE CASCADE,
  label text,
  start_time time NOT NULL,
  end_time time NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS tournament_day_breaks_day_idx
  ON public.tournament_day_breaks (day_id);
CREATE INDEX IF NOT EXISTS tournament_day_breaks_tournament_idx
  ON public.tournament_day_breaks (tournament_id);

GRANT SELECT ON public.tournament_day_breaks TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tournament_day_breaks TO authenticated;
GRANT ALL ON public.tournament_day_breaks TO service_role;
ALTER TABLE public.tournament_day_breaks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tournament_day_breaks public read" ON public.tournament_day_breaks;
CREATE POLICY "tournament_day_breaks public read" ON public.tournament_day_breaks
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "tournament_day_breaks staff write" ON public.tournament_day_breaks;
CREATE POLICY "tournament_day_breaks staff write" ON public.tournament_day_breaks
  FOR ALL TO authenticated
  USING (public.has_staff_role(ARRAY['admin','scheduler']))
  WITH CHECK (public.has_staff_role(ARRAY['admin','scheduler']));

-------------------------------------------------------------------------------
-- 4. enforce_team_shape: gender becomes data-driven
--    The old version special-cased MS/MD/WD/XD by code, so a WS category
--    silently accepted any gender. It now reads categories.gender.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_team_shape()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  cat public.categories%ROWTYPE;
  g1 text;
  g2 text;
BEGIN
  SELECT * INTO cat FROM public.categories WHERE id = NEW.category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  -- The category is the source of truth for scope.
  NEW.tournament_id := cat.tournament_id;

  IF NEW.player_1_id = NEW.player_2_id THEN
    RAISE EXCEPTION 'A pair needs two different players';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.player_1_id::text));
  IF NEW.player_2_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(NEW.player_2_id::text));
  END IF;

  SELECT gender INTO g1 FROM public.players WHERE id = NEW.player_1_id;
  IF NEW.player_2_id IS NOT NULL THEN
    SELECT gender INTO g2 FROM public.players WHERE id = NEW.player_2_id;
  END IF;

  IF cat.entry_type = 'individual' THEN
    IF NEW.player_2_id IS NOT NULL THEN
      RAISE EXCEPTION 'Singles entries must have exactly one player';
    END IF;
  ELSE
    IF NEW.player_2_id IS NULL THEN
      RAISE EXCEPTION 'Doubles entries need two players';
    END IF;
  END IF;

  -- gender describes who may enter. A player with no recorded gender is not
  -- rejected, matching the previous behaviour, except for mixed events where
  -- both halves must be known to prove the pair is genuinely mixed.
  IF cat.gender = 'men' THEN
    IF g1 IS NOT NULL AND g1 <> 'M' THEN
      RAISE EXCEPTION 'This event is a men''s event';
    END IF;
    IF NEW.player_2_id IS NOT NULL AND g2 IS NOT NULL AND g2 <> 'M' THEN
      RAISE EXCEPTION 'This event is a men''s event';
    END IF;
  ELSIF cat.gender = 'women' THEN
    IF g1 IS NOT NULL AND g1 <> 'F' THEN
      RAISE EXCEPTION 'This event is a women''s event';
    END IF;
    IF NEW.player_2_id IS NOT NULL AND g2 IS NOT NULL AND g2 <> 'F' THEN
      RAISE EXCEPTION 'This event is a women''s event';
    END IF;
  ELSIF cat.gender = 'mixed' THEN
    IF g1 IS NULL OR g2 IS NULL THEN
      RAISE EXCEPTION 'A mixed event needs both players'' genders recorded';
    END IF;
    IF g1 = g2 THEN
      RAISE EXCEPTION 'Mixed doubles requires one male and one female player';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-------------------------------------------------------------------------------
-- 5. enforce_two_category_cap: the cap is tournament configuration
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_two_category_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  p uuid;
  cnt int;
  cap int;
BEGIN
  SELECT max_categories_per_player INTO cap
  FROM public.tournaments WHERE id = NEW.tournament_id;
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;

  FOREACH p IN ARRAY ARRAY[NEW.player_1_id, NEW.player_2_id] LOOP
    IF p IS NULL THEN CONTINUE; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('catcap:' || p::text));
    SELECT count(DISTINCT category_id) INTO cnt
    FROM public.teams
    WHERE withdrawn = false
      AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND (player_1_id = p OR player_2_id = p)
      AND category_id <> NEW.category_id
      AND tournament_id = NEW.tournament_id;
    IF cnt >= cap THEN
      RAISE EXCEPTION 'Player % is already registered in % categories', p, cap;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-------------------------------------------------------------------------------
-- 6. report_draw_result: scoring comes from the tournament, not from constants
--    Knockout scoring used to be pinned to "best of three" and "race to 21,
--    win by 2". It now reads the tournament's configured rule.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.report_draw_result(p_match_id uuid, p_games jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  wins_a int := 0;
  wins_b int := 0;
  game jsonb;
  sa int;
  sb int;
  winner uuid;
  draw uuid;
  v_tournament uuid;
  games_to int;
  win_by int;
  best_of int;
  needed int;
  played int;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','scorer']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT dm.tournament_id INTO v_tournament
  FROM public.draw_matches dm WHERE dm.id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT knockout_games_to, knockout_win_by, knockout_best_of
  INTO games_to, win_by, best_of
  FROM public.tournaments WHERE id = v_tournament;

  needed := (best_of + 1) / 2;
  played := jsonb_array_length(p_games);

  IF played < 1 THEN
    RAISE EXCEPTION 'Enter at least one game';
  END IF;
  IF played > best_of THEN
    RAISE EXCEPTION 'This match is best of %', best_of;
  END IF;
  IF played < needed THEN
    RAISE EXCEPTION 'This match is best of % — a side must win % games', best_of, needed;
  END IF;

  FOR game IN SELECT * FROM jsonb_array_elements(p_games)
  LOOP
    sa := (game->>'a')::int;
    sb := (game->>'b')::int;
    IF sa < 0 OR sb < 0 OR sa = sb THEN
      RAISE EXCEPTION 'Each game needs a valid winning score';
    END IF;
    IF NOT (
      (sa >= games_to AND sa - sb >= win_by)
      OR (sb >= games_to AND sb - sa >= win_by)
    ) THEN
      IF win_by = 1 THEN
        RAISE EXCEPTION 'Games are to %', games_to;
      ELSE
        RAISE EXCEPTION 'Games are to %, win by %', games_to, win_by;
      END IF;
    END IF;
    IF sa > sb THEN wins_a := wins_a + 1; ELSE wins_b := wins_b + 1; END IF;
    IF (wins_a >= needed OR wins_b >= needed) AND game <> p_games -> -1 THEN
      RAISE EXCEPTION 'Do not enter games after the match is decided';
    END IF;
  END LOOP;

  IF wins_a < needed AND wins_b < needed THEN
    RAISE EXCEPTION 'A side must win % games', needed;
  END IF;

  SELECT CASE WHEN wins_a >= needed THEN team_a_id ELSE team_b_id END, draw_id
  INTO winner, draw
  FROM public.draw_matches WHERE id = p_match_id;
  IF winner IS NULL THEN
    RAISE EXCEPTION 'That side has no team assigned yet';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('draw:' || draw::text));
  UPDATE public.draw_matches
  SET games = p_games,
      winner_id = winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;
  PERFORM public.advance_draw_locked(draw);
  PERFORM public.shift_live_schedule_after_match('draw_matches', p_match_id);
END;
$$;

-------------------------------------------------------------------------------
-- 7. create_tournament: keep it consistent with the new lifecycle
--    It is no longer used by the app (the draft wizard replaces it), but it must
--    still satisfy the new "only In Progress may be active" invariant.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_tournament(
  p_name text,
  p_day_count int,
  p_court_count int,
  p_start_date date,
  p_categories jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
  i int;
  item jsonb;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'A tournament needs a name';
  END IF;
  IF p_day_count IS NULL OR p_day_count < 1 OR p_day_count > 7 THEN
    RAISE EXCEPTION 'Choose between 1 and 7 days';
  END IF;
  IF p_court_count IS NULL OR p_court_count < 1 OR p_court_count > 64 THEN
    RAISE EXCEPTION 'Choose between 1 and 64 courts';
  END IF;
  IF p_start_date IS NULL THEN
    RAISE EXCEPTION 'Choose a start date';
  END IF;
  IF jsonb_array_length(COALESCE(p_categories, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Select at least one category';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournaments'));

  -- The partial unique index allows only one active tournament.
  UPDATE public.tournaments SET is_active = false WHERE is_active;

  INSERT INTO public.tournaments (name, day_count, court_count, is_active, status, format)
  VALUES (btrim(p_name), p_day_count, p_court_count, true, 'in_progress', 'round_robin')
  RETURNING id INTO new_id;

  FOR i IN 0 .. p_day_count - 1 LOOP
    INSERT INTO public.tournament_days (tournament_id, day_number, date)
    VALUES (new_id, i + 1, p_start_date + i);
  END LOOP;

  FOR i IN 1 .. p_court_count LOOP
    INSERT INTO public.courts (tournament_id, number) VALUES (new_id, i);
  END LOOP;

  -- Every court is available on every day, matching the old whole-tournament
  -- court list this RPC used to produce.
  INSERT INTO public.tournament_day_courts (tournament_id, day_id, court_id)
  SELECT new_id, d.id, c.id
  FROM public.tournament_days d
  CROSS JOIN public.courts c
  WHERE d.tournament_id = new_id AND c.tournament_id = new_id;

  FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(p_categories, '[]'::jsonb))
  LOOP
    INSERT INTO public.categories (
      tournament_id, code, name, entry_type, sort_order, active, max_entries, gender
    )
    VALUES (
      new_id,
      item->>'code',
      item->>'name',
      item->>'entry_type',
      COALESCE((item->>'sort_order')::int, 0),
      COALESCE((item->>'active')::boolean, true),
      NULLIF(item->>'max_entries', '')::int,
      COALESCE(NULLIF(item->>'gender', ''),
               CASE
                 WHEN item->>'code' IN ('MS', 'MD') THEN 'men'
                 WHEN item->>'code' IN ('WS', 'WD') THEN 'women'
                 WHEN item->>'code' = 'XD' THEN 'mixed'
                 ELSE 'open'
               END)
    );
  END LOOP;

  RETURN new_id;
END;
$$;

-------------------------------------------------------------------------------
-- 8. Draft lifecycle RPCs
-------------------------------------------------------------------------------

-- Creates an empty draft. Only the basics are needed to start; every later step
-- saves into the same row, so a draft survives a refresh or a closed browser.
CREATE OR REPLACE FUNCTION public.create_tournament_draft(p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
  v_name text;
  v_format text;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_name := NULLIF(btrim(COALESCE(p_payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'A tournament needs a name';
  END IF;

  v_format := COALESCE(NULLIF(p_payload->>'format', ''), 'two_round_placement');
  IF v_format NOT IN ('round_robin', 'two_round_placement') THEN
    RAISE EXCEPTION 'Unsupported competition format';
  END IF;

  INSERT INTO public.tournaments (
    name, status, format, is_active,
    venue_name, venue_address, venue_timezone,
    organizer_name, organizer_email, organizer_phone
  )
  VALUES (
    v_name, 'draft', v_format, false,
    NULLIF(btrim(COALESCE(p_payload->>'venue_name', '')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'venue_address', '')), ''),
    COALESCE(NULLIF(btrim(COALESCE(p_payload->>'venue_timezone', '')), ''), 'America/Chicago'),
    NULLIF(btrim(COALESCE(p_payload->>'organizer_name', '')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'organizer_email', '')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'organizer_phone', '')), '')
  )
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- Saves basics, the tournament-wide cap and the per-stage match rules.
CREATE OR REPLACE FUNCTION public.save_tournament_draft(
  p_tournament_id uuid,
  p_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_name text;
  v_tz text;
  v_format text;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'This tournament is no longer a draft';
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

  IF (p_payload ? 'max_categories_per_player') THEN
    IF (p_payload->>'max_categories_per_player')::int NOT BETWEEN 1 AND 5 THEN
      RAISE EXCEPTION 'The category cap must be between 1 and 5';
    END IF;
  END IF;

  IF (p_payload ? 'knockout_best_of')
     AND (p_payload->>'knockout_best_of')::int NOT IN (1, 3, 5, 7, 9) THEN
    RAISE EXCEPTION 'A knockout match is a single game or an odd best of 3, 5, 7 or 9';
  END IF;
  IF (p_payload ? 'placement_best_of')
     AND (p_payload->>'placement_best_of')::int NOT IN (1, 3, 5, 7, 9) THEN
    RAISE EXCEPTION 'A placement match is a single game or an odd best of 3, 5, 7 or 9';
  END IF;

  UPDATE public.tournaments SET
    name = v_name,
    format = v_format,
    venue_name = NULLIF(btrim(COALESCE(p_payload->>'venue_name', '')), ''),
    venue_address = NULLIF(btrim(COALESCE(p_payload->>'venue_address', '')), ''),
    venue_timezone = v_tz,
    organizer_name = NULLIF(btrim(COALESCE(p_payload->>'organizer_name', '')), ''),
    organizer_email = NULLIF(btrim(COALESCE(p_payload->>'organizer_email', '')), ''),
    organizer_phone = NULLIF(btrim(COALESCE(p_payload->>'organizer_phone', '')), ''),
    max_categories_per_player = COALESCE(
      (p_payload->>'max_categories_per_player')::int, max_categories_per_player
    ),
    placement_games_to = COALESCE((p_payload->>'placement_games_to')::int, placement_games_to),
    placement_win_by = COALESCE((p_payload->>'placement_win_by')::int, placement_win_by),
    placement_best_of = COALESCE((p_payload->>'placement_best_of')::int, placement_best_of),
    knockout_games_to = COALESCE((p_payload->>'knockout_games_to')::int, knockout_games_to),
    knockout_win_by = COALESCE((p_payload->>'knockout_win_by')::int, knockout_win_by),
    knockout_best_of = COALESCE((p_payload->>'knockout_best_of')::int, knockout_best_of),
    group_slot_minutes = COALESCE((p_payload->>'group_slot_minutes')::int, group_slot_minutes),
    knockout_slot_minutes = COALESCE(
      (p_payload->>'knockout_slot_minutes')::int, knockout_slot_minutes
    ),
    group_rest_gap_minutes = COALESCE(
      (p_payload->>'group_rest_gap_minutes')::int, group_rest_gap_minutes
    ),
    knockout_rest_gap_minutes = COALESCE(
      (p_payload->>'knockout_rest_gap_minutes')::int, knockout_rest_gap_minutes
    )
  WHERE id = p_tournament_id;
END;
$$;

-- Replaces the whole day/court/break configuration in one transaction.
-- The court pool is the set of court numbers referenced by any day, numbered
-- 1..N, so the draft's court list is exactly "every court any day can use".
CREATE OR REPLACE FUNCTION public.save_tournament_days(
  p_tournament_id uuid,
  p_days jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'This tournament is no longer a draft';
  END IF;

  p_days := COALESCE(p_days, '[]'::jsonb);
  IF jsonb_typeof(p_days) <> 'array' THEN
    RAISE EXCEPTION 'Days must be a list';
  END IF;
  IF jsonb_array_length(p_days) > 7 THEN
    RAISE EXCEPTION 'A tournament can have at most 7 days';
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

  -- day_count has a 1..7 floor, so an emptied draft keeps a placeholder value.
  -- tournament_readiness reports the real day count from the rows.
  UPDATE public.tournaments
  SET day_count = GREATEST(idx, 1),
      court_count = GREATEST(max_court, 1)
  WHERE id = p_tournament_id;
END;
$$;

-- Replaces the event list. Only a draft with no entries may be rewritten.
CREATE OR REPLACE FUNCTION public.save_tournament_categories(
  p_tournament_id uuid,
  p_categories jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  item jsonb;
  idx int := 0;
  v_code text;
  v_entry text;
  v_gender text;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'This tournament is no longer a draft';
  END IF;

  IF EXISTS (SELECT 1 FROM public.teams WHERE tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'This tournament already has entries, so its events cannot be replaced';
  END IF;

  p_categories := COALESCE(p_categories, '[]'::jsonb);
  IF jsonb_typeof(p_categories) <> 'array' THEN
    RAISE EXCEPTION 'Events must be a list';
  END IF;

  DELETE FROM public.categories WHERE tournament_id = p_tournament_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_categories)
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
      p_tournament_id,
      v_code,
      COALESCE(NULLIF(btrim(COALESCE(item->>'name', '')), ''), v_code),
      v_entry,
      COALESCE((item->>'sort_order')::int, idx),
      COALESCE((item->>'active')::boolean, true),
      NULLIF(item->>'max_entries', '')::int,
      v_gender
    );
  END LOOP;
END;
$$;

-- The authoritative pre-activation checklist, so the review step and the
-- activation guard can never disagree about what "ready" means.
CREATE OR REPLACE FUNCTION public.tournament_readiness(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.tournaments%ROWTYPE;
  checks jsonb := '[]'::jsonb;
  day_total int;
  days_without_courts int;
  days_without_breaks_ok int;
  bad_windows int;
  breaks_outside int;
  overlapping_breaks int;
  duplicate_dates int;
  category_total int;
  over_capped int;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO t FROM public.tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  SELECT
    count(*),
    count(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1 FROM public.tournament_day_courts dc WHERE dc.day_id = d.id
      )
    ),
    count(*) FILTER (WHERE d.end_time <= d.start_time)
  INTO day_total, days_without_courts, bad_windows
  FROM public.tournament_days d
  WHERE d.tournament_id = p_tournament_id;

  SELECT count(*) INTO duplicate_dates
  FROM (
    SELECT d.date
    FROM public.tournament_days d
    WHERE d.tournament_id = p_tournament_id
    GROUP BY d.date
    HAVING count(*) > 1
  ) dup;

  -- A break must sit inside its day, and two breaks must not overlap.
  SELECT count(*) INTO breaks_outside
  FROM public.tournament_day_breaks b
  JOIN public.tournament_days d ON d.id = b.day_id
  WHERE b.tournament_id = p_tournament_id
    AND (b.start_time < d.start_time OR b.end_time > d.end_time);

  SELECT count(*) INTO overlapping_breaks
  FROM (
    SELECT b.day_id,
           b.end_time,
           lead(b.start_time) OVER (PARTITION BY b.day_id ORDER BY b.start_time) AS next_start
    FROM public.tournament_day_breaks b
    WHERE b.tournament_id = p_tournament_id
  ) seq
  WHERE seq.next_start IS NOT NULL AND seq.next_start < seq.end_time;

  SELECT count(*) INTO category_total
  FROM public.categories WHERE tournament_id = p_tournament_id;

  SELECT count(*) INTO over_capped
  FROM public.categories c
  WHERE c.tournament_id = p_tournament_id
    AND c.max_entries IS NOT NULL
    AND c.max_entries < 2;

  checks := checks || jsonb_build_object(
    'id', 'basics',
    'label', 'Tournament name, venue and organizer are set',
    'ok', t.name IS NOT NULL AND length(btrim(t.name)) > 0 AND t.venue_name IS NOT NULL,
    'detail', CASE
      WHEN t.name IS NULL OR length(btrim(t.name)) = 0 THEN 'Give the tournament a name.'
      WHEN t.venue_name IS NULL THEN 'Add the venue name.'
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
    'id', 'days',
    'label', 'At least one tournament day',
    'ok', day_total >= 1,
    'detail', CASE WHEN day_total >= 1 THEN NULL ELSE 'Add at least one day.' END
  );

  checks := checks || jsonb_build_object(
    'id', 'day_windows',
    'label', 'Every day ends after it starts',
    'ok', bad_windows = 0,
    'detail', CASE
      WHEN bad_windows = 0 THEN NULL
      ELSE bad_windows || ' day(s) have an end time before the start time.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'day_courts',
    'label', 'Every day has at least one court',
    'ok', days_without_courts = 0,
    'detail', CASE
      WHEN days_without_courts = 0 THEN NULL
      ELSE days_without_courts || ' day(s) have no courts selected.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'day_dates',
    'label', 'No two days share a date',
    'ok', duplicate_dates = 0,
    'detail', CASE
      WHEN duplicate_dates = 0 THEN NULL
      ELSE 'Two days use the same date.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'day_breaks',
    'label', 'Breaks sit inside their day and do not overlap',
    'ok', breaks_outside = 0 AND overlapping_breaks = 0,
    'detail', CASE
      WHEN breaks_outside > 0 THEN breaks_outside || ' break(s) fall outside the day window.'
      WHEN overlapping_breaks > 0 THEN 'Two breaks overlap.'
      ELSE NULL
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

  checks := checks || jsonb_build_object(
    'id', 'rules',
    'label', 'Match rules are valid',
    'ok', t.placement_best_of IN (1, 3, 5, 7, 9)
      AND t.knockout_best_of IN (1, 3, 5, 7, 9)
      AND t.placement_games_to BETWEEN 1 AND 99
      AND t.knockout_games_to BETWEEN 1 AND 99
      AND t.placement_win_by BETWEEN 1 AND 20
      AND t.knockout_win_by BETWEEN 1 AND 20
      AND t.group_slot_minutes > 0
      AND t.knockout_slot_minutes > 0
      AND t.group_rest_gap_minutes >= 0
      AND t.knockout_rest_gap_minutes >= 0,
    'detail', 'Check the scoring, duration and rest settings.'
  );

  RETURN jsonb_build_object(
    'ready', NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(checks) c WHERE (c->>'ok')::boolean = false
    ),
    'checks', checks
  );
END;
$$;

-- Draft -> In Progress. The only place a tournament becomes the active scope.
CREATE OR REPLACE FUNCTION public.activate_tournament(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  r jsonb;
  blockers text;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'This tournament is already %', v_status;
  END IF;

  r := public.tournament_readiness(p_tournament_id);
  IF NOT COALESCE((r->>'ready')::boolean, false) THEN
    SELECT string_agg(c->>'label', '; ') INTO blockers
    FROM jsonb_array_elements(r->'checks') c
    WHERE (c->>'ok')::boolean = false;
    RAISE EXCEPTION 'The tournament is not ready: %', blockers;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournaments'));

  -- The partial unique index allows only one active tournament.
  UPDATE public.tournaments SET is_active = false WHERE is_active;
  UPDATE public.tournaments
  SET status = 'in_progress', is_active = true
  WHERE id = p_tournament_id;
END;
$$;

-- Discards a draft and everything it owns.
CREATE OR REPLACE FUNCTION public.delete_tournament_draft(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft can be discarded';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournaments'));
  DELETE FROM public.tournaments WHERE id = p_tournament_id;
END;
$$;

-------------------------------------------------------------------------------
-- 9. Grants
-------------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.create_tournament_draft(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_tournament_draft(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_tournament_days(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_tournament_categories(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tournament_readiness(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_tournament(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_tournament_draft(uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.create_tournament(text, int, int, date, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_draw_result(uuid, jsonb) TO authenticated;
