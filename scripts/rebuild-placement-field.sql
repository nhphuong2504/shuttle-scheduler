-- ===========================================================================
-- Rebuild a two-round-placement tournament's field at a chosen size.
--
-- WHY THIS EXISTS
--
-- A demo tournament carries a different entry count than the event is being
-- sized for. The field is not a free-standing number: entries drive the seed
-- order, the seed order drives the round-one pairings, and every match under a
-- category is derived from that. So "delete a few teams" is not a smaller
-- version of this script, it is a different and worse operation — it leaves the
-- placement stage quoting seeds it no longer has, and (under this format) a pile
-- of pool rows that the app cannot render as results.
--
-- This script therefore treats the field as one unit: it clears everything
-- derived from the current entries, brings the player roster to the size the new
-- field needs, builds the field, and re-derives the seeding. Nothing is
-- preserved from the old entries, which is the point — the field is being
-- re-cut, not trimmed.
--
-- WHAT IT TOUCHES
--
-- For the ACTIVE tournament only.
--
--   deleted   placement_matches, tier_draw_matches, tier_draws,
--             draw_matches, draws, pool_matches, pool_entries, pools,
--             placement_entrants, teams
--             plus any surplus demo players (see THE ROSTER)
--
--   created   demo players needed to reach the roster target
--
--   rebuilt   teams, placement_entrants (seeded, skill-graded, seed-locked)
--
-- The pool/draw tables are deleted because under `two_round_placement` they are
-- leftovers from the round-robin engine that predates this format: the app
-- ignores them, and `competition-format.ts` says why they must not be listed as
-- results. Clearing them is part of leaving the tournament consistent.
--
-- THE FIELD
--
-- Entries per category. The second and third columns are the gender of the
-- players each entry needs, and must agree with the category's own `entry_type`
-- / `gender` — the script checks that before it writes anything, so a typo here
-- fails loudly instead of tripping a trigger halfway through the rebuild.
--
--   MS 59 (1 man)    MD 40 (2 men)     WS 23 (1 woman)
--   WD 18 (2 women)  XD 49 (1 of each)
--
--   = 189 entries, needing 188 men's seats and 108 women's seats.
--
-- THE ROSTER
--
-- Two constraints come out of the plan that the per-player cap cannot express,
-- and both are easy to miss:
--
--   1. A doubles entry needs two *different* players, so Men's Doubles needs 80
--      distinct men and Mixed Doubles needs 49 distinct women. That is a floor
--      on the roster that is independent of the cap.
--   2. Everything else is seats over the cap: 188 men's seats over
--      `max_categories_per_player`, and 108 women's.
--
-- So the roster must hold at least
--
--   max(80, ceil(188/3)) = 80 men      max(49, ceil(108/3)) = 49 women
--
-- and the targets below are checked against that before anything is deleted. The
-- women's floor is the binding one here: 49 mixed pairs need 49 different women,
-- so a roster of 34 — or even 46 — cannot field this plan at any cap. A roster
-- that is too small is a data problem, not a scheduling one, and the script says
-- so rather than half-building a field.
--
-- Players are dealt to the seats least-loaded-first, in seed order, and a player
-- is never dealt twice into the same category. That single rule gives four
-- things at once without being told: each category gets its own players, pairs
-- never contain the same player twice, the field spreads across the roster, and
-- nobody exceeds the cap. The script asserts all four afterwards rather than
-- trusting the deal.
--
-- Only players whose name matches the demo pattern (`Man 007`) are created or
-- removed, and only a player with no entry in any tournament is removed. A real
-- registration can never be touched by this file.
--
-- Seeds are a dense 1..N per category, ordered by the strongest player in the
-- entry, and skill levels are the same thirds split `50-test-players.sql` uses.
-- `seed_locked_at` is set, which is the state the placement stage expects before
-- round one is generated.
--
-- HOW TO RUN
--
-- Paste it into the Supabase SQL editor, or run the whole file in one go against
-- a direct connection. The whole file is one transaction: it either rebuilds the
-- field or changes nothing.
--
-- It lives in `scripts/` rather than `supabase/seed/` on purpose. That directory
-- is the Supabase CLI's own seed hook, so `supabase db reset` would run it and
-- silently re-cut the field on every local reset — which is wrong for a file
-- whose input is a hand-chosen entry count. `scripts/` already holds this
-- repository's other destructive operator SQL (`reset-tournament-data.sql`).
-- ===========================================================================

