-- ===========================================================================
-- 50 test players for the two-round placement format.
--
-- NOT A MIGRATION, and the location is the point. Everything under
-- `supabase/migrations/` is applied to the connected project by `npm run db:push`
-- (or `scripts/apply-migrations.mjs`), so a file there would drop fifty fake
-- entrants into the live tournament the moment it was pushed. This is in
-- `supabase/seed/`, so nothing happens until you paste it into the Supabase SQL
-- editor and run it.
--
-- Against the tournament the platform admin is pointed at, it:
--   * inserts 50 players (30 men, 20 women) with realistic names
--   * registers them as teams in MS, WS, MD, WD and XD
--   * creates the matching `placement_entrants` rows, with skill levels spread
--     across all three seed blocks so the skill-block shuffle has something to do
--
-- It deliberately does NOT generate the rounds, lock seeds, or write results.
-- Those are the desk's own buttons on /placement, and exercising them is the
-- whole point of the data.
--
-- ---------------------------------------------------------------------------
-- How the test data is identified
-- ---------------------------------------------------------------------------
--
-- Names are plain and realistic, as asked for. The handle is the EMAIL instead:
-- every test player gets `<name>@tournova.test`. `.test` is reserved by
-- RFC 2606 and can never resolve, so it cannot collide with a real person, and
-- the app never renders a player's email — only `profiles.email` is shown, on
-- the access page. So the roster and every court screen look like a genuine
-- field, while `WHERE email LIKE '%@tournova.test'` stays an exact handle for
-- both the reset and the cleanup.
--
-- ---------------------------------------------------------------------------
-- Re-running
-- ---------------------------------------------------------------------------
--
-- The script is idempotent: it deletes its own previous run and rebuilds.
--
-- It REFUSES to run if the placement stage is already under way (any
-- `placement_matches` rows, or locked seeds). That is not fussiness: injecting
-- entrants into a category whose round one was already generated from a smaller
-- field produces an inconsistent bracket, silently. Clear the stage first — see
-- the reset block at the bottom — and re-run.
--
-- `teams` triggers are enforced, because `tournament_id` is set explicitly here
-- rather than left to be derived: `enforce_team_shape` (singles one player,
-- pairs two, one man and one woman for a mixed event) and
-- `enforce_two_category_cap` (reads `max_categories_per_player`). The field plan
-- below keeps every player in at most 2 categories, and asserts it.
-- ===========================================================================

DO $seed$
DECLARE
  -- -------------------------------------------------------------------------
  -- The field plan. Every bound is a rank within the test roster, per gender:
  -- men are ranked 1..30 and women 1..20, alphabetically by name, so the
  -- assignment is deterministic and the same on every run.
  --
  -- The ranges overlap on purpose. A player appearing in two categories is what
  -- exercises the per-player category cap.
  --
  -- The odd sizes are deliberate too: an odd field is what makes the placement
  -- engine hold one entrant out of round one and give them two make-up matches
  -- in round two, which is the format's least obvious path. Sizing a range down
  -- to 2 is the other one worth trying, and exercises the no-round-two case.
  -- -------------------------------------------------------------------------
  -- Overlap is deliberate: men 19..23 and women 9..12 land in three categories,
  -- which is what exercises a cap of 3 rather than 2.
  v_ms_lo    int := 1;  v_ms_hi    int := 23;  -- Men's Singles   : 23 entrants, odd
  v_md_lo    int := 9;  v_md_hi    int := 30;  -- Men's Doubles   : 11 pairs, odd
  v_xd_men_lo int := 19; v_xd_men_hi int := 30; -- Mixed Doubles  : 12 pairs
  v_ws_lo    int := 1;  v_ws_hi    int := 12;  -- Women's Singles : 12 entrants
  v_wd_lo    int := 5;  v_wd_hi    int := 16;  -- Women's Doubles : 6 pairs
  v_xd_women_lo int := 9; v_xd_women_hi int := 20;

  v_tournament uuid;
  v_tname      text;
  v_cap        int;
  v_men        int;
  v_women      int;
  v_players    int;
  v_entries    int;
  v_entrants   int;
  v_worst      int;
  v_rec        record;
