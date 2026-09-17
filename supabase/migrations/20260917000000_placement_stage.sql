-- ============================================================================
-- Two-round placement format: tables
-- ============================================================================
--
-- The `two_round_placement` format gets its own storage, deliberately separate
-- from the legacy round-robin tables (`pools`, `pool_entries`, `pool_matches`,
-- `draws`, `draw_matches`), which are left completely untouched. Both formats
-- can therefore coexist in the same database and the round-robin engine keeps
-- working exactly as it did.
--
-- The format, in one line: every entrant plays two placement matches. Their two
-- results sort them into one of four single-elimination draws.
--
--   WW -> Draw A   WL -> Draw B   LW -> Draw C   LL -> Draw D
--
-- The two stages have deliberately OPPOSITE bye rules, which is the single most
-- confusing thing about this format, so it is stated here once:
--
--   * Placement stage: NO byes. An odd entry count "holds" one entrant, who then
--     plays two make-up matches in round two. Every entrant plays exactly twice,
--     so every entrant reaches a draw with a complete WW/WL/LW/LL record.
--   * Knockout stage: byes ARE allowed, and go to the highest seed.
--
-- Seeding uses a self-reported skill level, but only ONCE: `skill_level` decides
-- the initial `seed`, and after that every pairing rule reads `seed` only.
--
-- Ordering note: `placement_entrants` must exist before `placement_matches` and
-- `tier_draws`, and `tier_draws` before `tier_draw_matches`.

-------------------------------------------------------------------------------
-- 1. placement_entrants: one per registered team in a category
-------------------------------------------------------------------------------

-- `team_id` carries player identity, so the two-category cap and the
-- player-level rest gaps keep working without duplicating any of it. `skill_level`
-- and `seed` live here rather than on `teams`, which is what keeps the legacy
-- tables untouched.
CREATE TABLE IF NOT EXISTS public.placement_entrants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  -- Self-reported, used once to compute `seed`. Never read again after seeding.
  skill_level text NOT NULL DEFAULT 'intermediate'
    CHECK (skill_level IN ('beginner', 'intermediate', 'advanced')),
  -- 1..N, written once when registration closes. Never recomputed on the fly,
  -- so "why did I face this person" always has the same answer.
  seed int CHECK (seed IS NULL OR seed > 0),
  -- Assigned only after round two. Null until then.
  tier text CHECK (tier IS NULL OR tier IN ('A', 'B', 'C', 'D')),
  -- Set when the desk waives this entrant from the two-match gate, e.g. after a
  -- void. A waived entrant is left out of draw generation rather than blocking it.
  excluded boolean NOT NULL DEFAULT false,
  -- Non-null once seeds are frozen, which is what makes the shuffle one-shot.
  seed_locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One entrant per team per category: registering a team twice is not meaningful.
  UNIQUE (category_id, team_id)
);

CREATE INDEX IF NOT EXISTS placement_entrants_tournament_idx
  ON public.placement_entrants (tournament_id);
CREATE INDEX IF NOT EXISTS placement_entrants_category_idx
  ON public.placement_entrants (category_id);

-- Seeds are unique within a category, but only once they have been assigned.
-- A partial index is what lets every entrant sit at NULL until locking.
CREATE UNIQUE INDEX IF NOT EXISTS placement_entrants_seed_unique
  ON public.placement_entrants (category_id, seed) WHERE seed IS NOT NULL;

GRANT SELECT ON public.placement_entrants TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.placement_entrants TO authenticated;
GRANT ALL ON public.placement_entrants TO service_role;
ALTER TABLE public.placement_entrants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "placement_entrants public read" ON public.placement_entrants;
CREATE POLICY "placement_entrants public read" ON public.placement_entrants
FOR SELECT USING (true);

DROP POLICY IF EXISTS "placement_entrants staff write" ON public.placement_entrants;
CREATE POLICY "placement_entrants staff write" ON public.placement_entrants
FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin', 'registrar']))
WITH CHECK (public.has_staff_role(ARRAY['admin', 'registrar']));

