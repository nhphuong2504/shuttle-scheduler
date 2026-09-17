-- Realtime must be told about the new format's tables.
--
-- The desk subscribes with a single `postgres_changes` channel on `public` and
-- invalidates every query when anything arrives. That only works for tables that
-- are members of the `supabase_realtime` publication, and the placement tables were
-- created without being added to it: `pool_matches`, `draw_matches` and the rest of
-- the round-robin schema are members, so the desk kept looking live while silently
-- missing every placement generation, report, start and move.
--
-- The symptom is a control desk that never updates for the format it is actually
-- running: results entered on one screen never appear on another, and a just-built
-- schedule stays invisible until someone reloads by hand.
--
-- Adding a table that is already a member raises an error, so each one is checked
-- first. The publication itself is checked too, because a project may not have it.
DO $$
DECLARE
  v_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'supabase_realtime publication is absent; nothing to add.';
    RETURN;
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'placement_entrants',
    'placement_matches',
    'tier_draws',
    'tier_draw_matches',
    'tournament_day_courts',
    'tournament_day_breaks'
  ]
  LOOP
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
