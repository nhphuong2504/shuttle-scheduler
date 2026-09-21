-- Wipe the desk back to a blank slate so a tournament can be created from scratch.
--
-- Removes: every result (pool + knockout), every entry, every player, and the
--          tournament itself with its days, courts and categories.
-- Keeps:   staff_roles (so nobody loses desk access).
--
-- Safe to re-run: deleting already-deleted rows is a no-op.
--
-- Run it in the Supabase SQL editor for the project you intend to reset, as one
-- script. Then create the new tournament from /setup in the app.

BEGIN;

-- Results -------------------------------------------------------------------
DELETE FROM public.desk_activity;

DELETE FROM public.draw_matches;
DELETE FROM public.draws;

DELETE FROM public.pool_matches;
DELETE FROM public.pool_entries;
DELETE FROM public.pools;

-- Entries and roster --------------------------------------------------------
DELETE FROM public.teams;
DELETE FROM public.players;

-- Tournament structure ------------------------------------------------------
DELETE FROM public.categories;
DELETE FROM public.courts;
DELETE FROM public.tournament_days;
DELETE FROM public.tournaments;

-- `desk_activity.id` is a generated identity; restart it so the fresh
-- tournament's activity trail starts at 1.
ALTER TABLE public.desk_activity ALTER COLUMN id RESTART WITH 1;

COMMIT;

-- Verify everything is empty (every count should be 0) ----------------------
SELECT 'tournaments' AS table_name, count(*) FROM public.tournaments
UNION ALL SELECT 'tournament_days', count(*) FROM public.tournament_days
UNION ALL SELECT 'categories',      count(*) FROM public.categories
UNION ALL SELECT 'courts',          count(*) FROM public.courts
-- The per-day court and break rows cascade from tournaments, days and courts,
-- so they are not deleted explicitly above. Count them here to prove the
-- cascade reached them.
UNION ALL SELECT 'tournament_day_courts', count(*) FROM public.tournament_day_courts
UNION ALL SELECT 'tournament_day_breaks', count(*) FROM public.tournament_day_breaks
UNION ALL SELECT 'players',         count(*) FROM public.players
UNION ALL SELECT 'teams',           count(*) FROM public.teams
UNION ALL SELECT 'pools',           count(*) FROM public.pools
UNION ALL SELECT 'pool_entries',    count(*) FROM public.pool_entries
UNION ALL SELECT 'pool_matches',    count(*) FROM public.pool_matches
UNION ALL SELECT 'draws',           count(*) FROM public.draws
UNION ALL SELECT 'draw_matches',    count(*) FROM public.draw_matches
UNION ALL SELECT 'desk_activity',   count(*) FROM public.desk_activity
-- staff access is intentionally preserved; this must NOT be 0
UNION ALL SELECT 'staff_roles (kept)', count(*) FROM public.staff_roles
ORDER BY table_name;

-- Safety net ---------------------------------------------------------------
-- /setup and the tournaments insert are gated on the admin or scheduler role,
-- and that role comes from staff_roles. If the query above shows staff_roles
-- at 0, nobody can create the tournament — uncomment this and set a real email
-- so you can sign in and open /setup.
--
-- INSERT INTO public.staff_roles (email, role)
-- VALUES ('you@example.com', 'admin')
-- ON CONFLICT (email) DO UPDATE SET role = 'admin';
