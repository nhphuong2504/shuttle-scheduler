-- Definition-level parity dump.
--
-- Run this on BOTH the old project and the new one, save each result, and diff them.
-- Object counts are not enough: the repository is not a reliable description of the live
-- database. Two migrations here are near-duplicates of each other
-- (`20260909233700_tournament_hardening.sql` and
-- `20260910000044_d292a59b-d108-4b79-9c0e-7ed044025230.sql` define the same 17 functions,
-- 13 policies and 5 triggers), six migrations have UUID filenames rather than timestamps,
-- and `20260909220822` is a lone ALTER TABLE. Those are the signature of changes applied
-- through the dashboard, so a replay can land on a different final state than the original.
--
-- WHY THIS COMPARES DEFINITIONS
--
-- A count of 17 functions matches whether or not the bodies are identical, and a body is
-- where the business logic lives: the scoring rules, `advance_draw_locked`, and the
-- generation RPCs. Same for policies, where a differing `qual` is a silently different
-- authorization rule. So this emits `pg_get_functiondef`, `pg_get_constraintdef`,
-- `pg_get_triggerdef` and `pg_get_viewdef` output rather than names.
--
-- HOW TO USE
--
--   1. Supabase dashboard -> SQL editor on the OLD project -> paste -> Run -> download as CSV.
--   2. Repeat on the NEW project.
--   3. diff old.csv new.csv
--
-- Expect the extension and publication sections to differ on a first run; those are
-- managed outside migrations and are the point of the check. Anything else differing is a
-- real finding. See `supabase/migrations/README.md`.

