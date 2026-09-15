-- Tournament scoping foundation.
--
-- Introduces a Tournament as the top-level scope for the app. Court count, day
-- count, and the active categories become tournament configuration instead of
-- constants baked into the schema and the scheduler.
--
-- The migration is non-destructive. Every pre-existing row is backfilled onto a
-- single default tournament, so a tournament configured with the current
-- defaults (8 courts, 2 days, all four categories) behaves exactly as before.
--
-- Order matters here: `tournament_settings` is renamed to `tournaments`, so every
-- function that referenced the old name is recreated in this same migration.

-------------------------------------------------------------------------------
-- 1. tournaments: the settings singleton becomes a real, multi-row table
-------------------------------------------------------------------------------

ALTER TABLE public.tournament_settings RENAME TO tournaments;

DROP INDEX IF EXISTS public.tournament_settings_singleton;

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS day_count int NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false;

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_day_count_check;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_day_count_check CHECK (day_count BETWEEN 1 AND 7);

-- Exactly one tournament may be active at a time. The partial index is what
-- enforces that, so creating a new tournament must deactivate the old one first.
DROP INDEX IF EXISTS public.tournaments_single_active;
CREATE UNIQUE INDEX tournaments_single_active
  ON public.tournaments ((true)) WHERE is_active;

DROP POLICY IF EXISTS "settings public read" ON public.tournaments;
DROP POLICY IF EXISTS "tournaments public read" ON public.tournaments;
CREATE POLICY "tournaments public read" ON public.tournaments FOR SELECT USING (true);

DROP POLICY IF EXISTS "settings staff write" ON public.tournaments;
DROP POLICY IF EXISTS "tournaments staff write" ON public.tournaments;
CREATE POLICY "tournaments staff write" ON public.tournaments FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin','scheduler']))
WITH CHECK (public.has_staff_role(ARRAY['admin','scheduler']));

-------------------------------------------------------------------------------
-- 2. tournament_days: N days per tournament, each with its own window
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tournament_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  day_number int NOT NULL CHECK (day_number BETWEEN 1 AND 7),
  date date NOT NULL,
  start_time time NOT NULL DEFAULT '09:00',
  end_time time NOT NULL DEFAULT '18:30',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, day_number)
);
CREATE INDEX IF NOT EXISTS tournament_days_tournament_idx
  ON public.tournament_days (tournament_id);

GRANT SELECT ON public.tournament_days TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tournament_days TO authenticated;
GRANT ALL ON public.tournament_days TO service_role;
ALTER TABLE public.tournament_days ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tournament_days public read" ON public.tournament_days;
CREATE POLICY "tournament_days public read" ON public.tournament_days FOR SELECT USING (true);

DROP POLICY IF EXISTS "tournament_days staff write" ON public.tournament_days;
CREATE POLICY "tournament_days staff write" ON public.tournament_days FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin','scheduler']))
WITH CHECK (public.has_staff_role(ARRAY['admin','scheduler']));

-------------------------------------------------------------------------------
-- 3. Backfill: one default tournament owns every existing row
-------------------------------------------------------------------------------

-- Fresh databases have no tournament at all; make sure one exists.
INSERT INTO public.tournaments (name)
SELECT 'City Open 2026'
WHERE NOT EXISTS (SELECT 1 FROM public.tournaments);

UPDATE public.tournaments SET is_active = true
WHERE id = (SELECT id FROM public.tournaments ORDER BY created_at, id LIMIT 1);

-- Materialize the old day_1 / day_2 columns and the shared daily window as days.
-- The operative end-of-day was `planning_end_time` (falling back to day_end_time).
INSERT INTO public.tournament_days (tournament_id, day_number, date, start_time, end_time)
SELECT t.id, 1, t.day_1, t.day_start_time, COALESCE(t.planning_end_time, t.day_end_time)
FROM public.tournaments t
WHERE t.day_1 IS NOT NULL
ON CONFLICT (tournament_id, day_number) DO NOTHING;

INSERT INTO public.tournament_days (tournament_id, day_number, date, start_time, end_time)
SELECT t.id, 2, t.day_2, t.day_start_time, COALESCE(t.planning_end_time, t.day_end_time)
FROM public.tournaments t
WHERE t.day_2 IS NOT NULL
ON CONFLICT (tournament_id, day_number) DO NOTHING;