-------------------------------------------------------------------------------
-- 2. placement_matches: rounds one and two
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.placement_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('round1', 'round2')),
  -- Stable key from the generator, e.g. `r1-3` or `r2-makeup-2`. Two jobs: it
  -- resolves the prerequisite graph when a batch is inserted, and it makes
  -- regeneration idempotent and debuggable rather than positional.
  generation_key text NOT NULL,
  entrant_a_id uuid NOT NULL REFERENCES public.placement_entrants(id) ON DELETE CASCADE,
  entrant_b_id uuid NOT NULL REFERENCES public.placement_entrants(id) ON DELETE CASCADE,
  winner_id uuid REFERENCES public.placement_entrants(id) ON DELETE SET NULL,
  -- Games, not a single score: the tournament's placement rule can be best of
  -- three, exactly like the knockout rule. Shaped like `draw_matches.games`.
  games jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- True for the held entrant's two make-up matches, so the desk can explain
  -- them to players: those two are cross-group (a real winner, then a real loser)
  -- rather than the same-group path a regular entrant takes.
  is_makeup boolean NOT NULL DEFAULT false,
  -- True for the one match between a leftover winner and a leftover loser. This
  -- is an official part of tier assignment, not a spare qualifier.
  is_crossover boolean NOT NULL DEFAULT false,
  -- All of these must be finished before this match may start. Used for the held
  -- entrant's second make-up match, which waits for their first match plus `k`
  -- other round-two matches. An array rather than a join table because these are
  -- generated, not hand-authored, and the scheduler consumes them as a flat list.
  prerequisite_ids uuid[] NOT NULL DEFAULT '{}',
  court_id uuid REFERENCES public.courts(id) ON DELETE SET NULL,
  scheduled_time timestamptz,
  started_at timestamptz,
  -- When the match actually finished, which is what the rest-gap check reads.
  ended_at timestamptz,
  reported_time timestamptz,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'in-progress', 'reported', 'walkover', 'void')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- An entrant cannot play themselves.
  CHECK (entrant_a_id <> entrant_b_id),
  -- A winner must be one of the two entrants.
  CHECK (winner_id IS NULL OR winner_id IN (entrant_a_id, entrant_b_id))
);

CREATE INDEX IF NOT EXISTS placement_matches_tournament_idx
  ON public.placement_matches (tournament_id);
CREATE INDEX IF NOT EXISTS placement_matches_category_idx
  ON public.placement_matches (category_id);
CREATE INDEX IF NOT EXISTS placement_matches_stage_idx
  ON public.placement_matches (category_id, stage);

-- The generator's key is unique per category, which is what lets an insert
-- resolve prerequisites by name and lets a regeneration replace its own rows.
CREATE UNIQUE INDEX IF NOT EXISTS placement_matches_generation_key_unique
  ON public.placement_matches (category_id, generation_key);

-- A pairing may only occur once across the whole placement stage. This is the
-- database-level guard for the invariant that matters most: no entrant faces the
-- same opponent twice, including across the crossover boundary.
CREATE UNIQUE INDEX IF NOT EXISTS placement_matches_pairing_unique
  ON public.placement_matches (
    category_id,
    LEAST(entrant_a_id, entrant_b_id),
    GREATEST(entrant_a_id, entrant_b_id)
  );

GRANT SELECT ON public.placement_matches TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.placement_matches TO authenticated;
GRANT ALL ON public.placement_matches TO service_role;
ALTER TABLE public.placement_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "placement_matches public read" ON public.placement_matches;
CREATE POLICY "placement_matches public read" ON public.placement_matches
FOR SELECT USING (true);

DROP POLICY IF EXISTS "placement_matches staff write" ON public.placement_matches;
CREATE POLICY "placement_matches staff write" ON public.placement_matches
FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin', 'scheduler']))
WITH CHECK (public.has_staff_role(ARRAY['admin', 'scheduler']));

-------------------------------------------------------------------------------
-- 3. tier_draws: the A/B/C/D single-elimination brackets
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tier_draws (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('A', 'B', 'C', 'D')),
  bracket_size int NOT NULL CHECK (bracket_size >= 1),
  entrant_count int NOT NULL CHECK (entrant_count >= 0),
  -- Set immediately for a tier that has exactly one entrant: that entrant is the
  -- champion with no bracket, and the UI shows "champion of tier X" rather than
  -- an empty draw.
  champion_id uuid REFERENCES public.placement_entrants(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category_id, tier)
);

CREATE INDEX IF NOT EXISTS tier_draws_tournament_idx ON public.tier_draws (tournament_id);
CREATE INDEX IF NOT EXISTS tier_draws_category_idx ON public.tier_draws (category_id);

GRANT SELECT ON public.tier_draws TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tier_draws TO authenticated;
GRANT ALL ON public.tier_draws TO service_role;
ALTER TABLE public.tier_draws ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tier_draws public read" ON public.tier_draws;
CREATE POLICY "tier_draws public read" ON public.tier_draws FOR SELECT USING (true);

DROP POLICY IF EXISTS "tier_draws staff write" ON public.tier_draws;
CREATE POLICY "tier_draws staff write" ON public.tier_draws
FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin', 'scheduler']))
WITH CHECK (public.has_staff_role(ARRAY['admin', 'scheduler']));

