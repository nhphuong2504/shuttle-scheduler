-- ============================================================================
-- Demo tournaments: the generator, and the remover
-- ============================================================================
--
-- Companion to `20261015000000_demo_tournament_flag.sql`, which added the flag these
-- functions write. This file defines the two calls and runs neither of them: pushing the
-- branch to production leaves production with an empty `is_demo` column and two functions
-- nobody has called. Seeding a project is `select public.seed_demo_tournaments();` and
-- nothing else does it for you.
--
-- ## Why the generator is SQL rather than a script
--
-- `scripts/seed-ui-tournaments.sql` is the precedent, and it is a script for a good reason
-- of its own: it deletes every tournament to exercise the blank-slate path, so it must never
-- be a migration. This one is different twice over. It removes only rows it wrote, so it is
-- safe to hold as a function; and it must be *callable by name* by three callers that cannot
-- share a script - the SQL editor against a hosted project, the npm task against a local
-- stack, and the integration suite, which asserts that a second run produces the same rows.
-- A function is the only shape all three can use, and it makes the whole seed one statement,
-- so a failure half way through commits nothing.
--
-- ## Why it writes rows directly rather than going through the app's RPCs
--
-- The application's path is `create_tournament`, then `apply_placement_generation`, then
-- `apply_tier_draws`, and each checks `can_edit_tournament` against `auth.uid()`. A
-- migration runs with no JWT, so `current_profile_id()` is NULL, `is_tournament_owner()` is
-- false and every one of those calls refuses. Reaching them would mean impersonating a
-- signed-in user by writing `request.jwt.claims` mid-transaction - a trick the application
-- never performs, and one that would put demo seeding on a different code path from
-- everything else in the schema.
--
-- So this writes the rows those RPCs would have written, which is what
-- `seed-ui-tournaments.sql` already does, and leans on the same guards to catch a mistake:
-- `enforce_team_shape` checks each pair and its gender, `enforce_two_category_cap` checks the
-- per-player cap, `placement_matches_pairing_unique` checks that nobody meets twice, and the
-- `winner_id IN (entrant_a_id, entrant_b_id)` check on both match tables checks the results.
-- A wrong dataset raises inside the transaction, before anything is committed.
--
-- The rules it follows are the documented ones, not invented here:
--   * round one is the half-split `i` vs `ceil(N/2) + i` (docs/tournament-format.md);
--   * round two pairs the winners with the winners and the losers with the losers, which is
--     what leaves every entrant with a decided WW/WL/LW/LL record;
--   * the record decides the draw: WW is A, WL is B, LW is C, LL is D;
--   * a bracket is single elimination and a bye goes to the best seed.
--
-- ## Dates are relative, and the snapshot is fixed
--
-- Every date is derived from the venue's own local calendar at the moment the function runs,
-- so re-running is also how the data is refreshed: the two completed events stay behind us,
-- the four upcoming ones stay ahead, and the two in-progress ones stay around today. Nothing
-- here is a scheduled job, and nothing here is run on a timer.
--
-- The in-progress snapshot is a *picture*, not a feed. Round one sits on yesterday afternoon
-- and round two straddles the moment of seeding - the first two matches are `in-progress`
-- ten minutes before now and the rest are `scheduled` from ten minutes after - so the board
-- has something on court and nothing overdue whatever hour it is run at. The clock does not
-- move afterwards, which is exactly why the app labels these as demo and why they are not
-- presented as live events.

-------------------------------------------------------------------------------
-- 1. The sample owner
-------------------------------------------------------------------------------

-- `tournaments.owner_profile_id` is NOT NULL and references `profiles(id)`, so the sample
-- events need somebody to belong to. One dedicated profile with no `user_id` is the point:
-- it cannot be signed into, because nothing links it to `auth.users`, so the sample events
-- never appear in a real person's "Running" list and they survive a real user being deleted.
--
-- `@tournova.example` is a reserved documentation domain, not a mailbox. The address exists
-- to be recognisable as sample data in the SQL editor and can never receive mail.
CREATE OR REPLACE FUNCTION public.demo_tournament_owner()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT p.id INTO v_id FROM public.profiles p WHERE p.email = 'demo-tournaments@tournova.example';
  IF v_id IS NULL THEN
    INSERT INTO public.profiles (email, system_role)
    VALUES ('demo-tournaments@tournova.example', 'user')
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

-------------------------------------------------------------------------------
-- 2. Remove
-------------------------------------------------------------------------------

-- Leaf-first is not required - every foreign key on these tables cascades - but `desk_activity`
-- has no `tournament_id` and no foreign key, so its rows for a sample match would outlive the
-- tournament and keep appearing on the desk for a match that no longer exists. They are
-- cleared by `match_id` first, the way `delete_tournament` clears them.
--
-- `players` is why this is not just "delete the tournaments": it is the one global table, so
-- sample people are reached by no cascade from a tournament. They are removed by their own
-- flag and only their own flag - a walk-in a real desk added has `is_demo` false and is never
-- in the list.
CREATE OR REPLACE FUNCTION public.remove_demo_tournaments()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_removed int;
  v_owner uuid;
BEGIN
  DELETE FROM public.desk_activity da
  WHERE da.match_id IN (
    SELECT m.id FROM public.placement_matches m
      JOIN public.tournaments t ON t.id = m.tournament_id AND t.is_demo
    UNION ALL
    SELECT m.id FROM public.tier_draw_matches m
      JOIN public.tournaments t ON t.id = m.tournament_id AND t.is_demo
    UNION ALL
    SELECT m.id FROM public.pool_matches m
      JOIN public.tournaments t ON t.id = m.tournament_id AND t.is_demo
    UNION ALL
    SELECT m.id FROM public.draw_matches m
      JOIN public.tournaments t ON t.id = m.tournament_id AND t.is_demo
  );

  DELETE FROM public.tournaments WHERE is_demo;
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  DELETE FROM public.players WHERE is_demo;

  -- The sample owner goes too, unless something real has adopted it or it has somehow
  -- acquired a login.
  v_owner := public.demo_tournament_owner();
  DELETE FROM public.profiles p
  WHERE p.id = v_owner
    AND p.user_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.tournaments t WHERE t.owner_profile_id = p.id);

  RETURN v_removed;
END;
$$;

