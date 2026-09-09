-- Tournament logic hardening: roles, privacy, invariants, transactional RPCs, stage rest.

CREATE TABLE IF NOT EXISTS public.staff_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE,
  email text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('admin','registrar','scorer','scheduler')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.staff_roles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.staff_roles TO authenticated;
GRANT ALL ON public.staff_roles TO service_role;

CREATE OR REPLACE FUNCTION public.normalize_email(value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(value));
$$;

CREATE OR REPLACE FUNCTION public.current_staff_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT sr.role
  FROM public.staff_roles sr
  WHERE sr.user_id = auth.uid()
     OR sr.email = public.normalize_email(auth.jwt() ->> 'email')
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.has_staff_role(needed text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_staff_role() = ANY(needed);
$$;

CREATE OR REPLACE FUNCTION public.is_invited_email(value text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_roles
    WHERE email = public.normalize_email(value)
  );
$$;

GRANT EXECUTE ON FUNCTION public.current_staff_role() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_staff_role(text[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_invited_email(text) TO anon, authenticated;

INSERT INTO public.staff_roles (user_id, email, role)
SELECT u.id, public.normalize_email(u.email), 'admin'
FROM auth.users u
WHERE public.normalize_email(u.email) = 'nhphuong@iastate.edu'
ON CONFLICT (email) DO UPDATE
SET user_id = COALESCE(EXCLUDED.user_id, public.staff_roles.user_id),
    role = 'admin';

INSERT INTO public.staff_roles (email, role)
VALUES ('nhphuong@iastate.edu', 'admin')
ON CONFLICT (email) DO NOTHING;

CREATE OR REPLACE FUNCTION public.link_staff_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.staff_roles
  SET user_id = NEW.id
  WHERE email = public.normalize_email(NEW.email)
    AND (user_id IS NULL OR user_id = NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_link_staff ON auth.users;
CREATE TRIGGER on_auth_user_created_link_staff
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.link_staff_role();

DROP POLICY IF EXISTS "staff_roles self read" ON public.staff_roles;
CREATE POLICY "staff_roles self read" ON public.staff_roles
FOR SELECT TO authenticated
USING (user_id = auth.uid() OR email = public.normalize_email(auth.jwt() ->> 'email') OR public.has_staff_role(ARRAY['admin']));

DROP POLICY IF EXISTS "staff_roles admin write" ON public.staff_roles;
CREATE POLICY "staff_roles admin write" ON public.staff_roles
FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin']))
WITH CHECK (public.has_staff_role(ARRAY['admin']));

-- Public roster without PII
CREATE OR REPLACE VIEW public.player_roster AS
SELECT id, name, gender, created_at FROM public.players;
GRANT SELECT ON public.player_roster TO anon, authenticated;

-- Tighten player reads
DROP POLICY IF EXISTS "players public read" ON public.players;
CREATE POLICY "players public read" ON public.players
FOR SELECT TO authenticated
USING (public.has_staff_role(ARRAY['admin','registrar','scorer','scheduler']));

DROP POLICY IF EXISTS "players staff write" ON public.players;
CREATE POLICY "players staff write" ON public.players
FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin','registrar']))
WITH CHECK (public.has_staff_role(ARRAY['admin','registrar']));

REVOKE SELECT ON public.players FROM anon;

-- Replace remaining write policies
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname LIKE '%staff write%'
      AND tablename <> 'players'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', rec.policyname, rec.tablename);
  END LOOP;
END $$;

CREATE POLICY "categories staff write" ON public.categories FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin'])) WITH CHECK (public.has_staff_role(ARRAY['admin']));
CREATE POLICY "courts staff write" ON public.courts FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin','scheduler'])) WITH CHECK (public.has_staff_role(ARRAY['admin','scheduler']));
CREATE POLICY "teams staff write" ON public.teams FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin','registrar'])) WITH CHECK (public.has_staff_role(ARRAY['admin','registrar']));
CREATE POLICY "pools staff write" ON public.pools FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin','registrar','scheduler'])) WITH CHECK (public.has_staff_role(ARRAY['admin','registrar','scheduler']));
CREATE POLICY "pool_entries staff write" ON public.pool_entries FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin','registrar','scorer'])) WITH CHECK (public.has_staff_role(ARRAY['admin','registrar','scorer']));
CREATE POLICY "pool_matches staff write" ON public.pool_matches FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin','scorer','scheduler'])) WITH CHECK (public.has_staff_role(ARRAY['admin','scorer','scheduler']));
CREATE POLICY "draws staff write" ON public.draws FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin','registrar','scheduler'])) WITH CHECK (public.has_staff_role(ARRAY['admin','registrar','scheduler']));
CREATE POLICY "draw_matches staff write" ON public.draw_matches FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin','scorer','scheduler'])) WITH CHECK (public.has_staff_role(ARRAY['admin','scorer','scheduler']));
CREATE POLICY "settings staff write" ON public.tournament_settings FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin','scheduler'])) WITH CHECK (public.has_staff_role(ARRAY['admin','scheduler']));

-- Settings: stage rest, timezone, 08:00 start
ALTER TABLE public.tournament_settings
  ADD COLUMN IF NOT EXISTS group_rest_gap_minutes int NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS knockout_rest_gap_minutes int NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS venue_timezone text NOT NULL DEFAULT 'America/Chicago',
  ADD COLUMN IF NOT EXISTS planning_end_time time NOT NULL DEFAULT '17:00';

ALTER TABLE public.tournament_settings ALTER COLUMN day_start_time SET DEFAULT '08:00';
ALTER TABLE public.tournament_settings ALTER COLUMN rest_gap_minutes SET DEFAULT 10;
ALTER TABLE public.tournament_settings ALTER COLUMN group_slot_minutes SET DEFAULT 20;

UPDATE public.tournament_settings
SET day_start_time = '08:00',
    group_rest_gap_minutes = 10,
    knockout_rest_gap_minutes = 30,
    venue_timezone = COALESCE(venue_timezone, 'America/Chicago'),
    planning_end_time = '17:00',
    rest_gap_minutes = 10,
    group_slot_minutes = 20;

CREATE UNIQUE INDEX IF NOT EXISTS tournament_settings_singleton ON public.tournament_settings ((true));

-- Match lifecycle columns
ALTER TABLE public.pool_matches ADD COLUMN IF NOT EXISTS ended_at timestamptz;
ALTER TABLE public.draw_matches ADD COLUMN IF NOT EXISTS ended_at timestamptz;
ALTER TABLE public.draw_matches ADD COLUMN IF NOT EXISTS parent_a_id uuid REFERENCES public.draw_matches(id) ON DELETE SET NULL;
ALTER TABLE public.draw_matches ADD COLUMN IF NOT EXISTS parent_b_id uuid REFERENCES public.draw_matches(id) ON DELETE SET NULL;
ALTER TABLE public.draw_matches ADD COLUMN IF NOT EXISTS is_bye boolean NOT NULL DEFAULT false;

-- Pool size back to 4/5
ALTER TABLE public.pools DROP CONSTRAINT IF EXISTS pools_size_check;
ALTER TABLE public.pools ADD CONSTRAINT pools_size_check CHECK (size IN (4, 5));
ALTER TABLE public.pool_entries ADD CONSTRAINT pool_entries_position_unique UNIQUE (pool_id, position);

-- Team shape
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

DROP TRIGGER IF EXISTS teams_shape ON public.teams;
CREATE TRIGGER teams_shape
BEFORE INSERT OR UPDATE ON public.teams
FOR EACH ROW EXECUTE FUNCTION public.enforce_team_shape();

CREATE UNIQUE INDEX IF NOT EXISTS teams_singles_unique
  ON public.teams (category_id, player_1_id)
  WHERE player_2_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS teams_doubles_unique
  ON public.teams (category_id, least(player_1_id, player_2_id), greatest(player_1_id, player_2_id))
  WHERE player_2_id IS NOT NULL;

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
      AND category_id <> NEW.category_id;
    IF cnt >= 2 THEN
      RAISE EXCEPTION 'Player % is already registered in 2 categories', p;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_pool_entry_membership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  pool_cat uuid;
  team_cat uuid;
BEGIN
  SELECT category_id INTO pool_cat FROM public.pools WHERE id = NEW.pool_id;
  SELECT category_id INTO team_cat FROM public.teams WHERE id = NEW.team_id;
  IF pool_cat IS DISTINCT FROM team_cat THEN
    RAISE EXCEPTION 'Pool entry category mismatch';
  END IF;
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

DROP TRIGGER IF EXISTS pool_entries_membership ON public.pool_entries;
CREATE TRIGGER pool_entries_membership
BEFORE INSERT OR UPDATE ON public.pool_entries
FOR EACH ROW EXECUTE FUNCTION public.enforce_pool_entry_membership();

CREATE OR REPLACE FUNCTION public.enforce_match_sides()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'pool_matches' THEN
    IF NEW.team_a_id IS NOT NULL AND NEW.team_a_id = NEW.team_b_id THEN
      RAISE EXCEPTION 'A match needs two different teams';
    END IF;
    IF NEW.winner_id IS NOT NULL AND NEW.winner_id IS DISTINCT FROM NEW.team_a_id AND NEW.winner_id IS DISTINCT FROM NEW.team_b_id THEN
      RAISE EXCEPTION 'Winner must be one of the match participants';
    END IF;
  ELSE
    IF NEW.team_a_id IS NOT NULL AND NEW.team_a_id = NEW.team_b_id THEN
      RAISE EXCEPTION 'A match needs two different teams';
    END IF;
    IF NEW.winner_id IS NOT NULL AND NEW.winner_id IS DISTINCT FROM NEW.team_a_id AND NEW.winner_id IS DISTINCT FROM NEW.team_b_id THEN
      RAISE EXCEPTION 'Winner must be one of the match participants';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pool_matches_sides ON public.pool_matches;
CREATE TRIGGER pool_matches_sides
BEFORE INSERT OR UPDATE ON public.pool_matches
FOR EACH ROW EXECUTE FUNCTION public.enforce_match_sides();

DROP TRIGGER IF EXISTS draw_matches_sides ON public.draw_matches;
CREATE TRIGGER draw_matches_sides
BEFORE INSERT OR UPDATE ON public.draw_matches
FOR EACH ROW EXECUTE FUNCTION public.enforce_match_sides();

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
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','registrar']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pools:' || p_category_id::text));
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
    INSERT INTO public.pools (category_id, name, size)
    VALUES (p_category_id, pool->>'name', (pool->>'size')::int)
    RETURNING id INTO created_id;
    INSERT INTO public.pool_entries (pool_id, team_id, position)
    SELECT created_id, (e->>'team_id')::uuid, (e->>'position')::int
    FROM jsonb_array_elements(pool->'entries') e;
    INSERT INTO public.pool_matches (pool_id, category_id, round, team_a_id, team_b_id)
    SELECT created_id, p_category_id, (m->>'round')::int, (m->>'team_a_id')::uuid, (m->>'team_b_id')::uuid
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
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','registrar']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('draws:' || p_category_id::text));
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
    INSERT INTO public.draws (category_id, tier, bracket_size, entrant_count)
    VALUES (p_category_id, item->>'tier', (item->>'bracket_size')::int, (item->>'entrant_count')::int)
    RETURNING id INTO created_id;
    INSERT INTO public.draw_matches (draw_id, round, slot, team_a_id, team_b_id, winner_id, status, note, is_bye)
    SELECT created_id,
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

CREATE OR REPLACE FUNCTION public.apply_day_schedule(p_day int, p_slots jsonb, p_pool_ends jsonb)
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
  PERFORM pg_advisory_xact_lock(hashtext('schedule:' || p_day::text));
  IF p_day = 1 THEN
    UPDATE public.pool_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE status = 'scheduled';
  ELSE
    UPDATE public.draw_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE status = 'scheduled' AND COALESCE(is_bye, false) = false;
  END IF;
  FOR slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    IF p_day = 1 THEN
      UPDATE public.pool_matches
      SET scheduled_time = (slot->>'scheduled_time')::timestamptz,
          court_id = NULLIF(slot->>'court_id','')::uuid
      WHERE id = (slot->>'match_id')::uuid
        AND status = 'scheduled';
    ELSE
      UPDATE public.draw_matches
      SET scheduled_time = (slot->>'scheduled_time')::timestamptz,
          court_id = NULLIF(slot->>'court_id','')::uuid
      WHERE id = (slot->>'match_id')::uuid
        AND status = 'scheduled';
    END IF;
  END LOOP;
  IF p_day = 1 THEN
    UPDATE public.pools p
    SET scheduled_end = (e.value)::timestamptz
    FROM jsonb_each_text(COALESCE(p_pool_ends, '{}'::jsonb)) e
    WHERE p.id::text = e.key;
  END IF;
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
  INSERT INTO public.draw_matches (draw_id, round, slot, team_a_id, team_b_id, parent_a_id, parent_b_id)
  SELECT p_draw_id,
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

CREATE OR REPLACE FUNCTION public.report_pool_result(p_match_id uuid, p_score_a int, p_score_b int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  winner uuid;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','scorer']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_score_a < 0 OR p_score_b < 0 OR p_score_a = p_score_b THEN
    RAISE EXCEPTION 'A group match needs a valid winning score';
  END IF;
  IF NOT ((p_score_a >= 21 AND p_score_a - p_score_b >= 2) OR (p_score_b >= 21 AND p_score_b - p_score_a >= 2)) THEN
    RAISE EXCEPTION 'Group games are race to 21, win by 2';
  END IF;
  SELECT CASE WHEN p_score_a > p_score_b THEN team_a_id ELSE team_b_id END
  INTO winner FROM public.pool_matches WHERE id = p_match_id;
  UPDATE public.pool_matches
  SET score_a = p_score_a,
      score_b = p_score_b,
      winner_id = winner,
      status = 'reported',
      reported_time = now(),
      ended_at = now()
  WHERE id = p_match_id;
END;
$$;

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
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','scorer']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF jsonb_array_length(p_games) < 2 OR jsonb_array_length(p_games) > 3 THEN
    RAISE EXCEPTION 'Knockouts are best of three';
  END IF;
  FOR game IN SELECT * FROM jsonb_array_elements(p_games)
  LOOP
    sa := (game->>'a')::int;
    sb := (game->>'b')::int;
    IF sa < 0 OR sb < 0 OR sa = sb THEN
      RAISE EXCEPTION 'Each game needs a valid winning score';
    END IF;
    IF NOT ((sa >= 21 AND sa - sb >= 2) OR (sb >= 21 AND sb - sa >= 2)) THEN
      RAISE EXCEPTION 'Games are race to 21, win by 2';
    END IF;
    IF sa > sb THEN wins_a := wins_a + 1; ELSE wins_b := wins_b + 1; END IF;
    IF (wins_a >= 2 OR wins_b >= 2) AND game <> p_games -> -1 THEN
      RAISE EXCEPTION 'Do not enter games after the match is decided';
    END IF;
  END LOOP;
  IF wins_a < 2 AND wins_b < 2 THEN
    RAISE EXCEPTION 'A side must win two games';
  END IF;
  SELECT CASE WHEN wins_a >= 2 THEN team_a_id ELSE team_b_id END, draw_id
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
      reported_time = now(),
      ended_at = now()
  WHERE id = p_match_id;
  PERFORM public.advance_draw_locked(draw);
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_and_repair_match(p_table text, p_match_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  draw uuid;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','scorer']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_table = 'pool_matches' THEN
    UPDATE public.pool_matches
    SET status = 'scheduled', winner_id = NULL, score_a = NULL, score_b = NULL,
        reported_time = NULL, started_at = NULL, ended_at = NULL
    WHERE id = p_match_id;
    RETURN;
  END IF;
  SELECT draw_id INTO draw FROM public.draw_matches WHERE id = p_match_id;
  PERFORM pg_advisory_xact_lock(hashtext('draw:' || draw::text));
  WITH RECURSIVE descendent AS (
    SELECT id FROM public.draw_matches WHERE id = p_match_id
    UNION
    SELECT dm.id
    FROM public.draw_matches dm
    JOIN descendent d ON dm.parent_a_id = d.id OR dm.parent_b_id = d.id
  )
  UPDATE public.draw_matches dm
  SET status = CASE WHEN dm.id = p_match_id THEN 'scheduled' ELSE
                 CASE WHEN COALESCE(dm.is_bye, false) THEN dm.status ELSE 'scheduled' END END,
      winner_id = CASE WHEN dm.id = p_match_id THEN NULL ELSE
                    CASE WHEN COALESCE(dm.is_bye, false) THEN dm.winner_id ELSE NULL END END,
      games = CASE WHEN dm.id = p_match_id THEN '[]'::jsonb ELSE
                CASE WHEN COALESCE(dm.is_bye, false) THEN dm.games ELSE '[]'::jsonb END END,
      reported_time = CASE WHEN dm.id = p_match_id THEN NULL ELSE
                      CASE WHEN COALESCE(dm.is_bye, false) THEN dm.reported_time ELSE NULL END END,
      started_at = NULL,
      ended_at = NULL,
      team_a_id = CASE WHEN dm.parent_a_id IN (SELECT id FROM descendent) AND dm.id <> p_match_id THEN NULL ELSE dm.team_a_id END,
      team_b_id = CASE WHEN dm.parent_b_id IN (SELECT id FROM descendent) AND dm.id <> p_match_id THEN NULL ELSE dm.team_b_id END
  WHERE dm.id IN (SELECT id FROM descendent);
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_match_exception(
  p_table text,
  p_match_id uuid,
  p_status text,
  p_winner_id uuid,
  p_note text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin','scorer']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_status NOT IN ('walkover','void') THEN
    RAISE EXCEPTION 'Unsupported exception status';
  END IF;
  IF p_table = 'pool_matches' THEN
    UPDATE public.pool_matches
    SET status = p_status,
        winner_id = CASE WHEN p_status = 'void' THEN NULL ELSE p_winner_id END,
        note = p_note,
        reported_time = now(),
        ended_at = now()
    WHERE id = p_match_id;
  ELSE
    UPDATE public.draw_matches
    SET status = p_status,
        winner_id = CASE WHEN p_status = 'void' THEN NULL ELSE p_winner_id END,
        note = p_note,
        reported_time = now(),
        ended_at = now()
    WHERE id = p_match_id;
    IF p_status = 'walkover' THEN
      PERFORM public.advance_draw_locked((SELECT draw_id FROM public.draw_matches WHERE id = p_match_id));
    END IF;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_pool_generation(uuid, boolean, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_draw_generation(uuid, boolean, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_day_schedule(int, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_pool_result(uuid, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_draw_result(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_and_repair_match(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_match_exception(text, uuid, text, uuid, text) TO authenticated;
