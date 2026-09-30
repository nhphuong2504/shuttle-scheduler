-- Wipe the desk back to a blank slate so a tournament can be created from scratch.
--
-- Removes: every result (pool + knockout), every entry, every player, and the
--          tournament itself with its days, courts and categories.
-- Keeps:   profiles (so nobody loses their login or its platform role).
--
-- `profiles.current_tournament_id` is cleared for free: it is a foreign key to
-- `tournaments` with ON DELETE SET NULL, so the pointer follows the rows out rather
-- than dangling. Editors are rows on `tournament_editors` keyed by tournament, so they
-- cascade with the tournament and are not deleted explicitly either.
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
UNION ALL SELECT 'tournament_editors',    count(*) FROM public.tournament_editors
UNION ALL SELECT 'tournament_registrations', count(*) FROM public.tournament_registrations
UNION ALL SELECT 'players',         count(*) FROM public.players
UNION ALL SELECT 'teams',           count(*) FROM public.teams
UNION ALL SELECT 'pools',           count(*) FROM public.pools
UNION ALL SELECT 'pool_entries',    count(*) FROM public.pool_entries
UNION ALL SELECT 'pool_matches',    count(*) FROM public.pool_matches
UNION ALL SELECT 'draws',           count(*) FROM public.draws
UNION ALL SELECT 'draw_matches',    count(*) FROM public.draw_matches
UNION ALL SELECT 'desk_activity',   count(*) FROM public.desk_activity
-- Logins are intentionally preserved; this must NOT be 0.
UNION ALL SELECT 'profiles (kept)', count(*) FROM public.profiles
ORDER BY table_name;

-- Safety net ---------------------------------------------------------------
-- Creating a tournament needs only a signed-in session — anyone may create one and
-- becomes its owner — so an empty `profiles` table is not a lockout for creation.
-- It is a lockout for *signing in*: the identity in `auth.users` links to a profile by
-- email, and the platform role lives on that profile. If the count above is 0, nobody
-- can sign in; uncomment this and set a real email so you can reach /setup.
--
-- INSERT INTO public.profiles (email, system_role)
-- VALUES ('you@example.com', 'admin')
-- ON CONFLICT (email) DO UPDATE SET system_role = 'admin';
