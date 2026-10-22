-- Which stored results the exact-margin rule would refuse.
--
-- WHY
--
-- `20261022020000_exact_game_margin.sql` makes a game legal only if it is a score the game
-- could have stopped on. Results already in the database were written under the old floor -
-- reach `games_to` and lead by at least `win_by` - so some of them (25-10, 24-21, 22-5, and
-- any deuce that ran past the cap) are now scores the app will not accept again.
--
-- The migration does NOT rewrite them. A stored result is a fact about a match that was
-- played; quietly editing it to fit a newer rule would change standings, head-to-head and
-- every placement that reads it, with nobody to review the change. What it does instead is
-- make such a row obvious when the desk next opens that match: the old score is still on
-- screen, and it cannot be saved back without correcting it.
--
-- This query is the measure of how many those are, and which matches, so a decision about
-- handling them is made before the migration is applied rather than discovered after.
--
-- WHEN
--
-- Before applying the migration to staging and to production. It is read-only, and it repeats
-- the new rule inline rather than calling `game_score_is_legal`, because it has to answer the
-- same question *before* that function is replaced.
--
--   npm run db:audit-scores                                  # SUPABASE_DB_URL
--   npm run db:audit-scores -- --project-ref <ref>            # SUPABASE_ACCESS_TOKEN
--
-- An empty result is the expected answer for a tournament entered through the desk since the
-- two-digit field: at most two digits, and the margin is the rule's own.
--
-- WHAT IT LISTS
--
-- One row per affected match, with the games that must be corrected. Each is a decision for
-- the organiser: re-enter the result from the score sheet, or accept the match's existing
-- standing and leave the row as it stands.

WITH candidates AS (
  -- The placement stage reads its rule from the tournament.
  SELECT
    'placement_matches'::text AS match_table,
    m.id AS match_id,
    m.tournament_id,
    t.placement_games_to AS games_to,
    t.placement_win_by AS win_by,
    m.games
  FROM public.placement_matches m
  JOIN public.tournaments t ON t.id = m.tournament_id
  WHERE m.status = 'reported'
    AND jsonb_array_length(COALESCE(m.games, '[]'::jsonb)) > 0

  UNION ALL

  -- The bracket.
  SELECT
    'tier_draw_matches'::text,
    m.id,
    m.tournament_id,
    t.knockout_games_to,
    t.knockout_win_by,
    m.games
  FROM public.tier_draw_matches m
  JOIN public.tournaments t ON t.id = m.tournament_id
  WHERE m.status = 'reported'
    AND jsonb_array_length(COALESCE(m.games, '[]'::jsonb)) > 0

  UNION ALL

  -- The legacy A/B/C/D draw, which is written under the knockout rule.
  SELECT
    'draw_matches'::text,
    m.id,
    m.tournament_id,
    t.knockout_games_to,
    t.knockout_win_by,
    m.games
  FROM public.draw_matches m
  JOIN public.tournaments t ON t.id = m.tournament_id
  WHERE m.status = 'reported'
    AND jsonb_array_length(COALESCE(m.games, '[]'::jsonb)) > 0

  UNION ALL

  -- The legacy round-robin engine, whose rule is hardcoded at 21 / win by 2 in its RPC.
  SELECT
    'pool_matches'::text,
    m.id,
    m.tournament_id,
    21,
    2,
    jsonb_build_array(jsonb_build_object('a', m.score_a, 'b', m.score_b))
  FROM public.pool_matches m
  WHERE m.status = 'reported'
    AND m.score_a IS NOT NULL
    AND m.score_b IS NOT NULL
),

-- One row per stored game. The cast is guarded rather than trusted: a game stored as
-- something other than a whole number is itself a result that cannot be re-saved, and this
-- query is worth more reporting it than aborting on it.
games AS (
  SELECT
    c.match_table,
    c.match_id,
    c.tournament_id,
    c.games_to,
    c.win_by,
    CASE WHEN (g.value ->> 'a') ~ '^-?[0-9]+$' THEN (g.value ->> 'a')::int END AS a,
    CASE WHEN (g.value ->> 'b') ~ '^-?[0-9]+$' THEN (g.value ->> 'b')::int END AS b
  FROM candidates c
  CROSS JOIN LATERAL jsonb_array_elements(c.games) AS g(value)
),

-- The new rule, as `game_score_is_legal` will state it after the migration.
judged AS (
  SELECT
    games.*,
    CASE WHEN games.games_to = 21 AND games.win_by = 2 THEN 30 END AS cap
  FROM games
),

verdicts AS (
  SELECT
    judged.*,
    CASE
      WHEN judged.a IS NULL OR judged.b IS NULL THEN true
      WHEN judged.a < 0 OR judged.b < 0 OR judged.a = judged.b THEN true
      WHEN judged.cap IS NOT NULL AND GREATEST(judged.a, judged.b) > judged.cap THEN true
      WHEN GREATEST(judged.a, judged.b) = judged.games_to
        AND LEAST(judged.a, judged.b) <= judged.games_to - judged.win_by THEN false
      WHEN judged.win_by > 1
        AND GREATEST(judged.a, judged.b) > judged.games_to
        AND GREATEST(judged.a, judged.b) - LEAST(judged.a, judged.b) = judged.win_by THEN false
      WHEN judged.cap IS NOT NULL
        AND GREATEST(judged.a, judged.b) = judged.cap
        AND LEAST(judged.a, judged.b) = judged.cap - 1 THEN false
      ELSE true
    END AS is_illegal
  FROM judged
)

SELECT
  match_table,
  match_id,
  tournament_id,
  games_to,
  win_by,
  COUNT(*) AS illegal_games,
  STRING_AGG(
    CASE
      WHEN a IS NULL OR b IS NULL THEN '(unreadable)'
      ELSE a::text || '-' || b::text
    END,
    ', '
    ORDER BY a NULLS LAST, b NULLS LAST
  ) AS scores
FROM verdicts
WHERE is_illegal
GROUP BY match_table, match_id, tournament_id, games_to, win_by
ORDER BY match_table, match_id;
