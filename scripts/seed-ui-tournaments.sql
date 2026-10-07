-- ============================================================================
-- Seed three UI-testing tournaments: two completed, one upcoming (31 Oct 2026)
-- ============================================================================
--
-- Companion to `scripts/reset-tournament-data.sql`: that one leaves a blank desk,
-- this one leaves a desk with something to look at.
--
-- ## Where to run this
--
-- In the Supabase SQL editor, for the project you intend to fill. Read the tab
-- before you paste:
--
--     staging    dzilzdxzrbdimhbiwv   <- what `npm run dev` reads
--     production bwzemvaftzforfmaprif <- DO NOT RUN THIS THERE
--
-- This is deliberately NOT a migration. A migration would be applied to every
-- project the repository is pushed to, production included, and a migration that
-- deletes every tournament would be a catastrophe rather than a mistake.
--
-- ## What it does
--
--   1. Deletes every tournament, its days, courts, categories, entries, roster,
--      placement results and desk activity. `profiles` is kept, so nobody loses
--      their login or its platform role - the same contract as
--      `reset-tournament-data.sql`.
--   2. Inserts three tournaments with data shaped like a real event: venue,
--      timezone, organizer, days, courts, four events, a player roster, entries,
--      and - for the two finished ones - two placement rounds of reported results.
--
-- Shape of the result:
--
--     Windy City Open 2026      12-13 Sep 2026   completed   32 entries   Chicago, IL
--     Golden Gate Open 2026     15-16 Aug 2026   completed   32 entries   San Francisco, CA
--     Empire State Open 2026    31 Oct-1 Nov 26  upcoming    16 entries   New York, NY
--
-- The upcoming one is the interesting one for the registration button: it is
-- ready (venue, valid timezone, a day, a category, no cap below 2) and its window
-- is open, so `tournament_registration_state` answers `open` rather than
-- `not_ready` or `opens_soon`.
--
-- ## Re-runnable
--
-- It deletes before it inserts and the whole thing is one transaction, so a
-- failure leaves the database as it was and a second run is safe.
--
-- ## Deliberately not seeded
--
-- `tier_draws` / `tier_draw_matches` (the A/B/C/D brackets) and
-- `tournament_registrations` (pending requests). Entrants do get a `tier` from
-- their record, but no bracket rows exist, so a tier screen shows the tier word
-- without a bracket behind it.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Confirmation gate
-- ---------------------------------------------------------------------------
--
-- A speed bump, not security: this deletes every tournament in whatever project
-- it runs against, and the most likely way to get that wrong is pasting it into
-- the wrong tab. Change 'NO' to 'SEED-STAGING' to arm it.
DO $$
DECLARE
  v_confirm text := 'NO';
BEGIN
  IF v_confirm <> 'SEED-STAGING' THEN
    RAISE EXCEPTION
      'Refusing to run: this deletes every tournament. Set v_confirm to SEED-STAGING first, and check which project you are in.';
  END IF;
END $$;

-- `tournaments.owner_profile_id` is NOT NULL and references `profiles(id)`, so
-- there has to be somebody to own what we insert.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles) THEN
    RAISE EXCEPTION
      'No profile to own the seeded tournaments. Create a staff login first (scripts/create-staff-login.mjs), then re-run.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Clear the deck
-- ---------------------------------------------------------------------------
--
-- Leaf-first. Every foreign key here is ON DELETE CASCADE or SET NULL, so the
-- order is not strictly required, but explicit is reportable. The tier and
-- placement tables hang off `tournaments`/`categories` rather than off a team, so
-- they do not cascade from `teams` and have to be named.
DELETE FROM public.desk_activity;

DELETE FROM public.tier_draw_matches;
DELETE FROM public.tier_draws;
DELETE FROM public.placement_matches;
DELETE FROM public.placement_entrants;

DELETE FROM public.draw_matches;
DELETE FROM public.draws;
DELETE FROM public.pool_matches;
DELETE FROM public.pool_entries;
DELETE FROM public.pools;

DELETE FROM public.tournament_registration_entries;
DELETE FROM public.tournament_registrations;

DELETE FROM public.teams;
DELETE FROM public.players;

DELETE FROM public.categories;
DELETE FROM public.courts;
DELETE FROM public.tournament_days;
DELETE FROM public.tournaments;

ALTER TABLE public.desk_activity ALTER COLUMN id RESTART WITH 1;

