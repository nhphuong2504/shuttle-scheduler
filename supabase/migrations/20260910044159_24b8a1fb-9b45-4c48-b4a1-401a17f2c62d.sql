-- Destructive demo-data reconstruction for the 2026 tournament.
-- Preserves categories, courts, tournament settings, and staff access.

DELETE FROM public.draw_matches;
DELETE FROM public.draws;
DELETE FROM public.pool_matches;
DELETE FROM public.pool_entries;
DELETE FROM public.pools;
DELETE FROM public.teams;
DELETE FROM public.players;

UPDATE public.courts SET status = 'free';

INSERT INTO public.players (name, gender)
SELECT 'Man ' || lpad(n::text, 3, '0'), 'M'
FROM generate_series(1, 100) AS n;

INSERT INTO public.players (name, gender)
SELECT 'Woman ' || lpad(n::text, 3, '0'), 'F'
FROM generate_series(1, 34) AS n;

INSERT INTO public.teams (category_id, player_1_id, player_2_id, seed)
SELECT c.id, p.id, NULL, n
FROM generate_series(1, 100) AS n
JOIN public.players p ON p.name = 'Man ' || lpad(n::text, 3, '0')
JOIN public.categories c ON c.code = 'MS'
WHERE n BETWEEN 1 AND 4
   OR n BETWEEN 30 AND 80;

WITH eligible AS (
  SELECT p.id, row_number() OVER (ORDER BY p.name) AS rn
  FROM public.players p
  WHERE p.gender = 'M'
    AND (
      substring(p.name FROM '[0-9]+$')::int BETWEEN 5 AND 28
      OR substring(p.name FROM '[0-9]+$')::int BETWEEN 30 AND 69
      OR substring(p.name FROM '[0-9]+$')::int BETWEEN 81 AND 100
    )
),
pairs AS (
  SELECT
    ((first_player.rn + 1) / 2)::int AS pair_number,
    first_player.id AS player_1_id,
    second_player.id AS player_2_id
  FROM eligible first_player
  JOIN eligible second_player ON second_player.rn = first_player.rn + 1
  WHERE first_player.rn % 2 = 1
)
INSERT INTO public.teams (category_id, player_1_id, player_2_id, seed)
SELECT c.id, pairs.player_1_id, pairs.player_2_id, pairs.pair_number
FROM pairs
JOIN public.categories c ON c.code = 'MD'
ORDER BY pairs.pair_number;

WITH eligible AS (
  SELECT p.id, row_number() OVER (ORDER BY p.name) AS rn
  FROM public.players p
  WHERE p.gender = 'F'
    AND (
      substring(p.name FROM '[0-9]+$')::int BETWEEN 1 AND 2
      OR substring(p.name FROM '[0-9]+$')::int BETWEEN 5 AND 34
    )
),
pairs AS (
  SELECT
    ((first_player.rn + 1) / 2)::int AS pair_number,
    first_player.id AS player_1_id,
    second_player.id AS player_2_id
  FROM eligible first_player
  JOIN eligible second_player ON second_player.rn = first_player.rn + 1
  WHERE first_player.rn % 2 = 1
)
INSERT INTO public.teams (category_id, player_1_id, player_2_id, seed)
SELECT c.id, pairs.player_1_id, pairs.player_2_id, pairs.pair_number
FROM pairs
JOIN public.categories c ON c.code = 'WD'
ORDER BY pairs.pair_number;

WITH men AS (
  SELECT p.id, row_number() OVER (ORDER BY p.name) AS rn
  FROM public.players p
  WHERE p.gender = 'M'
    AND (
      substring(p.name FROM '[0-9]+$')::int = 29
      OR substring(p.name FROM '[0-9]+$')::int BETWEEN 70 AND 100
    )
),
women AS (
  SELECT p.id, row_number() OVER (ORDER BY p.name) AS rn
  FROM public.players p
  WHERE p.gender = 'F'
    AND substring(p.name FROM '[0-9]+$')::int BETWEEN 3 AND 34
)
INSERT INTO public.teams (category_id, player_1_id, player_2_id, seed)
SELECT c.id, men.id, women.id, men.rn::int
FROM men
JOIN women USING (rn)
JOIN public.categories c ON c.code = 'XD'
ORDER BY men.rn;

CREATE TEMP TABLE demo_pool_plan (
  category_code text NOT NULL,
  pool_number int NOT NULL,
  pool_size int NOT NULL,
  PRIMARY KEY (category_code, pool_number)
) ON COMMIT DROP;

