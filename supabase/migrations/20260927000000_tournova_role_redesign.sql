-- ===========================================================================
-- Tournova role redesign - Phase 1
-- ===========================================================================
--
-- One migration, applied in one transaction, so no intermediate authorization
-- state is ever deployed. Never edit an applied migration: add a new one.
--
-- WHAT CHANGES
--
--   Platform roles become `admin | user`; tournament access becomes
--   owner | editor | viewer (viewer is implicit and never a row). The lifecycle
--   loses `draft` and gains real transitions. Registration requests arrive as
--   their own table. Every RPC guard moves from a global staff role onto
--   `can_edit_tournament(<resolved>)` plus a lifecycle guard.
--
-- THE TWO AXES, WHICH MUST NOT BE CONFLATED
--
--   Authorization asks *who may act*. A predicate never reads `status`.
--   Lifecycle asks *when the action is valid*. A guard never reads a role, with
--   the single exception of the platform-admin override inside
--   `assert_tournament_writable`.
--
--   The override is scoped to that third class alone. Because a `completed`
--   tournament is neither `upcoming` nor `in_progress`, a platform admin cannot
--   score it, play it or generate its brackets either. The only functions any
--   admin can invoke against a completed tournament are the enumerated repair
--   paths - see the `assert_tournament_writable` call sites in part 5.
--
-- REFINEMENTS OF THE PLAN, NAMED SO THEY ARE NOT MISTAKEN FOR DRIFT
--
--   1. The six readiness checks moved into `tournament_readiness_checks(uuid)`
--      and both `tournament_readiness` and `tournament_is_ready` read it.
--      `tournament_is_ready` cannot delegate to `tournament_readiness`: that
--      function is guarded by `can_edit_tournament`, and registration - which
--      consults readiness for a plain participant - would then be refused. One
--      copy of the checks, two readers, no second authorization path.
--   2. `public_players` replaces the `player_roster` view. `player_roster` is
--      `security_invoker`, so it inherited the `players` policy and therefore
--      returned nothing for the authenticated non-staff user that self-serve
--      signup makes normal. `public_players` is a definer view over three columns
--      and is the only anonymous read of the roster.
--   3. `current_tournament_id()` replaces `active_tournament_id()`, and
--      `set_current_tournament(uuid)` is new. The old name described the public
--      default pointer, which is now only the fallback for a user who has not
--      chosen a working tournament.
--
-- STATEMENT ORDER
--
--   Parts 1-9 below follow the plan's step order exactly. The legacy helpers
--   `current_staff_role`, `has_staff_role` and `is_invited_email` survive parts
--   1-8 and are dropped in part 9, after asserting that nothing names them.
-- ===========================================================================

begin;
-- ===========================================================================
-- PART 1 - Schema
-- ===========================================================================
--
-- Rename, not recreate: `staff_roles.email` is the durable key the recovery
-- runbook and the auth trigger both depend on, and a new table would lose it.
-- No policy or function is rewritten in this part.

--------------------------------------------------------------------------------
-- 1.1 staff_roles -> profiles, role -> system_role
--------------------------------------------------------------------------------

alter table public.staff_roles rename to profiles;
alter table public.profiles rename column role to system_role;
alter table public.profiles rename constraint staff_roles_pkey to profiles_pkey;
alter table public.profiles rename constraint staff_roles_email_key to profiles_email_key;
alter table public.profiles rename constraint staff_roles_user_id_key to profiles_user_id_key;
alter table public.profiles drop constraint staff_roles_role_check;

-- The old three tournament-scoped roles map to `user`: they described work inside a
-- tournament, and the only per-tournament grant that replaces them is an explicit
-- editor row. Converted here, before the new constraint is added, because the
-- constraint is validated against the existing rows the moment it is created - and a
-- staging clone with a `scorer` row would otherwise fail the whole migration on
-- this statement rather than on anything about the design.
--
-- No production row needs this. Production holds exactly one account, the platform
-- admin.
update public.profiles set system_role = 'user' where system_role not in ('admin', 'user');

-- New rows default to the ordinary platform role, so a profile created by the
-- auth trigger is never accidentally privileged.
alter table public.profiles alter column system_role set default 'user';
alter table public.profiles
  add constraint profiles_system_role_check check (system_role in ('admin', 'user'));

comment on table public.profiles is
  'Platform identity: one row per email, linked to an auth user when that identity appears. Carries the platform role (admin|user) and the user''s working-tournament pointer. Email is the durable key, so a row can exist before its auth user does.';
comment on column public.profiles.system_role is
  'Platform role. `admin` overrides authorization everywhere but buys no lifecycle right beyond the enumerated repair paths; see the guards in part 2.';

-- The user's working context. ON DELETE SET NULL rather than CASCADE: deleting a
-- tournament must not delete the people who ran it.
alter table public.profiles
  add column current_tournament_id uuid references public.tournaments(id) on delete set null;

comment on column public.profiles.current_tournament_id is
  'The tournament this user is working in. Presentation context, not lifecycle state and not an authorization input. NULL means "fall back to the public default".';

create index profiles_current_tournament_idx on public.profiles (current_tournament_id);

--------------------------------------------------------------------------------
-- 1.2 tournaments: ownership, the registration window, and the new status set
--------------------------------------------------------------------------------

-- Nullable here so the backfill in part 3 can run; tightened to NOT NULL once
-- every existing row has an owner.
--
-- It points at `profiles`, not `auth.users`, and that is the load-bearing choice in
-- this table. `profiles` is the durable key: the migrations seed the platform admin's
-- row by email, long before any identity exists in `auth.users`, and the recovery
-- runbook recreates that identity rather than restoring it. Ownership held against
-- `auth.users` would therefore be unattributable on any database where the admin has
-- not signed in yet - which is every fresh stack - and, worse, an ON DELETE RESTRICT
-- against `auth.users` would make deleting the admin identity impossible for as long
-- as they own a tournament, blocking the recovery path this schema exists to support.
--
-- Ownership is a fact about a person, and the person is the profile. The auth link is
-- only what lets that person exercise it.
alter table public.tournaments
  add column owner_user_id uuid references public.profiles(id) on delete restrict;

comment on column public.tournaments.owner_user_id is
  'The profile that owns this tournament: may delete it, manage its editors and operate it. Exactly one owner; transfer is Phase 2. A profile, not an auth user, so ownership survives the owner''s identity being recreated.';

create index tournaments_owner_user_id_idx on public.tournaments (owner_user_id);

-- Both nullable, and both may stay null: registering is optional, and a
-- tournament with no window is a valid tournament that simply cannot accept
-- requests. A `(NULL, NULL)` pair is the "no window" state; a half-configured
-- pair is refused by `assert_registration_window`.
alter table public.tournaments add column registration_opens_at timestamptz;
alter table public.tournaments add column registration_closes_at timestamptz;

comment on column public.tournaments.registration_opens_at is
  'Absolute time registration requests open. NULL together with registration_closes_at means this tournament is not accepting registrations.';
comment on column public.tournaments.registration_closes_at is
  'Absolute time registration requests close. Must be after opens and at or before the derived start.';

-- `draft` is retired as a product state; the three jobs it was doing live in
-- `tournament_is_ready`, the guards, and a data-based precondition instead.
--
-- Converted before the new constraint is added, for the same reason as the profile
-- roles above: a CHECK is validated against the rows already present. A draft is an
-- upcoming tournament that nothing had started yet, so `upcoming` is the faithful
-- mapping and no tournament changes meaning.
update public.tournaments set status = 'upcoming' where status = 'draft';

alter table public.tournaments drop constraint tournaments_status_check;
alter table public.tournaments
  add constraint tournaments_status_check
  check (status in ('upcoming', 'in_progress', 'completed'));
alter table public.tournaments alter column status set default 'upcoming';

-- `is_active` stops implying a lifecycle state. The retained
-- `tournaments_single_active` index still allows only one public default, which
-- is a presentation fact and is orthogonal to how many tournaments may be
-- upcoming or in progress. Phase 2 drops the index and the column.
alter table public.tournaments drop constraint tournaments_active_status_check;

comment on column public.tournaments.is_active is
  'Phase-1-only legacy presentation pointer: the single public default tournament, read by the anonymous landing case. Not lifecycle state, and no new behaviour may depend on it. Retired in Phase 2 when Explore replaces it.';

--------------------------------------------------------------------------------
-- 1.3 tournament_editors
--------------------------------------------------------------------------------

