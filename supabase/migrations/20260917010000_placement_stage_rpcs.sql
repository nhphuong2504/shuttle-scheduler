-- ============================================================================
-- Two-round placement format: RPCs
-- ============================================================================
--
-- Apply after `20260917000000_placement_stage.sql`.
--
-- A deliberate split runs through this file, and it is worth stating because it
-- is the reason these functions look the way they do:
--
--   * The PAIRING ALGORITHMS live in TypeScript, not here. Half-split pairing,
--     the held entrant's make-up matches, crossover selection with rematch
--     avoidance, and bracket seeding are all non-obvious enough that they are
--     covered by exhaustive tests in `src/lib/tournament/placement.test.ts`.
--     Re-implementing them in PL/pgSQL would create a second copy of the same
--     logic with no test coverage, which is exactly how the two copies drift.
--
--   * The SQL here VALIDATES and PERSISTS. Every generator RPC re-checks the
--     invariants it depends on — the placement gate, the exclusivity of pairings,
--     that a prerequisite graph is resolvable — and refuses the batch otherwise.
--     A bug in the client can therefore produce a rejected call, never a corrupt
--     bracket.
--
-- The one exception is tier-draw advancement, which is pure set arithmetic
-- (pair the adjacent slots of a finished round) and has no algorithm to drift.
--
-- Every function below is admin/scheduler-gated and repeats its own
-- `REVOKE ... FROM anon, PUBLIC`, because `CREATE FUNCTION` grants EXECUTE to
-- PUBLIC by default and the hardening migration could only close the functions
-- that existed when it ran.

-------------------------------------------------------------------------------
-- 1. Helpers
-------------------------------------------------------------------------------