-------------------------------------------------------------------------------
-- 4. tier_draw_matches: bracket rounds, with byes
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tier_draw_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  draw_id uuid NOT NULL REFERENCES public.tier_draws(id) ON DELETE CASCADE,
  round int NOT NULL CHECK (round >= 1),
  slot int NOT NULL CHECK (slot >= 1),
  entrant_a_id uuid REFERENCES public.placement_entrants(id) ON DELETE SET NULL,
  entrant_b_id uuid REFERENCES public.placement_entrants(id) ON DELETE SET NULL,
  winner_id uuid REFERENCES public.placement_entrants(id) ON DELETE SET NULL,
  -- The two matches whose winners meet in this one. Null in round one.
  parent_a_id uuid REFERENCES public.tier_draw_matches(id) ON DELETE SET NULL,
  parent_b_id uuid REFERENCES public.tier_draw_matches(id) ON DELETE SET NULL,
  games jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Opposite rule from the placement stage: byes are allowed here, and go to the
  -- highest seed without one. A bye is pre-decided and never played.
  is_bye boolean NOT NULL DEFAULT false,
  court_id uuid REFERENCES public.courts(id) ON DELETE SET NULL,
  scheduled_time timestamptz,
  started_at timestamptz,
  -- When the match actually finished, which is what the rest-gap check reads.
  ended_at timestamptz,
  reported_time timestamptz,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'in-progress', 'reported', 'walkover', 'bye', 'void')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draw_id, round, slot)
);

CREATE INDEX IF NOT EXISTS tier_draw_matches_tournament_idx
  ON public.tier_draw_matches (tournament_id);
CREATE INDEX IF NOT EXISTS tier_draw_matches_draw_idx
  ON public.tier_draw_matches (draw_id);

GRANT SELECT ON public.tier_draw_matches TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tier_draw_matches TO authenticated;
GRANT ALL ON public.tier_draw_matches TO service_role;
ALTER TABLE public.tier_draw_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tier_draw_matches public read" ON public.tier_draw_matches;
CREATE POLICY "tier_draw_matches public read" ON public.tier_draw_matches
FOR SELECT USING (true);

DROP POLICY IF EXISTS "tier_draw_matches staff write" ON public.tier_draw_matches;
CREATE POLICY "tier_draw_matches staff write" ON public.tier_draw_matches
FOR ALL TO authenticated
USING (public.has_staff_role(ARRAY['admin', 'scheduler']))
WITH CHECK (public.has_staff_role(ARRAY['admin', 'scheduler']));

-------------------------------------------------------------------------------
-- 5. Desk activity trail for the new match tables
-------------------------------------------------------------------------------

-- `record_desk_match_activity()` writes `TG_TABLE_NAME`, so it already works for
-- any table with the same column shape. The existing triggers only cover
-- `pool_matches` and `draw_matches`, so the new tables need their own.
DROP TRIGGER IF EXISTS placement_matches_desk_activity ON public.placement_matches;
CREATE TRIGGER placement_matches_desk_activity
AFTER UPDATE OF status, court_id, scheduled_time ON public.placement_matches
FOR EACH ROW EXECUTE FUNCTION public.record_desk_match_activity();

DROP TRIGGER IF EXISTS tier_draw_matches_desk_activity ON public.tier_draw_matches;
CREATE TRIGGER tier_draw_matches_desk_activity
AFTER UPDATE OF status, court_id, scheduled_time ON public.tier_draw_matches
FOR EACH ROW EXECUTE FUNCTION public.record_desk_match_activity();

-------------------------------------------------------------------------------
-- 6. delete_tournament: also clear activity for the new match tables
-------------------------------------------------------------------------------

-- Redefined for the same reason the original documents: `desk_activity` has no
-- `tournament_id` and no foreign key, so its rows for these matches would outlive
-- the tournament and keep showing up on the desk for matches that no longer
-- exist. Everything else cascades from `tournaments` by foreign key.
CREATE OR REPLACE FUNCTION public.delete_tournament(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exists boolean;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournaments'));

  SELECT true INTO v_exists FROM public.tournaments WHERE id = p_tournament_id;
  IF v_exists IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  DELETE FROM public.desk_activity
  WHERE match_id IN (
    SELECT id FROM public.pool_matches WHERE tournament_id = p_tournament_id
    UNION ALL
    SELECT id FROM public.draw_matches WHERE tournament_id = p_tournament_id
    UNION ALL
    SELECT id FROM public.placement_matches WHERE tournament_id = p_tournament_id
    UNION ALL
    SELECT id FROM public.tier_draw_matches WHERE tournament_id = p_tournament_id
  );

  DELETE FROM public.tournaments WHERE id = p_tournament_id;
END;
$$;

-- CREATE OR REPLACE keeps the OID and therefore the existing ACL, but the revoke
-- is re-asserted rather than assumed: a fresh database applies this migration
-- without the hardening migration's revokes having run over this function.
REVOKE ALL ON FUNCTION public.delete_tournament(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_tournament(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