-- 55 = 3x5 + 10x4; 42 = 2x5 + 8x4; 16 = 4x4; 32 = 8x4.
INSERT INTO demo_pool_plan (category_code, pool_number, pool_size)
SELECT 'MS', n, CASE WHEN n <= 3 THEN 5 ELSE 4 END
FROM generate_series(1, 13) AS n
UNION ALL
SELECT 'MD', n, CASE WHEN n <= 2 THEN 5 ELSE 4 END
FROM generate_series(1, 10) AS n
UNION ALL
SELECT 'WD', n, 4
FROM generate_series(1, 4) AS n
UNION ALL
SELECT 'XD', n, 4
FROM generate_series(1, 8) AS n;

INSERT INTO public.pools (category_id, name, size)
SELECT c.id, 'Pool ' || chr(64 + plan.pool_number), plan.pool_size
FROM demo_pool_plan plan
JOIN public.categories c ON c.code = plan.category_code
ORDER BY c.sort_order, plan.pool_number;

WITH ordered_teams AS (
  SELECT
    c.code AS category_code,
    t.id AS team_id,
    row_number() OVER (
      PARTITION BY c.code
      ORDER BY t.seed NULLS LAST, t.id
    ) AS team_number
  FROM public.teams t
  JOIN public.categories c ON c.id = t.category_id
),
pool_ranges AS (
  SELECT
    plan.*,
    coalesce(
      sum(plan.pool_size) OVER (
        PARTITION BY plan.category_code
        ORDER BY plan.pool_number
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ),
      0
    ) AS previous_teams
  FROM demo_pool_plan plan
)
INSERT INTO public.pool_entries (pool_id, team_id, position)
SELECT
  p.id,
  ordered_teams.team_id,
  (ordered_teams.team_number - pool_ranges.previous_teams)::int
FROM pool_ranges
JOIN public.categories c ON c.code = pool_ranges.category_code
JOIN public.pools p
  ON p.category_id = c.id
 AND p.name = 'Pool ' || chr(64 + pool_ranges.pool_number)
JOIN ordered_teams
  ON ordered_teams.category_code = pool_ranges.category_code
 AND ordered_teams.team_number > pool_ranges.previous_teams
 AND ordered_teams.team_number <= pool_ranges.previous_teams + pool_ranges.pool_size
ORDER BY c.sort_order, pool_ranges.pool_number, ordered_teams.team_number;

-- Generate standard circle-method round-robin matches for every pool.
DO $$
DECLARE
  pool_record record;
  rotation uuid[];
  total_slots int;
  half int;
  round_number int;
  pair_index int;
  team_a uuid;
  team_b uuid;
BEGIN
  FOR pool_record IN
    SELECT p.id, p.category_id
    FROM public.pools p
    JOIN public.categories c ON c.id = p.category_id
    ORDER BY c.sort_order, p.name
  LOOP
    SELECT array_agg(pe.team_id ORDER BY pe.position)
    INTO rotation
    FROM public.pool_entries pe
    WHERE pe.pool_id = pool_record.id;

    IF cardinality(rotation) % 2 = 1 THEN
      rotation := array_append(rotation, NULL::uuid);
    END IF;

    total_slots := cardinality(rotation);
    half := total_slots / 2;

    FOR round_number IN 1..(total_slots - 1)
    LOOP
      FOR pair_index IN 1..half
      LOOP
        team_a := rotation[pair_index];
        team_b := rotation[total_slots - pair_index + 1];
        IF team_a IS NOT NULL AND team_b IS NOT NULL THEN
          INSERT INTO public.pool_matches (
            pool_id,
            category_id,
            round,
            team_a_id,
            team_b_id
          )
          VALUES (
            pool_record.id,
            pool_record.category_id,
            round_number,
            team_a,
            team_b
          );
        END IF;
      END LOOP;

      rotation :=
        ARRAY[rotation[1], rotation[total_slots]]
        || rotation[2:(total_slots - 1)];
    END LOOP;
  END LOOP;
END;
$$;

-- Fail the migration if any requested total or participation distribution drifts.
DO $$
DECLARE
  actual int;
