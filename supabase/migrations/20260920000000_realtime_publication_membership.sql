-- Realtime publication membership, stated in the repository instead of clicked in a dashboard.
--
-- WHY THIS MIGRATION EXISTS
--
-- The desk subscribes to `postgres_changes` with no table filter:
--
--     supabase.channel("ops-live").on("postgres_changes", { event: "*", schema: "public" }, ...)
--
-- so it only receives an event for tables that are members of the `supabase_realtime`
-- publication. Membership was configured outside migrations on the original project, and
-- `20260917080000_placement_realtime_publication.sql` only adds the six placement tables
-- created by the placement work - it does not create the publication, and it returns early
-- with a NOTICE if the publication is missing.
--
-- That combination is a silent failure on a rebuilt database: the desk renders its `Live`
-- badge (the websocket subscribe succeeds) while no row change ever arrives, so results
-- entered on one screen never appear on another until someone reloads by hand. Nothing in
-- the app can detect it, because a channel that is subscribed and simply never fires looks
-- identical to a quiet tournament.
--
-- This migration therefore declares the full membership the application depends on, so a
-- fresh project replays to the same realtime behaviour as the original.
--
-- EVERY TABLE THE APP READS IS INCLUDED, not just the match tables. The subscription has no
-- table filter, so omitting a table does not narrow the subscription - it silently drops
-- that table's events.
--
-- Idempotent and safe to re-run: membership is checked before each ADD, because adding a
-- table that is already a member raises an error.

DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    -- Tournament structure
    'tournaments',
    'tournament_days',
    'tournament_day_courts',
    'tournament_day_breaks',
    'categories',
    'courts',
    -- Entries
    'players',
    'teams',
    -- Staff
    'staff_roles',
    -- Round-robin
    'pools',
    'pool_entries',
    'pool_matches',
    'draws',
    'draw_matches',
    -- Placement
    'placement_entrants',
    'placement_matches',
    'tier_draws',
    'tier_draw_matches',
    -- Desk
    'desk_activity'
  ];

BEGIN
  -- The publication is normally created by Supabase. Create it if a project is missing it
  -- rather than skipping, because skipping is exactly the silent failure described above.
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
    RAISE NOTICE 'Created the supabase_realtime publication.';
  END IF;

  FOREACH v_table IN ARRAY v_tables
  LOOP
    -- A table that no longer exists is skipped: this migration must not fail on a database
    -- where a later migration dropped one, and the NOTICE keeps the skip visible.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = v_table
        AND c.relkind = 'r'
    ) THEN
      RAISE NOTICE 'Skipping public.% - not a table in this database.', v_table;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = v_table
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    RAISE NOTICE 'Added public.% to supabase_realtime.', v_table;
  END LOOP;
END
$$;

-- Deliberately no GRANT here.
--
-- It is tempting to add `GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated`
-- so the publication is readable, but Realtime authorizes `postgres_changes` through the
-- table's RLS policies rather than through the publication, and a blanket grant in this
-- file would silently reverse `REVOKE SELECT ON public.players FROM anon` from
-- `20260910000044_db7cefc0-3695-468f-be00-0e6b8dd1d299.sql`, which exists specifically to
-- stop players being readable anonymously. Table grants belong with the table, not here.