BEGIN
  -- -------------------------------------------------------------------------
  -- 0. Which tournament
  -- -------------------------------------------------------------------------
  --
  -- Phase 2 has no global active tournament: the admin's own pointer
  -- (`profiles.current_tournament_id`) is the working tournament, and it is what the
  -- app writes when they open one. Set it there before seeding; there is deliberately
  -- no "newest tournament" fallback, because seeding the wrong event silently is worse
  -- than refusing.
  SELECT t.id, t.name INTO v_tournament, v_tname
  FROM public.tournaments t
  WHERE t.id = (
    SELECT p.current_tournament_id
    FROM public.profiles p
    WHERE p.system_role = 'admin'
      AND p.current_tournament_id IS NOT NULL
    ORDER BY p.created_at, p.id
    LIMIT 1
  );

  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'No working tournament is set for the admin. Open a tournament in the app, then seed test data.';
  END IF;

  SELECT max_categories_per_player INTO v_cap
  FROM public.tournaments WHERE id = v_tournament;
  v_cap := COALESCE(v_cap, 3);

  -- -------------------------------------------------------------------------
  -- 1. Refuse to touch a tournament whose placement stage is already running
  -- -------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.placement_matches WHERE tournament_id = v_tournament) THEN
    RAISE EXCEPTION
      'Tournament "%" already has placement matches, so adding a test field would corrupt its brackets. Clear the placement stage first (see the reset block at the bottom of this file), then re-run.',
      v_tname;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.placement_entrants
    WHERE tournament_id = v_tournament AND seed_locked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Seeds are already locked for at least one category in "%". Clear the placement stage first (see the reset block at the bottom of this file), then re-run.',
      v_tname;
  END IF;

  -- -------------------------------------------------------------------------
  -- 2. Remove any previous run. Teams first, so the intent is explicit rather
  --    than relying on the player -> team cascade.
  -- -------------------------------------------------------------------------
  DELETE FROM public.teams
  WHERE player_1_id IN (SELECT id FROM public.players WHERE email LIKE '%@tournova.test')
     OR player_2_id IN (SELECT id FROM public.players WHERE email LIKE '%@tournova.test');

  DELETE FROM public.players WHERE email LIKE '%@tournova.test';

  -- -------------------------------------------------------------------------
  -- 3. The 50 players. The email is derived from the name so the list stays
  --    readable: lowercased, spaces to dots, in the reserved `.test` domain.
  -- -------------------------------------------------------------------------
  INSERT INTO public.players (name, gender, email)
  SELECT v.name,
         v.gender,
         lower(replace(v.name, ' ', '.')) || '@tournova.test'
  FROM (VALUES
    ('Daniel Okafor',     'M'),
    ('Wei Zhang',         'M'),
    ('Marcus Lindquist',  'M'),
    ('Tobias Brandt',     'M'),
    ('Rajesh Iyer',       'M'),
    ('Kwame Mensah',      'M'),
    ('Luca Ferrari',      'M'),
    ('Yusuf Demir',       'M'),
    ('Andrei Popescu',    'M'),
    ('Hiroshi Tanaka',    'M'),
    ('Emmanuel Adeyemi',  'M'),
    ('Peter Novak',       'M'),
    ('Sanjay Gupta',      'M'),
    ('Oliver Bennett',    'M'),
    ('Mateo Alvarez',     'M'),
    ('Chen Long',         'M'),
    ('Ibrahim Toure',     'M'),
    ('Dmitri Volkov',     'M'),
    ('Nathan Osei',       'M'),
    ('Felipe Cardoso',    'M'),
    ('Anton Petrov',      'M'),
    ('Samuel Kimani',     'M'),
    ('Jonas Weber',       'M'),
    ('Arjun Nair',        'M'),
    ('Carlos Mendoza',    'M'),
    ('Viktor Hansen',     'M'),
    ('Tunde Balogun',     'M'),
    ('Min-Jun Park',      'M'),
    ('Alejandro Ruiz',    'M'),
    ('Lukas Schmidt',     'M'),
    ('Amara Nwosu',       'F'),
    ('Lin Xiao',          'F'),
    ('Sofia Bergstrom',   'F'),
    ('Priya Raman',       'F'),
    ('Fatima Al-Sayed',   'F'),
    ('Elena Petrova',     'F'),
    ('Grace Wanjiru',     'F'),
    ('Mia Andersen',      'F'),
    ('Yuki Nakamura',     'F'),
    ('Zainab Bello',      'F'),
    ('Clara Dubois',      'F'),
    ('Anika Sharma',      'F'),
    ('Nadia Haddad',      'F'),
    ('Isabella Rossi',    'F'),
    ('Thandiwe Moyo',     'F'),
    ('Hana Kovac',        'F'),
    ('Camila Torres',     'F'),
    ('Aisha Ibrahim',     'F'),
    ('Mei Chen',          'F'),
    ('Rebecca Owusu',     'F')
  ) AS v(name, gender);

  -- -------------------------------------------------------------------------
  -- 4. Rank the roster. Everything below addresses players by these ranks, so
  --    the field plan above is the only thing that needs editing to reshape the
  --    test field.
  -- -------------------------------------------------------------------------
  DROP TABLE IF EXISTS tmp_seed_roster;
  CREATE TEMP TABLE tmp_seed_roster AS
  SELECT p.id,
         p.name,
         p.gender,
         row_number() OVER (PARTITION BY p.gender ORDER BY p.name, p.id) AS n
  FROM public.players p
  WHERE p.email LIKE '%@tournova.test';

  SELECT count(*) FILTER (WHERE gender = 'M'),
         count(*) FILTER (WHERE gender = 'F'),
         count(*)
  INTO v_men, v_women, v_players
  FROM tmp_seed_roster;

  IF v_players <> 50 THEN
    RAISE EXCEPTION 'Expected 50 test players, found %.', v_players;
  END IF;

  -- The plan addresses fixed ranks, so it breaks if the roster is short. Checked
  -- before any team is written, so a mismatch cannot leave a half-built field.
  IF v_men < greatest(v_ms_hi, v_md_hi, v_xd_men_hi) THEN
    RAISE EXCEPTION 'Field plan needs % men but only % were created.',
      greatest(v_ms_hi, v_md_hi, v_xd_men_hi), v_men;
  END IF;
  IF v_women < greatest(v_ws_hi, v_wd_hi, v_xd_women_hi) THEN
    RAISE EXCEPTION 'Field plan needs % women but only % were created.',
      greatest(v_ws_hi, v_wd_hi, v_xd_women_hi), v_women;
  END IF;

  -- A singles range can be any length. A doubles range is paired off two at a
  -- time, so an odd length would silently drop the last player and quietly make
  -- the entry count wrong -- which is exactly the kind of thing that is blamed on
  -- the engine rather than on the test data.
  IF (v_md_hi - v_md_lo + 1) % 2 <> 0 THEN
    RAISE EXCEPTION 'Men''s Doubles range %..% covers an odd number of players, so it cannot be paired.',
      v_md_lo, v_md_hi;
  END IF;
  IF (v_wd_hi - v_wd_lo + 1) % 2 <> 0 THEN
    RAISE EXCEPTION 'Women''s Doubles range %..% covers an odd number of players, so it cannot be paired.',
      v_wd_lo, v_wd_hi;
  END IF;
  IF (v_xd_men_hi - v_xd_men_lo) <> (v_xd_women_hi - v_xd_women_lo) THEN
    RAISE EXCEPTION 'Mixed Doubles needs one man per woman: % men against % women.',
      v_xd_men_hi - v_xd_men_lo + 1, v_xd_women_hi - v_xd_women_lo + 1;
  END IF;

  -- -------------------------------------------------------------------------
  -- 5. Teams. `tournament_id` is set explicitly rather than left to the shape
  --    trigger, so the category-cap trigger -- which fires first, alphabetically
  --    -- can actually see the tournament and enforce the cap.
  -- -------------------------------------------------------------------------

  -- Singles: one player per entry.
  INSERT INTO public.teams (tournament_id, category_id, player_1_id)
  SELECT v_tournament, c.id, r.id
  FROM tmp_seed_roster r
  CROSS JOIN public.categories c
  WHERE r.gender = 'M'
    AND r.n BETWEEN v_ms_lo AND v_ms_hi
    AND c.tournament_id = v_tournament
    AND c.code = 'MS';

  INSERT INTO public.teams (tournament_id, category_id, player_1_id)
  SELECT v_tournament, c.id, r.id
  FROM tmp_seed_roster r
  CROSS JOIN public.categories c
  WHERE r.gender = 'F'
    AND r.n BETWEEN v_ws_lo AND v_ws_hi
    AND c.tournament_id = v_tournament
    AND c.code = 'WS';

  -- Doubles: consecutive ranks pair up, at an even offset from the range start.
  INSERT INTO public.teams (tournament_id, category_id, player_1_id, player_2_id)
  SELECT v_tournament, c.id, a.id, b.id
  FROM tmp_seed_roster a
  JOIN tmp_seed_roster b ON b.gender = a.gender AND b.n = a.n + 1
  CROSS JOIN public.categories c
  WHERE a.gender = 'M'
    AND a.n BETWEEN v_md_lo AND v_md_hi
    AND (a.n - v_md_lo) % 2 = 0
    AND c.tournament_id = v_tournament
    AND c.code = 'MD';

  INSERT INTO public.teams (tournament_id, category_id, player_1_id, player_2_id)
  SELECT v_tournament, c.id, a.id, b.id
  FROM tmp_seed_roster a
  JOIN tmp_seed_roster b ON b.gender = a.gender AND b.n = a.n + 1
  CROSS JOIN public.categories c
  WHERE a.gender = 'F'
    AND a.n BETWEEN v_wd_lo AND v_wd_hi
    AND (a.n - v_wd_lo) % 2 = 0
    AND c.tournament_id = v_tournament
    AND c.code = 'WD';

  -- Mixed doubles: man at offset k pairs with the woman at offset k, so every
  -- pair is genuinely one man and one woman, which is what the shape trigger
  -- insists on for a `mixed` event.
  INSERT INTO public.teams (tournament_id, category_id, player_1_id, player_2_id)
  SELECT v_tournament, c.id, m.id, w.id
  FROM tmp_seed_roster m
  JOIN tmp_seed_roster w
    ON w.gender = 'F'
   AND (w.n - v_xd_women_lo) = (m.n - v_xd_men_lo)
  CROSS JOIN public.categories c
  WHERE m.gender = 'M'
    AND m.n BETWEEN v_xd_men_lo AND v_xd_men_hi
    AND c.tournament_id = v_tournament
    AND c.code = 'XD';

  SELECT count(*) INTO v_entries
  FROM public.teams t
  JOIN public.players p ON p.id = t.player_1_id
  WHERE t.tournament_id = v_tournament
    AND p.email LIKE '%@tournova.test';

  -- -------------------------------------------------------------------------
  -- 6. Entrants, for the test teams only.
  --
  -- This mirrors `sync_placement_entrants`, which cannot be called from here:
  -- it is guarded by `can_edit_tournament`, and the SQL editor has no JWT, so
  -- `auth.uid()` is NULL and the guard would reject it. The upsert is the same
  -- one the RPC performs.
  --
  -- Scoped to the test teams on purpose, so the script's blast radius is exactly
  -- its own data. Any real entries already registered get their entrant rows from
  -- the desk's Sync button, not from here.
  -- -------------------------------------------------------------------------
  INSERT INTO public.placement_entrants (tournament_id, category_id, team_id)
  SELECT t.tournament_id, t.category_id, t.id
  FROM public.teams t
  JOIN public.players p ON p.id = t.player_1_id
  WHERE t.tournament_id = v_tournament
    AND p.email LIKE '%@tournova.test'
  ON CONFLICT (category_id, team_id) DO NOTHING;

  SELECT count(*) INTO v_entrants
  FROM public.placement_entrants e
  JOIN public.teams t ON t.id = e.team_id
  JOIN public.players p ON p.id = t.player_1_id
  WHERE e.tournament_id = v_tournament
    AND p.email LIKE '%@tournova.test';

  -- -------------------------------------------------------------------------
  -- 7. Skill levels, so the skill-block seeding has all three blocks to shuffle
  --    within. Split by thirds of each category's field, ranked by name, which
  --    keeps it deterministic and explainable to the desk.
  -- -------------------------------------------------------------------------
  WITH ranked AS (
    SELECT e.id,
           row_number() OVER (PARTITION BY e.category_id ORDER BY p.name, e.id) AS rn,
           count(*)     OVER (PARTITION BY e.category_id)                        AS total
    FROM public.placement_entrants e
    JOIN public.teams t   ON t.id = e.team_id
    JOIN public.players p ON p.id = t.player_1_id
    WHERE t.tournament_id = v_tournament
      AND p.email LIKE '%@tournova.test'
  )
  UPDATE public.placement_entrants e
  SET skill_level = CASE
        WHEN ranked.rn <= ceil(ranked.total / 3.0)     THEN 'advanced'
        WHEN ranked.rn <= ceil(ranked.total * 2 / 3.0) THEN 'intermediate'
        ELSE 'beginner'
      END
  FROM ranked
  WHERE ranked.id = e.id;

  -- -------------------------------------------------------------------------
  -- 8. Assert what the plan claims. The cap trigger already enforces this, so
  --    this is a documented invariant rather than the only line of defence --
  --    which is the point: if the trigger is ever relaxed, this still fails.
  -- -------------------------------------------------------------------------
  SELECT max(cnt) INTO v_worst
  FROM (
    SELECT p.id, count(DISTINCT t.category_id) AS cnt
    FROM public.players p
    JOIN public.teams t
      ON t.player_1_id = p.id OR t.player_2_id = p.id
    WHERE p.email LIKE '%@tournova.test'
      AND t.tournament_id = v_tournament
    GROUP BY p.id
  ) per_player;

  IF v_worst > v_cap THEN
    RAISE EXCEPTION 'A test player ended up in % categories, above the cap of %.', v_worst, v_cap;
  END IF;

  DROP TABLE IF EXISTS tmp_seed_roster;

  -- -------------------------------------------------------------------------
  -- 9. Report
  -- -------------------------------------------------------------------------
  RAISE NOTICE 'Seeded "%": % players, % teams, % entrants. Busiest player is in % of % allowed categories.',
    v_tname, v_players, v_entries, v_entrants, v_worst, v_cap;

  FOR v_rec IN
    SELECT c.code, count(p.id) AS entries
    FROM public.categories c
    LEFT JOIN public.teams t   ON t.category_id = c.id
    LEFT JOIN public.players p ON p.id = t.player_1_id
                              AND p.email LIKE '%@tournova.test'
    WHERE c.tournament_id = v_tournament
    GROUP BY c.code, c.sort_order
    ORDER BY c.sort_order
  LOOP
    RAISE NOTICE '  % : % entries', rpad(v_rec.code, 3), v_rec.entries;
  END LOOP;

  RAISE NOTICE 'Open /placement to shuffle and lock seeds, then generate round one.';