DO $rebuild$
DECLARE
  v_tournament uuid;
  v_tname      text;
  v_format     text;
  v_cap        int;

  -- The roster the field is built from. Adjusted up or down to exactly this.
  v_men_target   int := 97;
  v_women_target int := 49;

  v_slot       record;
  v_rec        record;
  v_player     uuid;
  v_target     int;
  v_actual     int;
  v_worst      int;
  v_n          int;
  v_have       int;
  v_max        int;
  v_report     text := '';
BEGIN
  --------------------------------------------------------------------------
  -- 0. Which tournament, and is it the format this script can rebuild?
  --------------------------------------------------------------------------
  SELECT id, name, format, max_categories_per_player
  INTO v_tournament, v_tname, v_format, v_cap
  FROM public.tournaments
  WHERE is_active;

  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'No tournament is active, so there is no field to rebuild.';
  END IF;

  IF v_format IS DISTINCT FROM 'two_round_placement' THEN
    RAISE EXCEPTION
      'Tournament "%s" has format %s, not two_round_placement. This script rebuilds the placement field only.',
      v_tname, COALESCE(v_format, 'null');
  END IF;

  IF v_cap IS NULL OR v_cap < 1 THEN
    RAISE EXCEPTION 'Tournament "%s" has no usable max_categories_per_player.', v_tname;
  END IF;

  --------------------------------------------------------------------------
  -- 1. The plan.
  --------------------------------------------------------------------------
  CREATE TEMP TABLE tmp_plan (
    code          text NOT NULL PRIMARY KEY,
    entries       int  NOT NULL CHECK (entries > 0),
    slot_1_gender text NOT NULL CHECK (slot_1_gender IN ('M', 'F')),
    slot_2_gender text          CHECK (slot_2_gender IN ('M', 'F'))
  ) ON COMMIT DROP;

  INSERT INTO tmp_plan (code, entries, slot_1_gender, slot_2_gender) VALUES
    ('MS', 59, 'M', NULL),
    ('MD', 40, 'M', 'M'),
    ('WS', 23, 'F', NULL),
    ('WD', 18, 'F', 'F'),
    ('XD', 49, 'M', 'F');

  SELECT sum(entries) INTO v_target FROM tmp_plan;

  -- The plan and the tournament's own categories have to agree exactly. A plan
  -- that names a category the tournament does not run, or omits one it does,
  -- would silently build the wrong field.
  FOR v_rec IN
    SELECT p.code
    FROM tmp_plan p
    WHERE NOT EXISTS (
      SELECT 1 FROM public.categories c
      WHERE c.tournament_id = v_tournament AND c.code = p.code AND c.active
    )
  LOOP
    RAISE EXCEPTION 'Category % is not an active category of "%s".', v_rec.code, v_tname;
  END LOOP;

  FOR v_rec IN
    SELECT c.code
    FROM public.categories c
    WHERE c.tournament_id = v_tournament
      AND c.active
      AND NOT EXISTS (SELECT 1 FROM tmp_plan p WHERE p.code = c.code)
  LOOP
    RAISE EXCEPTION
      'Active category % is missing from the field plan. Add it, or an entry for it will not be built.',
      v_rec.code;
  END LOOP;

  -- The plan's shape must match what each category will accept, so a mistake is
  -- reported here rather than surfaced by `enforce_team_shape` mid-insert.
  IF EXISTS (
    SELECT 1
    FROM tmp_plan p
    JOIN public.categories c
      ON c.tournament_id = v_tournament AND c.code = p.code
    WHERE (c.entry_type = 'individual') <> (p.slot_2_gender IS NULL)
       OR (c.gender = 'men'   AND p.slot_1_gender <> 'M')
       OR (c.gender = 'men'   AND p.slot_2_gender = 'F')
       OR (c.gender = 'women' AND p.slot_1_gender <> 'F')
       OR (c.gender = 'women' AND p.slot_2_gender = 'M')
       OR (c.gender = 'mixed' AND p.slot_2_gender IS NULL)
       OR (c.gender = 'mixed' AND p.slot_1_gender = p.slot_2_gender)
  ) THEN
    RAISE EXCEPTION
      'The field plan disagrees with the category definitions of "%s": a planned gender or entry type is not one the category permits.',
      v_tname;
  END IF;

  --------------------------------------------------------------------------
  -- 2. Can the roster carry the plan? Checked before anything is deleted, so a
  --    roster that is too small is a refusal rather than a half-built field.
  --
  --    Per gender, the floor is the larger of two numbers: the most distinct
  --    players any one category needs (a doubles category needs two per entry),
  --    and the total seats divided by the cap.
  --------------------------------------------------------------------------
  FOR v_rec IN
    SELECT g.gender,
           max(p.entries * (CASE WHEN p.slot_1_gender = g.gender THEN 1 ELSE 0 END
                               + CASE WHEN p.slot_2_gender = g.gender THEN 1 ELSE 0 END)) AS most_distinct,
           sum(p.entries * (CASE WHEN p.slot_1_gender = g.gender THEN 1 ELSE 0 END
                               + CASE WHEN p.slot_2_gender = g.gender THEN 1 ELSE 0 END)) AS total_seats
    FROM tmp_plan p
    CROSS JOIN (VALUES ('M'), ('F')) AS g(gender)
    GROUP BY g.gender
  LOOP
    SELECT greatest(v_rec.most_distinct, ceil(v_rec.total_seats::numeric / v_cap)::int)
    INTO v_n;

    IF v_rec.gender = 'M' AND v_men_target < v_n THEN
      RAISE EXCEPTION
        'The plan needs at least % men (%s seats, and one category needs %s distinct players) but the roster target is %.',
        v_n, v_rec.total_seats, v_rec.most_distinct, v_men_target;
    END IF;

    IF v_rec.gender = 'F' AND v_women_target < v_n THEN
      RAISE EXCEPTION
        'The plan needs at least % women (%s seats, and one category needs %s distinct players) but the roster target is %.',
        v_n, v_rec.total_seats, v_rec.most_distinct, v_women_target;
    END IF;
  END LOOP;

  --------------------------------------------------------------------------
  -- 3. Clear everything derived from the current field, leaves first.
  --
  -- Pools and draws are included: under this format they are leftovers the app
  -- does not read, and leaving them would point match rows at teams this script
  -- is about to delete.
  --------------------------------------------------------------------------
  DELETE FROM public.tier_draw_matches WHERE tournament_id = v_tournament;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || format('  %-20s deleted %s%s', 'tier_draw_matches', v_n, E'\n');

  DELETE FROM public.tier_draws WHERE tournament_id = v_tournament;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || format('  %-20s deleted %s%s', 'tier_draws', v_n, E'\n');

  DELETE FROM public.placement_matches WHERE tournament_id = v_tournament;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || format('  %-20s deleted %s%s', 'placement_matches', v_n, E'\n');

  DELETE FROM public.draw_matches WHERE tournament_id = v_tournament;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || format('  %-20s deleted %s%s', 'draw_matches', v_n, E'\n');

  DELETE FROM public.draws WHERE tournament_id = v_tournament;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || format('  %-20s deleted %s%s', 'draws', v_n, E'\n');

  DELETE FROM public.pool_matches WHERE tournament_id = v_tournament;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || format('  %-20s deleted %s%s', 'pool_matches', v_n, E'\n');

  DELETE FROM public.pool_entries WHERE tournament_id = v_tournament;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || format('  %-20s deleted %s%s', 'pool_entries', v_n, E'\n');

  DELETE FROM public.pools WHERE tournament_id = v_tournament;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || format('  %-20s deleted %s%s', 'pools', v_n, E'\n');

  DELETE FROM public.placement_entrants WHERE tournament_id = v_tournament;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || format('  %-20s deleted %s%s', 'placement_entrants', v_n, E'\n');

  DELETE FROM public.teams WHERE tournament_id = v_tournament;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || format('  %-20s deleted %s%s', 'teams', v_n, E'\n');

  --------------------------------------------------------------------------
  -- 4. Bring the roster to the target size.
  --
  -- The first branch waives the rest of the purge, deliberately: fewer than the
  -- target can only happen for a real registration, and a real registration is
  -- not this script's to delete.
  -- --------------------------------------------------------------------------
  SELECT count(*), COALESCE(max(substring(name FROM '[0-9]+$')::int), 0)
  INTO v_have, v_max
  FROM public.players
  WHERE name ~ '^Man [0-9]+$';

  IF v_have < v_men_target THEN
    INSERT INTO public.players (name, gender)
    SELECT 'Man ' || lpad(n::text, 3, '0'), 'M'
    FROM generate_series(v_max + 1, v_max + (v_men_target - v_have)) AS n;

    v_report := v_report || format('  %-20s created %s%s', 'men', v_men_target - v_have, E'\n');
  ELSIF v_have > v_men_target THEN
    DELETE FROM public.players p
    WHERE p.name ~ '^Man [0-9]+$'
      AND NOT EXISTS (
        SELECT 1 FROM public.teams t
        WHERE t.player_1_id = p.id OR t.player_2_id = p.id
      )
      AND p.id IN (
        SELECT p2.id
        FROM public.players p2
        WHERE p2.name ~ '^Man [0-9]+$'
          AND NOT EXISTS (
            SELECT 1 FROM public.teams t
            WHERE t.player_1_id = p2.id OR t.player_2_id = p2.id
          )
        ORDER BY substring(p2.name FROM '[0-9]+$')::int DESC
        LIMIT v_have - v_men_target
      );

    v_report := v_report || format('  %-20s removed %s%s', 'men', v_have - v_men_target, E'\n');
  END IF;

  SELECT count(*), COALESCE(max(substring(name FROM '[0-9]+$')::int), 0)
  INTO v_have, v_max
  FROM public.players
  WHERE name ~ '^Woman [0-9]+$';

  IF v_have < v_women_target THEN
    INSERT INTO public.players (name, gender)
    SELECT 'Woman ' || lpad(n::text, 3, '0'), 'F'
    FROM generate_series(v_max + 1, v_max + (v_women_target - v_have)) AS n;

    v_report := v_report || format('  %-20s created %s%s', 'women', v_women_target - v_have, E'\n');
  ELSIF v_have > v_women_target THEN
    DELETE FROM public.players p
    WHERE p.name ~ '^Woman [0-9]+$'
      AND NOT EXISTS (
        SELECT 1 FROM public.teams t
        WHERE t.player_1_id = p.id OR t.player_2_id = p.id
      )
      AND p.id IN (
        SELECT p2.id
        FROM public.players p2
        WHERE p2.name ~ '^Woman [0-9]+$'
          AND NOT EXISTS (
            SELECT 1 FROM public.teams t
            WHERE t.player_1_id = p2.id OR t.player_2_id = p2.id
          )
        ORDER BY substring(p2.name FROM '[0-9]+$')::int DESC
        LIMIT v_have - v_women_target
      );

    v_report := v_report || format('  %-20s removed %s%s', 'women', v_have - v_women_target, E'\n');
  END IF;

  -- A player who survived a purge because they are entered somewhere else is a
  -- real registration, so the target is a floor the script reports on rather
  -- than a number it insists on.
  SELECT count(*) FILTER (WHERE gender = 'M'), count(*) FILTER (WHERE gender = 'F')
  INTO v_men_target, v_women_target
  FROM public.players
  WHERE name ~ '^(Man|Woman) [0-9]+$' AND gender IN ('M', 'F');

  --------------------------------------------------------------------------
  -- 5. One slot per player the new field needs.
  --
  -- A singles entry needs one slot, a doubles entry two, and a mixed entry one
  -- of each — which is what the plan's gender columns already say. Pair number
  -- is what later groups two slots into one entry.
  --------------------------------------------------------------------------
  CREATE TEMP TABLE tmp_slots (
    slot_id     serial PRIMARY KEY,
    category_id uuid NOT NULL,
    code        text NOT NULL,
    pair_no     int  NOT NULL,
    slot_no     int  NOT NULL,
    gender      text NOT NULL,
    player_id   uuid,
    UNIQUE (category_id, pair_no, slot_no)
  ) ON COMMIT DROP;

  INSERT INTO tmp_slots (category_id, code, pair_no, slot_no, gender)
  SELECT c.id, p.code, n.pair_no, s.slot_no, s.gender
  FROM tmp_plan p
  JOIN public.categories c
    ON c.tournament_id = v_tournament AND c.code = p.code
  CROSS JOIN LATERAL generate_series(1, p.entries) AS n(pair_no)
  CROSS JOIN LATERAL (
    VALUES (1, p.slot_1_gender), (2, p.slot_2_gender)
  ) AS s(slot_no, gender)
  WHERE s.gender IS NOT NULL
  ORDER BY c.sort_order, n.pair_no, s.slot_no;

  --------------------------------------------------------------------------
  -- 6. Deal players least-loaded-first.
  --
  -- Ordering by (load, name) is what makes the field deterministic: the same
  -- roster always produces the same field. Refusing a player who is already in
  -- this category is what keeps a pair from being one person twice, and capping
  -- the load is what keeps the per-player limit intact — a limit the database
  -- enforces anyway, but failing here names the category.
  --------------------------------------------------------------------------
  CREATE TEMP TABLE tmp_load (
    player_id uuid NOT NULL PRIMARY KEY,
    load      int  NOT NULL DEFAULT 0
  ) ON COMMIT DROP;

  INSERT INTO tmp_load (player_id)
  SELECT p.id FROM public.players p WHERE p.gender IN ('M', 'F');

  FOR v_slot IN
    SELECT s.*
    FROM tmp_slots s
    JOIN public.categories c ON c.id = s.category_id
    ORDER BY c.sort_order, s.pair_no, s.slot_no
  LOOP
    SELECT p.id
    INTO v_player
    FROM public.players p
    JOIN tmp_load l ON l.player_id = p.id
    WHERE p.gender = v_slot.gender
      AND l.load < v_cap
      AND NOT EXISTS (
        SELECT 1 FROM tmp_slots taken
        WHERE taken.category_id = v_slot.category_id
          AND taken.player_id = p.id
      )
    ORDER BY l.load, p.name, p.id
    LIMIT 1;

    IF v_player IS NULL THEN
      RAISE EXCEPTION
        'Ran out of % players for %: every candidate is already in the category or at the %-category limit. Raise the roster target or the cap.',
        v_slot.gender, v_slot.code, v_cap;
    END IF;

    UPDATE tmp_slots SET player_id = v_player WHERE slot_id = v_slot.slot_id;
    UPDATE tmp_load SET load = load + 1 WHERE player_id = v_player;
  END LOOP;

  --------------------------------------------------------------------------
  -- 7. Teams, one per pair. Seed order is by the stronger half of a pair, so
  --    the top seed is a genuinely strong entry rather than whichever slot the
  --    deal happened to fill first.
  --------------------------------------------------------------------------
  WITH ranked AS (
    SELECT p.id,
           row_number() OVER (PARTITION BY p.gender ORDER BY p.name, p.id) AS rank
    FROM public.players p
    WHERE p.gender IN ('M', 'F')
  ),
  entries AS (
    SELECT s.category_id,
           s.code,
           s.pair_no,
           (array_agg(s.player_id ORDER BY s.slot_no) FILTER (WHERE s.slot_no = 1))[1] AS player_1_id,
           (array_agg(s.player_id ORDER BY s.slot_no) FILTER (WHERE s.slot_no = 2))[1] AS player_2_id
    FROM tmp_slots s
    GROUP BY s.category_id, s.code, s.pair_no
  ),
  scored AS (
    SELECT e.*,
           least(r1.rank, COALESCE(r2.rank, r1.rank)) AS strength
    FROM entries e
    JOIN ranked r1 ON r1.id = e.player_1_id
    LEFT JOIN ranked r2 ON r2.id = e.player_2_id
  )
  INSERT INTO public.teams (tournament_id, category_id, player_1_id, player_2_id, seed)
  SELECT v_tournament,
         s.category_id,
         s.player_1_id,
         s.player_2_id,
         row_number() OVER (PARTITION BY s.category_id ORDER BY s.strength, s.player_1_id)
  FROM scored s;

  --------------------------------------------------------------------------
  -- 8. Entrants, which is what the placement stage actually reads.
  --
  -- This is the row set `sync_placement_entrants` would create, plus the seeding
  -- and skill levels the desk sets on /placement. The RPCs that normally write
  -- these are guarded by `has_staff_role`, and a script run outside the app has
  -- no JWT, so the rows are written directly — the same trade `50-test-players.sql`
  -- makes and for the same reason.
  --------------------------------------------------------------------------
  WITH ranked AS (
    SELECT t.id,
           t.category_id,
           t.seed,
           count(*) OVER (PARTITION BY t.category_id) AS total
    FROM public.teams t
    WHERE t.tournament_id = v_tournament
  )
  INSERT INTO public.placement_entrants (
    tournament_id, category_id, team_id, skill_level, seed, seed_locked_at
  )
  SELECT v_tournament,
         r.category_id,
         r.id,
         CASE
           WHEN r.seed <= ceil(r.total / 3.0)     THEN 'advanced'
           WHEN r.seed <= ceil(r.total * 2 / 3.0) THEN 'intermediate'
           ELSE 'beginner'
         END,
         r.seed,
         statement_timestamp()
  FROM ranked r;

  --------------------------------------------------------------------------
  -- 9. Assert what the plan claims. The triggers already enforce most of this,
  --    so these are documented invariants rather than the only defence — which
  --    is the point: if a trigger is ever relaxed, this still fails.
  --------------------------------------------------------------------------
  SELECT count(*) INTO v_actual
  FROM public.teams
  WHERE tournament_id = v_tournament;

  IF v_actual <> v_target THEN
    RAISE EXCEPTION 'Built %s entries, expected %s.', v_actual, v_target;
  END IF;

  FOR v_rec IN
    SELECT p.code, p.entries, count(t.id) AS built
    FROM tmp_plan p
    JOIN public.categories c
      ON c.tournament_id = v_tournament AND c.code = p.code
    LEFT JOIN public.teams t ON t.category_id = c.id
    GROUP BY p.code, p.entries, c.sort_order
    ORDER BY c.sort_order
  LOOP
    IF v_rec.built <> v_rec.entries THEN
      RAISE EXCEPTION 'Category %s built %s entries, expected %s.', v_rec.code, v_rec.built, v_rec.entries;
    END IF;
  END LOOP;

  -- Every team has exactly one entrant row, which is what the placement stage
  -- pairs from.
  SELECT count(*) INTO v_n
  FROM public.teams t
  WHERE t.tournament_id = v_tournament
    AND NOT EXISTS (SELECT 1 FROM public.placement_entrants e WHERE e.team_id = t.id);

  IF v_n <> 0 THEN
    RAISE EXCEPTION '%s team(s) have no placement entrant row.', v_n;
  END IF;

  -- Entrants are seeded and locked, so /placement opens ready to generate round
  -- one rather than asking for a shuffle first.
  SELECT count(*) INTO v_n
  FROM public.placement_entrants
  WHERE tournament_id = v_tournament
    AND (seed IS NULL OR seed_locked_at IS NULL OR seed < 1);

  IF v_n <> 0 THEN
    RAISE EXCEPTION '%s entrant(s) are missing a locked seed.', v_n;
  END IF;

  -- Seeds are dense 1..N per category.
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT category_id,
             max(seed) AS max_seed,
             count(*)  AS total
      FROM public.placement_entrants
      WHERE tournament_id = v_tournament
      GROUP BY category_id
    ) s
    WHERE s.max_seed <> s.total
  ) THEN
    RAISE EXCEPTION 'Seed order is not dense 1..N in at least one category.';
  END IF;

  -- No player twice in one category: the deal forbids it, and a duplicate would
  -- be a player playing themselves.
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT t.category_id, player.player_id
      FROM public.teams t
      CROSS JOIN LATERAL (
        VALUES (t.player_1_id), (t.player_2_id)
      ) AS player(player_id)
      WHERE t.tournament_id = v_tournament
        AND player.player_id IS NOT NULL
    ) m
    GROUP BY m.category_id, m.player_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'A player appears more than once in the same category.';
  END IF;

  -- Every player the plan needs is actually entered: a seat left empty would
  -- mean the deal found nobody, which the loop above would already have raised.
  SELECT count(*) INTO v_n
  FROM public.players p
  WHERE p.name ~ '^(Man|Woman) [0-9]+$'
    AND p.gender IN ('M', 'F')
    AND NOT EXISTS (
      SELECT 1 FROM public.teams t
      WHERE t.player_1_id = p.id OR t.player_2_id = p.id
    );

  IF v_n <> 0 THEN
    RAISE EXCEPTION '%s roster player(s) ended up with no entry.', v_n;
  END IF;

  -- And nobody above the per-player limit.
  SELECT max(cnt) INTO v_worst
  FROM (
    SELECT m.player_id, count(DISTINCT m.category_id) AS cnt
    FROM (
      SELECT t.category_id, player.player_id
      FROM public.teams t
      CROSS JOIN LATERAL (
        VALUES (t.player_1_id), (t.player_2_id)
      ) AS player(player_id)
      WHERE t.tournament_id = v_tournament
        AND player.player_id IS NOT NULL
    ) m
    GROUP BY m.player_id
  ) per_player;

  IF v_worst > v_cap THEN
    RAISE EXCEPTION 'A player ended up in %s categories, above the cap of %s.', v_worst, v_cap;
  END IF;

  -- No leftover pool or draw rows: under this format they are not results.
  SELECT (SELECT count(*) FROM public.pools WHERE tournament_id = v_tournament)
       + (SELECT count(*) FROM public.pool_matches WHERE tournament_id = v_tournament)
       + (SELECT count(*) FROM public.draws WHERE tournament_id = v_tournament)
       + (SELECT count(*) FROM public.draw_matches WHERE tournament_id = v_tournament)
  INTO v_n;

  IF v_n <> 0 THEN
    RAISE EXCEPTION '%s pool/draw row(s) survived the clear.', v_n;
  END IF;

  --------------------------------------------------------------------------
  -- 10. Report
  --------------------------------------------------------------------------
  RAISE NOTICE '%', format('Rebuilt "%s" (%s).', v_tname, v_tournament);
  RAISE NOTICE E'%', rtrim(v_report, E'\n');
  RAISE NOTICE '%', format('Roster: %s men, %s women (cap %s categories each).', v_men_target, v_women_target, v_cap);
  RAISE NOTICE '%', format('Built %s entries over %s players; busiest player is in %s categories.',
                           v_actual,
                           (SELECT count(*) FROM tmp_load WHERE load > 0),
                           v_worst);

  FOR v_rec IN
    SELECT c.code,
           count(DISTINCT e.id)                       AS entries,
           min(e.seed)                                AS first_seed,
           count(DISTINCT player.player_id)           AS players
    FROM public.placement_entrants e
    JOIN public.categories c ON c.id = e.category_id
    JOIN public.teams t ON t.id = e.team_id
    CROSS JOIN LATERAL (
      VALUES (t.player_1_id), (t.player_2_id)
    ) AS player(player_id)
    WHERE e.tournament_id = v_tournament
      AND player.player_id IS NOT NULL
    GROUP BY c.code, c.sort_order
    ORDER BY c.sort_order
  LOOP
    RAISE NOTICE '%', format('  %s %s entries, seeded %s..%s, drawing on %s players',
                             rpad(v_rec.code, 3), v_rec.entries,
                             v_rec.first_seed, v_rec.first_seed + v_rec.entries - 1,
                             v_rec.players);
  END LOOP;

  RAISE NOTICE 'Open /placement to generate round one; the seeds are already locked.';
END
$rebuild$;

-- ---------------------------------------------------------------------------
-- Confirmation. Runs as its own statement, so it reports committed state.
-- ---------------------------------------------------------------------------
SELECT c.code                              AS category,
       c.entry_type,
       count(e.id)                         AS entries,
       count(e.seed)                       AS seeded,
       count(e.seed_locked_at)             AS locked,
       string_agg(DISTINCT e.skill_level, ' / ') AS skill_levels
FROM public.categories c
JOIN public.placement_entrants e ON e.category_id = c.id
WHERE c.tournament_id = (SELECT id FROM public.tournaments WHERE is_active)
GROUP BY c.code, c.entry_type, c.sort_order
ORDER BY c.sort_order;

SELECT (SELECT count(*) FROM public.teams
        WHERE tournament_id = (SELECT id FROM public.tournaments WHERE is_active)) AS total_entries,
       (SELECT count(*) FROM public.players WHERE name ~ '^Man [0-9]+$')   AS men,
       (SELECT count(*) FROM public.players WHERE name ~ '^Woman [0-9]+$') AS women,
       (SELECT count(*) FROM public.pools)        AS leftover_pools,
       (SELECT count(*) FROM public.pool_matches) AS leftover_pool_matches;