-------------------------------------------------------------------------------
-- 4. tournament_id on every core entity
-------------------------------------------------------------------------------

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_entries int;

ALTER TABLE public.categories DROP CONSTRAINT IF EXISTS categories_max_entries_check;
ALTER TABLE public.categories
  ADD CONSTRAINT categories_max_entries_check CHECK (max_entries IS NULL OR max_entries > 0);

ALTER TABLE public.courts
  ADD COLUMN IF NOT EXISTS tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE;

ALTER TABLE public.teams
  ADD COLUMN IF NOT EXISTS tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE;

ALTER TABLE public.pools
  ADD COLUMN IF NOT EXISTS tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE;

ALTER TABLE public.pool_entries
  ADD COLUMN IF NOT EXISTS tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE;

ALTER TABLE public.pool_matches
  ADD COLUMN IF NOT EXISTS tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE;

ALTER TABLE public.draws
  ADD COLUMN IF NOT EXISTS tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE;

ALTER TABLE public.draw_matches
  ADD COLUMN IF NOT EXISTS tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE;

-- Backfill. Descendants inherit from their parent so scoping can never drift.
DO $$
DECLARE
  target uuid;
BEGIN
  SELECT id INTO target FROM public.tournaments WHERE is_active ORDER BY created_at, id LIMIT 1;
  IF target IS NULL THEN
    SELECT id INTO target FROM public.tournaments ORDER BY created_at, id LIMIT 1;
  END IF;

  UPDATE public.categories SET tournament_id = target WHERE tournament_id IS NULL;
  UPDATE public.courts     SET tournament_id = target WHERE tournament_id IS NULL;

  UPDATE public.teams t SET tournament_id = c.tournament_id
  FROM public.categories c
  WHERE c.id = t.category_id AND t.tournament_id IS NULL;

  UPDATE public.pools p SET tournament_id = c.tournament_id
  FROM public.categories c
  WHERE c.id = p.category_id AND p.tournament_id IS NULL;

  UPDATE public.pool_matches m SET tournament_id = c.tournament_id
  FROM public.categories c
  WHERE c.id = m.category_id AND m.tournament_id IS NULL;

  UPDATE public.pool_entries e SET tournament_id = p.tournament_id
  FROM public.pools p
  WHERE p.id = e.pool_id AND e.tournament_id IS NULL;

  UPDATE public.draws d SET tournament_id = c.tournament_id
  FROM public.categories c
  WHERE c.id = d.category_id AND d.tournament_id IS NULL;

  UPDATE public.draw_matches m SET tournament_id = d.tournament_id
  FROM public.draws d
  WHERE d.id = m.draw_id AND m.tournament_id IS NULL;
END $$;

ALTER TABLE public.categories   ALTER COLUMN tournament_id SET NOT NULL;
ALTER TABLE public.courts       ALTER COLUMN tournament_id SET NOT NULL;
ALTER TABLE public.teams        ALTER COLUMN tournament_id SET NOT NULL;
ALTER TABLE public.pools        ALTER COLUMN tournament_id SET NOT NULL;
ALTER TABLE public.pool_entries ALTER COLUMN tournament_id SET NOT NULL;
ALTER TABLE public.pool_matches ALTER COLUMN tournament_id SET NOT NULL;
ALTER TABLE public.draws        ALTER COLUMN tournament_id SET NOT NULL;
ALTER TABLE public.draw_matches ALTER COLUMN tournament_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS categories_tournament_idx   ON public.categories (tournament_id);
CREATE INDEX IF NOT EXISTS courts_tournament_idx       ON public.courts (tournament_id);
CREATE INDEX IF NOT EXISTS teams_tournament_idx        ON public.teams (tournament_id);
CREATE INDEX IF NOT EXISTS pools_tournament_idx        ON public.pools (tournament_id);
CREATE INDEX IF NOT EXISTS pool_entries_tournament_idx ON public.pool_entries (tournament_id);
CREATE INDEX IF NOT EXISTS pool_matches_tournament_idx ON public.pool_matches (tournament_id);
CREATE INDEX IF NOT EXISTS draws_tournament_idx        ON public.draws (tournament_id);
CREATE INDEX IF NOT EXISTS draw_matches_tournament_idx ON public.draw_matches (tournament_id);

-- Category codes and court numbers are now unique per tournament, not globally.
ALTER TABLE public.categories DROP CONSTRAINT IF EXISTS categories_code_key;
ALTER TABLE public.categories
  ADD CONSTRAINT categories_tournament_code_key UNIQUE (tournament_id, code);