END
$seed$;

-- ---------------------------------------------------------------------------
-- Confirmation. Runs as its own statement, so it reports committed state.
-- ---------------------------------------------------------------------------
SELECT c.code                                        AS category,
       c.entry_type,
       count(DISTINCT t.id)                          AS test_entries,
       count(DISTINCT e.id)                          AS entrants_ready,
       string_agg(DISTINCT e.skill_level, ' / ')     AS skill_levels
FROM public.categories c
JOIN public.teams t   ON t.category_id = c.id
JOIN public.players p ON p.id = t.player_1_id
LEFT JOIN public.placement_entrants e ON e.team_id = t.id
WHERE c.tournament_id = (
        SELECT p.current_tournament_id FROM public.profiles p
        WHERE p.system_role = 'admin' AND p.current_tournament_id IS NOT NULL
        ORDER BY p.created_at, p.id LIMIT 1
      )
  AND p.email LIKE '%@tournova.test'
GROUP BY c.code, c.entry_type, c.sort_order
ORDER BY c.sort_order;

SELECT count(*) AS test_players
FROM public.players
WHERE email LIKE '%@tournova.test';

-- ===========================================================================
-- Reset the placement stage
--
-- Run this, then re-run the script above, to get a clean field again after the
-- rounds have been generated. It clears the stage for the ADMIN'S WORKING TOURNAMENT
-- and nothing else. Uncomment it -- it is off by default so it can never fire by
-- accident.
--
-- It does NOT touch `pool_matches` / `draw_matches`: those are the round-robin
-- format's tables.
-- ===========================================================================
--
-- DELETE FROM public.placement_matches
-- WHERE tournament_id = (SELECT current_tournament_id FROM public.profiles
--   WHERE system_role = 'admin' ORDER BY created_at, id LIMIT 1);
--
-- DELETE FROM public.tier_draw_matches
-- WHERE tournament_id = (SELECT current_tournament_id FROM public.profiles
--   WHERE system_role = 'admin' ORDER BY created_at, id LIMIT 1);
--
-- DELETE FROM public.tier_draws
-- WHERE tournament_id = (SELECT current_tournament_id FROM public.profiles
--   WHERE system_role = 'admin' ORDER BY created_at, id LIMIT 1);
--
-- UPDATE public.placement_entrants
-- SET seed = NULL, tier = NULL, seed_locked_at = NULL, excluded = false
-- WHERE tournament_id = (SELECT current_tournament_id FROM public.profiles
--   WHERE system_role = 'admin' ORDER BY created_at, id LIMIT 1);

-- ===========================================================================
-- Remove the test data entirely
--
-- Deleting the players cascades to their teams, their placement entrants and any
-- matches those entrants were part of. Uncomment to clean up.
-- ===========================================================================
--
-- DELETE FROM public.players
-- WHERE email LIKE '%@tournova.test';