WITH lines AS (
  -- Schemas -----------------------------------------------------------------
  SELECT 'schema' AS kind,
         n.nspname AS name,
         COALESCE(pg_get_userbyid(n.nspowner), '-') AS definition
  FROM pg_namespace n
  WHERE n.nspname NOT LIKE 'pg\_%'
    AND n.nspname <> 'information_schema'

  -- Extensions ---------------------------------------------------------------
  -- No migration in this repository runs CREATE EXTENSION, yet the schema needs
  -- pgcrypto for `gen_random_uuid()`. A missing extension fails at the first insert,
  -- not at migration time, so it is checked here.
  UNION ALL
  SELECT 'extension',
         e.extname,
         'version=' || e.extversion || ' schema=' || n.nspname
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace

  -- Columns ------------------------------------------------------------------
  UNION ALL
  SELECT 'column',
         n.nspname || '.' || c.relname || '.' || a.attname,
         'type=' || format_type(a.atttypid, a.atttypmod)
           || ' nullable=' || (NOT a.attnotnull)::text
           || ' default=' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '-')
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'v')
    AND a.attnum > 0
    AND NOT a.attisdropped

  -- Constraints --------------------------------------------------------------
  -- Covers the `pools_size_check` history in particular: `20260909220822` sets it to
  -- `size >= 4 AND size <= 8`, then `20260910000044` replaces it with `size IN (4,5)`.
  -- The final state is what matters and only a definition comparison proves it.
  UNION ALL
  SELECT 'constraint',
         n.nspname || '.' || c.relname || '.' || con.conname,
         pg_get_constraintdef(con.oid)
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'

  -- Indexes ------------------------------------------------------------------
  -- Includes the partial unique indexes on `teams`, which are what actually prevent a
  -- duplicate entry; a missing one is a data-integrity hole rather than a slow query.
  UNION ALL
  SELECT 'index',
         i.schemaname || '.' || i.indexname,
         i.indexdef
  FROM pg_indexes i
  WHERE i.schemaname = 'public'

  -- Sequences ----------------------------------------------------------------
  UNION ALL
  SELECT 'sequence',
         n.nspname || '.' || c.relname,
         'type=' || format_type(s.seqtypid, NULL)
           || ' start=' || s.seqstart
           || ' increment=' || s.seqincrement
  FROM pg_sequence s
  JOIN pg_class c ON c.oid = s.seqrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'

  -- Functions ----------------------------------------------------------------
  -- The full body. This is the single most important section: a differing body here is
  -- a silent difference in tournament rules or scoring.
  UNION ALL
  SELECT 'function',
         n.nspname || '.' || p.proname
           || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         'security_definer=' || p.prosecdef::text
           || ' volatility=' || p.provolatile::text
           || ' search_path=' || COALESCE(array_to_string(p.proconfig, ','), '-')
           || chr(10) || pg_get_functiondef(p.oid)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prokind = 'f'

  -- Policies -----------------------------------------------------------------
  -- `qual` and `with_check` are compared, not just the policy name: the same name with a
  -- different expression is a different authorization rule.
  UNION ALL
  SELECT 'policy',
         pol.schemaname || '.' || pol.tablename || '.' || pol.policyname,
         'cmd=' || pol.cmd
           || ' permissive=' || pol.permissive
           || ' roles=' || array_to_string(pol.roles, ',')
           || ' qual=' || COALESCE(pol.qual, '-')
           || ' with_check=' || COALESCE(pol.with_check, '-')
  FROM pg_policies pol
  WHERE pol.schemaname = 'public'

  -- Row level security -------------------------------------------------------
  UNION ALL
  SELECT 'rls_enabled',
         n.nspname || '.' || c.relname,
         c.relrowsecurity::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'

  -- Triggers -----------------------------------------------------------------
  -- Includes `auth`. The `on_auth_user_created_link_staff` trigger is the only thing that
  -- links a new auth user to its staff role, and it lives on a schema the application
  -- migrations do not own, so it is easy to lose and hard to notice.
  UNION ALL
  SELECT 'trigger',
         n.nspname || '.' || c.relname || '.' || t.tgname,
         pg_get_triggerdef(t.oid)
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal
    AND n.nspname IN ('public', 'auth')

  -- Views --------------------------------------------------------------------
  -- Includes reloptions, because `player_roster` is set to `security_invoker = on`. A view
  -- without it runs with the definer's rights, which turns a read-only convenience view
  -- into an RLS bypass.
  UNION ALL
  SELECT 'view',
         n.nspname || '.' || c.relname,
         COALESCE(array_to_string(c.reloptions, ',') || chr(10), '')
           || pg_get_viewdef(c.oid, true)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'v'

  -- Table grants -------------------------------------------------------------
  -- Read from the ACL rather than information_schema, which only reports grants visible to
  -- the current role. An over-grant is a security hole and an under-grant breaks a screen,
  -- so both directions matter.
  UNION ALL
  SELECT 'grant_table',
         n.nspname || '.' || c.relname || ' -> '
           || (CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END),
         g.privilege_type
           || CASE WHEN g.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) g
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'v', 'S')

  -- Function grants ----------------------------------------------------------
  -- The REVOKEs on `current_staff_role`, `has_staff_role` and the generation RPCs, and the
  -- later re-grant of `is_invited_email` to `anon`, must land in the same final state.
  UNION ALL
  SELECT 'grant_routine',
         n.nspname || '.' || p.proname
           || '(' || pg_get_function_identity_arguments(p.oid) || ') -> '
           || (CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END),
         g.privilege_type
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) g
  WHERE n.nspname = 'public'

  -- Default privileges -------------------------------------------------------
  UNION ALL
  SELECT 'default_acl',
         COALESCE(n.nspname, '-'),
         pg_get_userbyid(d.defaclrole) || ' ' || d.defaclobjtype::text
           || ' ' || array_to_string(d.defaclacl::text[], ',')
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace

  -- Publications -------------------------------------------------------------
  -- No migration creates the `supabase_realtime` publication, so on the original project
  -- its membership was configured in the dashboard. This is the section that catches a
  -- database that would render a `Live` badge and never update.
  UNION ALL
  SELECT 'publication',
         pubname,
         'all_tables=' || puballtables::text
           || ' insert=' || pubinsert::text
           || ' update=' || pubupdate::text
           || ' delete=' || pubdelete::text
           || ' truncate=' || pubtruncate::text
  FROM pg_publication

  UNION ALL
  SELECT 'publication_table',
         p.pubname,
         p.schemaname || '.' || p.tablename
  FROM pg_publication_tables p

  -- Database settings --------------------------------------------------------
  -- Behaviour that is not part of the schema at all. A different `statement_timeout` or
  -- `timezone` changes what the application does without any migration differing.
  UNION ALL
  SELECT 'db_setting',
         s.name,
         s.setting
  FROM pg_settings s
  WHERE s.name IN (
    'statement_timeout',
    'lock_timeout',
    'idle_in_transaction_session_timeout',
    'TimeZone',
    'default_text_search_config',
    'search_path'
  )
)
SELECT kind || ' | ' || name || ' | ' || definition AS parity_line
FROM lines
ORDER BY kind, name, definition;