ALTER TABLE public.courts DROP CONSTRAINT IF EXISTS courts_number_key;
ALTER TABLE public.courts
  ADD CONSTRAINT courts_tournament_number_key UNIQUE (tournament_id, number);

-------------------------------------------------------------------------------
-- 5. Tournament helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.active_tournament_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.tournaments WHERE is_active ORDER BY created_at, id LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.active_tournament_id() TO anon, authenticated;

-------------------------------------------------------------------------------
-- 6. Team / entry invariants: tournament scope, category cap, tournament_id
-------------------------------------------------------------------------------

-- Derives tournament_id from the category so a team can never be mis-scoped,
-- and rejects a category that has reached its registration cap.
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
    IF cat.code = 'MS' AND g1 IS NOT NULL AND g1 <> 'M' THEN
      RAISE EXCEPTION 'Men''s singles requires a male player';
    END IF;
  ELSE
    IF NEW.player_2_id IS NULL THEN
      RAISE EXCEPTION 'Doubles entries need two players';
    END IF;
    IF cat.code = 'MD' AND ((g1 IS NOT NULL AND g1 <> 'M') OR (g2 IS NOT NULL AND g2 <> 'M')) THEN
      RAISE EXCEPTION 'Men''s doubles requires two male players';
    END IF;
    IF cat.code = 'WD' AND ((g1 IS NOT NULL AND g1 <> 'F') OR (g2 IS NOT NULL AND g2 <> 'F')) THEN
      RAISE EXCEPTION 'Women''s doubles requires two female players';
    END IF;
    IF cat.code = 'XD' AND g1 IS NOT NULL AND g2 IS NOT NULL AND g1 = g2 THEN
      RAISE EXCEPTION 'Mixed doubles requires one male and one female player';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- The two-category cap is per tournament, not global.
CREATE OR REPLACE FUNCTION public.enforce_two_category_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  p uuid;
  cnt int;
BEGIN
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
    IF cnt >= 2 THEN
      RAISE EXCEPTION 'Player % is already registered in 2 categories', p;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- Registration cap per category. A NULL cap means unlimited.
CREATE OR REPLACE FUNCTION public.enforce_category_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  cap int;
  cnt int;
BEGIN
  IF NEW.withdrawn THEN
    RETURN NEW;
  END IF;
  SELECT max_entries INTO cap FROM public.categories WHERE id = NEW.category_id;
  IF cap IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('entrycap:' || NEW.category_id::text));
  SELECT count(*) INTO cnt
  FROM public.teams t
  WHERE t.category_id = NEW.category_id
    AND t.withdrawn = false
    AND t.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);
  IF cnt >= cap THEN
    RAISE EXCEPTION 'This category is full (% of % entries)', cnt, cap;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS teams_category_cap ON public.teams;
CREATE TRIGGER teams_category_cap
BEFORE INSERT OR UPDATE ON public.teams
FOR EACH ROW EXECUTE FUNCTION public.enforce_category_cap();

-- Pool entries inherit their tournament from the pool.
CREATE OR REPLACE FUNCTION public.enforce_pool_entry_membership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  pool_cat uuid;
  pool_tournament uuid;
  team_cat uuid;
BEGIN
  SELECT category_id, tournament_id INTO pool_cat, pool_tournament
  FROM public.pools WHERE id = NEW.pool_id;
  SELECT category_id INTO team_cat FROM public.teams WHERE id = NEW.team_id;
  IF pool_cat IS DISTINCT FROM team_cat THEN
    RAISE EXCEPTION 'Pool entry category mismatch';
  END IF;
  NEW.tournament_id := pool_tournament;
  IF EXISTS (
    SELECT 1
    FROM public.pool_entries pe
    JOIN public.pools p ON p.id = pe.pool_id
    WHERE pe.team_id = NEW.team_id
      AND p.category_id = pool_cat
      AND pe.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) THEN
    RAISE EXCEPTION 'Team is already assigned to a pool in this category';
  END IF;
  RETURN NEW;
END;
$$;