-- ---------------------------------------------------------------------------
-- 2. Owner and the three tournaments
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE seed_owner ON COMMIT DROP AS
SELECT p.id
FROM public.profiles p
ORDER BY (p.system_role = 'admin') DESC, p.created_at
LIMIT 1;

CREATE TEMP TABLE seed_t (key text PRIMARY KEY, id uuid NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE seed_tkey (key text PRIMARY KEY, name text NOT NULL) ON COMMIT DROP;

INSERT INTO seed_tkey (key, name) VALUES
  ('chicago', 'Windy City Open 2026'),
  ('sf',      'Golden Gate Open 2026'),
  ('ny',      'Empire State Open 2026');

-- `status` is constrained to ('upcoming','in_progress','completed') and `format`
-- to ('round_robin','two_round_placement'); the placement RPCs are the current
-- format, so that is what a fresh event gets. `placement_best_of` is 3 so a
-- two-game result is a legal one.
--
-- The name comes from `seed_tkey` rather than being repeated here, so the two
-- cannot drift apart. `venue_timezone` is per-event: each is a different city, and
-- `tournament_starts_at` / `tournament_ends_at` convert the day rows through it.
-- The registration windows are written in the offset in force on those dates
-- (CDT -05, PDT -07, EDT -04), all before US DST ends on 1 Nov 2026.
INSERT INTO public.tournaments (
  name, status, format,
  venue_name, venue_address, venue_timezone,
  organizer_name, organizer_email, organizer_phone,
  day_count, court_count,
  registration_opens_at, registration_closes_at,
  placement_best_of, placement_games_to, placement_win_by,
  knockout_best_of, knockout_games_to, knockout_win_by,
  max_categories_per_player, notes, owner_profile_id
)
SELECT
  k.name, v.status, 'two_round_placement',
  v.venue_name, v.venue_address, v.venue_timezone,
  v.organizer_name, v.organizer_email, v.organizer_phone,
  v.day_count, v.court_count,
  v.reg_opens, v.reg_closes,
  3, 21, 2,
  3, 21, 2,
  2, v.notes, o.id
FROM (VALUES
  (
    'chicago', 'completed',
    'Midwest Badminton Center', '3150 N Sheffield Ave, Chicago, IL 60657',
    'America/Chicago',
    'Chicago Badminton Association', 'ops@chicagobadminton.example', '(312) 555-0184',
    2, 8,
    TIMESTAMPTZ '2026-08-01 00:00:00-05', TIMESTAMPTZ '2026-09-05 23:59:00-05',
    E'Annual Midwest classic, two days, four events.\nShuttle speed 77; feather shuttles throughout.'
  ),
  (
    'sf', 'completed',
    'Golden Gate Badminton Club', '60 Dorman Ave, San Francisco, CA 94124',
    'America/Los_Angeles',
    'Northern California Badminton Association', 'entry@ncbadminton.example', '(415) 555-0117',
    2, 8,
    TIMESTAMPTZ '2026-07-01 00:00:00-07', TIMESTAMPTZ '2026-08-08 23:59:00-07',
    E'Open regional championship. Group stage Saturday, placement Sunday.\nPlayers must report 30 minutes before their first match.'
  ),
  (
    'ny', 'upcoming',
    'Brooklyn Badminton Academy', '1555 63rd St, Brooklyn, NY 11219',
    'America/New_York',
    'New York Badminton Association', 'secretariat@nybadminton.example', '(212) 555-0143',
    2, 8,
    TIMESTAMPTZ '2026-10-01 00:00:00-04', TIMESTAMPTZ '2026-10-25 23:59:00-04',
    E'State championship, 31 October and 1 November 2026.\nRegistration closes when the draw is published, or at 48 entries per event, whichever comes first.'
  )
) AS v (
  key, status, venue_name, venue_address, venue_timezone,
  organizer_name, organizer_email, organizer_phone,
  day_count, court_count, reg_opens, reg_closes, notes
)
JOIN seed_tkey k ON k.key = v.key
CROSS JOIN seed_owner o;

INSERT INTO seed_t (key, id)
SELECT k.key, t.id
FROM seed_tkey k
JOIN public.tournaments t ON t.name = k.name;

-- ---------------------------------------------------------------------------
-- 3. Days and courts
-- ---------------------------------------------------------------------------
-- `tournament_starts_at` / `tournament_ends_at` are derived from these rows, so
-- the dates a card shows come from here rather than from the tournaments row.
INSERT INTO public.tournament_days (tournament_id, day_number, date, start_time, end_time)
SELECT t.id, d.day_number, d.date, d.start_time, d.end_time
FROM seed_t t
JOIN (VALUES
  ('chicago', 1, DATE '2026-09-12', TIME '09:00', TIME '18:30'),
  ('chicago', 2, DATE '2026-09-13', TIME '09:00', TIME '17:00'),
  ('sf',      1, DATE '2026-08-15', TIME '09:00', TIME '18:30'),
  ('sf',      2, DATE '2026-08-16', TIME '09:00', TIME '17:00'),
  ('ny',      1, DATE '2026-10-31', TIME '09:00', TIME '18:30'),
  ('ny',      2, DATE '2026-11-01', TIME '09:00', TIME '17:00')
) AS d (key, day_number, date, start_time, end_time) ON d.key = t.key;

INSERT INTO public.courts (tournament_id, number)
SELECT t.id, g.n
FROM seed_t t
CROSS JOIN generate_series(1, 8) AS g (n);

-- ---------------------------------------------------------------------------
-- 4. Events
-- ---------------------------------------------------------------------------
-- Caps stay well above the seeded entry counts, and none is below 2, which is
-- the `category_caps` readiness check.
INSERT INTO public.categories (
  tournament_id, code, name, entry_type, sort_order, active, max_entries
)
SELECT t.id, c.code, c.name, c.entry_type, c.sort_order, true, c.max_entries
FROM seed_t t
CROSS JOIN (VALUES
  ('MS', 'Men''s Singles',   'individual', 1, 32),
  ('MD', 'Men''s Doubles',   'pair',       2, 32),
  ('WD', 'Women''s Doubles', 'pair',       3, 16),
  ('XD', 'Mixed Doubles',    'pair',       4, 16)
) AS c (code, name, entry_type, sort_order, max_entries);

-- ---------------------------------------------------------------------------
-- 5. Roster
-- ---------------------------------------------------------------------------
-- `players` has no `tournament_id`: the roster is global, and the same person
-- turning up at two events is the realistic case, not an error. `profile_id` is
-- left NULL - these are walk-ins, not accounts.
CREATE TEMP TABLE seed_roster (
  seq int NOT NULL,
  name text NOT NULL,
  gender text NOT NULL CHECK (gender IN ('M', 'F')),
  PRIMARY KEY (gender, seq)
) ON COMMIT DROP;

-- Names are a plausible US club roster: badminton in the States draws heavily from
-- Asian-American and South Asian communities, with the rest of the field mixed.
-- `seq` is per gender and drives the entry slicing below, so only the labels change.
INSERT INTO seed_roster (seq, name, gender) VALUES
  (1,'Kevin Zhang','M'),                (2,'Marcus Chen','M'),
  (3,'Daniel Park','M'),                (4,'Jason Liu','M'),
  (5,'Andrew Nguyen','M'),              (6,'Ryan Kim','M'),
  (7,'Michael Tran','M'),               (8,'Eric Wu','M'),
  (9,'Brandon Lee','M'),                (10,'Justin Pham','M'),
  (11,'David Huang','M'),               (12,'Steven Vo','M'),
  (13,'Anthony Lam','M'),               (14,'Christopher Yoo','M'),
  (15,'Brian Ho','M'),                  (16,'Jonathan Thai','M'),
  (17,'Tyler Sharma','M'),              (18,'Nathan Patel','M'),
  (19,'Aaron Reddy','M'),               (20,'Adam Gupta','M'),
  (21,'Samuel Rivera','M'),             (22,'Joshua Alvarez','M'),
  (23,'Ethan Brooks','M'),              (24,'Caleb Whitfield','M'),
  (25,'Noah Bennett','M'),              (26,'Liam Sullivan','M'),
  (27,'Owen Fitzgerald','M'),           (28,'Mason Delgado','M'),
  (29,'Lucas Moreno','M'),              (30,'Henry Castillo','M'),
  (31,'Benjamin Price','M'),            (32,'Jacob Reynolds','M'),
  (33,'Alexander Foster','M'),          (34,'Elijah Coleman','M'),
  (35,'Gabriel Simmons','M'),           (36,'Isaac Baldwin','M'),
  (37,'Nathaniel Graves','M'),          (38,'Zachary Holloway','M'),
  (39,'Vincent Marsh','M'),             (40,'Daniel Okafor','M'),
  (1,'Emily Zhang','F'),                (2,'Sarah Chen','F'),
  (3,'Michelle Park','F'),              (4,'Jessica Liu','F'),
  (5,'Amanda Nguyen','F'),              (6,'Rachel Kim','F'),
  (7,'Stephanie Tran','F'),             (8,'Christina Wu','F'),
  (9,'Tiffany Lee','F'),                (10,'Vivian Pham','F'),
  (11,'Diana Huang','F'),               (12,'Angela Vo','F'),
  (13,'Grace Lam','F'),                 (14,'Helen Yoo','F'),
  (15,'Cathy Ho','F'),                  (16,'Priya Sharma','F'),
  (17,'Anjali Patel','F'),              (18,'Neha Reddy','F'),
  (19,'Meera Gupta','F'),               (20,'Olivia Okafor','F'),
  (21,'Sophia Rivera','F'),             (22,'Isabella Alvarez','F'),
  (23,'Madison Brooks','F'),            (24,'Hannah Whitfield','F');

INSERT INTO public.players (name, gender)
SELECT name, gender FROM seed_roster;

-- ---------------------------------------------------------------------------
-- 6. Entries
-- ---------------------------------------------------------------------------
-- The plan below slices the roster so that, *within one tournament*, no player is
-- used by two events. That is what keeps `enforce_two_category_cap` (two events
-- per player, per tournament) from firing, and it is why the slices are written
-- out rather than generated by a formula.
--
-- Across tournaments the same people reappear, which is the point of a roster.
CREATE TEMP TABLE seed_plan (
  tkey text NOT NULL,
  code text NOT NULL,
  entry_index int NOT NULL,
  p1_gender text NOT NULL,
  p1_seq int NOT NULL,
  p2_gender text,
  p2_seq int,
  PRIMARY KEY (tkey, code, entry_index)
) ON COMMIT DROP;

INSERT INTO seed_plan (tkey, code, entry_index, p1_gender, p1_seq, p2_gender, p2_seq)
SELECT s.tkey, s.code, g.i, s.p1g, s.p1start + g.i - 1,
       s.p2g,
       CASE WHEN s.p2g IS NULL THEN NULL ELSE s.p2start + g.i - 1 END
FROM (VALUES
  -- The two completed events: eight entries per event, 32 in all.
  ('chicago', 'MS', 8, 'M',  1, NULL, NULL),
  ('chicago', 'MD', 8, 'M',  9, 'M',    17),
  ('chicago', 'XD', 8, 'M', 25, 'F',     1),
  ('chicago', 'WD', 8, 'F',  9, 'F',    17),
  ('sf',      'MS', 8, 'M',  1, NULL, NULL),
  ('sf',      'MD', 8, 'M',  9, 'M',    17),
  ('sf',      'XD', 8, 'M', 25, 'F',     1),
  ('sf',      'WD', 8, 'F',  9, 'F',    17),
  -- The upcoming event: registration is still open, so it is partly filled.
  ('ny',      'MS', 4, 'M', 33, NULL, NULL),
  ('ny',      'MD', 4, 'M',  1, 'M',     5),
  ('ny',      'XD', 4, 'M',  9, 'F',     1),
  ('ny',      'WD', 4, 'F',  5, 'F',     9)
) AS s (tkey, code, entries, p1g, p1start, p2g, p2start)
CROSS JOIN LATERAL generate_series(1, s.entries) AS g (i);

-- `teams.tournament_id` is derived from the category by `enforce_team_shape`, so
-- the value here is the same one the trigger would write. The gender rules
-- (singles = one player, MD two men, WD two women, XD one of each, and the two
-- players must differ) are all satisfied by construction.
INSERT INTO public.teams (tournament_id, category_id, player_1_id, player_2_id, seed)
SELECT t.id, c.id, p1.id, p2.id, plan.entry_index
FROM seed_plan plan
JOIN seed_t t ON t.key = plan.tkey
JOIN public.categories c ON c.tournament_id = t.id AND c.code = plan.code
JOIN seed_roster r1 ON r1.gender = plan.p1_gender AND r1.seq = plan.p1_seq
JOIN public.players p1 ON p1.name = r1.name
LEFT JOIN seed_roster r2 ON r2.gender = plan.p2_gender AND r2.seq = plan.p2_seq
LEFT JOIN public.players p2 ON p2.name = r2.name;

-- ---------------------------------------------------------------------------
-- 7. Placement entrants, for the finished events only
-- ---------------------------------------------------------------------------
-- Registration is closed for a completed tournament, so seeds are frozen
-- (`seed_locked_at`). The upcoming event deliberately has none: seeds are only
-- assigned once registration closes.
INSERT INTO public.placement_entrants (
  tournament_id, category_id, team_id, skill_level, seed, seed_locked_at
)
SELECT
  tm.tournament_id, tm.category_id, tm.id,
  CASE WHEN tm.seed <= 2 THEN 'advanced'
       WHEN tm.seed <= 6 THEN 'intermediate'
       ELSE 'beginner' END,
  tm.seed, now()
FROM public.teams tm
JOIN public.tournaments t ON t.id = tm.tournament_id
WHERE t.status = 'completed';

-- ---------------------------------------------------------------------------
-- 8. Results: two placement rounds per event, all reported
-- ---------------------------------------------------------------------------
-- Round one pairs the field by seed (1v2, 3v4, ...) and the better seed wins, so
-- the round is a formality. Round two re-pairs inside each block of four
-- (1v3, 2v4) and is where the upsets are, which is what makes the standings and
-- the tiers look like a tournament rather than a table.
--
-- Two invariants are checked by the database and respected here: a pairing may
-- occur only once per category, and a winner must be one of the two entrants.
-- The two rounds never repeat a pairing.
DO $$
DECLARE
  cat record;
  v_entrants uuid[];
  v_courts uuid[];
  n int;
  i int;
  k int;
  a uuid;
  b uuid;
  v_court uuid;
  v_day1 timestamptz;
  v_day2 timestamptz;
  v_start timestamptz;
  v_upset boolean;
  v_games jsonb;
BEGIN
  FOR cat IN
    SELECT c.id AS category_id, c.tournament_id
    FROM public.categories c
    JOIN public.tournaments t ON t.id = c.tournament_id
    WHERE t.status = 'completed'
    ORDER BY c.tournament_id, c.sort_order
  LOOP
    SELECT array_agg(pe.id ORDER BY pe.seed)
    INTO v_entrants
    FROM public.placement_entrants pe
    WHERE pe.category_id = cat.category_id;

    n := COALESCE(array_length(v_entrants, 1), 0);
    -- The pairing scheme needs a multiple of four: round two pairs within blocks
    -- of four, and a short tail would leave somebody unpaired.
    IF n < 4 OR n % 4 <> 0 THEN
      CONTINUE;
    END IF;

    SELECT array_agg(c.id ORDER BY c.number)
    INTO v_courts
    FROM public.courts c
    WHERE c.tournament_id = cat.tournament_id;

    SELECT
      (SELECT min((d.date + d.start_time) AT TIME ZONE t.venue_timezone)
       FROM public.tournament_days d
       WHERE d.tournament_id = cat.tournament_id AND d.day_number = 1),
      (SELECT min((d.date + d.start_time) AT TIME ZONE t.venue_timezone)
       FROM public.tournament_days d
       WHERE d.tournament_id = cat.tournament_id AND d.day_number = 2)
    INTO v_day1, v_day2
    FROM public.tournaments t
    WHERE t.id = cat.tournament_id;

    -- Round one -----------------------------------------------------------------
    i := 1;
    k := 0;
    WHILE i <= n LOOP
      a := v_entrants[i];
      b := v_entrants[i + 1];
      k := k + 1;
      v_court := v_courts[((k - 1) % array_length(v_courts, 1)) + 1];
      v_start := v_day1 + make_interval(mins => (k - 1) * 25);

      INSERT INTO public.placement_matches (
        tournament_id, category_id, stage, generation_key,
        entrant_a_id, entrant_b_id, winner_id, games, status,
        court_id, scheduled_time, started_at, ended_at, reported_time
      ) VALUES (
        cat.tournament_id, cat.category_id, 'round1', 'r1-' || k,
        a, b, a,
        jsonb_build_array(
          jsonb_build_object('a', 21, 'b', 12 + (k % 6)),
          jsonb_build_object('a', 21, 'b', 14 + (k % 5))
        ),
        'reported',
        v_court, v_start, v_start, v_start + interval '25 minutes',
        v_start + interval '25 minutes'
      );

      i := i + 2;
    END LOOP;

    -- Round two -----------------------------------------------------------------
    -- Inside each block of four, 1v3 and 2v4: a different pairing from round one
    -- for everyone, and two matches for everyone in the field.
    i := 1;
    k := 0;
    WHILE i <= n LOOP
      k := k + 1;
      v_upset := (k % 2 = 0);
      v_court := v_courts[((k - 1) % array_length(v_courts, 1)) + 1];
      v_start := v_day2 + make_interval(mins => (k - 1) * 25);

      -- (i, i+2) - the higher seed unless this is an upset slot.
      a := v_entrants[i];
      b := v_entrants[i + 2];
      v_games := CASE WHEN v_upset
        THEN jsonb_build_array(
               jsonb_build_object('a', 18, 'b', 21),
               jsonb_build_object('a', 16, 'b', 21))
        ELSE jsonb_build_array(
               jsonb_build_object('a', 21, 'b', 18),
               jsonb_build_object('a', 21, 'b', 19))
      END;

      INSERT INTO public.placement_matches (
        tournament_id, category_id, stage, generation_key,
        entrant_a_id, entrant_b_id, winner_id, games, status,
        court_id, scheduled_time, started_at, ended_at, reported_time
      ) VALUES (
        cat.tournament_id, cat.category_id, 'round2', 'r2-' || k,
        a, b, CASE WHEN v_upset THEN b ELSE a END, v_games, 'reported',
        v_court, v_start, v_start, v_start + interval '25 minutes',
        v_start + interval '25 minutes'
      );

      k := k + 1;
      v_upset := (k % 2 = 0);
      v_court := v_courts[((k - 1) % array_length(v_courts, 1)) + 1];
      v_start := v_day2 + make_interval(mins => (k - 1) * 25);

      -- (i+1, i+3)
      a := v_entrants[i + 1];
      b := v_entrants[i + 3];
      v_games := CASE WHEN v_upset
        THEN jsonb_build_array(
               jsonb_build_object('a', 19, 'b', 21),
               jsonb_build_object('a', 15, 'b', 21))
        ELSE jsonb_build_array(
               jsonb_build_object('a', 21, 'b', 16),
               jsonb_build_object('a', 21, 'b', 13))
      END;

      INSERT INTO public.placement_matches (
        tournament_id, category_id, stage, generation_key,
        entrant_a_id, entrant_b_id, winner_id, games, status,
        court_id, scheduled_time, started_at, ended_at, reported_time
      ) VALUES (
        cat.tournament_id, cat.category_id, 'round2', 'r2-' || k,
        a, b, CASE WHEN v_upset THEN b ELSE a END, v_games, 'reported',
        v_court, v_start, v_start, v_start + interval '25 minutes',
        v_start + interval '25 minutes'
      );

      i := i + 4;
    END LOOP;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 9. Tiers, from the record
-- ---------------------------------------------------------------------------
-- Two wins is a tier A entrant, one is B, none is D. No `tier_draws` rows are
-- created, so this is the tier word without the bracket behind it.
WITH record AS (
  SELECT pe.id AS entrant_id,
         (SELECT count(*)
          FROM public.placement_matches pm
          WHERE pm.winner_id = pe.id) AS wins
  FROM public.placement_entrants pe
)
UPDATE public.placement_entrants pe
SET tier = CASE
  WHEN r.wins >= 2 THEN 'A'
  WHEN r.wins = 1 THEN 'B'
  ELSE 'D'
END
FROM record r
WHERE r.entrant_id = pe.id;

COMMIT;

-- ============================================================================
-- Verify
-- ============================================================================
SELECT 'tournaments' AS what, count(*)::text AS value FROM public.tournaments
UNION ALL SELECT '  completed', count(*)::text FROM public.tournaments WHERE status = 'completed'
UNION ALL SELECT '  upcoming',  count(*)::text FROM public.tournaments WHERE status = 'upcoming'
UNION ALL SELECT 'tournament_days', count(*)::text FROM public.tournament_days
UNION ALL SELECT 'courts',          count(*)::text FROM public.courts
UNION ALL SELECT 'categories',      count(*)::text FROM public.categories
UNION ALL SELECT 'players',         count(*)::text FROM public.players
UNION ALL SELECT 'teams (entries)', count(*)::text FROM public.teams
UNION ALL SELECT 'placement_entrants', count(*)::text FROM public.placement_entrants
UNION ALL SELECT 'placement_matches',  count(*)::text FROM public.placement_matches
UNION ALL SELECT 'profiles (kept)',    count(*)::text FROM public.profiles
ORDER BY 1;

-- What Explore will render, straight from the read the page uses. The upcoming
-- row is the one to check: `registration_state` should read `open`.
SELECT name, status, registration_state, entry_count, category_count,
       starts_at, ends_at, venue_name
FROM public.tournament_summary()
ORDER BY starts_at DESC;