-- Membership, not role. A viewer is the absence of a row and is never stored.
create table public.tournament_editors (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

create index tournament_editors_user_idx on public.tournament_editors (user_id);

comment on table public.tournament_editors is
  'Users who may operate a tournament: every operational RPC and every per-tournament write policy admits them. A platform admin is override, never an implicit editor, so admins deliberately do not appear here.';

--------------------------------------------------------------------------------
-- 1.4 tournament_registrations
--------------------------------------------------------------------------------

-- The participation request. Deliberately minimal: no category, partner, capacity
-- or payment fields, because those are Phase 2 and would otherwise be five
-- columns of guesswork now.
create table public.tournament_registrations (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tournament_registrations_status_check
    check (status in ('pending', 'approved', 'rejected')),
  -- A CHECK cannot tell an INSERT from an UPDATE, and "pending means no decision
  -- metadata" is a guarantee about both. The BEFORE INSERT trigger in part 6
  -- covers the other half; the pair is deliberate.
  constraint tournament_registrations_pending_undecided_check
    check (
      status <> 'pending'
      or (decided_by is null and decided_at is null and decision_note is null)
    ),
  constraint tournament_registrations_unique_request unique (tournament_id, user_id)
);

create index tournament_registrations_review_idx
  on public.tournament_registrations (tournament_id, status);

comment on table public.tournament_registrations is
  'A request to take part, not a competition entry. Submitting creates no player, team or entrant; approval creates no competition data and grants no management right. Terminal in Phase 1: pending -> approved | rejected, no reverse transition.';
-- ===========================================================================
-- PART 2 - Authorization predicates, lifecycle guards and resolvers
-- ===========================================================================
--
-- Everything in this part is SECURITY DEFINER with `search_path = public`, so a
-- policy or an RPC cannot be redirected by a caller-controlled search path.
--
-- The predicates are the only names the application layer references. The guards,
-- the lifecycle reader and the id-less resolvers are internal: they are revoked
-- from anon and PUBLIC, and only the predicates (which RLS policies call as the
-- querying role) plus `current_tournament_id()` are granted to a client.

--------------------------------------------------------------------------------
-- 2.1 Platform identity
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_system_role()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  -- The email arm is the durability seam the recovery runbook depends on: it
  -- resolves before the auth trigger has linked the row, which is what keeps a
  -- recreated identity working. A linked row wins when both match.
  SELECT p.system_role
  FROM public.profiles p
  WHERE p.user_id = auth.uid()
     OR p.email = public.normalize_email(auth.jwt() ->> 'email')
  ORDER BY (p.user_id = auth.uid()) DESC NULLS LAST
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(public.current_system_role() = 'admin', false);
$$;

--------------------------------------------------------------------------------
-- 2.2 Tournament access
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_tournament_owner(p_tournament_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  -- Ownership is held by a profile, so the question is whether the caller's profile
  -- is the owner's. The join is on `profiles.user_id`, which is NULL until the owner
  -- has signed in - and `p.user_id = auth.uid()` is false against NULL, so an unlinked
  -- owner can exercise nothing, which is correct.
  SELECT EXISTS (
    SELECT 1
    FROM public.tournaments t
    JOIN public.profiles p ON p.id = t.owner_user_id
    WHERE t.id = p_tournament_id
      AND p.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_tournament_editor(p_tournament_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tournament_editors e
    WHERE e.tournament_id = p_tournament_id
      AND e.user_id = auth.uid()
  );
$$;

-- The manager predicate: may operate a tournament. Also the registration reviewer
-- predicate. Deliberately not "is a member", because a platform admin is override
-- and never an implicit editor.
CREATE OR REPLACE FUNCTION public.can_edit_tournament(p_tournament_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_platform_admin()
      OR public.is_tournament_owner(p_tournament_id)
      OR public.is_tournament_editor(p_tournament_id);
$$;

-- Deletion and access management: ownership-sensitive, so no editor.
CREATE OR REPLACE FUNCTION public.can_manage_tournament_access(p_tournament_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_platform_admin()
      OR public.is_tournament_owner(p_tournament_id);
$$;

-- Named to keep the debt visible: `players` has no tournament scope, so "may this
-- person create a player identity" cannot be answered per tournament. This is the
-- only place a cross-tournament grant appears.
CREATE OR REPLACE FUNCTION public.has_any_tournament_edit()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_platform_admin()
      OR EXISTS (
        SELECT 1 FROM public.tournaments t
        JOIN public.profiles p ON p.id = t.owner_user_id
        WHERE p.user_id = auth.uid()
      )
      OR EXISTS (SELECT 1 FROM public.tournament_editors e WHERE e.user_id = auth.uid());
$$;

--------------------------------------------------------------------------------
-- 2.3 Lifecycle
--------------------------------------------------------------------------------

-- Read once, so the three guards below cannot disagree about the state.
CREATE OR REPLACE FUNCTION public.tournament_lifecycle_state(p_tournament_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT status FROM public.tournaments WHERE id = p_tournament_id;
$$;

-- Upcoming only. Does NOT consult is_platform_admin(): a completed tournament is
-- not configurable by anyone, which is what keeps the admin override to one class.
CREATE OR REPLACE FUNCTION public.assert_tournament_configurable(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state text := public.tournament_lifecycle_state(p_tournament_id);
BEGIN
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_state <> 'upcoming' THEN
    RAISE EXCEPTION
      'A tournament can only be configured before it starts, and this one is %',
      v_state;
  END IF;
END;
$$;

-- In progress only. Does NOT consult is_platform_admin().
CREATE OR REPLACE FUNCTION public.assert_tournament_live(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state text := public.tournament_lifecycle_state(p_tournament_id);
BEGIN
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_state <> 'in_progress' THEN
    RAISE EXCEPTION
      'This is only possible while the tournament is in progress, and it is %',
      v_state;
  END IF;
END;
$$;

-- Any state except completed, or any state at all for a platform admin. The only
-- guard that consults the platform role, and therefore the only route by which an
-- admin reaches a completed tournament.
--
-- Its call sites are a closed list, and it must stay one: reset_placement_schedule,
-- reset_placement_stage, apply_placement_day_schedule, the legacy apply_day_schedule,
-- the incremental day and court writers, and the registration decision - which is
-- writable rather than configurable because a window may close at the start, so the
-- last requests can legitimately be decided after it. Widening it is how a completed
-- tournament becomes scoreable again, so the db-invariants assertion pins the list.
CREATE OR REPLACE FUNCTION public.assert_tournament_writable(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state text := public.tournament_lifecycle_state(p_tournament_id);
BEGIN
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_state = 'completed' AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'This tournament is completed and can no longer be changed';
  END IF;
END;
$$;

--------------------------------------------------------------------------------
-- 2.4 Derived timing
--------------------------------------------------------------------------------
--
-- Start and end are derived from tournament_days, never stored, so adding or
-- moving a day cannot desynchronise them.
--
-- `AT TIME ZONE venue_timezone` is mandatory rather than cosmetic. `date + time`
-- is a wall clock, and comparing it against a timestamptz without the venue's zone
-- casts it in the session zone - UTC on Supabase - which puts every boundary five
-- or six hours out for a US venue. This is the first place in the repository where
-- a day window is compared against an absolute time.
--
-- Both return NULL when the tournament has no days, which is a legitimate upcoming
-- state: start_tournament treats it as "cannot start yet".

CREATE OR REPLACE FUNCTION public.tournament_starts_at(p_tournament_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT min((d.date + d.start_time) AT TIME ZONE t.venue_timezone)
  FROM public.tournament_days d
  JOIN public.tournaments t ON t.id = d.tournament_id
  WHERE d.tournament_id = p_tournament_id;
$$;

CREATE OR REPLACE FUNCTION public.tournament_ends_at(p_tournament_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT max((d.date + d.end_time) AT TIME ZONE t.venue_timezone)
  FROM public.tournament_days d
  JOIN public.tournaments t ON t.id = d.tournament_id
  WHERE d.tournament_id = p_tournament_id;
$$;

--------------------------------------------------------------------------------
-- 2.5 Readiness, split from the registration window
--------------------------------------------------------------------------------
--
-- The six checks read only `tournaments`, `tournament_days` and `categories`: pure
-- configuration, all writable while upcoming. None reads `teams`,
-- `placement_entrants`, `placement_matches`, `tier_draws` or `tier_draw_matches`,
-- which is what makes readiness satisfiable before anyone registers.
--
-- That is load-bearing rather than incidental. Phase 2's approval flow creates
-- teams, and the natural next check to write - "every event has at least two
-- entrants" - would make readiness depend on approvals, approvals on registration
-- being open, and registration on readiness. A check that needs entries belongs in
-- a separately named start-side predicate, not in this one.
--
-- The registration window is NOT one of these checks. Registering is optional
-- product behaviour: a tournament with no window is ready and startable, and
-- simply refuses requests. Merging the two predicates is forbidden for the same
-- reason in reverse - it is how a registration concern leaks into the start gate.

CREATE OR REPLACE FUNCTION public.tournament_readiness_checks(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $checks$
DECLARE
  t public.tournaments%ROWTYPE;
  checks jsonb := '[]'::jsonb;
  day_total int;
  duplicate_dates int;
  category_total int;
  over_capped int;
BEGIN
  SELECT * INTO t FROM public.tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  SELECT count(*) INTO day_total
  FROM public.tournament_days d
  WHERE d.tournament_id = p_tournament_id;

  SELECT count(*) INTO duplicate_dates
  FROM (
    SELECT d.date
    FROM public.tournament_days d
    WHERE d.tournament_id = p_tournament_id
    GROUP BY d.date
    HAVING count(*) > 1
  ) dup;

  SELECT count(*) INTO category_total
  FROM public.categories WHERE tournament_id = p_tournament_id;

  -- `category_caps` compares the cap against a constant, not against an entry
  -- count, which is the other half of staying independent of participation.
  SELECT count(*) INTO over_capped
  FROM public.categories c
  WHERE c.tournament_id = p_tournament_id
    AND c.max_entries IS NOT NULL
    AND c.max_entries < 2;

  -- The label says name and venue because that is all this reads. Organizer
  -- details are for the host's reference, so they must not gate a start.
  checks := checks || jsonb_build_object(
    'id', 'basics',
    'label', 'Tournament name and venue are set',
    'ok', t.name IS NOT NULL AND length(btrim(t.name)) > 0 AND t.venue_name IS NOT NULL,
    'detail', CASE
      WHEN t.name IS NULL OR length(btrim(t.name)) = 0 THEN 'Give the tournament a name.'
      WHEN t.venue_name IS NULL THEN 'Add the venue name.'
      ELSE NULL
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'timezone',
    'label', 'Timezone is valid',
    'ok', EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = t.venue_timezone),
    'detail', CASE
      WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = t.venue_timezone) THEN NULL
      ELSE 'That timezone is not recognised.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'days',
    'label', 'At least one tournament day',
    'ok', day_total >= 1,
    'detail', CASE WHEN day_total >= 1 THEN NULL ELSE 'Add at least one day.' END
  );

  checks := checks || jsonb_build_object(
    'id', 'day_dates',
    'label', 'No two days share a date',
    'ok', duplicate_dates = 0,
    'detail', CASE
      WHEN duplicate_dates = 0 THEN NULL
      ELSE 'Two days use the same date.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'categories',
    'label', 'At least one event is switched on',
    'ok', category_total >= 1,
    'detail', CASE
      WHEN category_total >= 1 THEN NULL
      ELSE 'Add at least one event.'
    END
  );

  checks := checks || jsonb_build_object(
    'id', 'category_caps',
    'label', 'Entry caps leave room for a pool',
    'ok', over_capped = 0,
    'detail', CASE
      WHEN over_capped = 0 THEN NULL
      ELSE over_capped || ' event(s) have a cap below 2.'
    END
  );

  -- `blocking` is honoured and defaults to true, so a check added later can be
  -- advisory without changing this expression. Nothing is advisory today.
  RETURN jsonb_build_object(
    'ready', NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(checks) c
      WHERE (c->>'ok')::boolean = false
        AND COALESCE((c->>'blocking')::boolean, true)
    ),
    'checks', checks
  );
END;
$checks$;

-- The boolean both readers agree on. It cannot delegate to `tournament_readiness`:
-- that function is guarded by can_edit_tournament, and
-- submit_tournament_registration consults readiness for a plain participant, who
-- would then be refused. One copy of the checks, two readers, no second
-- authorization path.
CREATE OR REPLACE FUNCTION public.tournament_is_ready(p_tournament_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (public.tournament_readiness_checks(p_tournament_id) ->> 'ready')::boolean,
    false
  );
$$;

-- The checklist the Setup page renders. Still all-or-nothing, still the same six
-- blockers, and read-only: the guard is now can_edit_tournament rather than a
-- global admin role.
CREATE OR REPLACE FUNCTION public.tournament_readiness(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN public.tournament_readiness_checks(p_tournament_id);
END;
$$;

--------------------------------------------------------------------------------
-- 2.6 The registration window
--------------------------------------------------------------------------------
--
-- Enforced here, on every writer, rather than at one entry point: the window and
-- the days arrive through separate RPCs and can be written in either order, so
-- moving the event earlier has to re-validate.

CREATE OR REPLACE FUNCTION public.assert_registration_window(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_opens timestamptz;
  v_closes timestamptz;
  v_starts timestamptz;
  v_tz text;
BEGIN
  SELECT t.registration_opens_at, t.registration_closes_at, t.venue_timezone
  INTO v_opens, v_closes, v_tz
  FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  -- No window at all is valid. Half a window is not: it is a configuration
  -- mistake that would otherwise surface as a confusing refusal at submit time.
  IF (v_opens IS NULL) <> (v_closes IS NULL) THEN
    RAISE EXCEPTION
      'Set both the opening and the closing time of the registration window, or neither';
  END IF;
  IF v_opens IS NULL THEN
    RETURN;
  END IF;

  IF v_opens >= v_closes THEN
    RAISE EXCEPTION 'Registration must close after it opens';
  END IF;

  -- NULL while the tournament has no days yet, which is why the day writers call
  -- this again once they have written one.
  v_starts := public.tournament_starts_at(p_tournament_id);
  IF v_starts IS NOT NULL AND v_closes > v_starts THEN
    RAISE EXCEPTION
      'Registration must close (%) by the time the tournament starts (%)',
      to_char(v_closes AT TIME ZONE v_tz, 'YYYY-MM-DD HH24:MI'),
      to_char(v_starts AT TIME ZONE v_tz, 'YYYY-MM-DD HH24:MI');
  END IF;
END;
$$;

-- Deliberately separate from tournament_is_ready. The window answers "may people
-- register"; readiness answers "is this configured enough to run". A merged
-- "ready for registration" predicate is forbidden, because merging is what would
-- let a registration concern into the start gate and a start-side check back out.
--
-- Note the deliberate asymmetry: a tournament with NO window is refused here
-- rather than treated as open. Registering is optional, and "optional" means
-- absent, not unbounded.
CREATE OR REPLACE FUNCTION public.assert_registration_not_shut(p_tournament_id uuid, p_now timestamptz)
RETURNS void
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state text := public.tournament_lifecycle_state(p_tournament_id);
  v_opens timestamptz;
  v_closes timestamptz;
  v_tz text;
BEGIN
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_state <> 'upcoming' THEN
    RAISE EXCEPTION 'Registration is closed: this tournament is %', v_state;
  END IF;

  SELECT t.registration_opens_at, t.registration_closes_at, t.venue_timezone
  INTO v_opens, v_closes, v_tz
  FROM public.tournaments t WHERE t.id = p_tournament_id;

  IF v_opens IS NULL OR v_closes IS NULL THEN
    RAISE EXCEPTION 'This tournament is not accepting registration requests';
  END IF;
  IF p_now < v_opens THEN
    RAISE EXCEPTION
      'Registration opens at %',
      to_char(v_opens AT TIME ZONE v_tz, 'YYYY-MM-DD HH24:MI');
  END IF;
  IF p_now > v_closes THEN
    RAISE EXCEPTION
      'Registration closed at %',
      to_char(v_closes AT TIME ZONE v_tz, 'YYYY-MM-DD HH24:MI');
  END IF;
END;
$$;

--------------------------------------------------------------------------------
-- 2.7 Id-less resolvers
--------------------------------------------------------------------------------
--
-- Every live RPC receives a match, draw or category id rather than a tournament
-- id, and a guard needs a tournament. The denormalised `tournament_id` the child
-- tables already carry keeps each of these one indexed read, not a join.
--
-- A resolver is a pure reader: it returns NULL for an unknown id and never raises,
-- so the caller decides the message. The one exception is match_tournament, where
-- an unrecognised table name is a programming error rather than a lookup miss.

CREATE OR REPLACE FUNCTION public.tournament_of_category(p_category_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tournament_id FROM public.categories WHERE id = p_category_id;
$$;

CREATE OR REPLACE FUNCTION public.tournament_of_placement_match(p_match_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tournament_id FROM public.placement_matches WHERE id = p_match_id;
$$;

CREATE OR REPLACE FUNCTION public.tournament_of_tier_draw_match(p_match_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tournament_id FROM public.tier_draw_matches WHERE id = p_match_id;
$$;

CREATE OR REPLACE FUNCTION public.tournament_of_registration(p_registration_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tournament_id FROM public.tournament_registrations WHERE id = p_registration_id;
$$;

-- The legacy round-robin engine addresses matches by table name plus id, so it
-- needs a dispatch. An unknown table is a programming error, not a permission
-- problem, so it raises here rather than returning NULL.
CREATE OR REPLACE FUNCTION public.match_tournament(p_table text, p_match_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid;
BEGIN
  IF p_table = 'pool_matches' THEN
    SELECT tournament_id INTO v_tournament FROM public.pool_matches WHERE id = p_match_id;
  ELSIF p_table = 'draw_matches' THEN
    SELECT tournament_id INTO v_tournament FROM public.draw_matches WHERE id = p_match_id;
  ELSIF p_table = 'placement_matches' THEN
    SELECT tournament_id INTO v_tournament FROM public.placement_matches WHERE id = p_match_id;
  ELSIF p_table = 'tier_draw_matches' THEN
    SELECT tournament_id INTO v_tournament FROM public.tier_draw_matches WHERE id = p_match_id;
  ELSE
    RAISE EXCEPTION 'Unsupported match table';
  END IF;
  RETURN v_tournament;
END;
$$;

--------------------------------------------------------------------------------
-- 2.8 The working tournament, and the public default
--------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.active_tournament_id();

-- Authenticated: the user's own pointer, then the public default. Anonymous: the
-- public default only.
--
-- The fallback to the globally live tournament is Phase 1 compatibility, so the
-- existing single-tournament pages keep rendering for a user who has not chosen
-- one. It is not final product behaviour, and nothing added in Phase 1 may depend
-- on it. There is deliberately no "most recent tournament" fallback: a user must
-- never be dropped into someone else's newly created event.
CREATE OR REPLACE FUNCTION public.current_tournament_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_own uuid;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    SELECT p.current_tournament_id INTO v_own
    FROM public.profiles p
    WHERE p.user_id = auth.uid();
    IF v_own IS NOT NULL THEN
      RETURN v_own;
    END IF;
  END IF;

  RETURN (
    SELECT t.id FROM public.tournaments t
    WHERE t.is_active
    ORDER BY t.created_at, t.id
    LIMIT 1
  );
END;
$$;

-- Writes only the caller's pointer. Any authenticated user may work in any
-- publicly readable tournament; one user's choice never touches another's row and
-- never changes is_active or status. Not lifecycle-guarded: it is a view
-- preference, and a completed tournament stays readable.
CREATE OR REPLACE FUNCTION public.set_current_tournament(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to choose a working tournament';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = p_tournament_id) THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  UPDATE public.profiles
  SET current_tournament_id = p_tournament_id
  WHERE user_id = auth.uid();

  -- No row means the auth trigger has not linked this identity yet, and the
  -- choice would otherwise silently do nothing.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Your profile is not linked yet - sign in again';
  END IF;
END;
$$;
-- ===========================================================================
-- PART 3 - Backfill and the auth seam
-- ===========================================================================
--
-- Production reality, verified: exactly one authenticated account exists - the
-- platform admin - and there are no normal users, editors, registrars, scorers or
-- schedulers. The backfill is therefore deliberately simple, and the architecture
-- stays future-proof rather than the data being retrofitted.
--
-- This part must precede the lifecycle RPCs in part 4, so owner_user_id is
-- non-null by the time they can be called.

--------------------------------------------------------------------------------
-- 3.1 The draft state, and the legacy roles
--------------------------------------------------------------------------------
--
-- Both conversions already happened in part 1, immediately before the CHECK
-- constraints that made them necessary - a CHECK is validated against the rows
-- already present, so the data has to move first. They are named here only so the
-- sequencing is not mistaken for an oversight: part 1 is where the schema and the
-- data it invalidates are reconciled, in one place, in the right order.

--------------------------------------------------------------------------------
-- 3.2 Attribute every existing tournament
--------------------------------------------------------------------------------
--
-- The one load-bearing backfill: the guards, the delete RPC and every
-- per-tournament write policy key off owner_user_id. The admin takes ownership of
-- everything that predates self-serve signup, which is exactly true here.
--
-- The admin's *profile* is used, not their auth user, and that is what makes this
-- apply everywhere rather than only where the admin happens to have signed in. The
-- migrations seed the admin row by email, so it exists on a fresh stack before any
-- identity does; the plan's `user_id` would be NULL there and the column could not
-- become NOT NULL. Ownership is a fact about a person, and the profile is the person.
--
-- It raises only when there are tournaments to attribute and no admin to attribute
-- them to, which is a genuine operator error rather than a fresh database.

DO $$
DECLARE
  v_admin uuid;
  v_orphans int;
BEGIN
  SELECT count(*) INTO v_orphans FROM public.tournaments WHERE owner_user_id IS NULL;
  IF v_orphans = 0 THEN
    RETURN;
  END IF;

  SELECT p.id INTO v_admin
  FROM public.profiles p
  WHERE p.system_role = 'admin'
  ORDER BY p.created_at, p.id
  LIMIT 1;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION
      'No platform admin profile exists, so % existing tournament(s) cannot be attributed. Create the admin profile (scripts/create-staff-login.mjs) and re-run.',
      v_orphans;
  END IF;

  UPDATE public.tournaments SET owner_user_id = v_admin WHERE owner_user_id IS NULL;
END;
$$;

-- Every tournament must be attributable from here on. ON DELETE RESTRICT on
-- owner_user_id means a profile cannot be deleted while it owns something. Profiles
-- are never deleted - the auth trigger unlinks instead - so this is the correct and
-- non-blocking failure: transfer or delete the tournament first.
alter table public.tournaments alter column owner_user_id set not null;

--------------------------------------------------------------------------------
-- 3.3 The working tournament for the admin
--------------------------------------------------------------------------------

UPDATE public.profiles p
SET current_tournament_id = (
  SELECT t.id FROM public.tournaments t
  WHERE t.is_active
  ORDER BY t.created_at, t.id
  LIMIT 1
)
WHERE p.system_role = 'admin'
  AND p.current_tournament_id IS NULL;

-- Deliberately NOT written: no editor rows. A platform admin is override, never
-- an implicit editor, so the one existing admin gains no membership row. That is
-- what keeps the two axes provably separate in this database rather than merely in
-- the design.

--------------------------------------------------------------------------------
-- 3.4 The auth seam, redefined against profiles
--------------------------------------------------------------------------------
--
-- The insert path links a waiting profile by email, and creates an ordinary one
-- when there is none. It never overwrites an existing row's system_role, which is
-- what protects the pre-seeded admin: signing up with the admin's email links the
-- admin row instead of resetting it to 'user'.
--
-- The names change with the table. `link_staff_role` and `unlink_staff_role` named
-- a vocabulary this migration removes, and leaving them would make the migration's
-- own assertion - that no legacy role vocabulary survives - false.

CREATE OR REPLACE FUNCTION public.link_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := public.normalize_email(NEW.email);
BEGIN
  -- Phone-only identities have no email, and profiles.email is NOT NULL.
  IF v_email IS NULL THEN
    RETURN NEW;
  END IF;

  -- The guard on user_id is load-bearing. Drop it and anyone signing up with a
  -- colleague's verified email inherits that colleague's row - and, for the admin
  -- address, the platform role with it.
  UPDATE public.profiles
  SET user_id = NEW.id
  WHERE email = v_email
    AND (user_id IS NULL OR user_id = NEW.id);

  IF NOT FOUND THEN
    INSERT INTO public.profiles (user_id, email, system_role)
    VALUES (NEW.id, v_email, 'user')
    ON CONFLICT (email) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.unlink_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- The profile row survives; only the link goes. `email` is unique, so the row
  -- has to stay for the durable-key fallback in current_system_role() to work, and
  -- a recreated identity with the same email re-links it.
  UPDATE public.profiles
  SET user_id = NULL,
      current_tournament_id = NULL
  WHERE user_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_link_staff ON auth.users;
DROP TRIGGER IF EXISTS on_auth_user_deleted_unlink_staff ON auth.users;
DROP FUNCTION IF EXISTS public.link_staff_role();
DROP FUNCTION IF EXISTS public.unlink_staff_role();

CREATE TRIGGER on_auth_user_created_link_profile
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.link_profile();

CREATE TRIGGER on_auth_user_deleted_unlink_profile
AFTER DELETE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.unlink_profile();

-- A SECURITY DEFINER function is not something a client should call directly. The
-- trigger still fires; EXECUTE on the function is checked when the trigger is
-- created, not each time it fires.
REVOKE ALL ON FUNCTION public.link_profile() FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.unlink_profile() FROM anon, authenticated, public;
-- ===========================================================================
-- PART 4 - Lifecycle RPCs, the renames, and the removal of draft
-- ===========================================================================
--
-- Neither lifecycle RPC is admin-only. A normal owner takes their own tournament
-- from upcoming to completed without a platform admin, which is the point of the
-- redesign. Each asserts its own expected current status, so the state machine is
-- enforced per transition rather than by a generic guard, and no reverse
-- transition exists in Phase 1.

--------------------------------------------------------------------------------
-- 4.1 start_tournament - upcoming -> in_progress
--------------------------------------------------------------------------------

-- Replaces `activate_tournament`, which did readiness + status + is_active in one
-- step and was admin-only. The readiness gate stays, the start-time floor is
-- added, and the is_active write moves out to set_active_tournament: a normal
-- owner starting their own tournament must not need platform-admin permission to
-- change the global default.
--
-- No registration window is required. Registering is optional, so the window is
-- not a readiness check and must not become one here.

DROP FUNCTION IF EXISTS public.activate_tournament(uuid);

CREATE OR REPLACE FUNCTION public.start_tournament(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state text;
  v_starts timestamptz;
  v_tz text;
  blockers text;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT t.status, t.venue_timezone INTO v_state, v_tz
  FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_state = 'in_progress' THEN
    RAISE EXCEPTION 'This tournament has already started';
  END IF;
  IF v_state = 'completed' THEN
    RAISE EXCEPTION 'This tournament is completed and cannot be started again';
  END IF;

  -- Gate one: configuration is complete. The blockers are named here rather than
  -- pre-empted in the browser, so a refusal explains itself.
  IF NOT public.tournament_is_ready(p_tournament_id) THEN
    SELECT string_agg(c->>'label', '; ') INTO blockers
    FROM jsonb_array_elements(public.tournament_readiness_checks(p_tournament_id)->'checks') c
    WHERE (c->>'ok')::boolean = false
      AND COALESCE((c->>'blocking')::boolean, true);
    RAISE EXCEPTION 'The tournament is not ready: %', blockers;
  END IF;

  -- Gate two: the derived start time has arrived. A floor, not a trigger - missing
  -- it leaves the tournament upcoming, and nothing starts on its own.
  v_starts := public.tournament_starts_at(p_tournament_id);
  IF v_starts IS NULL THEN
    RAISE EXCEPTION 'This tournament has no days, so it has no start time to reach';
  END IF;
  IF now() < v_starts THEN
    RAISE EXCEPTION
      'The tournament starts at % and cannot be started before then',
      to_char(v_starts AT TIME ZONE v_tz, 'YYYY-MM-DD HH24:MI');
  END IF;

  -- Serialised against complete_tournament and set_active_tournament, so no
  -- transition can interleave with another and be decided on a stale read.
  PERFORM pg_advisory_xact_lock(hashtext('tournaments'));

  UPDATE public.tournaments SET status = 'in_progress' WHERE id = p_tournament_id;
END;
$$;

comment on function public.start_tournament(uuid) is
  'upcoming -> in_progress, for an owner, an editor or a platform admin. Requires full readiness AND that the derived start time in the venue timezone has been reached. Manual by design: if nobody calls it, the tournament stays upcoming.';

--------------------------------------------------------------------------------
-- 4.2 complete_tournament - in_progress -> completed
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_tournament(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state text;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Taken before the status is read, so the check and the write are one decision.
  PERFORM pg_advisory_xact_lock(hashtext('tournaments'));

  SELECT status INTO v_state FROM public.tournaments WHERE id = p_tournament_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_state = 'upcoming' THEN
    RAISE EXCEPTION 'A tournament can only be completed once it has started';
  END IF;
  IF v_state = 'completed' THEN
    RAISE EXCEPTION 'This tournament is already completed';
  END IF;

  -- No reverse transition in Phase 1, so nothing here reopens. A mis-completion is
  -- corrected by a platform admin through the repair paths, not by a reopen RPC.
  --
  -- is_active is deliberately untouched: a completed tournament may stay the
  -- public default, so the desk keeps showing the final standings.
  UPDATE public.tournaments SET status = 'completed' WHERE id = p_tournament_id;
END;
$$;

comment on function public.complete_tournament(uuid) is
  'in_progress -> completed, for an owner, an editor or a platform admin. Deliberately irreversible in Phase 1. Does not touch is_active.';

--------------------------------------------------------------------------------
-- 4.3 set_active_tournament - the public default pointer
--------------------------------------------------------------------------------
--
-- Re-specified as "set the public default tournament". Two things are removed: the
-- draft readiness branch, because there is no draft, and the status write - which
-- was also a reverse transition, because activating a completed tournament flipped
-- it back to in_progress.
--
-- There is no separate `set_default_tournament`: this is it.

CREATE OR REPLACE FUNCTION public.set_active_tournament(p_tournament_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = p_tournament_id) THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournaments'));

  -- The partial unique index permits only one active row, so the previous default
  -- is cleared in the same transaction that sets the new one.
  UPDATE public.tournaments SET is_active = false WHERE is_active AND id <> p_tournament_id;
  UPDATE public.tournaments SET is_active = true WHERE id = p_tournament_id;
END;
$$;

comment on function public.set_active_tournament(uuid) is
  'Sets the single public default tournament, which is what an anonymous or unpointed visitor resolves to. A presentation pointer, not lifecycle: writes is_active only, and is no longer reachable by a normal owner.';

--------------------------------------------------------------------------------
-- 4.4 There is no reverse transition
--------------------------------------------------------------------------------

-- `reopen_tournament` is removed rather than re-guarded. Phase 1 has no backwards
-- edge in the state machine: `upcoming -> in_progress -> completed` only. Keeping a
-- reopen would be a fourth place the machine is written down, and it is the one that
-- would let a completed tournament become scoreable again without passing through
-- the platform admin's enumerated repair paths.
--
-- A mis-completion is corrected by a platform admin through those repair paths, which
-- is the same surface a completed tournament is edited through anyway. Phase 2 owns
-- a real reopen, if one is still wanted once the operator has used it.
DROP FUNCTION IF EXISTS public.reopen_tournament(uuid);

--------------------------------------------------------------------------------
-- 4.4 create_tournament - self-serve, and the creator lands in it
--------------------------------------------------------------------------------

-- The unused legacy overload. Its signature took a day count and a start date,
-- both of which are now derived from the days themselves, and nothing in the
-- repository or the database called it.
DROP FUNCTION IF EXISTS public.create_tournament(text, integer, integer, date, jsonb);

-- Creation needs no role check beyond being signed in: any authenticated user may
-- create a tournament and becomes its owner.
--
-- It no longer touches is_active or status. status takes the column default
-- (upcoming), and making a new tournament the global public default is a separate
-- platform-admin action rather than a side effect of pressing Create. The creator
-- is pointed at their own tournament instead, which is the part that matters to
-- them.

DROP FUNCTION IF EXISTS public.create_tournament_draft(jsonb);

CREATE OR REPLACE FUNCTION public.create_tournament(p_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
  v_name text;
  v_format text;
  v_notes text;
  v_profile uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to create a tournament';
  END IF;

  -- The owner is a profile, so the caller needs one before they can own anything.
  -- The auth trigger creates it on sign-up, so this only fires for an identity
  -- created outside the app.
  SELECT p.id INTO v_profile
  FROM public.profiles p
  WHERE p.user_id = auth.uid();

  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'Your profile is not linked yet - sign in again';
  END IF;

  v_name := NULLIF(btrim(COALESCE(p_payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'A tournament needs a name';
  END IF;

  v_format := COALESCE(NULLIF(p_payload->>'format', ''), 'two_round_placement');
  IF v_format NOT IN ('round_robin', 'two_round_placement') THEN
    RAISE EXCEPTION 'Unsupported competition format';
  END IF;

  -- An all-whitespace note is the same as no note.
  v_notes := public.notes_trim(p_payload->>'notes');

  INSERT INTO public.tournaments (
    name, format, notes,
    venue_name, venue_address, venue_timezone,
    organizer_name, organizer_email, organizer_phone,
    owner_user_id
  )
  VALUES (
    v_name, v_format, v_notes,
    NULLIF(btrim(COALESCE(p_payload->>'venue_name', '')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'venue_address', '')), ''),
    COALESCE(NULLIF(btrim(COALESCE(p_payload->>'venue_timezone', '')), ''), 'America/Chicago'),
    NULLIF(btrim(COALESCE(p_payload->>'organizer_name', '')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'organizer_email', '')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'organizer_phone', '')), ''),
    v_profile
  )
  RETURNING id INTO new_id;

  -- Same transaction, so the creator cannot land on somebody else's tournament
  -- between the two statements.
  UPDATE public.profiles
  SET current_tournament_id = new_id
  WHERE user_id = auth.uid();

  RETURN new_id;
END;
$$;

comment on function public.create_tournament(jsonb) is
  'Creates an upcoming tournament owned by the caller and points the caller at it. No role check beyond being signed in; does not touch is_active or status.';

-- The three renames are introduced by their CREATE statements in part 5. They are
-- listed here because the whole point of removing `draft` is that the old names
-- encoded it:
--
--   create_tournament_draft -> create_tournament      (above; the overload is gone)
--   save_tournament_draft   -> save_tournament_config (part 5)
--   delete_tournament_draft -> discard_tournament     (part 5)
--   activate_tournament     -> start_tournament       (part 4.1)
-- rename: save_tournament_draft(uuid,jsonb)
DROP FUNCTION IF EXISTS public.save_tournament_draft(uuid,jsonb);

-- rename: delete_tournament_draft(uuid)
DROP FUNCTION IF EXISTS public.delete_tournament_draft(uuid);

--------------------------------------------------------------------------------
-- Configuration and initial generation - assert_tournament_configurable
--------------------------------------------------------------------------------
--
-- Upcoming only, and never overridden: a completed tournament is not configurable by
-- anyone, because it is neither upcoming nor in progress.
--
-- `apply_placement_generation` belongs here and `apply_placement_round_two` does not.
-- The split is by what the function derives from, not by the word: the initial bracket
-- comes from the seed order, which is preparation, while round two and the tier draws
-- come from results that only exist once matches have been played.

CREATE OR REPLACE FUNCTION public.save_tournament_config(p_tournament_id uuid, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_name text;
  v_tz text;
  v_format text;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_configurable(p_tournament_id);

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  v_name := NULLIF(btrim(COALESCE(p_payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'A tournament needs a name';
  END IF;

  v_format := COALESCE(NULLIF(p_payload->>'format', ''), 'two_round_placement');
  IF v_format NOT IN ('round_robin', 'two_round_placement') THEN
    RAISE EXCEPTION 'Unsupported competition format';
  END IF;

  v_tz := COALESCE(NULLIF(btrim(COALESCE(p_payload->>'venue_timezone', '')), ''), 'America/Chicago');
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    RAISE EXCEPTION 'Unknown timezone: %', v_tz;
  END IF;

  IF (p_payload ? 'max_categories_per_player') THEN
    IF (p_payload->>'max_categories_per_player')::int NOT BETWEEN 1 AND 5 THEN
      RAISE EXCEPTION 'The category cap must be between 1 and 5';
    END IF;
  END IF;

  IF (p_payload ? 'knockout_best_of')
     AND (p_payload->>'knockout_best_of')::int NOT IN (1, 3, 5, 7, 9) THEN
    RAISE EXCEPTION 'A knockout match is a single game or an odd best of 3, 5, 7 or 9';
  END IF;
  IF (p_payload ? 'placement_best_of')
     AND (p_payload->>'placement_best_of')::int NOT IN (1, 3, 5, 7, 9) THEN
    RAISE EXCEPTION 'A placement match is a single game or an odd best of 3, 5, 7 or 9';
  END IF;

  UPDATE public.tournaments SET
    name = v_name,
    format = v_format,
    -- Unlike the numeric fields, notes may be cleared, so an omitted key and an
    -- empty string both mean "no note" rather than "leave it alone".
    notes = public.notes_trim(p_payload->>'notes'),
    venue_name = NULLIF(btrim(COALESCE(p_payload->>'venue_name', '')), ''),
    venue_address = NULLIF(btrim(COALESCE(p_payload->>'venue_address', '')), ''),
    venue_timezone = v_tz,
    organizer_name = NULLIF(btrim(COALESCE(p_payload->>'organizer_name', '')), ''),
    organizer_email = NULLIF(btrim(COALESCE(p_payload->>'organizer_email', '')), ''),
    organizer_phone = NULLIF(btrim(COALESCE(p_payload->>'organizer_phone', '')), ''),
    max_categories_per_player = COALESCE(
      (p_payload->>'max_categories_per_player')::int, max_categories_per_player
    ),
    placement_games_to = COALESCE((p_payload->>'placement_games_to')::int, placement_games_to),
    placement_win_by = COALESCE((p_payload->>'placement_win_by')::int, placement_win_by),
    placement_best_of = COALESCE((p_payload->>'placement_best_of')::int, placement_best_of),
    knockout_games_to = COALESCE((p_payload->>'knockout_games_to')::int, knockout_games_to),
    knockout_win_by = COALESCE((p_payload->>'knockout_win_by')::int, knockout_win_by),
    knockout_best_of = COALESCE((p_payload->>'knockout_best_of')::int, knockout_best_of),
    group_slot_minutes = COALESCE((p_payload->>'group_slot_minutes')::int, group_slot_minutes),
    knockout_slot_minutes = COALESCE(
      (p_payload->>'knockout_slot_minutes')::int, knockout_slot_minutes
    ),
    group_rest_gap_minutes = COALESCE(
      (p_payload->>'group_rest_gap_minutes')::int, group_rest_gap_minutes
    ),
    knockout_rest_gap_minutes = COALESCE(
      (p_payload->>'knockout_rest_gap_minutes')::int, knockout_rest_gap_minutes
    ),
    registration_opens_at = CASE
      WHEN p_payload ? 'registration_opens_at'
        THEN NULLIF(btrim(COALESCE(p_payload->>'registration_opens_at', '')), '')::timestamptz
      ELSE registration_opens_at
    END,
    registration_closes_at = CASE
      WHEN p_payload ? 'registration_closes_at'
        THEN NULLIF(btrim(COALESCE(p_payload->>'registration_closes_at', '')), '')::timestamptz
      ELSE registration_closes_at
    END
  WHERE id = p_tournament_id;

  -- Validated after the write, because the window and the days arrive through
  -- separate RPCs in either order. Moving the event earlier has to re-check a window
  -- that was already accepted.
  PERFORM public.assert_registration_window(p_tournament_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_tournament_days(p_tournament_id uuid, p_days jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  item jsonb;
  idx int := 0;
  new_day_id uuid;
  max_court int := 0;
  c jsonb;
  br jsonb;
  v_start time;
  v_end time;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_configurable(p_tournament_id);

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  p_days := COALESCE(p_days, '[]'::jsonb);
  IF jsonb_typeof(p_days) <> 'array' THEN
    RAISE EXCEPTION 'Days must be a list';
  END IF;
  IF jsonb_array_length(p_days) > 7 THEN
    RAISE EXCEPTION 'A tournament can have at most 7 days';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament-days:' || p_tournament_id::text));

  SELECT COALESCE(max((day_court.value)::int), 0) INTO max_court
  FROM jsonb_array_elements(p_days) d
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d->'courts', '[]'::jsonb)) AS day_court;
  IF max_court > 64 THEN
    RAISE EXCEPTION 'A tournament can have at most 64 courts';
  END IF;

  -- Breaks and day-court rows cascade from tournament_days.
  DELETE FROM public.tournament_days WHERE tournament_id = p_tournament_id;
  DELETE FROM public.courts WHERE tournament_id = p_tournament_id;

  FOR i IN 1 .. max_court LOOP
    INSERT INTO public.courts (tournament_id, number) VALUES (p_tournament_id, i);
  END LOOP;

  FOR item IN SELECT * FROM jsonb_array_elements(p_days)
  LOOP
    idx := idx + 1;

    IF NULLIF(item->>'date', '') IS NULL THEN
      RAISE EXCEPTION 'Day % needs a date', idx;
    END IF;

    v_start := COALESCE(NULLIF(item->>'start_time', '')::time, '09:00');
    v_end := COALESCE(NULLIF(item->>'end_time', '')::time, '18:30');
    IF v_end <= v_start THEN
      RAISE EXCEPTION 'Day % must end after it starts', idx;
    END IF;

    INSERT INTO public.tournament_days (tournament_id, day_number, date, start_time, end_time)
    VALUES (p_tournament_id, idx, (item->>'date')::date, v_start, v_end)
    RETURNING id INTO new_day_id;

    FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(item->'courts', '[]'::jsonb))
    LOOP
      INSERT INTO public.tournament_day_courts (tournament_id, day_id, court_id)
      SELECT p_tournament_id, new_day_id, ct.id
      FROM public.courts ct
      WHERE ct.tournament_id = p_tournament_id
        AND ct.number = (c)::int
      ON CONFLICT (day_id, court_id) DO NOTHING;
    END LOOP;

    FOR br IN SELECT * FROM jsonb_array_elements(COALESCE(item->'breaks', '[]'::jsonb))
    LOOP
      IF NULLIF(br->>'start_time', '') IS NULL OR NULLIF(br->>'end_time', '') IS NULL THEN
        RAISE EXCEPTION 'A break on day % needs a start and an end', idx;
      END IF;
      IF (br->>'end_time')::time <= (br->>'start_time')::time THEN
        RAISE EXCEPTION 'A break on day % must end after it starts', idx;
      END IF;
      INSERT INTO public.tournament_day_breaks (
        tournament_id, day_id, label, start_time, end_time
      )
      VALUES (
        p_tournament_id, new_day_id,
        NULLIF(btrim(COALESCE(br->>'label', '')), ''),
        (br->>'start_time')::time,
        (br->>'end_time')::time
      );
    END LOOP;
  END LOOP;

  -- day_count has a 1..7 floor, so an emptied draft keeps a placeholder value.
  -- tournament_readiness reports the real day count from the rows.
  UPDATE public.tournaments
  SET day_count = GREATEST(idx, 1),
      court_count = GREATEST(max_court, 1)
  WHERE id = p_tournament_id;

  PERFORM public.assert_registration_window(p_tournament_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_tournament_categories(p_tournament_id uuid, p_categories jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  item jsonb;
  idx int := 0;
  v_code text;
  v_entry text;
  v_gender text;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_configurable(p_tournament_id);

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF EXISTS (SELECT 1 FROM public.teams WHERE tournament_id = p_tournament_id) THEN
    RAISE EXCEPTION 'This tournament already has entries, so its events cannot be replaced';
  END IF;

  p_categories := COALESCE(p_categories, '[]'::jsonb);
  IF jsonb_typeof(p_categories) <> 'array' THEN
    RAISE EXCEPTION 'Events must be a list';
  END IF;

  DELETE FROM public.categories WHERE tournament_id = p_tournament_id;

  FOR item IN SELECT * FROM jsonb_array_elements(p_categories)
  LOOP
    idx := idx + 1;
    v_code := NULLIF(btrim(COALESCE(item->>'code', '')), '');
    IF v_code IS NULL THEN
      RAISE EXCEPTION 'Event % needs a code', idx;
    END IF;

    v_entry := COALESCE(NULLIF(item->>'entry_type', ''), 'individual');
    IF v_entry NOT IN ('individual', 'pair') THEN
      RAISE EXCEPTION 'Event % has an unsupported entry type', v_code;
    END IF;

    v_gender := COALESCE(NULLIF(item->>'gender', ''), 'open');
    IF v_gender NOT IN ('men', 'women', 'mixed', 'open') THEN
      RAISE EXCEPTION 'Event % has an unsupported gender', v_code;
    END IF;

    INSERT INTO public.categories (
      tournament_id, code, name, entry_type, sort_order, active, max_entries, gender
    )
    VALUES (
      p_tournament_id,
      v_code,
      COALESCE(NULLIF(btrim(COALESCE(item->>'name', '')), ''), v_code),
      v_entry,
      COALESCE((item->>'sort_order')::int, idx),
      COALESCE((item->>'active')::boolean, true),
      NULLIF(item->>'max_entries', '')::int,
      v_gender
    );
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.discard_tournament(p_tournament_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
  IF NOT public.can_manage_tournament_access(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_configurable(p_tournament_id);

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tournaments'));
  DELETE FROM public.tournaments WHERE id = p_tournament_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_placement_entrants(p_category_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_created int := 0;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_category(p_category_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_configurable(v_tournament);

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  INSERT INTO public.placement_entrants (tournament_id, category_id, team_id)
  SELECT v_tournament, t.category_id, t.id
  FROM public.teams t
  WHERE t.category_id = p_category_id
  ON CONFLICT (category_id, team_id) DO NOTHING;
  GET DIAGNOSTICS v_created = ROW_COUNT;

  -- A withdrawn team is waived rather than deleted, so its recorded results and
  -- its place in the seed order both survive if the withdrawal is reversed.
  UPDATE public.placement_entrants e
  SET excluded = COALESCE(t.withdrawn, false)
  FROM public.teams t
  WHERE e.category_id = p_category_id
    AND e.team_id = t.id
    AND e.excluded IS DISTINCT FROM COALESCE(t.withdrawn, false);

  RETURN v_created;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_placement_skill(p_category_id uuid, p_team_id uuid, p_skill_level text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_locked timestamptz;
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_category(p_category_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_configurable(v_tournament);
  IF p_skill_level NOT IN ('beginner', 'intermediate', 'advanced') THEN
    RAISE EXCEPTION 'Unknown skill level %', p_skill_level;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  SELECT seed_locked_at INTO v_locked
  FROM public.placement_entrants
  WHERE category_id = p_category_id AND team_id = p_team_id;

  IF v_locked IS NULL AND NOT FOUND THEN
    RAISE EXCEPTION 'That team is not entered in this category';
  END IF;
  IF v_locked IS NOT NULL THEN
    RAISE EXCEPTION 'Seeds are already locked for this category';
  END IF;

  UPDATE public.placement_entrants
  SET skill_level = p_skill_level
  WHERE category_id = p_category_id AND team_id = p_team_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.lock_placement_seeds(p_category_id uuid, p_seeds jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_expected int;
  v_provided int;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_category(p_category_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_configurable(v_tournament);

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  -- Any placement match at all, decided or not, for the reason in the header: the
  -- pairings on screen were generated from the order this call is about to
  -- replace, and there is no way to re-derive them here.
  IF EXISTS (
    SELECT 1 FROM public.placement_matches WHERE category_id = p_category_id
  ) THEN
    RAISE EXCEPTION
      'The seed order can only be changed while the placement stage is empty — this event already has placement matches';
  END IF;

  SELECT count(*) INTO v_expected
  FROM public.placement_entrants
  WHERE category_id = p_category_id AND NOT excluded;

  SELECT count(*) INTO v_provided
  FROM jsonb_array_elements(COALESCE(p_seeds, '[]'::jsonb));

  IF v_provided <> v_expected THEN
    RAISE EXCEPTION 'Expected % seeds but received %', v_expected, v_provided;
  END IF;

  -- Clear first so the partial unique index cannot trip on an intermediate state
  -- when seeds are being permuted. This is a permutation rather than an insert,
  -- so every seed is briefly NULL before the block below writes the new order.
  UPDATE public.placement_entrants
  SET seed = NULL, seed_locked_at = NULL
  WHERE category_id = p_category_id;

  -- `seed_locked_at` is refreshed on every write, so it reads as "when this order
  -- was last set" rather than "when the first one was". Nothing keys off its value
  -- — `set_placement_skill` only tests it for null — so a reorder moving it forward
  -- is a re-labelling, not a change in meaning.
  UPDATE public.placement_entrants e
  SET seed = (item->>'seed')::int,
      seed_locked_at = statement_timestamp()
  FROM jsonb_array_elements(p_seeds) AS item
  WHERE e.category_id = p_category_id
    AND e.team_id = (item->>'team_id')::uuid
    AND NOT e.excluded;

  IF EXISTS (
    SELECT 1 FROM public.placement_entrants
    WHERE category_id = p_category_id AND NOT excluded AND seed IS NULL
  ) THEN
    RAISE EXCEPTION 'Seeding left an entrant without a seed';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_placement_generation(p_category_id uuid, p_matches jsonb, p_force boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_expected int;
  v_inserted int;
  v_row jsonb;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_category(p_category_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_configurable(v_tournament);

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  IF EXISTS (
    SELECT 1 FROM public.placement_entrants
    WHERE category_id = p_category_id AND NOT excluded AND seed IS NULL
  ) THEN
    RAISE EXCEPTION 'Lock the seed order before generating placement matches';
  END IF;

  IF NOT p_force AND EXISTS (
    SELECT 1 FROM public.placement_matches
    WHERE category_id = p_category_id
      AND status IN ('in-progress', 'reported', 'walkover')
  ) THEN
    RAISE EXCEPTION 'Placement matches have already been played for this category';
  END IF;

  IF NOT p_force AND EXISTS (
    SELECT 1 FROM public.tier_draws WHERE category_id = p_category_id
  ) THEN
    RAISE EXCEPTION 'Tier draws already exist for this category';
  END IF;

  -- Regenerating from scratch: the draws describe pairings that are about to
  -- change, so they cannot be left in place. Their desk activity is keyed by
  -- match id and would otherwise outlive the matches it refers to.
  DELETE FROM public.desk_activity
  WHERE match_id IN (
    SELECT m.id FROM public.tier_draw_matches m
    JOIN public.tier_draws d ON d.id = m.draw_id
    WHERE d.category_id = p_category_id
  );
  DELETE FROM public.tier_draws WHERE category_id = p_category_id;

  DELETE FROM public.placement_matches WHERE category_id = p_category_id;

  INSERT INTO public.placement_matches (
    tournament_id, category_id, stage, generation_key,
    entrant_a_id, entrant_b_id, is_makeup, is_crossover
  )
  SELECT
    v_tournament,
    p_category_id,
    'round1',
    item->>'key',
    a.id,
    b.id,
    COALESCE((item->>'is_makeup')::boolean, false),
    COALESCE((item->>'is_crossover')::boolean, false)
  FROM jsonb_array_elements(COALESCE(p_matches, '[]'::jsonb)) AS item
  JOIN public.placement_entrants a
    ON a.category_id = p_category_id AND a.team_id = (item->>'entrant_a_team_id')::uuid
  JOIN public.placement_entrants b
    ON b.category_id = p_category_id AND b.team_id = (item->>'entrant_b_team_id')::uuid;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  v_expected := jsonb_array_length(COALESCE(p_matches, '[]'::jsonb));
  IF v_inserted <> v_expected THEN
    RAISE EXCEPTION 'Expected to create % matches but created % — an entrant is missing',
      v_expected, v_inserted;
  END IF;

  -- Second pass: the prerequisite graph can only be resolved once every key in
  -- the batch has a row to point at.
  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_matches, '[]'::jsonb))
  LOOP
    IF jsonb_typeof(v_row->'prerequisite_keys') = 'array'
       AND jsonb_array_length(v_row->'prerequisite_keys') > 0 THEN
      UPDATE public.placement_matches m
      SET prerequisite_ids = (
        SELECT COALESCE(array_agg(dep.id), '{}')
        FROM jsonb_array_elements_text(v_row->'prerequisite_keys') AS k(key)
        JOIN public.placement_matches dep
          ON dep.category_id = p_category_id AND dep.generation_key = k.key
      )
      WHERE m.category_id = p_category_id AND m.generation_key = v_row->>'key';
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_pool_generation(p_category_id uuid, p_force boolean, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  pool jsonb;
  created_id uuid;
  has_started boolean;
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_category(p_category_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_configurable(v_tournament);
  PERFORM pg_advisory_xact_lock(hashtext('pools:' || p_category_id::text));

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.draw_matches dm
    JOIN public.draws d ON d.id = dm.draw_id
    WHERE d.category_id = p_category_id
      AND dm.status IN ('in-progress','reported')
      AND COALESCE(dm.is_bye, false) = false
  ) INTO has_started;
  IF has_started AND NOT COALESCE(p_force, false) THEN
    RAISE EXCEPTION 'Draws are already in progress. Confirm rollback to regenerate pools.';
  END IF;
  DELETE FROM public.draws WHERE category_id = p_category_id;
  DELETE FROM public.pool_matches WHERE category_id = p_category_id;
  DELETE FROM public.pool_entries WHERE pool_id IN (SELECT id FROM public.pools WHERE category_id = p_category_id);
  DELETE FROM public.pools WHERE category_id = p_category_id;

  FOR pool IN SELECT * FROM jsonb_array_elements(p_payload)
  LOOP
    INSERT INTO public.pools (tournament_id, category_id, name, size)
    VALUES (v_tournament, p_category_id, pool->>'name', (pool->>'size')::int)
    RETURNING id INTO created_id;
    INSERT INTO public.pool_entries (tournament_id, pool_id, team_id, position)
    SELECT v_tournament, created_id, (e->>'team_id')::uuid, (e->>'position')::int
    FROM jsonb_array_elements(pool->'entries') e;
    INSERT INTO public.pool_matches (tournament_id, pool_id, category_id, round, team_a_id, team_b_id)
    SELECT v_tournament, created_id, p_category_id, (m->>'round')::int,
           (m->>'team_a_id')::uuid, (m->>'team_b_id')::uuid
    FROM jsonb_array_elements(pool->'matches') m;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_draw_generation(p_category_id uuid, p_force boolean, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  item jsonb;
  created_id uuid;
  has_started boolean;
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_category(p_category_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_configurable(v_tournament);
  PERFORM pg_advisory_xact_lock(hashtext('draws:' || p_category_id::text));

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.draw_matches dm
    JOIN public.draws d ON d.id = dm.draw_id
    WHERE d.category_id = p_category_id
      AND dm.status IN ('in-progress','reported')
      AND COALESCE(dm.is_bye, false) = false
  ) INTO has_started;
  IF has_started AND NOT COALESCE(p_force, false) THEN
    RAISE EXCEPTION 'Draws already have live results. Confirm rollback to regenerate.';
  END IF;
  DELETE FROM public.draws WHERE category_id = p_category_id;
  FOR item IN SELECT * FROM jsonb_array_elements(p_payload)
  LOOP
    INSERT INTO public.draws (tournament_id, category_id, tier, bracket_size, entrant_count)
    VALUES (v_tournament, p_category_id, item->>'tier',
            (item->>'bracket_size')::int, (item->>'entrant_count')::int)
    RETURNING id INTO created_id;
    INSERT INTO public.draw_matches (
      tournament_id, draw_id, round, slot, team_a_id, team_b_id, winner_id, status, note, is_bye
    )
    SELECT v_tournament,
           created_id,
           (m->>'round')::int,
           (m->>'slot')::int,
           NULLIF(m->>'team_a_id','')::uuid,
           NULLIF(m->>'team_b_id','')::uuid,
           NULLIF(m->>'winner_id','')::uuid,
           COALESCE(m->>'status','scheduled'),
           m->>'note',
           COALESCE((m->>'is_bye')::boolean, false)
    FROM jsonb_array_elements(item->'matches') m;
  END LOOP;
END;
$function$;

--------------------------------------------------------------------------------
-- Match start, scoring and live operation - assert_tournament_live
--------------------------------------------------------------------------------
--
-- In progress only, and never overridden either. An upcoming tournament must not be
-- scoreable, and a completed one must not be playable by anybody - which is why these
-- functions take no platform-admin override, and a completed tournament never becomes
-- scoreable by virtue of who is asking.

CREATE OR REPLACE FUNCTION public.start_placement_match(p_match_id uuid, p_court_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_placement_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  UPDATE public.placement_matches
  SET status = 'in-progress',
      started_at = COALESCE(started_at, statement_timestamp()),
      court_id = COALESCE(p_court_id, court_id)
  WHERE id = p_match_id AND status = 'scheduled';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match is not ready to start';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_tier_draw_match(p_match_id uuid, p_court_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_tier_draw_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  UPDATE public.tier_draw_matches
  SET status = 'in-progress',
      started_at = COALESCE(started_at, statement_timestamp()),
      court_id = COALESCE(p_court_id, court_id)
  WHERE id = p_match_id AND status = 'scheduled' AND NOT is_bye;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match is not ready to start';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.report_placement_result(p_match_id uuid, p_games jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_side text;
  v_winner uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_placement_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  SELECT tournament_id INTO v_tournament
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT public.placement_check_games(
    p_games, t.placement_games_to, t.placement_win_by, t.placement_best_of
  ) INTO v_side
  FROM public.tournaments t WHERE t.id = v_tournament;

  SELECT CASE WHEN v_side = 'a' THEN entrant_a_id ELSE entrant_b_id END INTO v_winner
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_winner IS NULL THEN
    RAISE EXCEPTION 'That side has no entrant assigned yet';
  END IF;

  UPDATE public.placement_matches
  SET games = p_games,
      winner_id = v_winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;

  PERFORM public.shift_live_schedule_after_match('placement_matches', p_match_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.report_tier_draw_result(p_match_id uuid, p_games jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_draw uuid;
  v_side text;
  v_winner uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_tier_draw_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  SELECT tournament_id, draw_id INTO v_tournament, v_draw
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT public.placement_check_games(
    p_games, t.knockout_games_to, t.knockout_win_by, t.knockout_best_of
  ) INTO v_side
  FROM public.tournaments t WHERE t.id = v_tournament;

  SELECT CASE WHEN v_side = 'a' THEN entrant_a_id ELSE entrant_b_id END INTO v_winner
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_winner IS NULL THEN
    RAISE EXCEPTION 'That side has no entrant assigned yet';
  END IF;

  UPDATE public.tier_draw_matches
  SET games = p_games,
      winner_id = v_winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;

  -- Advance first, then reflow. Advancing may create a match that is now ready to
  -- play, and reflowing before it existed would leave that match out of the
  -- ordering it just joined.
  PERFORM public.advance_tier_draw_locked(v_draw);
  PERFORM public.shift_live_schedule_after_match('tier_draw_matches', p_match_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reset_placement_result(p_match_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_category uuid;
  v_stage text;
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_placement_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  SELECT category_id, stage INTO v_category, v_stage
  FROM public.placement_matches WHERE id = p_match_id;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  -- Round two's make-up opponents are chosen from the round-one winner and loser
  -- sets, so a round-one result cannot be un-entered once round two exists: the
  -- pairings on screen were derived from it. Regenerating is the correct path.
  IF v_stage = 'round1' AND EXISTS (
    SELECT 1 FROM public.placement_matches
    WHERE category_id = v_category AND stage = 'round2'
  ) THEN
    RAISE EXCEPTION 'Round two was built from this result — regenerate round two instead';
  END IF;

  UPDATE public.placement_matches
  SET games = '[]'::jsonb,
      winner_id = NULL,
      status = 'scheduled',
      reported_time = NULL,
      -- The fix: without this, a restart inherits the original start time.
      started_at = NULL,
      ended_at = NULL
  WHERE id = p_match_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reset_tier_draw_result(p_match_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draw uuid;
  v_round int;
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_tier_draw_match(p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  SELECT draw_id, round INTO v_draw, v_round
  FROM public.tier_draw_matches WHERE id = p_match_id;
  IF v_draw IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  -- A later round already exists, so its entrants were derived from this result
  -- and cannot be un-derived in place.
  IF EXISTS (
    SELECT 1 FROM public.tier_draw_matches
    WHERE draw_id = v_draw AND round > v_round
  ) THEN
    RAISE EXCEPTION 'Later rounds have already been created from this result';
  END IF;

  UPDATE public.tier_draw_matches
  SET games = '[]'::jsonb,
      winner_id = CASE WHEN is_bye THEN winner_id ELSE NULL END,
      status = CASE WHEN is_bye THEN 'bye' ELSE 'scheduled' END,
      reported_time = NULL,
      ended_at = NULL,
      started_at = NULL
  WHERE id = p_match_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reschedule_placement_match(p_table text, p_match_id uuid, p_court_id uuid, p_scheduled_time timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_status text;
  v_players uuid[];
  v_slot interval;
  v_rest interval;
  v_end timestamptz;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament(p_table, p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  IF p_table NOT IN ('placement_matches', 'tier_draw_matches') THEN
    RAISE EXCEPTION 'Unsupported match table';
  END IF;
  IF p_court_id IS NULL THEN
    RAISE EXCEPTION 'Select a court before moving the match';
  END IF;
  IF p_scheduled_time IS NULL THEN
    RAISE EXCEPTION 'A scheduled time is required';
  END IF;

  -- The same lock as the day writer and the result reflow, so a hand-move cannot
  -- interleave with either.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));

  IF p_scheduled_time < statement_timestamp() - interval '1 minute' THEN
    RAISE EXCEPTION 'A scheduled match cannot be moved into the past';
  END IF;

  IF p_table = 'placement_matches' THEN
    SELECT
      m.tournament_id,
      m.status,
      make_interval(mins => t.group_slot_minutes),
      make_interval(mins => t.group_rest_gap_minutes)
    INTO v_tournament, v_status, v_slot, v_rest
    FROM public.placement_matches m
    JOIN public.tournaments t ON t.id = m.tournament_id
    WHERE m.id = p_match_id;
  ELSE
    SELECT
      m.tournament_id,
      m.status,
      make_interval(mins => t.knockout_slot_minutes),
      make_interval(mins => t.knockout_rest_gap_minutes)
    INTO v_tournament, v_status, v_slot, v_rest
    FROM public.tier_draw_matches m
    JOIN public.tournaments t ON t.id = m.tournament_id
    WHERE m.id = p_match_id;
  END IF;

  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;
  IF v_status <> 'scheduled' THEN
    RAISE EXCEPTION 'Only a match that has not started can be moved';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.courts WHERE id = p_court_id AND tournament_id = v_tournament
  ) THEN
    RAISE EXCEPTION 'Select a valid court';
  END IF;

  -- A match with an unassigned side is not movable: it has no players to clash, so
  -- letting it through would put a placeholder on a court.
  SELECT side.player_ids INTO v_players
  FROM public.placement_occupied_matches(v_tournament) side
  WHERE side.match_table = p_table AND side.match_id = p_match_id;

  IF v_players IS NULL OR COALESCE(array_length(v_players, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Both sides must be assigned before this match can be moved';
  END IF;

  v_end := p_scheduled_time + v_slot;

  IF EXISTS (
    SELECT 1
    FROM public.placement_occupied_matches(v_tournament) occupied
    WHERE NOT (occupied.match_table = p_table AND occupied.match_id = p_match_id)
      AND occupied.starts_at IS NOT NULL
      AND occupied.court_id = p_court_id
      AND p_scheduled_time < occupied.ends_at
      AND v_end > occupied.starts_at
  ) THEN
    RAISE EXCEPTION 'That court is occupied during the requested time';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.placement_occupied_matches(v_tournament) occupied
    WHERE NOT (occupied.match_table = p_table AND occupied.match_id = p_match_id)
      AND occupied.starts_at IS NOT NULL
      -- Half-open overlap on both sides of the rest gap: the candidate must start
      -- at least the rest gap after the other match ends, and the other match must
      -- start at least the rest gap after the candidate ends.
      AND p_scheduled_time < occupied.ends_at + v_rest
      AND v_end + v_rest > occupied.starts_at
      AND occupied.player_ids && v_players
  ) THEN
    RAISE EXCEPTION 'A player is busy or has not completed the required rest gap';
  END IF;

  IF p_table = 'placement_matches' THEN
    UPDATE public.placement_matches
    SET court_id = p_court_id,
        scheduled_time = p_scheduled_time
    WHERE id = p_match_id
      AND status = 'scheduled';
  ELSE
    UPDATE public.tier_draw_matches
    SET court_id = p_court_id,
        scheduled_time = p_scheduled_time
    WHERE id = p_match_id
      AND status = 'scheduled'
      AND NOT is_bye;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That match could not be moved';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.report_pool_result(p_match_id uuid, p_score_a integer, p_score_b integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  winner uuid;
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament('pool_matches', p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);
  IF p_score_a < 0 OR p_score_b < 0 OR p_score_a = p_score_b THEN
    RAISE EXCEPTION 'A group match needs a valid winning score';
  END IF;
  IF NOT ((p_score_a >= 21 AND p_score_a - p_score_b >= 2) OR (p_score_b >= 21 AND p_score_b - p_score_a >= 2)) THEN
    RAISE EXCEPTION 'Group games are race to 21, win by 2';
  END IF;
  SELECT CASE WHEN p_score_a > p_score_b THEN team_a_id ELSE team_b_id END
  INTO winner FROM public.pool_matches WHERE id = p_match_id;
  UPDATE public.pool_matches
  SET score_a = p_score_a,
      score_b = p_score_b,
      winner_id = winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;
  PERFORM public.shift_live_schedule_after_match('pool_matches', p_match_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.report_draw_result(p_match_id uuid, p_games jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  wins_a int := 0;
  wins_b int := 0;
  game jsonb;
  sa int;
  sb int;
  winner uuid;
  draw uuid;
  v_tournament uuid;
  games_to int;
  win_by int;
  best_of int;
  needed int;
  played int;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament('draw_matches', p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  SELECT dm.tournament_id INTO v_tournament
  FROM public.draw_matches dm WHERE dm.id = p_match_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown match';
  END IF;

  SELECT knockout_games_to, knockout_win_by, knockout_best_of
  INTO games_to, win_by, best_of
  FROM public.tournaments WHERE id = v_tournament;

  needed := (best_of + 1) / 2;
  played := jsonb_array_length(p_games);

  IF played < 1 THEN
    RAISE EXCEPTION 'Enter at least one game';
  END IF;
  IF played > best_of THEN
    RAISE EXCEPTION 'This match is best of %', best_of;
  END IF;
  IF played < needed THEN
    RAISE EXCEPTION 'This match is best of % — a side must win % games', best_of, needed;
  END IF;

  FOR game IN SELECT * FROM jsonb_array_elements(p_games)
  LOOP
    sa := (game->>'a')::int;
    sb := (game->>'b')::int;
    IF sa < 0 OR sb < 0 OR sa = sb THEN
      RAISE EXCEPTION 'Each game needs a valid winning score';
    END IF;
    IF NOT (
      (sa >= games_to AND sa - sb >= win_by)
      OR (sb >= games_to AND sb - sa >= win_by)
    ) THEN
      IF win_by = 1 THEN
        RAISE EXCEPTION 'Games are to %', games_to;
      ELSE
        RAISE EXCEPTION 'Games are to %, win by %', games_to, win_by;
      END IF;
    END IF;
    IF sa > sb THEN wins_a := wins_a + 1; ELSE wins_b := wins_b + 1; END IF;
    IF (wins_a >= needed OR wins_b >= needed) AND game <> p_games -> -1 THEN
      RAISE EXCEPTION 'Do not enter games after the match is decided';
    END IF;
  END LOOP;

  IF wins_a < needed AND wins_b < needed THEN
    RAISE EXCEPTION 'A side must win % games', needed;
  END IF;

  SELECT CASE WHEN wins_a >= needed THEN team_a_id ELSE team_b_id END, draw_id
  INTO winner, draw
  FROM public.draw_matches WHERE id = p_match_id;
  IF winner IS NULL THEN
    RAISE EXCEPTION 'That side has no team assigned yet';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('draw:' || draw::text));
  UPDATE public.draw_matches
  SET games = p_games,
      winner_id = winner,
      status = 'reported',
      reported_time = statement_timestamp(),
      ended_at = COALESCE(ended_at, statement_timestamp())
  WHERE id = p_match_id;
  PERFORM public.advance_draw_locked(draw);
  PERFORM public.shift_live_schedule_after_match('draw_matches', p_match_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reset_and_repair_match(p_table text, p_match_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  draw uuid;
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament(p_table, p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);
  IF p_table = 'pool_matches' THEN
    UPDATE public.pool_matches
    SET status = 'scheduled', winner_id = NULL, score_a = NULL, score_b = NULL,
        reported_time = NULL, started_at = NULL, ended_at = NULL
    WHERE id = p_match_id;
    RETURN;
  END IF;
  SELECT draw_id INTO draw FROM public.draw_matches WHERE id = p_match_id;
  PERFORM pg_advisory_xact_lock(hashtext('draw:' || draw::text));
  WITH RECURSIVE descendent AS (
    SELECT id FROM public.draw_matches WHERE id = p_match_id
    UNION
    SELECT dm.id
    FROM public.draw_matches dm
    JOIN descendent d ON dm.parent_a_id = d.id OR dm.parent_b_id = d.id
  )
  UPDATE public.draw_matches dm
  SET status = CASE WHEN dm.id = p_match_id THEN 'scheduled' ELSE
                 CASE WHEN COALESCE(dm.is_bye, false) THEN dm.status ELSE 'scheduled' END END,
      winner_id = CASE WHEN dm.id = p_match_id THEN NULL ELSE
                    CASE WHEN COALESCE(dm.is_bye, false) THEN dm.winner_id ELSE NULL END END,
      games = CASE WHEN dm.id = p_match_id THEN '[]'::jsonb ELSE
                CASE WHEN COALESCE(dm.is_bye, false) THEN dm.games ELSE '[]'::jsonb END END,
      reported_time = CASE WHEN dm.id = p_match_id THEN NULL ELSE
                      CASE WHEN COALESCE(dm.is_bye, false) THEN dm.reported_time ELSE NULL END END,
      started_at = NULL,
      ended_at = NULL,
      team_a_id = CASE WHEN dm.parent_a_id IN (SELECT id FROM descendent) AND dm.id <> p_match_id THEN NULL ELSE dm.team_a_id END,
      team_b_id = CASE WHEN dm.parent_b_id IN (SELECT id FROM descendent) AND dm.id <> p_match_id THEN NULL ELSE dm.team_b_id END
  WHERE dm.id IN (SELECT id FROM descendent);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reset_match_with_note(p_table text, p_match_id uuid, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament(p_table, p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);
  IF length(trim(COALESCE(p_note, ''))) = 0 THEN
    RAISE EXCEPTION 'A correction note is required';
  END IF;
  PERFORM public.reset_and_repair_match(p_table, p_match_id);
  INSERT INTO public.desk_activity (
    actor_id,
    action,
    match_table,
    match_id,
    details
  )
  VALUES (
    auth.uid(),
    'correction-opened',
    p_table,
    p_match_id,
    jsonb_build_object('note', trim(p_note))
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_match_exception(p_table text, p_match_id uuid, p_status text, p_winner_id uuid, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament(p_table, p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);
  IF p_status NOT IN ('walkover','void') THEN
    RAISE EXCEPTION 'Unsupported exception status';
  END IF;
  IF p_table = 'pool_matches' THEN
    UPDATE public.pool_matches
    SET status = p_status,
        winner_id = CASE WHEN p_status = 'void' THEN NULL ELSE p_winner_id END,
        note = p_note,
        reported_time = statement_timestamp(),
        ended_at = COALESCE(ended_at, statement_timestamp())
    WHERE id = p_match_id;
  ELSIF p_table = 'draw_matches' THEN
    UPDATE public.draw_matches
    SET status = p_status,
        winner_id = CASE WHEN p_status = 'void' THEN NULL ELSE p_winner_id END,
        note = p_note,
        reported_time = statement_timestamp(),
        ended_at = COALESCE(ended_at, statement_timestamp())
    WHERE id = p_match_id;
    IF p_status = 'walkover' THEN
      PERFORM public.advance_draw_locked(
        (SELECT draw_id FROM public.draw_matches WHERE id = p_match_id)
      );
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported match table';
  END IF;

  IF p_status = 'walkover' THEN
    PERFORM public.shift_live_schedule_after_match(p_table, p_match_id);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_match_safe(p_table text, p_match_id uuid, p_court_id uuid, p_ignore_rest boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament(p_table, p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));
  PERFORM public.assert_match_eligible(
    p_table,
    p_match_id,
    p_court_id,
    statement_timestamp(),
    true,
    p_ignore_rest
  );

  IF p_table = 'pool_matches' THEN
    UPDATE public.pool_matches
    SET status = 'in-progress',
        started_at = statement_timestamp(),
        court_id = p_court_id
    WHERE id = p_match_id
      AND status = 'scheduled';
  ELSIF p_table = 'draw_matches' THEN
    UPDATE public.draw_matches
    SET status = 'in-progress',
        started_at = statement_timestamp(),
        court_id = p_court_id
    WHERE id = p_match_id
      AND status = 'scheduled';
  ELSE
    RAISE EXCEPTION 'Unsupported match table';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reschedule_live_match(p_table text, p_match_id uuid, p_court_id uuid, p_scheduled_time timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.match_tournament(p_table, p_match_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:1'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:2'));
  IF p_scheduled_time < statement_timestamp() - interval '1 minute' THEN
    RAISE EXCEPTION 'A scheduled match cannot be moved into the past';
  END IF;
  PERFORM public.assert_match_eligible(
    p_table,
    p_match_id,
    p_court_id,
    p_scheduled_time,
    false
  );

  IF p_table = 'pool_matches' THEN
    UPDATE public.pool_matches
    SET court_id = p_court_id,
        scheduled_time = p_scheduled_time
    WHERE id = p_match_id
      AND status = 'scheduled';
  ELSIF p_table = 'draw_matches' THEN
    UPDATE public.draw_matches
    SET court_id = p_court_id,
        scheduled_time = p_scheduled_time
    WHERE id = p_match_id
      AND status = 'scheduled';
  ELSE
    RAISE EXCEPTION 'Unsupported match table';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_placement_round_two(p_category_id uuid, p_matches jsonb, p_force boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_expected int;
  v_inserted int;
  v_row jsonb;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_category(p_category_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  IF EXISTS (
    SELECT 1 FROM public.placement_matches
    WHERE category_id = p_category_id
      AND stage = 'round1'
      AND (status NOT IN ('reported', 'walkover') OR winner_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Round two needs every round one result first';
  END IF;

  IF NOT p_force AND EXISTS (
    SELECT 1 FROM public.placement_matches
    WHERE category_id = p_category_id AND stage = 'round2' AND status <> 'scheduled'
  ) THEN
    RAISE EXCEPTION 'Round two has already been played for this category';
  END IF;

  DELETE FROM public.placement_matches
  WHERE category_id = p_category_id AND stage = 'round2';

  INSERT INTO public.placement_matches (
    tournament_id, category_id, stage, generation_key,
    entrant_a_id, entrant_b_id, is_makeup, is_crossover
  )
  SELECT
    v_tournament,
    p_category_id,
    'round2',
    item->>'key',
    a.id,
    b.id,
    COALESCE((item->>'is_makeup')::boolean, false),
    COALESCE((item->>'is_crossover')::boolean, false)
  FROM jsonb_array_elements(COALESCE(p_matches, '[]'::jsonb)) AS item
  JOIN public.placement_entrants a
    ON a.category_id = p_category_id AND a.team_id = (item->>'entrant_a_team_id')::uuid
  JOIN public.placement_entrants b
    ON b.category_id = p_category_id AND b.team_id = (item->>'entrant_b_team_id')::uuid;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  v_expected := jsonb_array_length(COALESCE(p_matches, '[]'::jsonb));
  IF v_inserted <> v_expected THEN
    RAISE EXCEPTION 'Expected to create % matches but created % — an entrant is missing',
      v_expected, v_inserted;
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_matches, '[]'::jsonb))
  LOOP
    IF jsonb_typeof(v_row->'prerequisite_keys') = 'array'
       AND jsonb_array_length(v_row->'prerequisite_keys') > 0 THEN
      UPDATE public.placement_matches m
      SET prerequisite_ids = (
        SELECT COALESCE(array_agg(dep.id), '{}')
        FROM jsonb_array_elements_text(v_row->'prerequisite_keys') AS k(key)
        JOIN public.placement_matches dep
          ON dep.category_id = p_category_id AND dep.generation_key = k.key
      )
      WHERE m.category_id = p_category_id AND m.generation_key = v_row->>'key';
    END IF;
  END LOOP;

  RETURN v_inserted;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_tier_draws(p_category_id uuid, p_tiers jsonb, p_draws jsonb, p_force boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tournament uuid;
  v_required int;
  v_draw jsonb;
  v_match jsonb;
  v_draw_id uuid;
  v_champion uuid;
  v_short int;
BEGIN
  -- The tournament is not a parameter, so it is resolved from the id that is.
  v_tournament := public.tournament_of_category(p_category_id);
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_live(v_tournament);

  SELECT tournament_id INTO v_tournament FROM public.categories WHERE id = p_category_id;
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('placement:' || p_category_id::text));

  v_required := public.placement_required_matches(p_category_id);

  IF NOT p_force THEN
    SELECT count(*) INTO v_short
    FROM public.placement_entrants e
    WHERE e.category_id = p_category_id
      AND NOT e.excluded
      AND public.placement_decided_matches(p_category_id, e.id) < v_required;

    IF v_short > 0 THEN
      RAISE EXCEPTION
        'Every entrant needs % placement matches before draws — % still short',
        v_required, v_short;
    END IF;

    IF EXISTS (SELECT 1 FROM public.tier_draws WHERE category_id = p_category_id) THEN
      RAISE EXCEPTION 'Tier draws already exist for this category';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tier_draw_matches m
    JOIN public.tier_draws d ON d.id = m.draw_id
    WHERE d.category_id = p_category_id
      AND m.status IN ('in-progress', 'reported', 'walkover')
  ) THEN
    RAISE EXCEPTION 'Tier draws have already been played for this category';
  END IF;

  DELETE FROM public.desk_activity
  WHERE match_id IN (
    SELECT m.id FROM public.tier_draw_matches m
    JOIN public.tier_draws d ON d.id = m.draw_id
    WHERE d.category_id = p_category_id
  );
  DELETE FROM public.tier_draws WHERE category_id = p_category_id;

  UPDATE public.placement_entrants
  SET tier = NULL
  WHERE category_id = p_category_id;

  UPDATE public.placement_entrants e
  SET tier = item->>'tier'
  FROM jsonb_array_elements(COALESCE(p_tiers, '[]'::jsonb)) AS item
  WHERE e.category_id = p_category_id
    AND e.team_id = (item->>'team_id')::uuid
    AND item->>'tier' IN ('A', 'B', 'C', 'D');

  FOR v_draw IN SELECT value FROM jsonb_array_elements(COALESCE(p_draws, '[]'::jsonb))
  LOOP
    -- An empty tier gets no draw at all: a bracket needs at least one entrant, and
    -- the `bracket_size >= 1` check would reject a placeholder row anyway.
    IF COALESCE((v_draw->>'entrant_count')::int, 0) = 0 THEN
      CONTINUE;
    END IF;

    SELECT NULLIF(v_draw->>'champion_team_id', '')::uuid INTO v_champion;

    INSERT INTO public.tier_draws (
      tournament_id, category_id, tier, bracket_size, entrant_count, champion_id
    )
    VALUES (
      v_tournament,
      p_category_id,
      v_draw->>'tier',
      COALESCE((v_draw->>'bracket_size')::int, 0),
      COALESCE((v_draw->>'entrant_count')::int, 0),
      (SELECT id FROM public.placement_entrants
        WHERE category_id = p_category_id AND team_id = v_champion)
    )
    RETURNING id INTO v_draw_id;

    FOR v_match IN SELECT value FROM jsonb_array_elements(COALESCE(v_draw->'matches', '[]'::jsonb))
    LOOP
      INSERT INTO public.tier_draw_matches (
        tournament_id, draw_id, round, slot,
        entrant_a_id, entrant_b_id, winner_id, is_bye, status
      )
      VALUES (
        v_tournament,
        v_draw_id,
        (v_match->>'round')::int,
        (v_match->>'slot')::int,
        (SELECT id FROM public.placement_entrants
          WHERE category_id = p_category_id
            AND team_id = NULLIF(v_match->>'entrant_a_team_id', '')::uuid),
        (SELECT id FROM public.placement_entrants
          WHERE category_id = p_category_id
            AND team_id = NULLIF(v_match->>'entrant_b_team_id', '')::uuid),
        (SELECT id FROM public.placement_entrants
          WHERE category_id = p_category_id
            AND team_id = NULLIF(v_match->>'winner_team_id', '')::uuid),
        COALESCE((v_match->>'is_bye')::boolean, false),
        CASE WHEN COALESCE((v_match->>'is_bye')::boolean, false) THEN 'bye' ELSE 'scheduled' END
      );
    END LOOP;

    -- A real first-round match with a missing entrant would be a silently broken
    -- bracket, so it is rejected rather than left to fail at the desk.
    IF EXISTS (
      SELECT 1 FROM public.tier_draw_matches
      WHERE draw_id = v_draw_id AND round = 1 AND NOT is_bye
        AND (entrant_a_id IS NULL OR entrant_b_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'A first-round % match is missing an entrant', v_draw->>'tier';
    END IF;
  END LOOP;
END;
$function$;

--------------------------------------------------------------------------------
-- Structural repair and the incremental writers - assert_tournament_writable
--------------------------------------------------------------------------------
--
-- Any state but completed, or any state for a platform admin. This is the only class the
-- override reaches, and its call sites are the closed list of what a platform admin's
-- privileged surface against a completed tournament consists of. The db-invariants
-- assertion pins the list, because widening it is how a completed tournament becomes
-- writable again.
--
-- Two asymmetries inside the group are deliberate. `save_tournament_days` is the
-- wizard's wholesale rewrite of every day and stays upcoming-only, because running it
-- mid-event would discard the schedule; these incremental writers are what the Schedule
-- page uses to add one more day to a tournament that ran long. And
-- `apply_placement_day_schedule` and `set_tournament_courts` each serve initial setup
-- and mid-event replanning, and the RPC cannot tell the two intents apart, so they take
-- the more permissive guard rather than growing a second RPC in Phase 1.

CREATE OR REPLACE FUNCTION public.apply_placement_day_schedule(p_tournament_id uuid, p_stage text, p_slots jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_slot_json jsonb;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);
  IF p_stage NOT IN ('placement', 'knockout') THEN
    RAISE EXCEPTION 'Unknown stage %', p_stage;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = p_tournament_id) THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  -- Same lock key as the legacy writer, so a rebuild of either format is
  -- serialised against the other and against result-driven shifts.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));

  IF p_stage = 'placement' THEN
    UPDATE public.placement_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE tournament_id = p_tournament_id AND status = 'scheduled';
  ELSE
    UPDATE public.tier_draw_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE tournament_id = p_tournament_id AND status = 'scheduled' AND NOT is_bye;
  END IF;

  FOR v_slot_json IN SELECT * FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb))
  LOOP
    IF p_stage = 'placement' THEN
      UPDATE public.placement_matches
      SET scheduled_time = (v_slot_json->>'scheduled_time')::timestamptz,
          court_id = NULLIF(v_slot_json->>'court_id', '')::uuid
      WHERE id = (v_slot_json->>'match_id')::uuid
        AND tournament_id = p_tournament_id
        AND status = 'scheduled';
    ELSE
      UPDATE public.tier_draw_matches
      SET scheduled_time = (v_slot_json->>'scheduled_time')::timestamptz,
          court_id = NULLIF(v_slot_json->>'court_id', '')::uuid
      WHERE id = (v_slot_json->>'match_id')::uuid
        AND tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND NOT is_bye;
    END IF;
  END LOOP;

  -- The same completeness check the legacy writer makes: a rebuild that leaves an
  -- assigned match without a court or a time has silently dropped a match, and
  -- failing the transaction is better than persisting a half-built day.
  IF p_stage = 'placement' THEN
    IF EXISTS (
      SELECT 1 FROM public.placement_matches
      WHERE tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Placement rebuild left assigned matches without a court or time';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.tier_draw_matches
      WHERE tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND NOT is_bye
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Knockout rebuild left assigned matches without a court or time';
    END IF;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reset_placement_schedule(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tier_matches int := 0;
  v_draws int := 0;
  v_placement_matches int := 0;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = p_tournament_id) THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));

  -- Brackets first: their rows reference the draws and each other. The cascade from
  -- `tier_draws` would cover the matches anyway, but deleting the leaves explicitly
  -- keeps the counts below meaningful rather than zero.
  DELETE FROM public.tier_draw_matches WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_tier_matches = ROW_COUNT;

  DELETE FROM public.tier_draws WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_draws = ROW_COUNT;

  DELETE FROM public.placement_matches WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_placement_matches = ROW_COUNT;

  -- `seed`, `seed_locked_at` and `excluded` are deliberately NOT touched: they are the
  -- seeding this function exists to preserve. Only the derived tier goes, because the
  -- results it was derived from are the rows just deleted.
  UPDATE public.placement_entrants
  SET tier = NULL
  WHERE tournament_id = p_tournament_id
    AND tier IS NOT NULL;

  RETURN jsonb_build_object(
    'placementMatches', v_placement_matches,
    'tierDraws', v_draws,
    'tierMatches', v_tier_matches
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reset_placement_stage(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tier_matches int := 0;
  v_draws int := 0;
  v_placement_matches int := 0;
  v_entrants int := 0;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = p_tournament_id) THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  -- Taken before the gate, not after. The check and the deletes have to be one decision:
  -- a build that slipped a round-one row in between them would be deleting rows the gate
  -- had just approved, which is the interleaving the lock exists to prevent.
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));

  -- The gate. Anything here means the seed order is still load-bearing.
  IF EXISTS (
    SELECT 1 FROM public.placement_matches WHERE tournament_id = p_tournament_id
    UNION ALL
    SELECT 1 FROM public.tier_draws WHERE tournament_id = p_tournament_id
    UNION ALL
    SELECT 1 FROM public.tier_draw_matches WHERE tournament_id = p_tournament_id
  ) THEN
    RAISE EXCEPTION
      'Clear the schedule first: this reset discards the seed order, and the schedule still '
      'has matches or draws that depend on it. Use the Reset panel on the Schedule tab, which '
      'clears the schedule and keeps the seeding.';
  END IF;

  -- Brackets first: their rows reference the draws and each other. The cascade from
  -- `tier_draws` would cover the matches anyway, but deleting the leaves explicitly keeps
  -- the counts below meaningful rather than zero.
  DELETE FROM public.tier_draw_matches WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_tier_matches = ROW_COUNT;

  DELETE FROM public.tier_draws WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_draws = ROW_COUNT;

  DELETE FROM public.placement_matches WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_placement_matches = ROW_COUNT;

  -- The entrant rows stay: they mirror the registrations, so removing them would mean
  -- re-syncing a field that has not actually changed. Only the placement state on them is
  -- cleared, which is what returns the stage to its start. `seed` and `seed_locked_at` are
  -- the seeding this function exists to clear, and `excluded` is the waiver.
  UPDATE public.placement_entrants
  SET seed = NULL,
      seed_locked_at = NULL,
      tier = NULL,
      excluded = false
  WHERE tournament_id = p_tournament_id;
  GET DIAGNOSTICS v_entrants = ROW_COUNT;

  RETURN jsonb_build_object(
    'placementMatches', v_placement_matches,
    'tierDraws', v_draws,
    'tierMatches', v_tier_matches,
    'entrants', v_entrants
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_day_schedule(p_tournament_id uuid, p_day integer, p_stage text, p_slots jsonb, p_pool_ends jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  slot jsonb;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'A tournament is required';
  END IF;
  IF p_stage NOT IN ('group','knockout') THEN
    RAISE EXCEPTION 'Unsupported stage';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('live-schedule'));
  PERFORM pg_advisory_xact_lock(hashtext('schedule:' || p_day::text));

  IF p_stage = 'group' THEN
    UPDATE public.pool_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE status = 'scheduled' AND tournament_id = p_tournament_id;
  ELSE
    UPDATE public.draw_matches
    SET scheduled_time = NULL, court_id = NULL
    WHERE status = 'scheduled'
      AND COALESCE(is_bye, false) = false
      AND tournament_id = p_tournament_id;
  END IF;

  FOR slot IN SELECT * FROM jsonb_array_elements(p_slots)
  LOOP
    IF p_stage = 'group' THEN
      UPDATE public.pool_matches
      SET scheduled_time = (slot->>'scheduled_time')::timestamptz,
          court_id = NULLIF(slot->>'court_id','')::uuid
      WHERE id = (slot->>'match_id')::uuid
        AND status = 'scheduled'
        AND tournament_id = p_tournament_id;
    ELSE
      UPDATE public.draw_matches
      SET scheduled_time = (slot->>'scheduled_time')::timestamptz,
          court_id = NULLIF(slot->>'court_id','')::uuid
      WHERE id = (slot->>'match_id')::uuid
        AND status = 'scheduled'
        AND tournament_id = p_tournament_id;
    END IF;
  END LOOP;

  IF p_stage = 'group' THEN
    UPDATE public.pools p
    SET scheduled_end = (e.value)::timestamptz
    FROM jsonb_each_text(COALESCE(p_pool_ends, '{}'::jsonb)) e
    WHERE p.id::text = e.key
      AND p.tournament_id = p_tournament_id;

    IF EXISTS (
      SELECT 1
      FROM public.pool_matches
      WHERE tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND team_a_id IS NOT NULL
        AND team_b_id IS NOT NULL
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Group rebuild left assigned matches without a court or time';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM public.draw_matches
      WHERE tournament_id = p_tournament_id
        AND status = 'scheduled'
        AND COALESCE(is_bye, false) = false
        AND team_a_id IS NOT NULL
        AND team_b_id IS NOT NULL
        AND (scheduled_time IS NULL OR court_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Knockout rebuild left assigned matches without a court or time';
    END IF;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.add_tournament_day(p_tournament_id uuid, p_date date, p_start_time time without time zone DEFAULT '09:00:00'::time without time zone, p_end_time time without time zone DEFAULT '18:30:00'::time without time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_exists boolean;
  v_total int;
  v_target int;
  v_new_id uuid;
  v_row record;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

  SELECT true INTO v_exists FROM public.tournaments WHERE id = p_tournament_id;
  IF v_exists IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  IF p_date IS NULL THEN
    RAISE EXCEPTION 'Choose a date for the new day';
  END IF;

  -- Serialise with every other day mutation for this tournament. Without it two
  -- concurrent adds can compute the same target number and race on the unique
  -- (tournament_id, day_number) index.
  PERFORM pg_advisory_xact_lock(hashtext('tournament-days:' || p_tournament_id::text));

  SELECT count(*) INTO v_total
  FROM public.tournament_days
  WHERE tournament_id = p_tournament_id;

  IF v_total >= 7 THEN
    RAISE EXCEPTION 'A tournament can have at most 7 days';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournament_days
    WHERE tournament_id = p_tournament_id AND date = p_date
  ) THEN
    RAISE EXCEPTION 'Another day already uses %', p_date;
  END IF;

  -- Its rank among the existing dates: 1 + however many fall before it.
  SELECT count(*) + 1 INTO v_target
  FROM public.tournament_days
  WHERE tournament_id = p_tournament_id AND date < p_date;

  -- Descending, so the slot at v_target is free by the time the row below it moves.
  FOR v_row IN
    SELECT d.id, d.day_number
    FROM public.tournament_days d
    WHERE d.tournament_id = p_tournament_id
      AND d.day_number >= v_target
    ORDER BY d.day_number DESC
  LOOP
    UPDATE public.tournament_days
    SET day_number = v_row.day_number + 1
    WHERE id = v_row.id;
  END LOOP;

  INSERT INTO public.tournament_days
    (tournament_id, day_number, date, start_time, end_time)
  VALUES
    (p_tournament_id, v_target, p_date, COALESCE(p_start_time, '09:00'::time), COALESCE(p_end_time, '18:30'::time))
  RETURNING id INTO v_new_id;

  UPDATE public.tournaments
  SET day_count = (SELECT count(*) FROM public.tournament_days WHERE tournament_id = p_tournament_id)
  WHERE id = p_tournament_id;

  RETURN v_new_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.remove_tournament_day(p_tournament_id uuid, p_day_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_day public.tournament_days%ROWTYPE;
  v_total int;
  v_tz text;
  v_next_start timestamptz;
  v_start timestamptz;
  v_matches int;
  v_row record;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

  PERFORM pg_advisory_xact_lock(hashtext('tournament-days:' || p_tournament_id::text));

  SELECT * INTO v_day
  FROM public.tournament_days
  WHERE id = p_day_id AND tournament_id = p_tournament_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown day';
  END IF;

  SELECT count(*) INTO v_total
  FROM public.tournament_days
  WHERE tournament_id = p_tournament_id;

  IF v_total <= 1 THEN
    RAISE EXCEPTION 'A tournament needs at least one day';
  END IF;

  SELECT venue_timezone INTO v_tz
  FROM public.tournaments WHERE id = p_tournament_id;

  v_start := ((v_day.date + v_day.start_time) AT TIME ZONE v_tz);

  SELECT ((d.date + d.start_time) AT TIME ZONE v_tz) INTO v_next_start
  FROM public.tournament_days d
  WHERE d.tournament_id = p_tournament_id
    AND d.day_number > v_day.day_number
  ORDER BY d.day_number
  LIMIT 1;

  SELECT count(*) INTO v_matches
  FROM (
    SELECT COALESCE(m.scheduled_time, m.started_at) AS at
    FROM public.placement_matches m
    WHERE m.tournament_id = p_tournament_id AND m.status <> 'void'
    UNION ALL
    SELECT COALESCE(m.scheduled_time, m.started_at)
    FROM public.tier_draw_matches m
    WHERE m.tournament_id = p_tournament_id AND m.status <> 'void'
    UNION ALL
    SELECT COALESCE(m.scheduled_time, m.started_at)
    FROM public.pool_matches m
    WHERE m.tournament_id = p_tournament_id AND m.status <> 'void'
    UNION ALL
    SELECT COALESCE(m.scheduled_time, m.started_at)
    FROM public.draw_matches m
    WHERE m.tournament_id = p_tournament_id AND m.status <> 'void'
  ) scheduled
  WHERE scheduled.at IS NOT NULL
    AND scheduled.at >= v_start
    AND (v_next_start IS NULL OR scheduled.at < v_next_start);

  IF v_matches > 0 THEN
    RAISE EXCEPTION
      'Day % still has % match(es) on it. Clear or move them before removing the day.',
      v_day.day_number, v_matches;
  END IF;

  -- Day courts and breaks are ON DELETE CASCADE, so they go with it.
  DELETE FROM public.tournament_days WHERE id = p_day_id;

  -- Ascending, so each row steps into the slot the delete just freed.
  FOR v_row IN
    SELECT d.id, d.day_number
    FROM public.tournament_days d
    WHERE d.tournament_id = p_tournament_id
      AND d.day_number > v_day.day_number
    ORDER BY d.day_number
  LOOP
    UPDATE public.tournament_days
    SET day_number = v_row.day_number - 1
    WHERE id = v_row.id;
  END LOOP;

  UPDATE public.tournaments
  SET day_count = (SELECT count(*) FROM public.tournament_days WHERE tournament_id = p_tournament_id)
  WHERE id = p_tournament_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_tournament_courts(p_tournament_id uuid, p_count integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_in_use int;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  IF p_count IS NULL OR p_count < 1 OR p_count > 64 THEN
    RAISE EXCEPTION 'A venue has between 1 and 64 courts';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tournament-courts:' || p_tournament_id::text));

  -- A court is `ON DELETE SET NULL` from every match, so removing one that is in
  -- use would unassign a live match rather than fail: the desk would lose the
  -- court a match is on and the schedule would quietly grow a hole. Refuse the
  -- shrink instead, and name the court so the host can move the match first.
  SELECT count(*) INTO v_in_use
  FROM public.courts c
  WHERE c.tournament_id = p_tournament_id
    AND c.number > p_count
    AND (
      EXISTS (
        SELECT 1 FROM public.placement_matches m
        WHERE m.court_id = c.id AND m.status <> 'void'
      )
      OR EXISTS (
        SELECT 1 FROM public.tier_draw_matches m
        WHERE m.court_id = c.id AND m.status <> 'void'
      )
      OR EXISTS (
        SELECT 1 FROM public.pool_matches m
        WHERE m.court_id = c.id AND m.status <> 'void'
      )
      OR EXISTS (
        SELECT 1 FROM public.draw_matches m
        WHERE m.court_id = c.id AND m.status <> 'void'
      )
    );

  IF v_in_use > 0 THEN
    RAISE EXCEPTION
      'Cannot remove % court(s): they still hold a match. Move those matches first.',
      v_in_use;
  END IF;

  -- Shrink first, then fill the gaps, so the pool is always numbered 1..p_count
  -- without ever colliding on the per-tournament unique number.
  DELETE FROM public.courts
  WHERE tournament_id = p_tournament_id
    AND number > p_count;

  INSERT INTO public.courts (tournament_id, number)
  SELECT p_tournament_id, series.n
  FROM generate_series(1, p_count) AS series(n)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.courts c
    WHERE c.tournament_id = p_tournament_id
      AND c.number = series.n
  );

  UPDATE public.tournaments
  SET court_count = p_count
  WHERE id = p_tournament_id;
END;
$function$;

--------------------------------------------------------------------------------
-- Authority without a lifecycle guard
--------------------------------------------------------------------------------
--
-- An owner or an admin must be able to delete in any state, including completed, so
-- `delete_tournament` takes no lifecycle guard at all. It is ownership-sensitive, so it
-- takes can_manage_tournament_access rather than can_edit_tournament: an editor cannot
-- delete the event they help run.

CREATE OR REPLACE FUNCTION public.delete_tournament(p_tournament_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_exists boolean;
BEGIN
  IF NOT public.can_manage_tournament_access(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;


  PERFORM pg_advisory_xact_lock(hashtext('tournaments'));

  SELECT true INTO v_exists FROM public.tournaments WHERE id = p_tournament_id;
  IF v_exists IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  DELETE FROM public.desk_activity
  WHERE match_id IN (
    SELECT id FROM public.pool_matches WHERE tournament_id = p_tournament_id
    UNION ALL
    SELECT id FROM public.draw_matches WHERE tournament_id = p_tournament_id
    UNION ALL
    SELECT id FROM public.placement_matches WHERE tournament_id = p_tournament_id
    UNION ALL
    SELECT id FROM public.tier_draw_matches WHERE tournament_id = p_tournament_id
  );

  DELETE FROM public.tournaments WHERE id = p_tournament_id;
END;
$function$;

-- ===========================================================================
-- PART 6 - Registration
-- ===========================================================================
--
-- Registering is optional product behaviour, and it is deliberately small: the
-- request carries no category, no partner, no capacity and no payment, because
-- those are Phase 2 and would be five columns of guesswork now.
--
-- The one guarantee that matters is that a request cannot arrive already decided.
-- It is enforced twice, on purpose: a CHECK cannot tell an INSERT from an UPDATE,
-- and a trigger cannot be reasoned about from the table definition alone, so both
-- hold one half. The INSERT half is a trigger rather than a DEFAULT because a
-- client that sends `status: 'approved'` would otherwise be trusted.

--------------------------------------------------------------------------------
-- 6.1 The write guards
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tournament_registrations_guard_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A submitted request is always pending. Anything else in the payload is
  -- discarded rather than refused, so an over-eager client cannot accidentally
  -- write a decision, and a well-meaning one cannot read the refusal as a bug.
  NEW.status := 'pending';
  NEW.decided_by := NULL;
  NEW.decided_at := NULL;
  NEW.decision_note := NULL;

  IF auth.uid() IS NOT NULL THEN
    NEW.user_id := auth.uid();
  END IF;

  RETURN NEW;
END;
$$;

-- The client has SELECT only on this table, so every UPDATE arrives from an RPC. The
-- trigger is still the enforcement point rather than the RPC, because it is the only
-- place that holds for a direct SQL write, a service-role script or a future RPC
-- somebody adds without reading this file.
CREATE OR REPLACE FUNCTION public.tournament_registrations_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'A registration cannot be moved to another tournament or person';
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'This request has already been decided';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'A decision is either approved or rejected';
  END IF;

  IF NOT public.can_edit_tournament(OLD.tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Stamped from the transaction clock and the caller, never from the payload, so a
  -- decision cannot be backdated and cannot be attributed to somebody else.
  NEW.decided_by := auth.uid();
  NEW.decided_at := statement_timestamp();
  NEW.updated_at := statement_timestamp();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tournament_registrations_before_insert ON public.tournament_registrations;
CREATE TRIGGER tournament_registrations_before_insert
BEFORE INSERT ON public.tournament_registrations
FOR EACH ROW EXECUTE FUNCTION public.tournament_registrations_guard_insert();

DROP TRIGGER IF EXISTS tournament_registrations_before_update ON public.tournament_registrations;
CREATE TRIGGER tournament_registrations_before_update
BEFORE UPDATE ON public.tournament_registrations
FOR EACH ROW EXECUTE FUNCTION public.tournament_registrations_guard_update();

--------------------------------------------------------------------------------
-- 6.2 Submitting a request
--------------------------------------------------------------------------------

-- The window is checked, then readiness, then the state - in that order, because it
-- is the order the person experiences. A shut window is not a configuration problem
-- on their side, so it must not be reported as one.
--
-- Readiness is consulted here, and this is the only reader of it that is not an
-- editor. That is why `tournament_is_ready` exists separately from
-- `tournament_readiness`: the checklist is editor-only, the boolean is not.
CREATE OR REPLACE FUNCTION public.submit_tournament_registration(p_tournament_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to register';
  END IF;

  PERFORM public.assert_registration_not_shut(p_tournament_id, now());

  IF NOT public.tournament_is_ready(p_tournament_id) THEN
    RAISE EXCEPTION 'This tournament is not accepting registration requests yet';
  END IF;

  INSERT INTO public.tournament_registrations (tournament_id, user_id)
  VALUES (p_tournament_id, auth.uid())
  -- The unique (tournament_id, user_id) index makes a second tap harmless, which
  -- matters on the imperfect wifi this is operated on. It returns the existing
  -- request rather than raising, so a retry is not an error the user has to read.
  ON CONFLICT (tournament_id, user_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT r.id INTO v_id
    FROM public.tournament_registrations r
    WHERE r.tournament_id = p_tournament_id AND r.user_id = auth.uid();
  END IF;

  RETURN v_id;
END;
$$;

comment on function public.submit_tournament_registration(uuid) is
  'Creates a pending registration request for the caller. Idempotent per (tournament, user). Enforces the registration window and readiness; creates no player, team or entrant.';

--------------------------------------------------------------------------------
-- 6.3 Deciding a request
--------------------------------------------------------------------------------

-- One RPC for both decisions, so approval and rejection cannot drift apart in their
-- authorization, their lifecycle rule or their stamping. There is no reverse
-- transition: a decided request stays decided, and a mistake is corrected by
-- deleting the row through the owner's discard path or by a Phase 2 flow. Phase 1
-- has no reopen, and inventing one here would be the third place the state machine
-- is written down.
CREATE OR REPLACE FUNCTION public.decide_tournament_registration(
  p_registration_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tournament uuid := public.tournament_of_registration(p_registration_id);
BEGIN
  -- Resolved from the row, not taken on trust from the caller, so the predicate is
  -- always asked about the tournament the request actually belongs to.
  IF v_tournament IS NULL THEN
    RAISE EXCEPTION 'Unknown registration request';
  END IF;
  IF NOT public.can_edit_tournament(v_tournament) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'A decision is either approved or rejected';
  END IF;

  -- The writable guard, not the configurable one. A window is only required to close
  -- by the derived start, so the last requests can legitimately arrive minutes before
  -- it and be decided after it: an approval is a decision about a request, not a
  -- change to the tournament's configuration, and freezing it at the start would
  -- strand exactly the requests that arrived closest to the deadline. It still cannot
  -- be decided once the event is completed.
  PERFORM public.assert_tournament_writable(v_tournament);

  UPDATE public.tournament_registrations
  SET status = p_decision,
      decision_note = NULLIF(btrim(COALESCE(p_note, '')), '')
  WHERE id = p_registration_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown registration request';
  END IF;
END;
$$;

comment on function public.decide_tournament_registration(uuid, text, text) is
  'Approves or rejects one pending request. Editor-gated, upcoming-only, and terminal: decided_by and decided_at are stamped by the guard trigger, never by the caller. Approval grants no management right and creates no competition data.';

--------------------------------------------------------------------------------
-- 6.4 Reading requests
--------------------------------------------------------------------------------

-- The reviewer list. SECURITY DEFINER with its own authorization, rather than a
-- table policy, because the row carries another user's identity and only the
-- tournament's editors should ever see it. A policy on the table could not express
-- "editors of this tournament" without leaking the whole table to a reader who
-- queries it unfiltered.
CREATE OR REPLACE FUNCTION public.review_tournament_registrations(p_tournament_id uuid)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  email text,
  status text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT r.id, r.user_id, p.email, r.status, r.decided_at, r.decision_note, r.created_at
  FROM public.tournament_registrations r
  LEFT JOIN public.profiles p ON p.user_id = r.user_id
  WHERE r.tournament_id = p_tournament_id
  ORDER BY r.created_at DESC;
END;
$$;

-- The caller's own request, or NULL. This is what makes the button on a tournament
-- page say "Requested" instead of "Register" without exposing anyone else's row.
CREATE OR REPLACE FUNCTION public.my_tournament_registration(p_tournament_id uuid)
RETURNS TABLE (
  id uuid,
  status text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.id, r.status, r.decided_at, r.decision_note, r.created_at
  FROM public.tournament_registrations r
  WHERE r.tournament_id = p_tournament_id
    AND r.user_id = auth.uid();
$$;

--------------------------------------------------------------------------------
-- 6.5 Executable surface
--------------------------------------------------------------------------------

-- Internal guard triggers, not an API. The trigger fires either way; the revoke is
-- so a client cannot call them directly with a hand-built row.
REVOKE ALL ON FUNCTION public.tournament_registrations_guard_insert() FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.tournament_registrations_guard_update() FROM anon, authenticated, public;

GRANT EXECUTE ON FUNCTION public.submit_tournament_registration(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_tournament_registration(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_tournament_registrations(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_tournament_registration(uuid) TO authenticated;
-- ===========================================================================
-- PART 7 - RLS, projections and the executable surface
-- ===========================================================================
--
-- Every `staff write` policy below collapses into the same shape:
--
--   for all to authenticated using (can_edit_tournament(tournament_id))
--
-- which is the whole point of the redesign. The old policies asked a global role
-- question and could not express "this tournament's editors"; because every child
-- table carries a denormalised tournament_id, the answer is one indexed read.
--
-- The public read policies are untouched. A tournament's schedule and results stay
-- world-readable - the app is operated from the floor and the desk, and nothing in
-- this migration changes who can look.

--------------------------------------------------------------------------------
-- 7.1 The write policies, re-scoped per tournament
--------------------------------------------------------------------------------

do $policies$
declare
  t text;
  tables text[] := array[
    'categories', 'courts', 'draw_matches', 'draws', 'placement_entrants',
    'placement_matches', 'pool_entries', 'pool_matches', 'pools', 'teams',
    'tier_draw_matches', 'tier_draws', 'tournament_day_breaks',
    'tournament_day_courts', 'tournament_days'
  ];
begin
  -- The old policy name and the new one are both dropped before the replacement is
  -- created, so the migration is idempotent against a database that has already run
  -- it and against one that has not.
  foreach t in array tables loop
    execute format('drop policy if exists %I on public.%I', t || ' staff write', t);
    execute format('drop policy if exists %I on public.%I', t || ' editor write', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (public.can_edit_tournament(tournament_id)) '
      'with check (public.can_edit_tournament(tournament_id))',
      t || ' editor write', t
    );
  end loop;
end;
$policies$;

--------------------------------------------------------------------------------
-- 7.2 tournaments: read in public, update for an editor, delete for an owner
--------------------------------------------------------------------------------
--
-- Split into three, where one `staff write` policy used to cover everything. The
-- split is what makes the column-privilege revoke in part 8 meaningful: the UPDATE
-- policy admits an editor, and the grant then decides which columns that editor may
-- name. `status`, `is_active` and `owner_user_id` are excluded there, so lifecycle
-- transitions happen only through the RPCs, which are the only code that knows the
-- state machine.
--
-- There is deliberately no INSERT policy. Creating a tournament goes through
-- `create_tournament`, which sets owner_user_id to the caller; a client insert could
-- not, and would produce an ownerless row.

drop policy if exists "tournaments staff write" on public.tournaments;

drop policy if exists "tournaments editor update" on public.tournaments;
create policy "tournaments editor update" on public.tournaments
for update to authenticated
using (public.can_edit_tournament(id))
with check (public.can_edit_tournament(id));

-- Ownership-sensitive: an editor operates the event, the owner decides whether it
-- continues to exist.
drop policy if exists "tournaments owner delete" on public.tournaments;
create policy "tournaments owner delete" on public.tournaments
for delete to authenticated
using (public.can_manage_tournament_access(id));

--------------------------------------------------------------------------------
-- 7.3 tournament_editors
--------------------------------------------------------------------------------

alter table public.tournament_editors enable row level security;

-- An editor may see who else is on the tournament; anyone signed in may see their
-- own membership, so the app can tell "I can edit this" without reading the list.
drop policy if exists "tournament_editors member read" on public.tournament_editors;
create policy "tournament_editors member read" on public.tournament_editors
for select to authenticated
using (
  public.can_edit_tournament(tournament_id)
  or user_id = auth.uid()
  or added_by = auth.uid()
);

-- No client write policy at all. Membership changes go through the RPCs below, which
-- is where "an owner, not an editor" and "the owner may not be demoted" are decided.

--------------------------------------------------------------------------------
-- 7.4 tournament_registrations
--------------------------------------------------------------------------------

alter table public.tournament_registrations enable row level security;

-- SELECT only, and only your own request. The reviewer list is an RPC, not a policy:
-- the row contains another person's identity, and a policy cannot express "editors of
-- this tournament" without handing the whole table to an unfiltered query.
--
-- With no INSERT, UPDATE or DELETE policy, every write is refused to a client before
-- a trigger could even be reached. The RPCs are SECURITY DEFINER, and the guard
-- triggers still fire inside them, so the invariant holds on both paths.
drop policy if exists "tournament_registrations own read" on public.tournament_registrations;
create policy "tournament_registrations own read" on public.tournament_registrations
for select to authenticated
using (user_id = auth.uid());

--------------------------------------------------------------------------------
-- 7.5 profiles
--------------------------------------------------------------------------------
--
-- Renamed with the table. The self-read arm keeps its two clauses: the linked
-- identity, and the durable email match that resolves before the auth trigger has
-- run - which is what keeps a recreated admin identity working, and is the reason the
-- recovery runbook does not depend on the link.

drop policy if exists "staff_roles self read" on public.profiles;
drop policy if exists "profiles self read" on public.profiles;
create policy "profiles self read" on public.profiles
for select to authenticated
using (
  user_id = auth.uid()
  or email = public.normalize_email(auth.jwt() ->> 'email')
  or public.is_platform_admin()
);

drop policy if exists "staff_roles admin write" on public.profiles;
drop policy if exists "profiles admin write" on public.profiles;
create policy "profiles admin write" on public.profiles
for all to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

--------------------------------------------------------------------------------
-- 7.6 The caller's access to one tournament, in one read
--------------------------------------------------------------------------------
--
-- The UI asks "may I edit this, may I manage its people, and am I the owner" on
-- every tournament page. Composing that from four predicate calls would be four
-- round-trips per navigation on the wifi this is operated on, so it is one read.
--
-- It is a *summary*, never a gate. The predicates remain the authority and are what
-- every RPC and every policy consults; this only spares the browser from asking four
-- questions whose answers it must not be trusted with anyway.

CREATE OR REPLACE FUNCTION public.tournament_access(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'is_platform_admin', public.is_platform_admin(),
    'is_owner', public.is_tournament_owner(p_tournament_id),
    'is_editor', public.is_tournament_editor(p_tournament_id),
    'can_edit', public.can_edit_tournament(p_tournament_id),
    'can_manage_access', public.can_manage_tournament_access(p_tournament_id)
  );
$$;

comment on function public.tournament_access(uuid) is
  'The caller''s access to one tournament as one jsonb read, for UI gating only. The predicates it summarises are the authority; nothing may treat this as a gate.';

--------------------------------------------------------------------------------
-- 7.7 The editor roster, as RPCs
--------------------------------------------------------------------------------
--
-- Adding an editor is an ownership act, so all three are
-- can_manage_tournament_access rather than can_edit_tournament. An editor cannot
-- appoint or dismiss another editor.

CREATE OR REPLACE FUNCTION public.list_tournament_editors(p_tournament_id uuid)
RETURNS TABLE (user_id uuid, email text, is_owner boolean, created_at timestamptz)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT e.user_id, COALESCE(p.email, ''), false, e.created_at
  FROM public.tournament_editors e
  LEFT JOIN public.profiles p ON p.user_id = e.user_id
  WHERE e.tournament_id = p_tournament_id
  UNION ALL
  -- The owner is rendered in the same list because "who can edit this" is one
  -- question, but they are not an editor row: a platform admin is override, never an
  -- implicit editor, and the owner is not an implicit editor either.
  --
  -- `user_id` is taken from the profile, because ownership is held by a profile. It is
  -- NULL for an owner who has not signed in yet, which is correct: there is no
  -- identity to manage, only a person to show.
  SELECT p.user_id, COALESCE(p.email, ''), true, t.created_at
  FROM public.tournaments t
  LEFT JOIN public.profiles p ON p.id = t.owner_user_id
  WHERE t.id = p_tournament_id
  ORDER BY 3 DESC, 2;
END;
$$;

-- By email, because the panel the host actually has is a list of colleagues' email
-- addresses. The profile must already exist: an unlinked email has no user_id, and
-- inventing one would mean a pending membership that silently starts working when
-- somebody happens to sign up with that address.
CREATE OR REPLACE FUNCTION public.add_tournament_editor(p_tournament_id uuid, p_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := public.normalize_email(p_email);
  v_user uuid;
BEGIN
  IF NOT public.can_manage_tournament_access(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Enter an email address';
  END IF;

  SELECT p.user_id INTO v_user
  FROM public.profiles p
  WHERE p.email = v_email AND p.user_id IS NOT NULL;

  IF v_user IS NULL THEN
    RAISE EXCEPTION
      'Nobody with the address % has signed in yet. Ask them to sign up first.', v_email;
  END IF;

  -- Ownership is a profile, so this compares the owner's auth user to the candidate's.
  IF EXISTS (
    SELECT 1 FROM public.tournaments t
    JOIN public.profiles p ON p.id = t.owner_user_id
    WHERE t.id = p_tournament_id AND p.user_id = v_user
  ) THEN
    RAISE EXCEPTION 'That is already the owner of this tournament';
  END IF;

  INSERT INTO public.tournament_editors (tournament_id, user_id, added_by)
  VALUES (p_tournament_id, v_user, auth.uid())
  ON CONFLICT (tournament_id, user_id) DO NOTHING;

  RETURN v_user;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_tournament_editor(p_tournament_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_manage_tournament_access(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tournaments t
    JOIN public.profiles p ON p.id = t.owner_user_id
    WHERE t.id = p_tournament_id AND p.user_id = p_user_id
  ) THEN
    -- An owner cannot be demoted by this path. Ownership transfer is Phase 2, and a
    -- half-built transfer here would be an ownerless tournament.
    RAISE EXCEPTION 'The owner of a tournament cannot be removed as an editor';
  END IF;

  DELETE FROM public.tournament_editors
  WHERE tournament_id = p_tournament_id AND user_id = p_user_id;
END;
$$;

comment on function public.list_tournament_editors(uuid) is
  'The "who can edit this tournament" list: the editor rows plus the owner, flagged. Readable by any editor.';
comment on function public.add_tournament_editor(uuid, text) is
  'Owner or platform admin only. Resolves an email to an already-linked profile; refuses rather than storing a membership for somebody who has never signed in.';
comment on function public.remove_tournament_editor(uuid, uuid) is
  'Owner or platform admin only. Refuses to remove the owner, because that would leave the tournament unattributable.';

--------------------------------------------------------------------------------
-- 7.8 players: the roster projection
--------------------------------------------------------------------------------
--
-- `player_roster` is replaced, not extended. It was `security_invoker`, so it
-- inherited the `players` SELECT policy - which admitted only staff roles, and
-- therefore returned nothing for the ordinary signed-in user that self-serve signup
-- makes normal. `public_players` is an ordinary (definer) view over three columns, so
-- it reads through, and it is the only anonymous read of the roster.
--
-- Anonymous access to `players` itself is revoked, which is the part that matters:
-- the table carries email and phone, and a view is not a redaction unless the
-- underlying table stops answering.

create or replace view public.public_players as
  select id, name, gender, created_at from public.players;

comment on view public.public_players is
  'The anonymous-safe roster: id, name, gender, created_at. Excludes email and phone by construction.';

grant select on public.public_players to anon, authenticated;

drop view if exists public.player_roster;

drop policy if exists "player roster public read" on public.players;
revoke select on public.players from anon;

drop policy if exists "players public read" on public.players;
create policy "players read" on public.players
for select to authenticated
using (public.has_any_tournament_edit());

drop policy if exists "players staff write" on public.players;
drop policy if exists "players editor write" on public.players;

-- `has_any_tournament_edit`, not a per-tournament predicate: `players` has no
-- tournament scope at all, so "may this person create a player identity" cannot be
-- answered per tournament. The name is deliberately awkward, so the debt is visible
-- rather than dressed up as a rule.
create policy "players editor write" on public.players
for all to authenticated
using (public.has_any_tournament_edit())
with check (public.has_any_tournament_edit());

--------------------------------------------------------------------------------
-- 7.9 desk_activity
--------------------------------------------------------------------------------
--
-- The audit feed is per-match and carries no tournament_id, so the policy has to
-- resolve one. `desk_activity_tournament` does it without a join and without the
-- possibility of raising on an unexpected table name - a policy that can throw turns
-- a read into a 500 rather than an empty list.
--
-- This replaces `current_staff_role() IS NOT NULL`, which let any staff member read
-- every tournament's feed, including one they have nothing to do with.

CREATE OR REPLACE FUNCTION public.desk_activity_tournament(p_table text, p_match_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE p_table
    WHEN 'placement_matches' THEN
      (SELECT m.tournament_id FROM public.placement_matches m WHERE m.id = p_match_id)
    WHEN 'tier_draw_matches' THEN
      (SELECT m.tournament_id FROM public.tier_draw_matches m WHERE m.id = p_match_id)
    WHEN 'pool_matches' THEN
      (SELECT m.tournament_id FROM public.pool_matches m WHERE m.id = p_match_id)
    WHEN 'draw_matches' THEN
      (SELECT m.tournament_id FROM public.draw_matches m WHERE m.id = p_match_id)
    ELSE NULL
  END;
$$;

drop policy if exists "staff read desk activity" on public.desk_activity;
drop policy if exists "desk activity editor read" on public.desk_activity;
create policy "desk activity editor read" on public.desk_activity
for select to authenticated
using (
  public.can_edit_tournament(public.desk_activity_tournament(match_table, match_id))
);

--------------------------------------------------------------------------------
-- 7.10 Realtime membership
--------------------------------------------------------------------------------
--
-- Publication membership is a separate switch from a grant, and it fails in the
-- quietest possible way: a table with no policy and no membership simply never
-- pushes, and the page that expected it looks like it is not reloading.
--
-- `staff_roles` follows its rename rather than being re-added, because a publication
-- tracks the relation, not the name. The two new tables are added; both are read by
-- the access panel, which is the one screen that has to react to a colleague being
-- added while it is open.

do $realtime$
declare
  t text;
  tables text[] := array['tournament_editors', 'tournament_registrations'];
begin
  foreach t in array tables loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$realtime$;

--------------------------------------------------------------------------------
-- 7.11 The executable surface
--------------------------------------------------------------------------------
--
-- Everything internal is revoked from the client. The predicates stay, because an
-- RLS policy is evaluated as the querying role, and `current_tournament_id()` stays
-- because the app asks for the working tournament on every load.

-- The internal helpers: session and lifecycle readers, the guards, the resolvers, the
-- guard triggers. None is an API.
do $revoke$
declare
  f text;
  sigs text[] := array[
    'current_system_role()',
    'tournament_lifecycle_state(uuid)',
    'assert_tournament_configurable(uuid)',
    'assert_tournament_live(uuid)',
    'assert_tournament_writable(uuid)',
    'assert_registration_window(uuid)',
    'assert_registration_not_shut(uuid, timestamp with time zone)',
    'tournament_starts_at(uuid)',
    'tournament_ends_at(uuid)',
    'tournament_readiness_checks(uuid)',
    'tournament_of_category(uuid)',
    'tournament_of_placement_match(uuid)',
    'tournament_of_tier_draw_match(uuid)',
    'tournament_of_registration(uuid)',
    'match_tournament(text, uuid)',
    'is_platform_admin()',
    'is_tournament_owner(uuid)',
    'is_tournament_editor(uuid)',
    'can_edit_tournament(uuid)',
    'can_manage_tournament_access(uuid)',
    'has_any_tournament_edit()',
    'notes_trim(text)',
    'record_desk_match_activity()',
    'tournament_days_guard_order()',
    'enforce_category_cap()',
    'enforce_match_sides()',
    'enforce_pool_entry_membership()',
    'enforce_team_shape()',
    'enforce_two_category_cap()'
  ];
begin
  foreach f in array sigs loop
    execute format('revoke all on function public.%s from anon, authenticated, public', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$revoke$;

-- The predicates an RLS policy calls, plus the read surface the app uses. These are
-- deliberately callable by the querying role.
grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.can_edit_tournament(uuid) to authenticated;
grant execute on function public.can_manage_tournament_access(uuid) to authenticated;
grant execute on function public.has_any_tournament_edit() to authenticated;
grant execute on function public.current_tournament_id() to anon, authenticated;
grant execute on function public.set_current_tournament(uuid) to authenticated;
grant execute on function public.tournament_readiness(uuid) to authenticated;
grant execute on function public.current_system_role() to authenticated;
grant execute on function public.is_tournament_owner(uuid) to authenticated;
grant execute on function public.is_tournament_editor(uuid) to authenticated;
-- Called from inside two RLS policies, so the querying role has to be able to run
-- them - a policy is evaluated as the caller, not as the policy's author.
grant execute on function public.normalize_email(text) to authenticated;
grant execute on function public.desk_activity_tournament(text, uuid) to authenticated;
grant execute on function public.tournament_access(uuid) to authenticated;

-- The three legacy match RPCs that were executable by PUBLIC. Each is now
-- authenticated-only, which is the smallest correct surface: they are desk actions
-- and an anonymous caller has no legitimate reason to reach one.
revoke all on function public.start_match_safe(text, uuid, uuid, boolean) from public, anon;
revoke all on function public.reset_match_with_note(text, uuid, text) from public, anon;
revoke all on function public.reschedule_live_match(text, uuid, uuid, timestamp with time zone) from public, anon;
grant execute on function public.start_match_safe(text, uuid, uuid, boolean) to authenticated;
grant execute on function public.reset_match_with_note(text, uuid, text) to authenticated;
grant execute on function public.reschedule_live_match(text, uuid, uuid, timestamp with time zone) to authenticated;

-- The RPCs the app calls: still an authenticated surface, unchanged in shape from
-- before except that the guard moved inside.
do $grant$
declare
  f text;
  sigs text[] := array[
    'create_tournament(jsonb)',
    'save_tournament_config(uuid, jsonb)',
    'save_tournament_days(uuid, jsonb)',
    'save_tournament_categories(uuid, jsonb)',
    'discard_tournament(uuid)',
    'delete_tournament(uuid)',
    'start_tournament(uuid)',
    'complete_tournament(uuid)',
    'set_active_tournament(uuid)',
    'set_tournament_courts(uuid, integer)',
    'add_tournament_day(uuid, date, time without time zone, time without time zone)',
    'remove_tournament_day(uuid, uuid)',
    'apply_day_schedule(uuid, integer, text, jsonb, jsonb)',
    'apply_placement_day_schedule(uuid, text, jsonb)',
    'reset_placement_schedule(uuid)',
    'reset_placement_stage(uuid)',
    'sync_placement_entrants(uuid)',
    'set_placement_skill(uuid, uuid, text)',
    'lock_placement_seeds(uuid, jsonb)',
    'apply_placement_generation(uuid, jsonb, boolean)',
    'apply_placement_round_two(uuid, jsonb, boolean)',
    'apply_pool_generation(uuid, boolean, jsonb)',
    'apply_draw_generation(uuid, boolean, jsonb)',
    'apply_tier_draws(uuid, jsonb, jsonb, boolean)',
    'start_placement_match(uuid, uuid)',
    'start_tier_draw_match(uuid, uuid)',
    'report_placement_result(uuid, jsonb)',
    'report_tier_draw_result(uuid, jsonb)',
    'report_pool_result(uuid, integer, integer)',
    'report_draw_result(uuid, jsonb)',
    'reset_placement_result(uuid)',
    'reset_tier_draw_result(uuid)',
    'reschedule_placement_match(text, uuid, uuid, timestamp with time zone)',
    'reset_and_repair_match(text, uuid)',
    'resolve_match_exception(text, uuid, text, uuid, text)',
    'tournament_readiness(uuid)',
    'list_tournament_editors(uuid)',
    'add_tournament_editor(uuid, text)',
    'remove_tournament_editor(uuid, uuid)'
  ];
begin
  foreach f in array sigs loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$grant$;
-- ===========================================================================
-- PART 8 - Column privileges on tournaments
-- ===========================================================================
--
-- RLS decides *which rows* an authenticated editor may touch. It cannot decide
-- *which columns*, and the UPDATE policy in part 7 admits an editor for the whole
-- row. That is the gap this part closes.
--
-- `status`, `is_active` and `owner_user_id` are withheld from the grant, so a direct
-- client update to any of them fails at the privilege layer - before a policy is
-- consulted, before a trigger could fire, and without depending on anything in the
-- application layer being correct. They are written only by the SECURITY DEFINER
-- functions in parts 4 and 5, which run as the table owner and are therefore not
-- subject to this grant at all.
--
-- Why it is a grant and not a trigger: a trigger can be disabled, and a BEFORE UPDATE
-- trigger that reverts a column silently is indistinguishable from a working update -
-- the client gets a 204 and nothing happened. A missing column privilege raises
-- `permission denied for table tournaments`, which is the failure an engineer can
-- actually diagnose.
--
--   withheld - lifecycle, set only by start_tournament / complete_tournament:
--     status
--   withheld - presentation pointer, set only by set_active_tournament:
--     is_active
--   withheld - identity, set only by create_tournament (and Phase 2 transfer):
--     owner_user_id
--   withheld - derived, maintained by the day writers:
--     day_count, court_count
--   withheld - legacy duplicate of group_rest_gap_minutes, written by nothing:
--     rest_gap_minutes
--   withheld - immutable:
--     id, created_at
--
-- Everything else is the setup surface an editor is allowed to type into. The
-- registration window is in the grant rather than withheld, because it is editable
-- configuration and `assert_registration_window` is what validates it - a privilege
-- cannot express "closes before the derived start time".

-- Table-wide, first: the old grant let an authenticated caller INSERT a tournament,
-- DELETE one, and update every column. Removing all three and adding back only the
-- UPDATE columns is the whole change.
revoke insert, update, delete, truncate, references, trigger
  on public.tournaments from anon, authenticated;

grant update (
  name,
  format,
  notes,
  venue_name,
  venue_address,
  venue_timezone,
  organizer_name,
  organizer_email,
  organizer_phone,
  max_categories_per_player,
  placement_games_to,
  placement_win_by,
  placement_best_of,
  knockout_games_to,
  knockout_win_by,
  knockout_best_of,
  group_slot_minutes,
  knockout_slot_minutes,
  group_rest_gap_minutes,
  knockout_rest_gap_minutes,
  registration_opens_at,
  registration_closes_at
) on public.tournaments to authenticated;

-- anon gets no write at all: it was never a legitimate writer and the only reason it
-- had the privilege is that Supabase grants column write to `anon` by default.
revoke insert, update, delete, truncate, references, trigger
  on public.tournaments from anon;

comment on column public.tournaments.status is
  'Lifecycle state. Not in the authenticated UPDATE grant, so it can only be written by start_tournament or complete_tournament. A direct client write fails at the privilege layer.';

--------------------------------------------------------------------------------
-- The same treatment for the tables where a client could write the key columns
--------------------------------------------------------------------------------
--
-- `tournament_editors` has no client write policy at all, so its grants are closed
-- for the same reason the policy was omitted: membership changes are RPC-only, and a
-- grant is what makes that true even if a policy is ever added carelessly.

revoke insert, update, delete on public.tournament_editors from anon, authenticated;
grant select on public.tournament_editors to authenticated;

-- Read-only to the client. The guard triggers run inside the SECURITY DEFINER RPCs,
-- where the invoker is the function owner, so they are unaffected.
revoke insert, update, delete on public.tournament_registrations from anon, authenticated;
grant select on public.tournament_registrations to authenticated;

revoke insert, update, delete on public.profiles from anon;
grant select, insert, update, delete on public.profiles to authenticated;
-- ===========================================================================
-- PART 9 - Verification
-- ===========================================================================
--
-- These assertions run before the legacy helpers are dropped, and they raise rather
-- than warn. A migration this wide has exactly one honest failure mode - it applies
-- and something still names the vocabulary it was supposed to remove - and a warning
-- printed into a CI log is not a failure.
--
-- Everything here is a question about the catalog, not about the diff. It is the
-- same set of questions the db-invariants test asks afterwards, which is deliberate:
-- the migration must not be able to pass its own gate and fail the suite.

do $verify$
declare
  v_bad text;
begin
  -- 1. No function still consults a global staff role, and none reads `draft` as a
  --    lifecycle state. `status <> 'draft'` surviving anywhere is the tell that a
  --    guard was rewritten by hand instead of by the generator.
  --
  --    The three legacy helpers themselves are excluded from the scan: they are about
  --    to be dropped two blocks below, and asking "does anything call has_staff_role"
  --    while has_staff_role still exists is the one question that cannot be answered
  --    yes. The exclusion list is the drop list, and both are three names long on
  --    purpose so they have to be edited together.
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
  into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname not in ('current_staff_role', 'has_staff_role', 'is_invited_email')
    and p.prosrc like '%has_staff_role%';
  if v_bad is not null then
    raise exception 'PART 9: functions still call has_staff_role: %', v_bad;
  end if;

  select string_agg(p.proname, ', ')
  into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname not in ('current_staff_role', 'has_staff_role', 'is_invited_email')
    and p.prosrc like '%current_staff_role%';
  if v_bad is not null then
    raise exception 'PART 9: functions still call current_staff_role: %', v_bad;
  end if;

  select string_agg(p.proname, ', ')
  into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname not in ('current_staff_role', 'has_staff_role', 'is_invited_email')
    and p.prosrc like '%is_invited_email%';
  if v_bad is not null then
    raise exception 'PART 9: functions still call is_invited_email: %', v_bad;
  end if;

  -- `draft` must not survive as a literal. The word appears in prose comments, which
  -- is why the pattern is the quoted literal rather than the bare word.
  select string_agg(p.proname, ', ')
  into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname not in ('current_staff_role', 'has_staff_role', 'is_invited_email')
    and p.prosrc like '%''draft''%';
  if v_bad is not null then
    raise exception 'PART 9: functions still test for a draft status: %', v_bad;
  end if;

  -- 2. No policy does either.
  select string_agg(policyname, ', ')
  into v_bad
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual, '') || coalesce(with_check, '')) ~ 'has_staff_role|current_staff_role|is_invited_email';
  if v_bad is not null then
    raise exception 'PART 9: policies still consult a legacy role helper: %', v_bad;
  end if;

  -- 3. No relation is still called staff_roles, and no legacy helper survives.
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('staff_roles', 'player_roster')
  ) then
    raise exception 'PART 9: a retired relation still exists';
  end if;

  -- 4. The three lifecycle guards keep their intended shape. This is the assertion
  --    that matters most, because the tempting future edit is to widen
  --    assert_tournament_writable into a general override - which is exactly how a
  --    completed tournament becomes scoreable again.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_tournament_configurable'
      and p.prosrc like '%is_platform_admin%'
  ) then
    raise exception 'PART 9: assert_tournament_configurable must not consult the platform role';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_tournament_live'
      and p.prosrc like '%is_platform_admin%'
  ) then
    raise exception 'PART 9: assert_tournament_live must not consult the platform role';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'assert_tournament_writable'
      and p.prosrc like '%is_platform_admin%'
  ) then
    raise exception 'PART 9: assert_tournament_writable must be the one guard with the override';
  end if;

  -- 5. The lifecycle RPCs exist and the retired ones do not. A leftover
  --    `reopen_tournament` or `activate_tournament` is a second, unguarded way in.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('reopen_tournament', 'activate_tournament', 'create_tournament_draft',
                        'save_tournament_draft', 'delete_tournament_draft', 'active_tournament_id')
  ) then
    raise exception 'PART 9: a retired RPC still exists';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'start_tournament'
  ) then
    raise exception 'PART 9: start_tournament was not created';
  end if;

  -- 5b. The writable guard's call sites are exactly the enumerated repair paths. This
  --     is the list the plan calls a closed one, and comparing it as a set rather
  --     than counting it means adding a caller and removing another cannot cancel out.
  select string_agg(p.proname, ',' order by p.proname)
  into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosrc like '%PERFORM public.assert_tournament_writable(%';
  if v_bad is distinct from
     'add_tournament_day,apply_day_schedule,apply_placement_day_schedule,decide_tournament_registration,remove_tournament_day,reset_placement_schedule,reset_placement_stage,set_tournament_courts'
  then
    raise exception 'PART 9: assert_tournament_writable call sites changed: %', v_bad;
  end if;

  -- 5c. And no writer reaches the live guard with a platform-admin override available:
  --     the two guards that must not consult the role are checked above, and this is
  --     the positive half - every scoring and live path is guarded by the live guard,
  --     not by the permissive one.
  select string_agg(p.proname, ',' order by p.proname)
  into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosrc like '%PERFORM public.assert_tournament_live(%';
  if v_bad is distinct from
     'apply_placement_round_two,apply_tier_draws,report_draw_result,report_placement_result,report_pool_result,report_tier_draw_result,reschedule_live_match,reschedule_placement_match,reset_and_repair_match,reset_match_with_note,reset_placement_result,reset_tier_draw_result,resolve_match_exception,start_match_safe,start_placement_match,start_tier_draw_match'
  then
    raise exception 'PART 9: assert_tournament_live call sites changed: %', v_bad;
  end if;

  -- 6. The column privileges. An editor holds UPDATE on the setup columns and not on
  --    the three columns the state machine owns.
  if has_column_privilege('authenticated', 'public.tournaments', 'status', 'update')
     or has_column_privilege('authenticated', 'public.tournaments', 'is_active', 'update')
     or has_column_privilege('authenticated', 'public.tournaments', 'owner_user_id', 'update') then
    raise exception 'PART 9: authenticated can still write a lifecycle column of tournaments';
  end if;

  if not has_column_privilege('authenticated', 'public.tournaments', 'name', 'update') then
    raise exception 'PART 9: authenticated lost UPDATE on the setup columns';
  end if;

  if has_table_privilege('authenticated', 'public.tournaments', 'insert')
     or has_table_privilege('authenticated', 'public.tournaments', 'delete')
     or has_table_privilege('anon', 'public.tournaments', 'update') then
    raise exception 'PART 9: tournaments still has a table-wide write privilege';
  end if;

  -- 7. Ownership is a profile and every tournament has one. The FK target is
  --    asserted rather than assumed: pointing at auth.users would be unattributable on
  --    a database where the admin has not signed in, and would block the admin's
  --    identity from being deleted for as long as they own anything.
  if exists (
    select 1 from public.tournaments where owner_user_id is null
  ) then
    raise exception 'PART 9: a tournament has no owner';
  end if;

  select a.attnotnull into v_bad
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'tournaments' and a.attname = 'owner_user_id';
  if v_bad is null or v_bad = 'false' then
    raise exception 'PART 9: tournaments.owner_user_id is still nullable';
  end if;

  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_class f on f.oid = c.confrelid
    where t.relname = 'tournaments' and c.contype = 'f' and f.relname = 'profiles'
      and pg_get_constraintdef(c.oid) like '%owner_user_id%'
  ) then
    raise exception 'PART 9: tournaments.owner_user_id does not reference profiles';
  end if;

  -- 8. Nothing compares owner_user_id against auth.uid(): it is a profile id, and a
  --    direct comparison would silently authorize nobody.
  select string_agg(p.proname, ', ')
  into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosrc like '%owner_user_id = auth.uid()%';
  if v_bad is not null then
    raise exception 'PART 9: owner_user_id is compared to auth.uid() in: %', v_bad;
  end if;

  -- 9. Registration is single-directional in the schema, not only in the code.
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    where t.relname = 'tournament_registrations'
      and c.conname = 'tournament_registrations_pending_undecided_check'
  ) then
    raise exception 'PART 9: the pending/undecided registration check is missing';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tournament_registrations'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception 'PART 9: tournament_registrations has a client write policy';
  end if;
end;
$verify$;

--------------------------------------------------------------------------------
-- 9.1 Retire the legacy helpers
--------------------------------------------------------------------------------
--
-- Safe to drop now: nothing in the database names them, and the checks above prove
-- it rather than assuming it. They are dropped in this same transaction, so there is
-- no window in which the app could be talking to a deployment that has one and not
-- the other.

drop function if exists public.current_staff_role();
drop function if exists public.has_staff_role(text[]);
drop function if exists public.is_invited_email(text);

-- The retired helpers were reachable by anon through PUBLIC. Their replacements are
-- not: every predicate in part 2 is SECURITY DEFINER with a fixed search_path, and
-- part 7 grants execute to exactly the roles that need it.

--------------------------------------------------------------------------------
-- 9.2 The vocabulary is gone from the catalog, not just from the diff
--------------------------------------------------------------------------------

do $final$
declare
  v_bad text;
begin
  select string_agg(c.relname, ', ')
  into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname ~ 'staff'
    and c.relkind in ('r', 'v', 'm');
  if v_bad is not null then
    raise exception 'PART 9: relations still carry the retired vocabulary: %', v_bad;
  end if;
end;
$final$;

commit;
