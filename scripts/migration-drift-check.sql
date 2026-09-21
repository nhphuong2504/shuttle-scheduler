-- Migration drift check.
--
-- Run this on the OLD project. It answers one question: does the set of migrations that
-- were actually applied match the files in `supabase/migrations/`?
--
-- WHY THIS EXISTS
--
-- The timing of the migrations in this repository shows changes were applied through the
-- dashboard rather than authored as migrations:
--
--   * `20260909233700_tournament_hardening.sql` and
--     `20260910000044_d292a59b-d108-4b79-9c0e-7ed044025230.sql` are near-duplicates -
--     706 and 696 lines defining the same 17 functions, 1 table, 13 policies and 5
--     triggers, differing by 58 lines that are almost all comments.
--   * Six migrations have UUID filenames rather than timestamps (`95225afa`, `da4b8e8e`,
--     `d292a59b`, `db7cefc0`, `24b8a1fb`, `a81552e2`), which is what the dashboard writes.
--   * `20260909220822_da4b8e8e-...sql` is a single ALTER TABLE.
--
-- So the files are a partial record. A version that appears in `schema_migrations` with no
-- corresponding file is a change that exists ONLY in the old database, and replaying the
-- repository onto a fresh project would silently lose it. That is the specific failure this
-- query is designed to surface, and it is why the parity dump in `parity-dump.sql` compares
-- definitions rather than relying on a replay.
--
-- The expected list below is generated from `ls supabase/migrations/*.sql`. Regenerate it
-- if migrations are added before this check is run - but note that this file is a one-time
-- migration tool, not permanent infrastructure, so it is expected to be deleted once the
-- move is complete.

WITH expected(version) AS (
  VALUES
    ('20260909220619'),
    ('20260909220822'),
    ('20260909230000'),
    ('20260909233700'),
    ('20260910000044'),
    ('20260910000115'),
    ('20260910043000'),
    ('20260910044159'),
    ('20260910120000'),
    ('20260910130000'),
    ('20260910160000'),
    ('20260910185353'),
    ('20260910200000'),
    ('20260915000000'),
    ('20260916000000'),
    ('20260916010000'),
    ('20260916020000'),
    ('20260916030000'),
    ('20260917000000'),
    ('20260917010000'),
    ('20260917020000'),
    ('20260917030000'),
    ('20260917040000'),
    ('20260917050000'),
    ('20260917060000'),
    ('20260917070000'),
    ('20260917080000'),
    ('20260917090000'),
    ('20260919000000'),
    ('20260919010000'),
    ('20260919020000'),
    ('20260919030000'),
    ('20260919040000'),
    ('20260920000000'),
    ('20260921000000')
),
applied AS (
  SELECT version::text AS version, name
  FROM supabase_migrations.schema_migrations
)
SELECT 'DRIFT | applied but no local file | '
         || a.version || ' | ' || COALESCE(a.name, '-') AS finding
FROM applied a
WHERE NOT EXISTS (SELECT 1 FROM expected e WHERE e.version = a.version)

UNION ALL

SELECT 'DRIFT | local file but never applied | ' || e.version || ' | -'
FROM expected e
WHERE NOT EXISTS (SELECT 1 FROM applied a WHERE a.version = e.version)

UNION ALL

-- Both sides agree. Reported explicitly rather than emitted as zero rows, because "no rows"
-- is indistinguishable from "the query did not run".
SELECT 'OK | applied=' || (SELECT count(*) FROM applied)::text
         || ' expected=' || (SELECT count(*) FROM expected)::text
         || ' matched=' || (
              SELECT count(*) FROM applied a
              WHERE EXISTS (SELECT 1 FROM expected e WHERE e.version = a.version)
            )::text
WHERE NOT EXISTS (
  SELECT 1 FROM applied a
  WHERE NOT EXISTS (SELECT 1 FROM expected e WHERE e.version = a.version)
)
AND NOT EXISTS (
  SELECT 1 FROM expected e
  WHERE NOT EXISTS (SELECT 1 FROM applied a WHERE a.version = e.version)
)

ORDER BY finding;