-------------------------------------------------------------------------------
-- 7. Generation RPCs: stamp tournament_id on everything they create
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_pool_generation(p_category_id uuid, p_force boolean, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pool jsonb;
  created_id uuid;
  has_started boolean;
  v_tournament uuid;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','registrar']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pools:' || p_category_id::text));

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.draw_matches dm
    JOIN public.draws d ON d.id = dm.draw_id
    WHERE d.category_id = p_category_id
      AND dm.status IN ('in-progress','reported')
      AND COALESCE(dm.is_bye, false) = false
  ) INTO has_started;
  IF has_started AND NOT COALESCE(p_force, false) THEN
    RAISE EXCEPTION 'Draws are already in progress. Confirm rollback to regenerate pools.';
  END IF;
  DELETE FROM public.draws WHERE category_id = p_category_id;
  DELETE FROM public.pool_matches WHERE category_id = p_category_id;
  DELETE FROM public.pool_entries WHERE pool_id IN (SELECT id FROM public.pools WHERE category_id = p_category_id);
  DELETE FROM public.pools WHERE category_id = p_category_id;

  FOR pool IN SELECT * FROM jsonb_array_elements(p_payload)
  LOOP
    INSERT INTO public.pools (tournament_id, category_id, name, size)
    VALUES (v_tournament, p_category_id, pool->>'name', (pool->>'size')::int)
    RETURNING id INTO created_id;
    INSERT INTO public.pool_entries (tournament_id, pool_id, team_id, position)
    SELECT v_tournament, created_id, (e->>'team_id')::uuid, (e->>'position')::int
    FROM jsonb_array_elements(pool->'entries') e;
    INSERT INTO public.pool_matches (tournament_id, pool_id, category_id, round, team_a_id, team_b_id)
    SELECT v_tournament, created_id, p_category_id, (m->>'round')::int,
           (m->>'team_a_id')::uuid, (m->>'team_b_id')::uuid
    FROM jsonb_array_elements(pool->'matches') m;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_draw_generation(p_category_id uuid, p_force boolean, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  item jsonb;
  created_id uuid;
  has_started boolean;
  v_tournament uuid;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','registrar']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('draws:' || p_category_id::text));

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.draw_matches dm
    JOIN public.draws d ON d.id = dm.draw_id
    WHERE d.category_id = p_category_id
      AND dm.status IN ('in-progress','reported')
      AND COALESCE(dm.is_bye, false) = false
  ) INTO has_started;
  IF has_started AND NOT COALESCE(p_force, false) THEN
    RAISE EXCEPTION 'Draws already have live results. Confirm rollback to regenerate.';
  END IF;
  DELETE FROM public.draws WHERE category_id = p_category_id;
  FOR item IN SELECT * FROM jsonb_array_elements(p_payload)
  LOOP
    INSERT INTO public.draws (tournament_id, category_id, tier, bracket_size, entrant_count)
    VALUES (v_tournament, p_category_id, item->>'tier',
            (item->>'bracket_size')::int, (item->>'entrant_count')::int)
    RETURNING id INTO created_id;
    INSERT INTO public.draw_matches (
      tournament_id, draw_id, round, slot, team_a_id, team_b_id, winner_id, status, note, is_bye
    )
    SELECT v_tournament,
           created_id,
           (m->>'round')::int,
           (m->>'slot')::int,
           NULLIF(m->>'team_a_id','')::uuid,
           NULLIF(m->>'team_b_id','')::uuid,
           NULLIF(m->>'winner_id','')::uuid,
           COALESCE(m->>'status','scheduled'),
           m->>'note',
           COALESCE((m->>'is_bye')::boolean, false)
    FROM jsonb_array_elements(item->'matches') m;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_draw_locked(p_draw_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  max_round int;
  current_count int;
  decided_count int;
BEGIN
  SELECT COALESCE(max(round), 0) INTO max_round FROM public.draw_matches WHERE draw_id = p_draw_id;
  SELECT count(*), count(*) FILTER (WHERE winner_id IS NOT NULL)
  INTO current_count, decided_count
  FROM public.draw_matches WHERE draw_id = p_draw_id AND round = max_round;
  IF current_count < 2 OR decided_count <> current_count THEN
    RETURN;
  END IF;
  INSERT INTO public.draw_matches (
    tournament_id, draw_id, round, slot, team_a_id, team_b_id, parent_a_id, parent_b_id
  )
  SELECT a.tournament_id,
         p_draw_id,
         max_round + 1,
         (a.slot + 1) / 2,
         a.winner_id,
         b.winner_id,
         a.id,
         b.id
  FROM public.draw_matches a
  JOIN public.draw_matches b
    ON b.draw_id = a.draw_id AND b.round = a.round AND b.slot = a.slot + 1
  WHERE a.draw_id = p_draw_id AND a.round = max_round AND a.slot % 2 = 1
  ON CONFLICT (draw_id, round, slot) DO UPDATE
  SET team_a_id = EXCLUDED.team_a_id,
      team_b_id = EXCLUDED.team_b_id,
      parent_a_id = EXCLUDED.parent_a_id,
      parent_b_id = EXCLUDED.parent_b_id
  WHERE public.draw_matches.status = 'scheduled'
    AND public.draw_matches.winner_id IS NULL;
END;
$$;

-------------------------------------------------------------------------------
-- 8. apply_day_schedule: scoped to a tournament, and stage-explicit
--    (`p_stage` replaces the old `p_day = 1` branch, which could not express a
--     single-day tournament where groups and knockouts share day 1)
-------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.apply_day_schedule(int, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.apply_day_schedule(
  p_tournament_id uuid,
  p_day int,
  p_stage text,
  p_slots jsonb,
  p_pool_ends jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  slot jsonb;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'A tournament is required';
  END IF;
  IF p_stage NOT IN ('group','knockout') THEN
    RAISE EXCEPTION 'Unsupported stage';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:' || p_day::text));

  IF p_stage = 'group' THEN
    UPDATE public.pool_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE status = 'scheduled' AND tournament_id = p_tournament_id;
  ELSE
    UPDATE public.draw_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE status = 'scheduled'
      AND COALESCE(is_bye, false) = false
      AND tournament_id = p_tournament_id;
  END IF;

  FOR slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    IF p_stage = 'group' THEN
      UPDATE public.pool_matches
      SET scheduled_time = (slot->>'scheduled_time')::timestamptz,
          court_id = NULLIF(slot->>'court_id','')::uuid
      WHERE id = (slot->>'match_id')::uuid
        AND status = 'scheduled'
        AND tournament_id = p_tournament_id;
    ELSE
      UPDATE public.draw_matches
      SET scheduled_time = (slot->>'scheduled_time')::timestamptz,
          court_id = NULLIF(slot->>'court_id','')::uuid
      WHERE id = (slot->>'match_id')::uuid
        AND status = 'scheduled'
        AND tournament_id = p_tournament_id;
    END IF;
  END LOOP;

  IF p_stage = 'group' THEN
    UPDATE public.pools p
    SET scheduled_end = (e.value)::timestamptz
    FROM jsonb_each_text(COALESCE(p_pool_ends, '{}'::jsonb)) e
    WHERE p.id::text = e.key
      AND p.tournament_id = p_tournament_id;

    IF EXISTS (
      SELECT 1
      FROM public.pool_matches
      WHERE tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND team_a_id IS NOT NULL
        AND team_b_id IS NOT NULL
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Group rebuild left assigned matches without a court or time';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM public.draw_matches
      WHERE tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND COALESCE(is_bye, false) = false
        AND team_a_id IS NOT NULL
        AND team_b_id IS NOT NULL
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Knockout rebuild left assigned matches without a court or time';
    END IF;
  END IF;
END;
$$;

-------------------------------------------------------------------------------
-- 9. Live rest-gap + reflow: settings come from the match's own tournament,
--    and the "other matches" scan is confined to that tournament
-------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.assert_match_eligible(text, uuid, uuid, timestamptz, boolean, boolean);

CREATE OR REPLACE FUNCTION public.assert_match_eligible(
  p_table text,
  p_match_id uuid,
  p_court_id uuid,
  p_start timestamp with time zone,
  p_allow_push boolean DEFAULT false,
  p_ignore_rest boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  candidate_players uuid[];
  candidate_duration interval;
  candidate_rest interval;
  candidate_end timestamptz;
  candidate_tournament uuid;
BEGIN
  IF p_table = 'pool_matches' THEN
    SELECT
      ARRAY(
        SELECT DISTINCT player_id
        FROM (
          SELECT team.player_1_id AS player_id
          FROM public.teams team
          WHERE team.id IN (match.team_a_id, match.team_b_id)
          UNION ALL
          SELECT team.player_2_id
          FROM public.teams team
          WHERE team.id IN (match.team_a_id, match.team_b_id)
        ) players
        WHERE player_id IS NOT NULL
      ),
      make_interval(mins => settings.group_slot_minutes),
      make_interval(mins => settings.group_rest_gap_minutes),
      match.tournament_id
    INTO candidate_players, candidate_duration, candidate_rest, candidate_tournament
    FROM public.pool_matches match
    JOIN public.tournaments settings ON settings.id = match.tournament_id
    WHERE match.id = p_match_id
      AND match.status = 'scheduled';
  ELSIF p_table = 'draw_matches' THEN
    SELECT
      ARRAY(
        SELECT DISTINCT player_id
        FROM (
          SELECT team.player_1_id AS player_id
          FROM public.teams team
          WHERE team.id IN (match.team_a_id, match.team_b_id)
          UNION ALL
          SELECT team.player_2_id
          FROM public.teams team
          WHERE team.id IN (match.team_a_id, match.team_b_id)
        ) players
        WHERE player_id IS NOT NULL
      ),
      make_interval(mins => settings.knockout_slot_minutes),
      make_interval(mins => settings.knockout_rest_gap_minutes),
      match.tournament_id
    INTO candidate_players, candidate_duration, candidate_rest, candidate_tournament
    FROM public.draw_matches match
    JOIN public.tournaments settings ON settings.id = match.tournament_id
    WHERE match.id = p_match_id
      AND match.status = 'scheduled'
      AND COALESCE(match.is_bye, false) = false;
  ELSE
    RAISE EXCEPTION 'Unsupported match table';
  END IF;

  IF candidate_duration IS NULL THEN
    RAISE EXCEPTION 'Only a scheduled match can be moved or started';
  END IF;
  IF COALESCE(array_length(candidate_players, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Both sides must be assigned before this match can start';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.courts
    WHERE id = p_court_id AND tournament_id = candidate_tournament
  ) THEN
    RAISE EXCEPTION 'Select a valid court';
  END IF;

  IF p_ignore_rest THEN
    candidate_rest := make_interval(mins => 0);
  END IF;

  candidate_end := p_start + candidate_duration;

  IF EXISTS (
    WITH settings AS (
      SELECT
        make_interval(mins => t.group_slot_minutes) AS group_slot,
        make_interval(mins => t.knockout_slot_minutes) AS draw_slot
      FROM public.tournaments t
      WHERE t.id = candidate_tournament
    ),
    occupied AS (
      SELECT
        'pool_matches'::text AS match_table,
        match.id,
        match.status,
        match.court_id,
        COALESCE(match.started_at, match.scheduled_time) AS starts_at,
        CASE
          WHEN match.ended_at IS NOT NULL THEN match.ended_at
          WHEN match.status = 'in-progress'
            THEN GREATEST(
              COALESCE(match.started_at, match.scheduled_time) + settings.group_slot,
              statement_timestamp()
            )
          ELSE match.scheduled_time + settings.group_slot
        END AS ends_at,
        match.team_a_id,
        match.team_b_id
      FROM public.pool_matches match
      CROSS JOIN settings
      WHERE match.tournament_id = candidate_tournament
        AND match.status <> 'void'
        AND match.court_id IS NOT NULL
        AND match.scheduled_time IS NOT NULL
      UNION ALL
      SELECT
        'draw_matches',
        match.id,
        match.status,
        match.court_id,
        COALESCE(match.started_at, match.scheduled_time),
        CASE
          WHEN match.ended_at IS NOT NULL THEN match.ended_at
          WHEN match.status = 'in-progress'
            THEN GREATEST(
              COALESCE(match.started_at, match.scheduled_time) + settings.draw_slot,
              statement_timestamp()
            )
          ELSE match.scheduled_time + settings.draw_slot
        END,
        match.team_a_id,
        match.team_b_id
      FROM public.draw_matches match
      CROSS JOIN settings
      WHERE match.tournament_id = candidate_tournament
        AND match.status <> 'void'
        AND COALESCE(match.is_bye, false) = false
        AND match.court_id IS NOT NULL
        AND match.scheduled_time IS NOT NULL
    )
    SELECT 1
    FROM occupied
    WHERE NOT (match_table = p_table AND id = p_match_id)
      AND (NOT p_allow_push OR status <> 'scheduled')
      AND court_id = p_court_id
      AND p_start < ends_at
      AND candidate_end > starts_at
  ) THEN
    RAISE EXCEPTION 'That court is occupied during the requested time';
  END IF;

  IF EXISTS (
    WITH settings AS (
      SELECT
        make_interval(mins => t.group_slot_minutes) AS group_slot,
        make_interval(mins => t.knockout_slot_minutes) AS draw_slot
      FROM public.tournaments t
      WHERE t.id = candidate_tournament
    ),
    occupied AS (
      SELECT
        'pool_matches'::text AS match_table,
        match.id,
        match.status,
        COALESCE(match.started_at, match.scheduled_time) AS starts_at,
        CASE
          WHEN match.ended_at IS NOT NULL THEN match.ended_at
          WHEN match.status = 'in-progress'
            THEN GREATEST(
              COALESCE(match.started_at, match.scheduled_time) + settings.group_slot,
              statement_timestamp()
            )
          ELSE match.scheduled_time + settings.group_slot
        END AS ends_at,
        match.team_a_id,
        match.team_b_id
      FROM public.pool_matches match
      CROSS JOIN settings
      WHERE match.tournament_id = candidate_tournament
        AND match.status <> 'void'
        AND match.scheduled_time IS NOT NULL
      UNION ALL
      SELECT
        'draw_matches',
        match.id,
        match.status,
        COALESCE(match.started_at, match.scheduled_time),
        CASE
          WHEN match.ended_at IS NOT NULL THEN match.ended_at
          WHEN match.status = 'in-progress'
            THEN GREATEST(
              COALESCE(match.started_at, match.scheduled_time) + settings.draw_slot,
              statement_timestamp()
            )
          ELSE match.scheduled_time + settings.draw_slot
        END,
        match.team_a_id,
        match.team_b_id
      FROM public.draw_matches match
      CROSS JOIN settings
      WHERE match.tournament_id = candidate_tournament
        AND match.status <> 'void'
        AND COALESCE(match.is_bye, false) = false
        AND match.scheduled_time IS NOT NULL
    )
    SELECT 1
    FROM occupied
    WHERE NOT (match_table = p_table AND id = p_match_id)
      AND (NOT p_allow_push OR status <> 'scheduled')
      AND p_start < ends_at + candidate_rest
      AND candidate_end + candidate_rest > starts_at
      AND EXISTS (
        SELECT 1
        FROM public.teams team
        JOIN unnest(candidate_players) AS candidate(player_id)
          ON candidate.player_id IN (team.player_1_id, team.player_2_id)
        WHERE team.id IN (occupied.team_a_id, occupied.team_b_id)
      )
  ) THEN
    IF p_ignore_rest THEN
      RAISE EXCEPTION 'A player is already busy in another match';
    ELSE
      RAISE EXCEPTION 'A player is busy or has not completed the required rest gap';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_match_eligible(text, uuid, uuid, timestamptz, boolean, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.assert_match_eligible(text, uuid, uuid, timestamptz, boolean, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_match_eligible(text, uuid, uuid, timestamptz, boolean, boolean) TO service_role;

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
  source_court uuid;
  source_time timestamptz;
  source_end timestamptz;
  source_tournament uuid;
  current_match record;
  blocking_match record;
  next_start timestamptz;
  previous_end timestamptz;
  iterations int := 0;
BEGIN
  IF p_table NOT IN ('pool_matches', 'draw_matches') THEN
    RAISE EXCEPTION 'Unsupported match table';
  END IF;

  -- Serialize result-driven changes with either day's full schedule writer.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));

  IF p_table = 'pool_matches' THEN
    SELECT court_id, scheduled_time, ended_at, tournament_id
    INTO source_court, source_time, source_end, source_tournament
    FROM public.pool_matches
    WHERE id = p_match_id
      AND status IN ('reported', 'walkover');
  ELSE
    SELECT court_id, scheduled_time, ended_at, tournament_id
    INTO source_court, source_time, source_end, source_tournament
    FROM public.draw_matches
    WHERE id = p_match_id
      AND status IN ('reported', 'walkover');
  END IF;

  -- Unscheduled completions cannot establish a court sequence.
  IF source_court IS NULL OR source_time IS NULL OR source_end IS NULL THEN
    RETURN;
  END IF;

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
    PRIMARY KEY (match_table, match_id)
  ) ON COMMIT DROP;

  CREATE INDEX live_schedule_work_court_time
    ON live_schedule_work (court_id, original_time, match_table, match_id);

  -- Only this tournament's matches are in scope for the reflow.
  INSERT INTO live_schedule_work (
    match_table, match_id, court_id, original_time, shifted_time,
    actual_start, actual_end, duration, rest_gap, status, movable
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
    pm.status = 'scheduled'
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
    dm.status = 'scheduled'
  FROM public.draw_matches dm
  JOIN public.tournaments settings ON settings.id = dm.tournament_id
  WHERE dm.tournament_id = source_tournament
    AND dm.court_id IS NOT NULL
    AND dm.scheduled_time IS NOT NULL
    AND dm.status <> 'void'
    AND COALESCE(dm.is_bye, false) = false;

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

  CREATE INDEX live_match_players_player
    ON live_match_players (player_id, match_table, match_id);

  CREATE TEMP TABLE live_schedule_queue (
    match_table text NOT NULL,
    match_id uuid NOT NULL,
    PRIMARY KEY (match_table, match_id)
  ) ON COMMIT DROP;

  -- Every still-movable match after the completion on this court is in scope.
  INSERT INTO live_schedule_queue
  SELECT work.match_table, work.match_id
  FROM live_schedule_work work
  WHERE work.movable
    AND work.court_id = source_court
    AND (work.original_time, work.match_table, work.match_id::text)
      > (source_time, p_table, p_match_id::text);

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
    -- previous match's real end when known.
    SELECT CASE
      WHEN previous.actual_end IS NOT NULL THEN previous.actual_end
      WHEN previous.status = 'in-progress'
        THEN GREATEST(previous.shifted_time + previous.duration, statement_timestamp())
      ELSE previous.shifted_time + previous.duration
    END
    INTO previous_end
    FROM live_schedule_work previous
    WHERE previous.court_id = current_match.court_id
      AND (previous.original_time, previous.match_table, previous.match_id::text)
        < (current_match.original_time, current_match.match_table, current_match.match_id::text)
    ORDER BY previous.original_time DESC, previous.match_table DESC, previous.match_id DESC
    LIMIT 1;

    next_start := COALESCE(previous_end, current_match.shifted_time);

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
        AND (later.original_time, later.match_table, later.match_id::text)
          > (current_match.original_time, current_match.match_table, current_match.match_id::text)
        AND later.shifted_time < next_start + current_match.duration + later.rest_gap
      ON CONFLICT DO NOTHING;
    END IF;
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

REVOKE ALL ON FUNCTION public.shift_live_schedule_after_match(text, uuid)
FROM anon, authenticated, public;

-------------------------------------------------------------------------------
-- 10. Tournament creation: one atomic call for the setup form
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

  INSERT INTO public.tournaments (name, day_count, court_count, is_active)
  VALUES (btrim(p_name), p_day_count, p_court_count, true)
  RETURNING id INTO new_id;

  FOR i IN 0 .. p_day_count - 1 LOOP
    INSERT INTO public.tournament_days (tournament_id, day_number, date)
    VALUES (new_id, i + 1, p_start_date + i);
  END LOOP;

  FOR i IN 1 .. p_court_count LOOP
    INSERT INTO public.courts (tournament_id, number) VALUES (new_id, i);
  END LOOP;

  FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(p_categories, '[]'::jsonb))
  LOOP
    INSERT INTO public.categories (
      tournament_id, code, name, entry_type, sort_order, active, max_entries
    )
    VALUES (
      new_id,
      item->>'code',
      item->>'name',
      item->>'entry_type',
      COALESCE((item->>'sort_order')::int, 0),
      COALESCE((item->>'active')::boolean, true),
      NULLIF(item->>'max_entries', '')::int
    );
  END LOOP;

  RETURN new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_tournament(text, int, int, date, jsonb) TO authenticated;

-------------------------------------------------------------------------------
-- 11. Retire the old day columns now that functions no longer read them
-------------------------------------------------------------------------------

ALTER TABLE public.tournaments
  DROP COLUMN IF EXISTS day_1,
  DROP COLUMN IF EXISTS day_2,
  DROP COLUMN IF EXISTS day_start_time,
  DROP COLUMN IF EXISTS day_end_time,
  DROP COLUMN IF EXISTS planning_end_time;

-------------------------------------------------------------------------------
-- 12. Re-assert grants for recreated functions
-------------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.apply_pool_generation(uuid, boolean, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_draw_generation(uuid, boolean, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_day_schedule(uuid, int, text, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_tournament(text, int, int, date, jsonb) TO authenticated;
