
CREATE TABLE public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('individual','pair')),
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.categories TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.categories TO authenticated;
GRANT ALL ON public.categories TO service_role;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "categories public read" ON public.categories FOR SELECT USING (true);
CREATE POLICY "categories staff write" ON public.categories FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.courts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number int NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'free' CHECK (status IN ('free','in-progress','finished')),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.courts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.courts TO authenticated;
GRANT ALL ON public.courts TO service_role;
ALTER TABLE public.courts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "courts public read" ON public.courts FOR SELECT USING (true);
CREATE POLICY "courts staff write" ON public.courts FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text,
  phone text,
  gender text CHECK (gender IN ('M','F')),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.players TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.players TO authenticated;
GRANT ALL ON public.players TO service_role;
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
CREATE POLICY "players public read" ON public.players FOR SELECT USING (true);
CREATE POLICY "players staff write" ON public.players FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  player_1_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  player_2_id uuid REFERENCES public.players(id) ON DELETE CASCADE,
  seed int,
  withdrawn boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teams_category_idx ON public.teams(category_id);
GRANT SELECT ON public.teams TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.teams TO authenticated;
GRANT ALL ON public.teams TO service_role;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "teams public read" ON public.teams FOR SELECT USING (true);
CREATE POLICY "teams staff write" ON public.teams FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.enforce_two_category_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  p uuid;
  cnt int;
BEGIN
  FOREACH p IN ARRAY ARRAY[NEW.player_1_id, NEW.player_2_id] LOOP
    IF p IS NULL THEN CONTINUE; END IF;
    SELECT count(DISTINCT category_id) INTO cnt
    FROM public.teams
    WHERE id <> NEW.id
      AND category_id <> NEW.category_id
      AND (player_1_id = p OR player_2_id = p);
    IF cnt >= 2 THEN
      RAISE EXCEPTION 'Player % is already registered in 2 categories', p;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER teams_two_category_cap
BEFORE INSERT OR UPDATE ON public.teams
FOR EACH ROW EXECUTE FUNCTION public.enforce_two_category_cap();

CREATE TABLE public.pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  name text NOT NULL,
  size int NOT NULL CHECK (size IN (4,5)),
  scheduled_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pools_category_idx ON public.pools(category_id);
GRANT SELECT ON public.pools TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pools TO authenticated;
GRANT ALL ON public.pools TO service_role;
ALTER TABLE public.pools ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pools public read" ON public.pools FOR SELECT USING (true);
CREATE POLICY "pools staff write" ON public.pools FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.pool_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES public.pools(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  position int NOT NULL,
  manual_rank_override int,
  UNIQUE (pool_id, team_id)
);
GRANT SELECT ON public.pool_entries TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pool_entries TO authenticated;
GRANT ALL ON public.pool_entries TO service_role;
ALTER TABLE public.pool_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pool_entries public read" ON public.pool_entries FOR SELECT USING (true);
CREATE POLICY "pool_entries staff write" ON public.pool_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.pool_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES public.pools(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  round int NOT NULL,
  team_a_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  team_b_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  score_a int,
  score_b int,
  winner_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  court_id uuid REFERENCES public.courts(id) ON DELETE SET NULL,
  scheduled_time timestamptz,
  started_at timestamptz,
  reported_time timestamptz,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in-progress','reported','walkover','void')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pool_matches_pool_idx ON public.pool_matches(pool_id);
CREATE INDEX pool_matches_category_idx ON public.pool_matches(category_id);
GRANT SELECT ON public.pool_matches TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pool_matches TO authenticated;
GRANT ALL ON public.pool_matches TO service_role;
ALTER TABLE public.pool_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pool_matches public read" ON public.pool_matches FOR SELECT USING (true);
CREATE POLICY "pool_matches staff write" ON public.pool_matches FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.draws (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('A','B','C','D')),
  bracket_size int NOT NULL,
  entrant_count int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_id, tier)
);
GRANT SELECT ON public.draws TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draws TO authenticated;
GRANT ALL ON public.draws TO service_role;
ALTER TABLE public.draws ENABLE ROW LEVEL SECURITY;
CREATE POLICY "draws public read" ON public.draws FOR SELECT USING (true);
CREATE POLICY "draws staff write" ON public.draws FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.draw_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_id uuid NOT NULL REFERENCES public.draws(id) ON DELETE CASCADE,
  round int NOT NULL,
  slot int NOT NULL,
  team_a_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  team_b_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  games jsonb NOT NULL DEFAULT '[]'::jsonb,
  winner_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  court_id uuid REFERENCES public.courts(id) ON DELETE SET NULL,
  scheduled_time timestamptz,
  started_at timestamptz,
  reported_time timestamptz,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in-progress','reported','walkover','bye','void')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draw_id, round, slot)
);
CREATE INDEX draw_matches_draw_idx ON public.draw_matches(draw_id);
GRANT SELECT ON public.draw_matches TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draw_matches TO authenticated;
GRANT ALL ON public.draw_matches TO service_role;
ALTER TABLE public.draw_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "draw_matches public read" ON public.draw_matches FOR SELECT USING (true);
CREATE POLICY "draw_matches staff write" ON public.draw_matches FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.tournament_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'City Open',
  day_1 date NOT NULL DEFAULT current_date,
  day_2 date NOT NULL DEFAULT (current_date + 1),
  day_start_time time NOT NULL DEFAULT '09:00',
  day_end_time time NOT NULL DEFAULT '18:30',
  rest_gap_minutes int NOT NULL DEFAULT 10,
  group_slot_minutes int NOT NULL DEFAULT 20,
  knockout_slot_minutes int NOT NULL DEFAULT 25,
  court_count int NOT NULL DEFAULT 8,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.tournament_settings TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tournament_settings TO authenticated;
GRANT ALL ON public.tournament_settings TO service_role;
ALTER TABLE public.tournament_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings public read" ON public.tournament_settings FOR SELECT USING (true);
CREATE POLICY "settings staff write" ON public.tournament_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO public.categories (code, name, entry_type, sort_order) VALUES
  ('MS','Men''s Singles','individual',1),
  ('MD','Men''s Doubles','pair',2),
  ('WD','Women''s Doubles','pair',3),
  ('XD','Mixed Doubles','pair',4);

INSERT INTO public.courts (number) SELECT generate_series(1,8);

INSERT INTO public.tournament_settings (name) VALUES ('City Open 2026');