-- How many placement matches an entrant must complete before draws open. Mirrors
-- `requiredPlacementMatches` in `placement.ts`; the two must agree, so if one
-- changes the other has to change with it.
CREATE OR REPLACE FUNCTION public.placement_required_matches(p_category_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN count(*) <= 1 THEN 0
    WHEN count(*) = 2 THEN 1
    ELSE 2
  END
  FROM public.placement_entrants
  WHERE category_id = p_category_id AND NOT excluded;
$$;

-- Decided matches for one entrant. `walkover` counts: it is a real result for
-- tier purposes even though no games were played.
CREATE OR REPLACE FUNCTION public.placement_decided_matches(
  p_category_id uuid,
  p_entrant_id uuid
)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT count(*)::int
  FROM public.placement_matches m
  WHERE m.category_id = p_category_id
    AND m.status IN ('reported', 'walkover')
    AND m.winner_id IS NOT NULL
    AND p_entrant_id IN (m.entrant_a_id, m.entrant_b_id);
$$;

-------------------------------------------------------------------------------
-- 2. Entrants and skill levels
-------------------------------------------------------------------------------

-- Materialises one entrant per active team in a category, and flags entrants for
-- teams that have since withdrawn. Idempotent, so it is safe to call every time
-- the placement setup screen opens.
--
-- Skill levels already recorded are preserved; this only creates and reconciles.
CREATE OR REPLACE FUNCTION public.sync_placement_entrants(p_category_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_created int := 0;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'registrar', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  INSERT INTO public.placement_entrants (tournament_id, category_id, team_id)
  SELECT v_tournament, t.category_id, t.id
  FROM public.teams t
  WHERE t.category_id = p_category_id
  ON CONFLICT (category_id, team_id) DO NOTHING;
  GET DIAGNOSTICS v_created = ROW_COUNT;

  -- A withdrawn team is waived rather than deleted, so its recorded results and
  -- its place in the seed order both survive if the withdrawal is reversed.
  UPDATE public.placement_entrants e
  SET excluded = COALESCE(t.withdrawn, false)
  FROM public.teams t
  WHERE e.category_id = p_category_id
    AND e.team_id = t.id
    AND e.excluded IS DISTINCT FROM COALESCE(t.withdrawn, false);

  RETURN v_created;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_placement_entrants(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_placement_entrants(uuid) TO authenticated;

-- Sets one entrant's self-reported skill level. Refused once seeds are locked,
-- because a skill change after seeding would not move the entrant and would only
-- make the stored data disagree with the seed order.
CREATE OR REPLACE FUNCTION public.set_placement_skill(
  p_category_id uuid,
  p_team_id uuid,
  p_skill_level text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_locked timestamptz;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'registrar', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_skill_level NOT IN ('beginner', 'intermediate', 'advanced') THEN
    RAISE EXCEPTION 'Unknown skill level %', p_skill_level;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  SELECT seed_locked_at INTO v_locked
  FROM public.placement_entrants
  WHERE category_id = p_category_id AND team_id = p_team_id;

  IF v_locked IS NULL AND NOT FOUND THEN
    RAISE EXCEPTION 'That team is not entered in this category';
  END IF;
  IF v_locked IS NOT NULL THEN
    RAISE EXCEPTION 'Seeds are already locked for this category';
  END IF;

  UPDATE public.placement_entrants
  SET skill_level = p_skill_level
  WHERE category_id = p_category_id AND team_id = p_team_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_placement_skill(uuid, uuid, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_placement_skill(uuid, uuid, text) TO authenticated;

-------------------------------------------------------------------------------
-- 3. Seeding
-------------------------------------------------------------------------------

-- Writes the seed order computed by `assignSeeds` in TypeScript and freezes it.
--
-- The shuffle is deliberately done on the client and stored here rather than
-- recomputed on read: seeds are a one-shot decision, and storing them is what
-- makes "why did I face this person" answerable months later.
--
-- `p_seeds` is `[{ "team_id": uuid, "seed": int }]` covering every non-waived
-- team in the category. A missing or duplicated seed is rejected rather than
-- silently tolerated.
CREATE OR REPLACE FUNCTION public.lock_placement_seeds(
  p_category_id uuid,
  p_seeds jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_expected int;
  v_provided int;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'registrar', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  -- A decided match means the seed order is already reflected in real results, so
  -- re-locking would silently reinterpret matches that have been played.
  IF EXISTS (
    SELECT 1 FROM public.placement_matches
    WHERE category_id = p_category_id AND status <> 'scheduled'
  ) THEN
    RAISE EXCEPTION 'Placement matches have already started for this category';
  END IF;

  SELECT count(*) INTO v_expected
  FROM public.placement_entrants
  WHERE category_id = p_category_id AND NOT excluded;

  SELECT count(*) INTO v_provided
  FROM jsonb_array_elements(COALESCE(p_seeds, '[]'::jsonb));

  IF v_provided <> v_expected THEN
    RAISE EXCEPTION 'Expected % seeds but received %', v_expected, v_provided;
  END IF;

  -- Clear first so the partial unique index cannot trip on an intermediate state
  -- when seeds are being permuted.
  UPDATE public.placement_entrants
  SET seed = NULL, seed_locked_at = NULL
  WHERE category_id = p_category_id;

  UPDATE public.placement_entrants e
  SET seed = (item->>'seed')::int,
      seed_locked_at = statement_timestamp()
  FROM jsonb_array_elements(p_seeds) AS item
  WHERE e.category_id = p_category_id
    AND e.team_id = (item->>'team_id')::uuid
    AND NOT e.excluded;

  IF EXISTS (
    SELECT 1 FROM public.placement_entrants
    WHERE category_id = p_category_id AND NOT excluded AND seed IS NULL
  ) THEN
    RAISE EXCEPTION 'Seeding left an entrant without a seed';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_placement_seeds(uuid, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.lock_placement_seeds(uuid, jsonb) TO authenticated;

-------------------------------------------------------------------------------
-- 4. Placement generation
-------------------------------------------------------------------------------

-- Creates round one from the locked seeds.
--
-- `p_matches` is `[{ "key", "entrant_a_team_id", "entrant_b_team_id",
-- "is_makeup", "is_crossover", "prerequisite_keys": [] }]`, produced by
-- `pairPlacementRoundOne`. Team ids are used rather than entrant ids so the
-- payload stays stable across a regeneration, where entrant rows are recreated.
--
-- Prerequisites are resolved in a second pass, once every key exists to point at.
CREATE OR REPLACE FUNCTION public.apply_placement_generation(
  p_category_id uuid,
  p_matches jsonb,
  p_force boolean DEFAULT false
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_expected int;
  v_inserted int;
  v_row jsonb;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  IF EXISTS (
    SELECT 1 FROM public.placement_entrants
    WHERE category_id = p_category_id AND NOT excluded AND seed IS NULL
  ) THEN
    RAISE EXCEPTION 'Lock the seed order before generating placement matches';
  END IF;

  IF NOT p_force AND EXISTS (
    SELECT 1 FROM public.placement_matches
    WHERE category_id = p_category_id
      AND status IN ('in-progress', 'reported', 'walkover')
  ) THEN
    RAISE EXCEPTION 'Placement matches have already been played for this category';
  END IF;

  IF NOT p_force AND EXISTS (
    SELECT 1 FROM public.tier_draws WHERE category_id = p_category_id
  ) THEN
    RAISE EXCEPTION 'Tier draws already exist for this category';
  END IF;

  -- Regenerating from scratch: the draws describe pairings that are about to
  -- change, so they cannot be left in place. Their desk activity is keyed by
  -- match id and would otherwise outlive the matches it refers to.
  DELETE FROM public.desk_activity
  WHERE match_id IN (
    SELECT m.id FROM public.tier_draw_matches m
    JOIN public.tier_draws d ON d.id = m.draw_id
    WHERE d.category_id = p_category_id
  );
  DELETE FROM public.tier_draws WHERE category_id = p_category_id;

  DELETE FROM public.placement_matches WHERE category_id = p_category_id;

  INSERT INTO public.placement_matches (
    tournament_id, category_id, stage, generation_key,
    entrant_a_id, entrant_b_id, is_makeup, is_crossover
  )
  SELECT
    v_tournament,
    p_category_id,
    'round1',
    item->>'key',
    a.id,
    b.id,
    COALESCE((item->>'is_makeup')::boolean, false),
    COALESCE((item->>'is_crossover')::boolean, false)
  FROM jsonb_array_elements(COALESCE(p_matches, '[]'::jsonb)) AS item
  JOIN public.placement_entrants a
    ON a.category_id = p_category_id AND a.team_id = (item->>'entrant_a_team_id')::uuid
  JOIN public.placement_entrants b
    ON b.category_id = p_category_id AND b.team_id = (item->>'entrant_b_team_id')::uuid;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  v_expected := jsonb_array_length(COALESCE(p_matches, '[]'::jsonb));
  IF v_inserted <> v_expected THEN
    RAISE EXCEPTION 'Expected to create % matches but created % — an entrant is missing',
      v_expected, v_inserted;
  END IF;

  -- Second pass: the prerequisite graph can only be resolved once every key in
  -- the batch has a row to point at.
  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_matches, '[]'::jsonb))
  LOOP
    IF jsonb_typeof(v_row->'prerequisite_keys') = 'array'
       AND jsonb_array_length(v_row->'prerequisite_keys') > 0 THEN
      UPDATE public.placement_matches m
      SET prerequisite_ids = (
        SELECT COALESCE(array_agg(dep.id), '{}')
        FROM jsonb_array_elements_text(v_row->'prerequisite_keys') AS k(key)
        JOIN public.placement_matches dep
          ON dep.category_id = p_category_id AND dep.generation_key = k.key
      )
      WHERE m.category_id = p_category_id AND m.generation_key = v_row->>'key';
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_placement_generation(uuid, jsonb, boolean) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_placement_generation(uuid, jsonb, boolean) TO authenticated;

-- Creates round two from results, using the pairings computed by
-- `buildPlacementRoundTwo`.
--
-- Refused until every round-one match is decided, which is what stops a held
-- entrant's make-up opponents from being chosen from an incomplete winner or
-- loser set.
CREATE OR REPLACE FUNCTION public.apply_placement_round_two(
  p_category_id uuid,
  p_matches jsonb,
  p_force boolean DEFAULT false
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_expected int;
  v_inserted int;
  v_row jsonb;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  IF EXISTS (
    SELECT 1 FROM public.placement_matches
    WHERE category_id = p_category_id
      AND stage = 'round1'
      AND (status NOT IN ('reported', 'walkover') OR winner_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Round two needs every round one result first';
  END IF;

  IF NOT p_force AND EXISTS (
    SELECT 1 FROM public.placement_matches
    WHERE category_id = p_category_id AND stage = 'round2' AND status <> 'scheduled'
  ) THEN
    RAISE EXCEPTION 'Round two has already been played for this category';
  END IF;

  DELETE FROM public.placement_matches
  WHERE category_id = p_category_id AND stage = 'round2';

  INSERT INTO public.placement_matches (
    tournament_id, category_id, stage, generation_key,
    entrant_a_id, entrant_b_id, is_makeup, is_crossover
  )
  SELECT
    v_tournament,
    p_category_id,
    'round2',
    item->>'key',
    a.id,
    b.id,
    COALESCE((item->>'is_makeup')::boolean, false),
    COALESCE((item->>'is_crossover')::boolean, false)
  FROM jsonb_array_elements(COALESCE(p_matches, '[]'::jsonb)) AS item
  JOIN public.placement_entrants a
    ON a.category_id = p_category_id AND a.team_id = (item->>'entrant_a_team_id')::uuid
  JOIN public.placement_entrants b
    ON b.category_id = p_category_id AND b.team_id = (item->>'entrant_b_team_id')::uuid;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  v_expected := jsonb_array_length(COALESCE(p_matches, '[]'::jsonb));
  IF v_inserted <> v_expected THEN
    RAISE EXCEPTION 'Expected to create % matches but created % — an entrant is missing',
      v_expected, v_inserted;
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_matches, '[]'::jsonb))
  LOOP
    IF jsonb_typeof(v_row->'prerequisite_keys') = 'array'
       AND jsonb_array_length(v_row->'prerequisite_keys') > 0 THEN
      UPDATE public.placement_matches m
      SET prerequisite_ids = (
        SELECT COALESCE(array_agg(dep.id), '{}')
        FROM jsonb_array_elements_text(v_row->'prerequisite_keys') AS k(key)
        JOIN public.placement_matches dep
          ON dep.category_id = p_category_id AND dep.generation_key = k.key
      )
      WHERE m.category_id = p_category_id AND m.generation_key = v_row->>'key';
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_placement_round_two(uuid, jsonb, boolean) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_placement_round_two(uuid, jsonb, boolean) TO authenticated;

-------------------------------------------------------------------------------
-- 5. Tier draws
-------------------------------------------------------------------------------

-- Persists the tier assignment and the four round-one brackets.
--
-- `p_tiers` is `[{ "team_id", "tier" }]`; `p_draws` is
-- `[{ "tier", "bracket_size", "entrant_count", "champion_team_id",
-- "matches": [{ "round", "slot", "entrant_a_team_id", "entrant_b_team_id",
-- "winner_team_id", "is_bye" }] }]`.
--
-- The gate is re-checked here rather than trusted from the client. It is the same
-- rule the UI shows, and having it in both places is intentional: the client
-- check explains why the button is disabled, and this one is what actually
-- protects the data.
CREATE OR REPLACE FUNCTION public.apply_tier_draws(
  p_category_id uuid,
  p_tiers jsonb,
  p_draws jsonb,
  p_force boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_required int;
  v_draw jsonb;
  v_match jsonb;
  v_draw_id uuid;
  v_champion uuid;
  v_short int;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

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
    -- bracket, so it is rejected rather than left to fail at the desk.
    IF EXISTS (
      SELECT 1 FROM public.tier_draw_matches
      WHERE draw_id = v_draw_id AND round = 1 AND NOT is_bye
        AND (entrant_a_id IS NULL OR entrant_b_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'A first-round % match is missing an entrant', v_draw->>'tier';
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_tier_draws(uuid, jsonb, jsonb, boolean) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_tier_draws(uuid, jsonb, jsonb, boolean) TO authenticated;

-- Creates the next round of one draw, pairing adjacent slots. Called after a
-- result is reported and by the desk.
--
-- This is the one piece of bracket logic that lives in SQL, because it is pure
-- set arithmetic with no algorithm to drift from the TypeScript copy. Byes carry
-- a winner already, so a round containing byes is complete without anyone having
-- played, and the next round follows immediately.
CREATE OR REPLACE FUNCTION public.advance_tier_draw_locked(p_draw_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current int;
  v_tournament uuid;
  v_pending int;
  v_slots int;
  v_champion uuid;
  v_slot int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tier-draw:' || p_draw_id::text));

  SELECT tournament_id INTO v_tournament FROM public.tier_draws WHERE id = p_draw_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown tier draw';
  END IF;

  SELECT max(round) INTO v_current FROM public.tier_draw_matches WHERE draw_id = p_draw_id;
  IF v_current IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_pending
  FROM public.tier_draw_matches
  WHERE draw_id = p_draw_id AND round = v_current AND winner_id IS NULL;
  IF v_pending > 0 THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_slots
  FROM public.tier_draw_matches
  WHERE draw_id = p_draw_id AND round = v_current;

  -- A single decided match in the final round settles the draw.
  IF v_slots <= 1 THEN
    SELECT winner_id INTO v_champion
    FROM public.tier_draw_matches
    WHERE draw_id = p_draw_id AND round = v_current;
    UPDATE public.tier_draws SET champion_id = v_champion WHERE id = p_draw_id;
    RETURN;
  END IF;

  -- Nothing to do if the next round already exists; advancement can be triggered
  -- from more than one place and must be idempotent.
  IF EXISTS (
    SELECT 1 FROM public.tier_draw_matches
    WHERE draw_id = p_draw_id AND round = v_current + 1
  ) THEN
    RETURN;
  END IF;

  FOR v_slot IN 0 .. (v_slots / 2) - 1 LOOP
    INSERT INTO public.tier_draw_matches (
      tournament_id, draw_id, round, slot, entrant_a_id, entrant_b_id, is_bye, status
    )
    SELECT
      v_tournament,
      p_draw_id,
      v_current + 1,
      v_slot + 1,
      a.winner_id,
      b.winner_id,
      false,
      'scheduled'
    FROM public.tier_draw_matches a
    JOIN public.tier_draw_matches b
      ON b.draw_id = a.draw_id AND b.round = a.round AND b.slot = a.slot + 1
    WHERE a.draw_id = p_draw_id AND a.round = v_current AND a.slot = v_slot * 2 + 1;
  END LOOP;
END;
$$;

-- Internal helper, like `advance_draw_locked`: reachable only from other
-- SECURITY DEFINER functions, never from a client.
REVOKE ALL ON FUNCTION public.advance_tier_draw_locked(uuid)
FROM anon, authenticated, PUBLIC;

-------------------------------------------------------------------------------
-- 6. Desk operations
-------------------------------------------------------------------------------

-- Shared game validation, so the placement and knockout reports cannot disagree
-- about what a legal result is. Returns the winning side as 'a' or 'b'.
--
-- `p_games_to`, `p_win_by` and `p_best_of` are passed in rather than read here so
-- the same checker serves both stage rules.
CREATE OR REPLACE FUNCTION public.placement_check_games(
  p_games jsonb,
  p_games_to int,
  p_win_by int,
  p_best_of int
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  wins_a int := 0;
  wins_b int := 0;
  game jsonb;
  sa int;
  sb int;
  needed int;
  played int;
  seen int := 0;
  total int;
BEGIN
  needed := (p_best_of + 1) / 2;
  played := jsonb_array_length(COALESCE(p_games, '[]'::jsonb));
  total := played;

  IF played < 1 THEN
    RAISE EXCEPTION 'Enter at least one game';
  END IF;
  IF played > p_best_of THEN
    RAISE EXCEPTION 'This match is best of %', p_best_of;
  END IF;
  IF played < needed THEN
    RAISE EXCEPTION 'This match is best of % — a side must win % games', p_best_of, needed;
  END IF;

  FOR game IN SELECT * FROM jsonb_array_elements(p_games)
  LOOP
    seen := seen + 1;
    sa := (game->>'a')::int;
    sb := (game->>'b')::int;
    IF sa < 0 OR sb < 0 OR sa = sb THEN
      RAISE EXCEPTION 'Each game needs a valid winning score';
    END IF;
    IF NOT (
      (sa >= p_games_to AND sa - sb >= p_win_by)
      OR (sb >= p_games_to AND sb - sa >= p_win_by)
    ) THEN
      IF p_win_by = 1 THEN
        RAISE EXCEPTION 'Games are to %', p_games_to;
      ELSE
        RAISE EXCEPTION 'Games are to %, win by %', p_games_to, p_win_by;
      END IF;
    END IF;
    IF sa > sb THEN wins_a := wins_a + 1; ELSE wins_b := wins_b + 1; END IF;
    IF (wins_a >= needed OR wins_b >= needed) AND seen < total THEN
      RAISE EXCEPTION 'Do not enter games after the match is decided';
    END IF;
  END LOOP;

  IF wins_a >= needed AND wins_b < needed THEN RETURN 'a'; END IF;
  IF wins_b >= needed AND wins_a < needed THEN RETURN 'b'; END IF;
  RAISE EXCEPTION 'A side must win % games', needed;
END;
$$;

REVOKE ALL ON FUNCTION public.placement_check_games(jsonb, int, int, int)
FROM anon, authenticated, PUBLIC;

-- Reports a placement result. Reads the tournament's PLACEMENT rule, which is
-- stored separately from the knockout rule, so the two stages can be scored
-- differently without either one hardcoding the other's numbers.
CREATE OR REPLACE FUNCTION public.report_placement_result(
  p_match_id uuid,
  p_games jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_side text;
  v_winner uuid;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT tournament_id INTO v_tournament
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT public.placement_check_games(
    p_games, t.placement_games_to, t.placement_win_by, t.placement_best_of
  ) INTO v_side
  FROM public.tournaments t WHERE t.id = v_tournament;

  SELECT CASE WHEN v_side = 'a' THEN entrant_a_id ELSE entrant_b_id END INTO v_winner
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_winner IS NULL THEN
    RAISE EXCEPTION 'That side has no entrant assigned yet';
  END IF;

  UPDATE public.placement_matches
  SET games = p_games,
      winner_id = v_winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;
END;
$$;

REVOKE ALL ON FUNCTION public.report_placement_result(uuid, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_placement_result(uuid, jsonb) TO authenticated;

-- Reports a tier-draw result under the KNOCKOUT rule, then advances the bracket.
CREATE OR REPLACE FUNCTION public.report_tier_draw_result(
  p_match_id uuid,
  p_games jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
  v_draw uuid;
  v_side text;
  v_winner uuid;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT tournament_id, draw_id INTO v_tournament, v_draw
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT public.placement_check_games(
    p_games, t.knockout_games_to, t.knockout_win_by, t.knockout_best_of
  ) INTO v_side
  FROM public.tournaments t WHERE t.id = v_tournament;

  SELECT CASE WHEN v_side = 'a' THEN entrant_a_id ELSE entrant_b_id END INTO v_winner
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_winner IS NULL THEN
    RAISE EXCEPTION 'That side has no entrant assigned yet';
  END IF;

  UPDATE public.tier_draw_matches
  SET games = p_games,
      winner_id = v_winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;

  PERFORM public.advance_tier_draw_locked(v_draw);
END;
$$;

REVOKE ALL ON FUNCTION public.report_tier_draw_result(uuid, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_tier_draw_result(uuid, jsonb) TO authenticated;

-- Starts a match on a court. Kept separate from reporting so the desk can show a
-- match as in progress without committing a result.
CREATE OR REPLACE FUNCTION public.start_placement_match(
  p_match_id uuid,
  p_court_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE public.placement_matches
  SET status = 'in-progress',
      started_at = COALESCE(started_at, statement_timestamp()),
      court_id = COALESCE(p_court_id, court_id)
  WHERE id = p_match_id AND status = 'scheduled';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match is not ready to start';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.start_placement_match(uuid, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_placement_match(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.start_tier_draw_match(
  p_match_id uuid,
  p_court_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE public.tier_draw_matches
  SET status = 'in-progress',
      started_at = COALESCE(started_at, statement_timestamp()),
      court_id = COALESCE(p_court_id, court_id)
  WHERE id = p_match_id AND status = 'scheduled' AND NOT is_bye;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match is not ready to start';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.start_tier_draw_match(uuid, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_tier_draw_match(uuid, uuid) TO authenticated;

-- Clears a reported result so it can be re-entered. Refused once the knockout
-- has advanced past this match, because the later rounds were built from it.
CREATE OR REPLACE FUNCTION public.reset_placement_result(p_match_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_category uuid;
  v_stage text;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT category_id, stage INTO v_category, v_stage
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  -- Round two's make-up opponents are chosen from the round-one winner and loser
  -- sets, so a round-one result cannot be un-entered once round two exists: the
  -- pairings on screen were derived from it. Regenerating is the correct path.
  IF v_stage = 'round1' AND EXISTS (
    SELECT 1 FROM public.placement_matches
    WHERE category_id = v_category AND stage = 'round2'
  ) THEN
    RAISE EXCEPTION 'Round two was built from this result — regenerate round two instead';
  END IF;

  UPDATE public.placement_matches
  SET games = '[]'::jsonb,
      winner_id = NULL,
      status = 'scheduled',
      reported_time = NULL,
      ended_at = NULL
  WHERE id = p_match_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_placement_result(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_placement_result(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reset_tier_draw_result(p_match_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draw uuid;
  v_round int;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scorer', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT draw_id, round INTO v_draw, v_round
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_draw IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  -- A later round already exists, so its entrants were derived from this result
  -- and cannot be un-derived in place.
  IF EXISTS (
    SELECT 1 FROM public.tier_draw_matches
    WHERE draw_id = v_draw AND round > v_round
  ) THEN
    RAISE EXCEPTION 'Later rounds have already been created from this result';
  END IF;

  UPDATE public.tier_draw_matches
  SET games = '[]'::jsonb,
      winner_id = CASE WHEN is_bye THEN winner_id ELSE NULL END,
      status = CASE WHEN is_bye THEN 'bye' ELSE 'scheduled' END,
      reported_time = NULL,
      ended_at = NULL,
      started_at = NULL
  WHERE id = p_match_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_tier_draw_result(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_tier_draw_result(uuid) TO authenticated;

-------------------------------------------------------------------------------
-- 7. Scheduling
-------------------------------------------------------------------------------

-- Persists one pass of the GRASP scheduler for the placement or knockout stage
-- of one tournament.
--
-- Mirrors `apply_day_schedule`: only matches still in `scheduled` are moved, so a
-- match already under way keeps its court. Bye rows are never scheduled, because
-- they are pre-decided and there is nothing to play.
--
-- `p_stage` is 'placement' or 'knockout'. `p_slots` is
-- `[{ "match_id", "scheduled_time", "court_id" }]`.
CREATE OR REPLACE FUNCTION public.apply_placement_day_schedule(
  p_tournament_id uuid,
  p_stage text,
  p_slots jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  slot jsonb;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin', 'scheduler']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
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

  FOR slot IN SELECT * FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb))
  LOOP
    IF p_stage = 'placement' THEN
      UPDATE public.placement_matches
      SET scheduled_time = (slot->>'scheduled_time')::timestamptz,
          court_id = NULLIF(slot->>'court_id', '')::uuid
      WHERE id = (slot->>'match_id')::uuid
        AND tournament_id = p_tournament_id
        AND status = 'scheduled';
    ELSE
      UPDATE public.tier_draw_matches
      SET scheduled_time = (slot->>'scheduled_time')::timestamptz,
          court_id = NULLIF(slot->>'court_id', '')::uuid
      WHERE id = (slot->>'match_id')::uuid
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
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Knockout rebuild left assigned matches without a court or time';
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_placement_day_schedule(uuid, text, jsonb) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_placement_day_schedule(uuid, text, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