BEGIN
  SELECT count(*) INTO actual FROM public.players;
  IF actual <> 134 THEN RAISE EXCEPTION 'Expected 134 players, found %', actual; END IF;

  SELECT count(*) INTO actual FROM public.players WHERE gender = 'M';
  IF actual <> 100 THEN RAISE EXCEPTION 'Expected 100 men, found %', actual; END IF;

  SELECT count(*) INTO actual FROM public.players WHERE gender = 'F';
  IF actual <> 34 THEN RAISE EXCEPTION 'Expected 34 women, found %', actual; END IF;

  SELECT count(*) INTO actual
  FROM public.teams t JOIN public.categories c ON c.id = t.category_id
  WHERE c.code = 'MS';
  IF actual <> 55 THEN RAISE EXCEPTION 'Expected 55 MS entries, found %', actual; END IF;

  SELECT count(*) INTO actual
  FROM public.teams t JOIN public.categories c ON c.id = t.category_id
  WHERE c.code = 'MD';
  IF actual <> 42 THEN RAISE EXCEPTION 'Expected 42 MD teams, found %', actual; END IF;

  SELECT count(*) INTO actual
  FROM public.teams t JOIN public.categories c ON c.id = t.category_id
  WHERE c.code = 'WD';
  IF actual <> 16 THEN RAISE EXCEPTION 'Expected 16 WD teams, found %', actual; END IF;

  SELECT count(*) INTO actual
  FROM public.teams t JOIN public.categories c ON c.id = t.category_id
  WHERE c.code = 'XD';
  IF actual <> 32 THEN RAISE EXCEPTION 'Expected 32 XD teams, found %', actual; END IF;

  WITH memberships AS (
    SELECT t.player_1_id AS player_id, t.category_id FROM public.teams t
    UNION ALL
    SELECT t.player_2_id, t.category_id FROM public.teams t WHERE t.player_2_id IS NOT NULL
  ),
  category_counts AS (
    SELECT p.gender, p.id, count(DISTINCT memberships.category_id) AS category_count
    FROM public.players p
    JOIN memberships ON memberships.player_id = p.id
    GROUP BY p.gender, p.id
  )
  SELECT count(*) INTO actual FROM category_counts
  WHERE gender = 'M' AND category_count = 1;
  IF actual <> 29 THEN RAISE EXCEPTION 'Expected 29 one-category men, found %', actual; END IF;

  WITH memberships AS (
    SELECT t.player_1_id AS player_id, t.category_id FROM public.teams t
    UNION ALL
    SELECT t.player_2_id, t.category_id FROM public.teams t WHERE t.player_2_id IS NOT NULL
  ),
  category_counts AS (
    SELECT p.gender, p.id, count(DISTINCT memberships.category_id) AS category_count
    FROM public.players p
    JOIN memberships ON memberships.player_id = p.id
    GROUP BY p.gender, p.id
  )
  SELECT count(*) INTO actual FROM category_counts
  WHERE gender = 'M' AND category_count = 2;
  IF actual <> 71 THEN RAISE EXCEPTION 'Expected 71 two-category men, found %', actual; END IF;

  WITH memberships AS (
    SELECT t.player_1_id AS player_id, t.category_id FROM public.teams t
    UNION ALL
    SELECT t.player_2_id, t.category_id FROM public.teams t WHERE t.player_2_id IS NOT NULL
  ),
  category_counts AS (
    SELECT p.gender, p.id, count(DISTINCT memberships.category_id) AS category_count
    FROM public.players p
    JOIN memberships ON memberships.player_id = p.id
    GROUP BY p.gender, p.id
  )
  SELECT count(*) INTO actual FROM category_counts
  WHERE gender = 'F' AND category_count = 1;
  IF actual <> 4 THEN RAISE EXCEPTION 'Expected 4 one-category women, found %', actual; END IF;

  WITH memberships AS (
    SELECT t.player_1_id AS player_id, t.category_id FROM public.teams t
    UNION ALL
    SELECT t.player_2_id, t.category_id FROM public.teams t WHERE t.player_2_id IS NOT NULL
  ),
  category_counts AS (
    SELECT p.gender, p.id, count(DISTINCT memberships.category_id) AS category_count
    FROM public.players p
    JOIN memberships ON memberships.player_id = p.id
    GROUP BY p.gender, p.id
  )
  SELECT count(*) INTO actual FROM category_counts
  WHERE gender = 'F' AND category_count = 2;
  IF actual <> 30 THEN RAISE EXCEPTION 'Expected 30 two-category women, found %', actual; END IF;

  SELECT count(*) INTO actual FROM public.pools;
  IF actual <> 35 THEN RAISE EXCEPTION 'Expected 35 pools, found %', actual; END IF;

  SELECT count(*) INTO actual FROM public.pool_matches;
  IF actual <> 230 THEN RAISE EXCEPTION 'Expected 230 pool matches, found %', actual; END IF;
END;
$$;