-------------------------------------------------------------------------------
-- 3. Seed
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.seed_demo_tournaments()
RETURNS TABLE (
  tournament text,
  status text,
  venue text,
  dates text,
  entries int,
  events int,
  stage text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- The name pools. Crossed by a stride rather than listed longhand: 40 first names against
  -- 32 surnames is more distinct people than the seed needs, and the arithmetic is fixed, so
  -- the roster is reproducible without a 170-line literal. The pools are drawn from the
  -- communities American badminton clubs actually draw from, so the combinations read like
  -- an entry list rather than like generated words.
  v_m_first text[] := ARRAY[
    'Kevin', 'Marcus', 'Daniel', 'Jason', 'Andrew', 'Ryan', 'Michael', 'Eric', 'Brandon', 'Justin',
    'David', 'Steven', 'Anthony', 'Christopher', 'Brian', 'Jonathan', 'Tyler', 'Nathan', 'Aaron', 'Adam',
    'Samuel', 'Joshua', 'Ethan', 'Caleb', 'Noah', 'Liam', 'Owen', 'Mason', 'Lucas', 'Henry',
    'Benjamin', 'Jacob', 'Alexander', 'Elijah', 'Gabriel', 'Isaac', 'Zachary', 'Vincent', 'Raymond', 'Adrian'
  ];
  v_f_first text[] := ARRAY[
    'Emily', 'Sarah', 'Michelle', 'Jessica', 'Amanda', 'Rachel', 'Stephanie', 'Christina', 'Tiffany', 'Vivian',
    'Diana', 'Angela', 'Grace', 'Helen', 'Cathy', 'Priya', 'Anjali', 'Neha', 'Meera', 'Olivia',
    'Sophia', 'Isabella', 'Madison', 'Hannah', 'Chloe', 'Natalie', 'Rebecca', 'Lauren', 'Megan', 'Alice',
    'Julia', 'Fiona', 'Karen', 'Nina', 'Selina', 'Joyce', 'Carol', 'Winnie', 'Dana', 'Iris'
  ];
  v_last text[] := ARRAY[
    'Zhang', 'Chen', 'Park', 'Liu', 'Nguyen', 'Kim', 'Tran', 'Wu', 'Lee', 'Pham',
    'Huang', 'Vo', 'Lam', 'Yoo', 'Ho', 'Thai', 'Sharma', 'Patel', 'Reddy', 'Gupta',
    'Rivera', 'Alvarez', 'Brooks', 'Whitfield', 'Bennett', 'Sullivan', 'Fitzgerald', 'Delgado', 'Moreno', 'Castillo',
    'Price', 'Okafor'
  ];

  v_owner uuid;
  v_t record;
  v_e record;
  v_s record;
  v_cat_id uuid;
  v_tier text;

  v_today date;
  v_starts date;
  v_reg_opens timestamptz;
  v_reg_closes timestamptz;
  v_created timestamptz;
  v_tid uuid;
  v_day_start timestamp;
  v_day_end time;

  -- Entry allocation cursors, one per tournament and gender.
  v_m_cur int;
  v_f_cur int;
  v_g text;
  v_p1 uuid;
  v_p2 uuid;

  -- Scheduling.
  v_k int;
  v_courts uuid[];
  v_seq1 int;
  v_seq2 int;
  v_ord int;
  v_at timestamptz;
  v_round2 timestamptz;
  v_court uuid;
  v_upset boolean;
  v_games jsonb;

  -- Placement rounds.
  v_entrants uuid[];
  v_winners uuid[];
  v_losers uuid[];
  v_n int;
  v_half int;
  v_i int;
  v_a uuid;
  v_b uuid;
  v_w uuid;

  -- Brackets.
  v_bseq int;
  v_field uuid[];
  v_cnt int;
  v_size int;
  v_draw uuid;
  v_round int;
  v_prev int;
  v_cur int;
  v_slot int;
  v_match uuid;
  v_mid_a uuid;
  v_mid_b uuid;
  v_wa uuid;
  v_wb uuid;
  v_champion uuid;
BEGIN
  -- Idempotent by construction: the previous sample set goes first, in the same transaction,
  -- so a second run cannot duplicate anything and a failed run leaves the first set intact.
  PERFORM public.remove_demo_tournaments();

  v_owner := public.demo_tournament_owner();

  DROP TABLE IF EXISTS demo_spec;
  CREATE TEMP TABLE demo_spec (
    tkey text PRIMARY KEY,
    name text NOT NULL,
    venue_name text NOT NULL,
    venue_address text NOT NULL,
    venue_timezone text NOT NULL,
    organizer_name text NOT NULL,
    organizer_email text NOT NULL,
    organizer_phone text NOT NULL,
    t_status text NOT NULL,
    court_count int NOT NULL,
    day_count int NOT NULL,
    starts_offset int NOT NULL,
    has_registration boolean NOT NULL,
    build_mode text NOT NULL,
    m_start int NOT NULL,
    f_start int NOT NULL,
    notes text NOT NULL
  ) ON COMMIT DROP;

  -- Eight events: two in progress, four upcoming, two completed, and no two the same size,
  -- shape or stage. `build_mode` says how far the tournament has got:
  --   full    - both placement rounds played, tiers drawn, brackets played to a champion
  --   partial - round one played, round two on court now (the in-progress snapshot)
  --   round1  - the draw is published and scheduled, nothing played
  --   none    - the field is set, the schedule is not built
  INSERT INTO demo_spec VALUES
    ('harbor', 'Harborline Open 2026',
     'Harborline Badminton Center', '214 Marginal St, Boston, MA 02128', 'America/New_York',
     'Harborline Badminton Association', 'entry@harborline.example', '(617) 555-0142',
     'in_progress', 8, 3, -1, true, 'partial', 1, 1,
     E'Three days and five events, with placement on the first two days.\nShuttle speed 77. Feather throughout.'),
    ('cedar', 'Cedar Ridge Classic',
     'Cedar Ridge Sports Hall', '4801 Burnet Rd, Austin, TX 78756', 'America/Chicago',
     'Cedar Ridge Badminton Club', 'desk@cedarridge.example', '(512) 555-0198',
     'in_progress', 4, 2, -1, true, 'partial', 25, 41,
     E'A short club classic: the men''s doubles draw and the mixed draw, over two days.'),
    ('lakeshore', 'Lakeshore Winter Challenge',
     'Lakeshore Athletic Complex', '900 N Harbor Dr, Milwaukee, WI 53202', 'America/Chicago',
     'Lakeshore Badminton League', 'entries@lakeshore.example', '(414) 555-0126',
     'upcoming', 8, 3, 13, true, 'round1', 5, 9,
     E'Winter challenge across five events. The draw is published; play begins on the first day at nine.'),
    ('sonoran', 'Sonoran Desert Open',
     'Sonoran Racquet Center', '3601 E Broadway Blvd, Tucson, AZ 85716', 'America/Phoenix',
     'Sonoran Badminton Association', 'register@sonoranopen.example', '(520) 555-0173',
     'upcoming', 6, 2, 21, true, 'none', 33, 49,
     E'Singles, men''s doubles and the mixed draw. The field is set and the schedule is being built.'),
    ('pinehurst', 'Pinehurst Invitational',
     'Pinehurst Village Hall', '395 Magnolia Rd, Pinehurst, NC 28374', 'America/New_York',
     'Pinehurst Badminton Circle', 'invitations@pinehurst.example', '(910) 555-0111',
     'upcoming', 4, 1, 35, false, 'none', 49, 57,
     E'An invitation event for club members. Entry is by invitation rather than by request.'),
    ('cascade', 'Cascade Autumn Cup',
     'Cascade Badminton Centre', '11900 NE 1st St, Bellevue, WA 98005', 'America/Los_Angeles',
     'Cascade Badminton Union', 'cup@cascadebadminton.example', '(425) 555-0164',
     'upcoming', 8, 2, 48, true, 'round1', 17, 21,
     E'The largest event on the autumn calendar: five draws and sixty-four entries.\nDoors open at 09:00.'),
    ('magnolia', 'Magnolia State Championships',
     'Magnolia Sports Pavilion', '1200 Lakeland Dr, Jackson, MS 39216', 'America/Chicago',
     'Magnolia Badminton Federation', 'championships@magnolia.example', '(601) 555-0135',
     'completed', 8, 2, -20, true, 'full', 9, 29,
     E'State championships across five events.\nPlacement on the first day, all four draws on the second.'),
    ('quarry', 'Quarry Lakes Open',
     'Quarry Lakes Recreation Center', '4444 Peralta Blvd, Fremont, CA 94536', 'America/Los_Angeles',
     'Quarry Lakes Badminton Club', 'open@quarrylakes.example', '(510) 555-0187',
     'completed', 4, 1, -47, true, 'full', 41, 45,
     E'A one-day open: placement in the morning, draws and finals in the afternoon.');

  DROP TABLE IF EXISTS demo_event;
  CREATE TEMP TABLE demo_event (
    tkey text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    entry_type text NOT NULL,
    gender text NOT NULL,
    sort_order int NOT NULL,
    max_entries int NOT NULL,
    teams int NOT NULL
  ) ON COMMIT DROP;

  -- `teams` is deliberately a multiple of four. Round two then yields four equal blocks, so
  -- the four tiers come out the same size and every bracket is a power of two with no byes to
  -- reason about. `m_start` / `f_start` are where each tournament starts reading the roster,
  -- so two events that share a city do not field the same people.
  INSERT INTO demo_event VALUES
    ('harbor',    'MS', 'Men''s Singles',   'individual', 'men',   1, 32, 16),
    ('harbor',    'WS', 'Women''s Singles', 'individual', 'women', 2, 24,  8),
    ('harbor',    'MD', 'Men''s Doubles',   'pair',       'men',   3, 32,  8),
    ('harbor',    'WD', 'Women''s Doubles', 'pair',       'women', 4, 24,  8),
    ('harbor',    'XD', 'Mixed Doubles',    'pair',       'mixed', 5, 32, 16),
    ('cedar',     'MD', 'Men''s Doubles',   'pair',       'men',   1, 16,  8),
    ('cedar',     'XD', 'Mixed Doubles',    'pair',       'mixed', 2, 16,  8),
    ('lakeshore', 'MS', 'Men''s Singles',   'individual', 'men',   1, 32, 16),
    ('lakeshore', 'WS', 'Women''s Singles', 'individual', 'women', 2, 24,  8),
    ('lakeshore', 'MD', 'Men''s Doubles',   'pair',       'men',   3, 32,  8),
    ('lakeshore', 'WD', 'Women''s Doubles', 'pair',       'women', 4, 24,  8),
    ('lakeshore', 'XD', 'Mixed Doubles',    'pair',       'mixed', 5, 32, 16),
    ('sonoran',   'MS', 'Men''s Singles',   'individual', 'men',   1, 24, 12),
    ('sonoran',   'MD', 'Men''s Doubles',   'pair',       'men',   2, 16,  8),
    ('sonoran',   'XD', 'Mixed Doubles',    'pair',       'mixed', 3, 16,  8),
    ('pinehurst', 'MS', 'Men''s Singles',   'individual', 'men',   1, 16,  8),
    ('pinehurst', 'WS', 'Women''s Singles', 'individual', 'women', 2, 16,  8),
    ('pinehurst', 'MD', 'Men''s Doubles',   'pair',       'men',   3, 16,  8),
    ('cascade',   'MS', 'Men''s Singles',   'individual', 'men',   1, 32, 16),
    ('cascade',   'WS', 'Women''s Singles', 'individual', 'women', 2, 32, 16),
    ('cascade',   'MD', 'Men''s Doubles',   'pair',       'men',   3, 32,  8),
    ('cascade',   'WD', 'Women''s Doubles', 'pair',       'women', 4, 24,  8),
    ('cascade',   'XD', 'Mixed Doubles',    'pair',       'mixed', 5, 32, 16),
    ('magnolia',  'MS', 'Men''s Singles',   'individual', 'men',   1, 32, 16),
    ('magnolia',  'WS', 'Women''s Singles', 'individual', 'women', 2, 24,  8),
    ('magnolia',  'MD', 'Men''s Doubles',   'pair',       'men',   3, 32,  8),
    ('magnolia',  'WD', 'Women''s Doubles', 'pair',       'women', 4, 24,  8),
    ('magnolia',  'XD', 'Mixed Doubles',    'pair',       'mixed', 5, 32, 16),
    ('quarry',    'MS', 'Men''s Singles',   'individual', 'men',   1, 16,  8),
    ('quarry',    'WS', 'Women''s Singles', 'individual', 'women', 2, 16,  8),
    ('quarry',    'MD', 'Men''s Doubles',   'pair',       'men',   3, 16,  8),
    ('quarry',    'XD', 'Mixed Doubles',    'pair',       'mixed', 4, 16,  8);

  DROP TABLE IF EXISTS demo_t;
  CREATE TEMP TABLE demo_t (
    tkey text PRIMARY KEY,
    id uuid NOT NULL,
    mode text NOT NULL,
    day_count int NOT NULL,
    starts_on date NOT NULL,
    courts uuid[] NOT NULL,
    day1 timestamptz NOT NULL,
    day2 timestamptz NOT NULL,
    later timestamptz NOT NULL
  ) ON COMMIT DROP;

  DROP TABLE IF EXISTS demo_cat;
  CREATE TEMP TABLE demo_cat (
    tkey text NOT NULL,
    code text NOT NULL,
    category_id uuid NOT NULL,
    PRIMARY KEY (tkey, code)
  ) ON COMMIT DROP;

  DROP TABLE IF EXISTS demo_roster;
  CREATE TEMP TABLE demo_roster (
    gender text NOT NULL,
    idx int NOT NULL,
    name text NOT NULL,
    player_id uuid,
    PRIMARY KEY (gender, idx)
  ) ON COMMIT DROP;

  DROP TABLE IF EXISTS demo_sched;
  CREATE TEMP TABLE demo_sched (
    tournament_id uuid NOT NULL,
    category_id uuid NOT NULL,
    stage text NOT NULL,
    generation_key text NOT NULL,
    a uuid NOT NULL,
    b uuid NOT NULL,
    winner uuid NOT NULL,
    ord int NOT NULL
  ) ON COMMIT DROP;

  DROP TABLE IF EXISTS demo_dtm;
  CREATE TEMP TABLE demo_dtm (
    draw_id uuid NOT NULL,
    round int NOT NULL,
    slot int NOT NULL,
    match_id uuid NOT NULL,
    winner_id uuid,
    PRIMARY KEY (draw_id, round, slot)
  ) ON COMMIT DROP;

  ---------------------------------------------------------------------------
  -- 3a. The roster
  ---------------------------------------------------------------------------
  --
  -- 96 men and 72 women, sized against the largest field below (48 and 48) plus its starting
  -- offset, so no tournament has to wrap around and reuse a person. Reusing one inside a
  -- tournament would trip `enforce_two_category_cap`, so the size is a correctness
  -- requirement rather than a preference.
  INSERT INTO demo_roster (gender, idx, name)
  SELECT 'M', i,
         v_m_first[((i - 1) % array_length(v_m_first, 1)) + 1] || ' ' ||
         v_last[((((i - 1) / array_length(v_m_first, 1)) + (i - 1)) % array_length(v_last, 1)) + 1]
  FROM generate_series(1, 96) AS g(i);

  INSERT INTO demo_roster (gender, idx, name)
  SELECT 'F', i,
         v_f_first[((i - 1) % array_length(v_f_first, 1)) + 1] || ' ' ||
         v_last[((((i - 1) / array_length(v_f_first, 1)) + (i - 1)) % array_length(v_last, 1)) + 1]
  FROM generate_series(1, 72) AS g(i);

  INSERT INTO public.players (name, gender, is_demo)
  SELECT r.name, r.gender, true FROM demo_roster r;

  UPDATE demo_roster r SET player_id = p.id
  FROM public.players p
  WHERE p.is_demo AND p.name = r.name AND p.gender = r.gender;

  IF EXISTS (SELECT 1 FROM demo_roster WHERE player_id IS NULL) THEN
    RAISE EXCEPTION 'demo seed: the sample roster did not resolve to player rows';
  END IF;

  ---------------------------------------------------------------------------
  -- 3b. Tournaments, days, courts, events
  ---------------------------------------------------------------------------
  FOR v_t IN SELECT * FROM demo_spec ORDER BY starts_offset, name LOOP
    v_today := (now() AT TIME ZONE v_t.venue_timezone)::date;
    v_starts := v_today + v_t.starts_offset;
    -- Closed a few days before seeding, so re-running later in the season cannot quietly turn
    -- a closed window into an open one. `tournament_registration_state` reads `closed`
    -- whenever the close is behind us, which is what all of these events are.
    v_reg_closes := now() - interval '5 days';
    v_reg_opens := v_reg_closes - interval '20 days';
    v_created := ((v_starts - 60) + time '09:00') AT TIME ZONE v_t.venue_timezone;

    INSERT INTO public.tournaments (
      name, status, format,
      venue_name, venue_address, venue_timezone,
      organizer_name, organizer_email, organizer_phone,
      day_count, court_count, starts_on, ends_on,
      registration_opens_at, registration_closes_at,
      placement_best_of, placement_games_to, placement_win_by,
      knockout_best_of, knockout_games_to, knockout_win_by,
      max_categories_per_player, notes, owner_profile_id, is_demo, created_at
    ) VALUES (
      v_t.name, v_t.t_status, 'two_round_placement',
      v_t.venue_name, v_t.venue_address, v_t.venue_timezone,
      v_t.organizer_name, v_t.organizer_email, v_t.organizer_phone,
      v_t.day_count, v_t.court_count, v_starts, v_starts + (v_t.day_count - 1),
      CASE WHEN v_t.has_registration THEN v_reg_opens END,
      CASE WHEN v_t.has_registration THEN v_reg_closes END,
      3, 21, 2,
      3, 21, 2,
      2, v_t.notes, v_owner, true, v_created
    ) RETURNING id INTO v_tid;

    FOR v_i IN 1..v_t.day_count LOOP
      v_day_start := (v_starts + (v_i - 1)) + time '09:00';
      v_day_end := time '18:30';

      -- The in-progress picture needs two full days of room: round one sits on yesterday
      -- afternoon and round two straddles now, which a 09:00-18:30 window cannot always hold.
      IF v_t.build_mode = 'partial' THEN
        IF v_i = 1 THEN
          v_day_start := (v_starts + (v_i - 1)) + time '13:00';
        ELSIF v_i = 2 THEN
          v_day_start := (v_starts + (v_i - 1)) + time '00:00';
        END IF;
        IF v_i <= 2 THEN v_day_end := time '23:59'; END IF;
      END IF;

      INSERT INTO public.tournament_days (tournament_id, day_number, date, start_time, end_time)
      VALUES (v_tid, v_i, v_starts + (v_i - 1), v_day_start::time, v_day_end);
    END LOOP;

    INSERT INTO public.courts (tournament_id, number)
    SELECT v_tid, g.n FROM generate_series(1, v_t.court_count) AS g(n);

    FOR v_e IN SELECT * FROM demo_event WHERE tkey = v_t.tkey ORDER BY sort_order LOOP
      INSERT INTO public.categories (
        tournament_id, code, name, entry_type, gender, sort_order, active, max_entries
      ) VALUES (
        v_tid, v_e.code, v_e.name, v_e.entry_type, v_e.gender, v_e.sort_order, true, v_e.max_entries
      ) RETURNING id INTO v_cat_id;

      INSERT INTO demo_cat (tkey, code, category_id) VALUES (v_t.tkey, v_e.code, v_cat_id);
    END LOOP;

    INSERT INTO demo_t (tkey, id, mode, day_count, starts_on, courts, day1, day2, later)
    SELECT
      v_t.tkey, v_tid, v_t.build_mode, v_t.day_count, v_starts,
      (SELECT array_agg(c.id ORDER BY c.number) FROM public.courts c WHERE c.tournament_id = v_tid),
      CASE
        -- The tournament's own first day, not the day before it: `starts_offset` is already
        -- -1 for these two, so round one lands on yesterday afternoon and round two on today
        -- without either of them leaving the window the day rows above just declared.
        WHEN v_t.build_mode = 'partial' THEN (v_starts + time '13:00') AT TIME ZONE v_t.venue_timezone
        ELSE (v_starts + time '09:00') AT TIME ZONE v_t.venue_timezone
      END,
      CASE
        WHEN v_t.build_mode = 'partial' THEN (v_starts + time '00:00') AT TIME ZONE v_t.venue_timezone
        ELSE ((v_starts + 1) + time '09:00') AT TIME ZONE v_t.venue_timezone
      END,
      CASE
        WHEN v_t.day_count >= 2 AND v_t.build_mode <> 'partial'
          THEN ((v_starts + 1) + time '09:00') AT TIME ZONE v_t.venue_timezone
        ELSE (v_starts + time '15:00') AT TIME ZONE v_t.venue_timezone
      END;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 3c. Entries
  ---------------------------------------------------------------------------
  --
  -- One gender cursor per tournament, consumed in event order, so a single tournament's
  -- events draw on disjoint people and no entrant is ever in three of them. Across
  -- tournaments the same faces come back, which is what a roster is.
  FOR v_t IN
    SELECT s.tkey, s.name, s.build_mode, s.starts_offset, s.m_start, s.f_start,
           t.id AS tid, t.courts, t.day1, t.day2, t.later, t.mode, t.day_count
    FROM demo_spec s JOIN demo_t t ON t.tkey = s.tkey
    ORDER BY s.starts_offset, s.name
  LOOP
    v_m_cur := v_t.m_start;
    v_f_cur := v_t.f_start;

    FOR v_e IN SELECT * FROM demo_event WHERE tkey = v_t.tkey ORDER BY sort_order LOOP
      FOR v_i IN 1..v_e.teams LOOP
        IF v_e.entry_type = 'individual' THEN
          v_g := CASE v_e.gender WHEN 'men' THEN 'M' ELSE 'F' END;
          SELECT r.player_id INTO v_p1 FROM demo_roster r
          WHERE r.gender = v_g AND r.idx = CASE WHEN v_g = 'M' THEN v_m_cur ELSE v_f_cur END;
          IF v_g = 'M' THEN v_m_cur := v_m_cur + 1; ELSE v_f_cur := v_f_cur + 1; END IF;
          v_p2 := NULL;
        ELSIF v_e.gender = 'mixed' THEN
          SELECT r.player_id INTO v_p1 FROM demo_roster r WHERE r.gender = 'M' AND r.idx = v_m_cur;
          SELECT r.player_id INTO v_p2 FROM demo_roster r WHERE r.gender = 'F' AND r.idx = v_f_cur;
          v_m_cur := v_m_cur + 1;
          v_f_cur := v_f_cur + 1;
        ELSE
          v_g := CASE v_e.gender WHEN 'men' THEN 'M' ELSE 'F' END;
          SELECT r.player_id INTO v_p1 FROM demo_roster r
          WHERE r.gender = v_g AND r.idx = CASE WHEN v_g = 'M' THEN v_m_cur ELSE v_f_cur END;
          SELECT r.player_id INTO v_p2 FROM demo_roster r
          WHERE r.gender = v_g AND r.idx = CASE WHEN v_g = 'M' THEN v_m_cur + 1 ELSE v_f_cur + 1 END;
          IF v_g = 'M' THEN v_m_cur := v_m_cur + 2; ELSE v_f_cur := v_f_cur + 2; END IF;
        END IF;

        IF v_p1 IS NULL OR (v_e.entry_type = 'pair' AND v_p2 IS NULL) THEN
          RAISE EXCEPTION 'demo seed: % % ran past the sample roster', v_t.tkey, v_e.code;
        END IF;

        INSERT INTO public.teams (tournament_id, category_id, player_1_id, player_2_id, seed)
        SELECT v_t.tid, dc.category_id, v_p1, v_p2, v_i
        FROM demo_cat dc WHERE dc.tkey = v_t.tkey AND dc.code = v_e.code;
      END LOOP;
    END LOOP;
  END LOOP;

  -- Entrants mirror the teams, with a seed and a skill block taken from the seed order, which
  -- is the shape `sync_placement_entrants` produces once registration closes.
  INSERT INTO public.placement_entrants (
    tournament_id, category_id, team_id, skill_level, seed, seed_locked_at
  )
  SELECT
    tm.tournament_id, tm.category_id, tm.id,
    CASE
      WHEN tm.seed <= ceil(r.n * 0.25) THEN 'advanced'
      WHEN tm.seed <= ceil(r.n * 0.65) THEN 'intermediate'
      ELSE 'beginner'
    END,
    tm.seed,
    now()
  FROM (
    SELECT tm.*, count(*) OVER (PARTITION BY tm.category_id) AS n
    FROM public.teams tm
    JOIN public.tournaments t ON t.id = tm.tournament_id
    WHERE t.is_demo AND NOT tm.withdrawn
  ) r
  JOIN public.teams tm ON tm.id = r.id;

  ---------------------------------------------------------------------------
  -- 3d. The two placement rounds, as rows to be laid out
  ---------------------------------------------------------------------------
  --
  -- Built before anything is scheduled, so the layout pass can put round one ahead of round
  -- two across *every* event of a tournament. That ordering is what keeps a player's two
  -- matches apart and keeps two matches off one court at the same time: a per-event counter
  -- would let event B's round one share a court with event A's round two.
  --
  -- Round one is the documented half-split, not bracket seeding: seed `i` meets seed
  -- `ceil(N/2) + i`. With skill-block seeding, pairing strongest against weakest would make
  -- the round predictable, so the halves are crossed at their boundary instead.
  v_ord := 0;
  FOR v_t IN SELECT * FROM demo_t ORDER BY starts_on, tkey LOOP
    FOR v_s IN
      SELECT c.id AS category_id, c.sort_order
      FROM demo_cat dc JOIN public.categories c ON c.id = dc.category_id
      WHERE dc.tkey = v_t.tkey
      ORDER BY c.sort_order
    LOOP
      SELECT array_agg(pe.id ORDER BY pe.seed) INTO v_entrants
      FROM public.placement_entrants pe WHERE pe.category_id = v_s.category_id;

      v_n := coalesce(array_length(v_entrants, 1), 0);
      IF v_n < 4 OR v_n % 2 <> 0 THEN
        RAISE EXCEPTION 'demo seed: an event has an entry count the placement rounds cannot pair';
      END IF;
      v_half := v_n / 2;

      FOR v_i IN 1..v_half LOOP
        v_a := v_entrants[v_i];
        v_b := v_entrants[v_i + v_half];
        -- The better seed wins, with a scheduled upset every third match so the round is not a
        -- formality. Deterministic: the same run always produces the same results.
        v_upset := (v_i % 3 = 0);
        v_w := CASE WHEN v_upset THEN v_b ELSE v_a END;

        v_ord := v_ord + 1;
        INSERT INTO demo_sched (tournament_id, category_id, stage, generation_key, a, b, winner, ord)
        VALUES (v_t.id, v_s.category_id, 'round1', 'r1-' || v_i, v_a, v_b, v_w, v_ord);
      END LOOP;
    END LOOP;
  END LOOP;

  -- Round two: winners meet winners and losers meet losers, which is what leaves every
  -- entrant with a decided two-match record and therefore a tier. The pairing cannot repeat
  -- round one, because the winners of matches 1 and 2 came from four different players.
  FOR v_t IN SELECT * FROM demo_t ORDER BY starts_on, tkey LOOP
    FOR v_s IN
      SELECT c.id AS category_id, c.sort_order
      FROM demo_cat dc JOIN public.categories c ON c.id = dc.category_id
      WHERE dc.tkey = v_t.tkey
      ORDER BY c.sort_order
    LOOP
      SELECT array_agg(s.winner ORDER BY s.ord), array_agg(CASE WHEN s.winner = s.a THEN s.b ELSE s.a END ORDER BY s.ord)
      INTO v_winners, v_losers
      FROM demo_sched s
      WHERE s.category_id = v_s.category_id AND s.stage = 'round1';

      v_n := array_length(v_winners, 1);
      FOR v_i IN 1..(v_n / 2) LOOP
        v_a := v_winners[v_i * 2 - 1];
        v_b := v_winners[v_i * 2];
        v_upset := (v_i % 2 = 0);
        v_ord := v_ord + 1;
        INSERT INTO demo_sched (tournament_id, category_id, stage, generation_key, a, b, winner, ord)
        VALUES (v_t.id, v_s.category_id, 'round2', 'r2-w' || v_i, v_a, v_b,
                CASE WHEN v_upset THEN v_b ELSE v_a END, v_ord);
      END LOOP;

      v_n := array_length(v_losers, 1);
      FOR v_i IN 1..(v_n / 2) LOOP
        v_a := v_losers[v_i * 2 - 1];
        v_b := v_losers[v_i * 2];
        v_upset := (v_i % 3 = 0);
        v_ord := v_ord + 1;
        INSERT INTO demo_sched (tournament_id, category_id, stage, generation_key, a, b, winner, ord)
        VALUES (v_t.id, v_s.category_id, 'round2', 'r2-l' || v_i, v_a, v_b,
                CASE WHEN v_upset THEN v_b ELSE v_a END, v_ord);
      END LOOP;
    END LOOP;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 3e. Lay the placement rounds out, and write them
  ---------------------------------------------------------------------------
  --
  -- A twenty-minute slot per court, filled in waves: the first `k` matches share the first
  -- slot, the next `k` the second, and so on. Round two starts from its own anchor rather than
  -- from wherever round one ended, so the two rounds are separated by a break and a player's
  -- second match is always at least one wave after their first.
  --
  -- `mode = 'none'` is skipped rather than laid out and dropped. Those two events are the
  -- ones whose notes say the schedule is still being built, and a tournament whose draw is
  -- published but whose schedule is not is a state the app has an empty state for and a
  -- reader should be able to see. Scheduling them anyway would leave the notes claiming
  -- something the data contradicts, and would make all four upcoming events the same shape.
  FOR v_t IN SELECT * FROM demo_t WHERE mode <> 'none' ORDER BY starts_on, tkey LOOP
    v_k := array_length(v_t.courts, 1);
    v_seq1 := 0;
    v_seq2 := 0;
    v_round2 := CASE
      WHEN v_t.mode = 'partial' THEN now() - interval '10 minutes'
      ELSE v_t.day1 + interval '4 hours'
    END;

    FOR v_s IN
      SELECT s.* FROM demo_sched s WHERE s.tournament_id = v_t.id ORDER BY s.ord
    LOOP
      IF v_s.stage = 'round1' THEN
        v_seq1 := v_seq1 + 1;
        v_court := v_t.courts[((v_seq1 - 1) % v_k) + 1];
        v_at := v_t.day1 + make_interval(mins => ((v_seq1 - 1) / v_k) * 20);
      ELSE
        v_seq2 := v_seq2 + 1;
        v_court := v_t.courts[((v_seq2 - 1) % v_k) + 1];
        -- The in-progress snapshot: the first two matches of round two are on court now, ten
        -- minutes in, and everything after them starts ten minutes from now. Nothing is
        -- scheduled in the past, so nothing reads as overdue.
        IF v_t.mode = 'partial' AND v_seq2 <= 2 THEN
          v_at := now() - interval '10 minutes';
        ELSIF v_t.mode = 'partial' THEN
          v_at := v_round2 + interval '20 minutes'
                  + make_interval(mins => ((v_seq2 - 3) / v_k) * 20);
        ELSE
          v_at := v_round2 + make_interval(mins => ((v_seq2 - 1) / v_k) * 20);
        END IF;
      END IF;

      IF v_t.mode = 'full' THEN
        v_games := jsonb_build_array(
          jsonb_build_object('a', 21, 'b', 14 + (v_s.ord % 5)),
          jsonb_build_object('a', 21, 'b', 12 + (v_s.ord % 7))
        );
        IF v_s.winner <> v_s.a THEN
          v_games := jsonb_build_array(
            jsonb_build_object('a', 14 + (v_s.ord % 5), 'b', 21),
            jsonb_build_object('a', 12 + (v_s.ord % 7), 'b', 21)
          );
        END IF;
        INSERT INTO public.placement_matches (
          tournament_id, category_id, stage, generation_key,
          entrant_a_id, entrant_b_id, winner_id, games, status,
          court_id, scheduled_time, started_at, ended_at, reported_time
        ) VALUES (
          v_t.id, v_s.category_id, v_s.stage, v_s.generation_key,
          v_s.a, v_s.b, v_s.winner, v_games, 'reported',
          v_court, v_at, v_at, v_at + interval '20 minutes', v_at + interval '20 minutes'
        );
      ELSIF v_t.mode = 'partial' AND v_s.stage = 'round1' THEN
        v_games := jsonb_build_array(
          jsonb_build_object('a', 21, 'b', 15 + (v_s.ord % 5)),
          jsonb_build_object('a', 21, 'b', 13 + (v_s.ord % 6))
        );
        IF v_s.winner <> v_s.a THEN
          v_games := jsonb_build_array(
            jsonb_build_object('a', 15 + (v_s.ord % 5), 'b', 21),
            jsonb_build_object('a', 13 + (v_s.ord % 6), 'b', 21)
          );
        END IF;
        INSERT INTO public.placement_matches (
          tournament_id, category_id, stage, generation_key,
          entrant_a_id, entrant_b_id, winner_id, games, status,
          court_id, scheduled_time, started_at, ended_at, reported_time
        ) VALUES (
          v_t.id, v_s.category_id, v_s.stage, v_s.generation_key,
          v_s.a, v_s.b, v_s.winner, v_games, 'reported',
          v_court, v_at, v_at, v_at + interval '20 minutes', v_at + interval '20 minutes'
        );
      ELSIF v_t.mode = 'partial' AND v_seq2 <= 2 THEN
        INSERT INTO public.placement_matches (
          tournament_id, category_id, stage, generation_key,
          entrant_a_id, entrant_b_id, winner_id, games, status,
          court_id, scheduled_time, started_at
        ) VALUES (
          v_t.id, v_s.category_id, v_s.stage, v_s.generation_key,
          v_s.a, v_s.b, NULL, '[]'::jsonb, 'in-progress',
          v_court, v_at, v_at
        );
      ELSE
        INSERT INTO public.placement_matches (
          tournament_id, category_id, stage, generation_key,
          entrant_a_id, entrant_b_id, winner_id, games, status,
          court_id, scheduled_time
        ) VALUES (
          v_t.id, v_s.category_id, v_s.stage, v_s.generation_key,
          v_s.a, v_s.b, NULL, '[]'::jsonb, 'scheduled',
          v_court, v_at
        );
      END IF;
    END LOOP;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 3f. Tiers, from the record
  ---------------------------------------------------------------------------
  --
  -- Two wins is A, a win then a loss is B, a loss then a win is C, and two losses is D. Read
  -- from the matches rather than from a counter, so the tier cannot disagree with the results
  -- beside it.
  UPDATE public.placement_entrants pe
  SET tier = CASE
    WHEN EXISTS (
      SELECT 1 FROM public.placement_matches m
      WHERE m.stage = 'round1' AND m.winner_id = pe.id
    ) AND EXISTS (
      SELECT 1 FROM public.placement_matches m
      WHERE m.stage = 'round2' AND m.winner_id = pe.id
    ) THEN 'A'
    WHEN EXISTS (
      SELECT 1 FROM public.placement_matches m
      WHERE m.stage = 'round1' AND m.winner_id = pe.id
    ) THEN 'B'
    WHEN EXISTS (
      SELECT 1 FROM public.placement_matches m
      WHERE m.stage = 'round2' AND m.winner_id = pe.id
    ) THEN 'C'
    ELSE 'D'
  END
  WHERE pe.tournament_id IN (
    SELECT t.id FROM public.tournaments t WHERE t.is_demo AND t.status = 'completed'
  );

  ---------------------------------------------------------------------------
  -- 3g. The four draws, played to a champion
  ---------------------------------------------------------------------------
  --
  -- Single elimination per tier, with the bye given to the best seed (field position 1) when a
  -- tier's size is not a power of two. Every draw in this dataset happens to be a power of two
  -- - the field sizes are multiples of four - so the bye path is present for correctness and
  -- exercised by nothing here.
  FOR v_t IN
    SELECT t.* FROM demo_t t JOIN public.tournaments tt ON tt.id = t.id
    WHERE t.mode = 'full' ORDER BY t.starts_on, t.tkey
  LOOP
    v_k := array_length(v_t.courts, 1);
    v_bseq := 0;

    FOR v_s IN
      SELECT c.id AS category_id, c.sort_order
      FROM demo_cat dc JOIN public.categories c ON c.id = dc.category_id
      WHERE dc.tkey = v_t.tkey
      ORDER BY c.sort_order
    LOOP
      FOREACH v_tier IN ARRAY ARRAY['A', 'B', 'C', 'D'] LOOP
        SELECT array_agg(pe.id ORDER BY pe.seed) INTO v_field
        FROM public.placement_entrants pe
        WHERE pe.category_id = v_s.category_id AND pe.tier = v_tier;

        v_cnt := coalesce(array_length(v_field, 1), 0);
        IF v_cnt = 0 THEN CONTINUE; END IF;

        v_size := 1;
        WHILE v_size < v_cnt LOOP v_size := v_size * 2; END LOOP;

        INSERT INTO public.tier_draws (tournament_id, category_id, tier, bracket_size, entrant_count)
        VALUES (v_t.id, v_s.category_id, v_tier, v_size, v_cnt)
        RETURNING id INTO v_draw;

        DELETE FROM demo_dtm WHERE draw_id = v_draw;

        -- A tier with a single entrant is a champion with no bracket, which the schema
        -- expresses with a draw that has a champion and no matches.
        IF v_size = 1 THEN
          UPDATE public.tier_draws SET champion_id = v_field[1] WHERE id = v_draw;
          CONTINUE;
        END IF;

        -- Round one: field position i against position size-i+1, so the strongest seed meets
        -- the weakest and a bye falls to the top of the list.
        FOR v_slot IN 1..(v_size / 2) LOOP
          v_a := CASE WHEN v_slot <= v_cnt THEN v_field[v_slot] END;
          v_b := CASE WHEN (v_size - v_slot + 1) <= v_cnt THEN v_field[v_size - v_slot + 1] END;
          IF v_a IS NULL THEN CONTINUE; END IF;

          v_bseq := v_bseq + 1;
          v_court := v_t.courts[((v_bseq - 1) % v_k) + 1];
          v_at := v_t.later + make_interval(mins => ((v_bseq - 1) / v_k) * 25);

          IF v_b IS NULL THEN
            INSERT INTO public.tier_draw_matches (
              tournament_id, draw_id, round, slot, entrant_a_id, winner_id, is_bye, status
            ) VALUES (v_t.id, v_draw, 1, v_slot, v_a, v_a, true, 'bye')
            RETURNING id INTO v_match;
            v_w := v_a;
          ELSE
            v_upset := ((v_slot * 7) % 4 = 0);
            v_w := CASE WHEN v_upset THEN v_b ELSE v_a END;
            v_games := CASE WHEN v_w = v_a
              THEN jsonb_build_array(
                jsonb_build_object('a', 21, 'b', 16 + (v_slot % 4)),
                jsonb_build_object('a', 21, 'b', 15 + (v_slot % 5)))
              ELSE jsonb_build_array(
                jsonb_build_object('a', 16 + (v_slot % 4), 'b', 21),
                jsonb_build_object('a', 15 + (v_slot % 5), 'b', 21))
            END;
            INSERT INTO public.tier_draw_matches (
              tournament_id, draw_id, round, slot, entrant_a_id, entrant_b_id, winner_id,
              games, status, court_id, scheduled_time, started_at, ended_at, reported_time
            ) VALUES (
              v_t.id, v_draw, 1, v_slot, v_a, v_b, v_w,
              v_games, 'reported', v_court, v_at, v_at, v_at + interval '25 minutes',
              v_at + interval '25 minutes'
            ) RETURNING id INTO v_match;
          END IF;

          INSERT INTO demo_dtm (draw_id, round, slot, match_id, winner_id)
          VALUES (v_draw, 1, v_slot, v_match, v_w);
        END LOOP;

        -- Later rounds: the winners of the two matches under a slot meet in it.
        v_round := 1;
        v_prev := v_size / 2;
        WHILE v_prev > 1 LOOP
          v_cur := v_prev / 2;
          FOR v_slot IN 1..v_cur LOOP
            SELECT d.match_id, d.winner_id INTO v_mid_a, v_wa
            FROM demo_dtm d WHERE d.draw_id = v_draw AND d.round = v_round AND d.slot = v_slot * 2 - 1;
            SELECT d.match_id, d.winner_id INTO v_mid_b, v_wb
            FROM demo_dtm d WHERE d.draw_id = v_draw AND d.round = v_round AND d.slot = v_slot * 2;

            v_bseq := v_bseq + 1;
            v_court := v_t.courts[((v_bseq - 1) % v_k) + 1];
            v_at := v_t.later + make_interval(mins => ((v_bseq - 1) / v_k) * 25);

            v_upset := ((v_round * 5 + v_slot) % 3 = 0);
            v_w := CASE WHEN v_upset THEN v_wb ELSE v_wa END;
            v_games := CASE WHEN v_w = v_wa
              THEN jsonb_build_array(
                jsonb_build_object('a', 21, 'b', 17 + (v_slot % 3)),
                jsonb_build_object('a', 21, 'b', 18 - (v_slot % 3)))
              ELSE jsonb_build_array(
                jsonb_build_object('a', 17 + (v_slot % 3), 'b', 21),
                jsonb_build_object('a', 18 - (v_slot % 3), 'b', 21))
            END;

            INSERT INTO public.tier_draw_matches (
              tournament_id, draw_id, round, slot, entrant_a_id, entrant_b_id, winner_id,
              games, status, court_id, scheduled_time, started_at, ended_at, reported_time,
              parent_a_id, parent_b_id
            ) VALUES (
              v_t.id, v_draw, v_round + 1, v_slot, v_wa, v_wb, v_w,
              v_games, 'reported', v_court, v_at, v_at, v_at + interval '25 minutes',
              v_at + interval '25 minutes', v_mid_a, v_mid_b
            ) RETURNING id INTO v_match;

            INSERT INTO demo_dtm (draw_id, round, slot, match_id, winner_id)
            VALUES (v_draw, v_round + 1, v_slot, v_match, v_w);
          END LOOP;

          v_round := v_round + 1;
          v_prev := v_cur;
        END LOOP;

        SELECT d.winner_id INTO v_champion
        FROM demo_dtm d WHERE d.draw_id = v_draw ORDER BY d.round DESC, d.slot LIMIT 1;
        UPDATE public.tier_draws SET champion_id = v_champion WHERE id = v_draw;
      END LOOP;
    END LOOP;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 3h. What the caller gets back
  ---------------------------------------------------------------------------
  RETURN QUERY
  SELECT
    t.name,
    t.status,
    t.venue_name,
    to_char(t.starts_on, 'Mon FMDD') || ' - ' || to_char(t.ends_on, 'Mon FMDD'),
    (SELECT count(*)::int FROM public.teams tm WHERE tm.tournament_id = t.id),
    (SELECT count(*)::int FROM public.categories c WHERE c.tournament_id = t.id),
    CASE
      WHEN t.status = 'completed' THEN 'completed, drawn and played'
      WHEN t.status = 'in_progress' THEN 'on court now'
      WHEN EXISTS (SELECT 1 FROM public.placement_matches m WHERE m.tournament_id = t.id) THEN 'draw published'
      ELSE 'field set'
    END
  FROM public.tournaments t
  WHERE t.is_demo
  ORDER BY t.starts_on;
END;
$$;

-------------------------------------------------------------------------------
-- 4. Privileges
-------------------------------------------------------------------------------
--
-- Both are operator calls, not application calls: they write rows the application never
-- writes from the client, and `seed_demo_tournaments` in particular must not be reachable by
-- a signed-in user who could use it to litter a shared project. `service_role` only, which is
-- the role the SQL editor, the npm task and the integration suite all use.
--
-- `internal` are the helpers the two calls share. `demo_tournament_owner()` creates a profile
-- row, so it is not something a client should be able to call either.

REVOKE ALL ON FUNCTION public.seed_demo_tournaments() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remove_demo_tournaments() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.demo_tournament_owner() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.seed_demo_tournaments() TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_demo_tournaments() TO service_role;
GRANT EXECUTE ON FUNCTION public.demo_tournament_owner() TO service_role;

-------------------------------------------------------------------------------
-- 5. Verify
-------------------------------------------------------------------------------

DO $verify$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'seed_demo_tournaments()',
    'remove_demo_tournaments()',
    'demo_tournament_owner()'
  ] LOOP
    IF to_regprocedure('public.' || f) IS NULL THEN
      RAISE EXCEPTION 'D2: public.% was not created', f;
    END IF;
    IF has_function_privilege('anon', 'public.' || f, 'execute')
       OR has_function_privilege('authenticated', 'public.' || f, 'execute') THEN
      RAISE EXCEPTION 'D2: public.% must not be callable by a client', f;
    END IF;
    IF NOT has_function_privilege('service_role', 'public.' || f, 'execute') THEN
      RAISE EXCEPTION 'D2: public.% must be callable by service_role', f;
    END IF;
  END LOOP;

  -- The seeding path writes rows in tables the application owns, so it has to be a definer
  -- with a pinned search_path like every other definer here. A function that resolved
  -- `players` through the caller's search_path could be pointed at another schema.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'seed_demo_tournaments'
      AND p.prosecdef
      AND EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) AS cfg WHERE cfg = 'search_path=public'
      )
  ) THEN
    RAISE EXCEPTION 'D2: seed_demo_tournaments must be a definer with a pinned search_path';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
