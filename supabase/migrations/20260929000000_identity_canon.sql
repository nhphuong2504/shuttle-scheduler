-- ===========================================================================
-- Phase 2, step 1: identity canon
-- ===========================================================================
--
-- Phase 1 introduced `profiles` as the durable person - it holds ownership, the
-- platform role and the working-tournament pointer - but left the two *domain*
-- relationships behind it still keyed on `auth.users.id`:
--
--   tournament_editors.user_id        -> auth.users(id)
--   tournament_editors.added_by       -> auth.users(id)
--   tournament_registrations.user_id  -> auth.users(id)
--   tournament_registrations.decided_by -> auth.users(id)
--
-- That split is the last place a relationship between a person and a tournament
-- points at an identity rather than at the person. It is not cosmetic: an editor
-- grant or a registration request is lost the moment the auth identity is
-- recreated, which is the exact failure `profiles` exists to survive - the recovery
-- runbook recreates the admin identity rather than restoring it, and ownership
-- already survives that. Membership and requests must survive it too.
--
-- After this file every domain relationship keys on `profiles.id`. The only columns
-- in the schema that still name an auth user are `profiles.user_id` (the link
-- itself) and `desk_activity.actor_id` (an audit attribution, deliberately an
-- identity: it records who was signed in, not who they durably are).
--
-- This is a rename-and-convert, never a drop-and-recreate. The rows carry real
-- decisions - who may operate a tournament, who asked to take part - and they are
-- migrated, not re-derived.
--
-- Invariant: I1. Every domain relationship keys on `profiles.id`.

-- ===========================================================================
-- PART 0 - The unmatched-identity pre-flight
-- ===========================================================================
--
-- Before any DDL, because the failure has to be loud and it has to happen while the
-- transaction is still untouched.
--
-- The two kinds of column behave differently, and deliberately:
--
--   * Actor columns (`added_by`, `decided_by`) are *attribution*. A row can exist
--     without them, so an unmatched value becomes NULL - losing the attribution is
--     acceptable, losing the row is not.
--
--   * Member and requester columns (`tournament_editors.user_id`,
--     `tournament_registrations.user_id`) are *the relationship itself*. A profile
--     that cannot be found for one of these rows means a person is about to be
--     silently removed from a tournament or have their request erased. That is not
--     a migration that can succeed by dropping data, so it fails here, before it
--     has changed anything.
--
-- The fix when this fires is to link the missing profile first - the identity exists
-- in auth.users but no profiles row carries its user_id - and re-run.

do $preflight$
declare
  v_editors bigint;
  v_requests bigint;
begin
  select count(*)
    into v_editors
  from public.tournament_editors e
  where not exists (
    select 1 from public.profiles p where p.user_id = e.user_id
  );

  select count(*)
    into v_requests
  from public.tournament_registrations r
  where not exists (
    select 1 from public.profiles p where p.user_id = r.user_id
  );

  if v_editors > 0 or v_requests > 0 then
    raise exception
      'identity canon: % tournament_editors row(s) and % tournament_registrations row(s) name an auth user with no matching profile. A membership or a request must not silently lose its person - link the profile first, then re-run.',
      v_editors, v_requests;
  end if;
end;
$preflight$;

-- ===========================================================================
-- PART 1 - The caller's profile, as one predicate
-- ===========================================================================
--
-- `current_system_role()`'s twin, and it keeps the same two arms for the same
-- reason: the auth link is the fast path, and the normalized JWT email is the
-- durability seam that resolves *before* the auth trigger has linked the row. That
-- is what lets a recreated identity recover its access instead of losing it, and it
-- is why the predicates below go through this function rather than comparing
-- `profiles.user_id` to `auth.uid()` at each call site.

CREATE OR REPLACE FUNCTION public.current_profile_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id
  FROM public.profiles p
  WHERE p.user_id = auth.uid()
     OR p.email = public.normalize_email(auth.jwt() ->> 'email')
  -- A linked row wins when both arms match.
  ORDER BY (p.user_id = auth.uid()) DESC NULLS LAST
  LIMIT 1;
$$;

comment on function public.current_profile_id() is
  'The caller''s profiles.id, by the auth link or - before the trigger has run - by the normalized JWT email. The single answer to "who is the caller" for every per-person rule.';

-- ===========================================================================
-- PART 2 - Foreign keys: drop, rename, convert, re-point
-- ===========================================================================
--
-- The four constraints to `auth.users` are dropped by catalog lookup rather than by
-- their auto-generated names, so the file cannot silently leave one behind if a name
-- ever differs. The tables are named explicitly; nothing else in the schema points
-- at `auth.users`, and the block is scoped so that stays true.

do $drop_auth_fks$
declare
  r record;
begin
  for r in
    select n.nspname as schema_name, c.relname as table_name, con.conname as constraint_name
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where con.contype = 'f'
      and con.confrelid = 'auth.users'::regclass
      and n.nspname = 'public'
      and c.relname in ('tournament_editors', 'tournament_registrations')
  loop
    execute format(
      'alter table %I.%I drop constraint %I',
      r.schema_name, r.table_name, r.constraint_name
    );
  end loop;
end;
$drop_auth_fks$;

--------------------------------------------------------------------------------
-- 2.1 tournaments.owner_user_id -> owner_profile_id
--------------------------------------------------------------------------------
--
-- The foreign key already pointed at `profiles`; only the name was wrong. Phase 1
-- called it `owner_user_id` because it was written while `auth.users` was still the
-- expectation everywhere else, and a column named `..._user_id` that holds a profile
-- id is the kind of mismatch that produces a wrong join six months later.

alter table public.tournaments rename column owner_user_id to owner_profile_id;

do $rename_owner_fk$
declare
  v_conname text;
begin
  select con.conname
    into v_conname
  from pg_constraint con
  join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
  where con.contype = 'f'
    and con.conrelid = 'public.tournaments'::regclass
    and con.confrelid = 'public.profiles'::regclass
    and a.attname = 'owner_profile_id';

  if v_conname is not null and v_conname <> 'tournaments_owner_profile_id_fkey' then
    execute format(
      'alter table public.tournaments rename constraint %I to tournaments_owner_profile_id_fkey',
      v_conname
    );
  end if;
end;
$rename_owner_fk$;

alter index public.tournaments_owner_user_id_idx rename to tournaments_owner_profile_id_idx;

comment on column public.tournaments.owner_profile_id is
  'The profile that owns this tournament: may delete it, manage its editors and operate it. Exactly one owner; transfer is Phase 2. A profile, not an auth user, so ownership survives the owner''s identity being recreated.';

--------------------------------------------------------------------------------
-- 2.2 tournament_editors
--------------------------------------------------------------------------------

alter table public.tournament_editors rename column user_id to profile_id;
alter table public.tournament_editors rename column added_by to added_by_profile_id;
alter index public.tournament_editors_user_idx rename to tournament_editors_profile_idx;

-- The member column first. The pre-flight has already proved every row matches, so
-- this is a total mapping and the NOT NULL on the column is never in question.
--
-- A correlated scalar subquery rather than `update ... from`: it is a no-op on the
-- rows that have no match instead of leaving their old auth uid in place, which is
-- what a `from` join would do - and an auth uid silently left in a profile column is
-- precisely the bug this migration exists to remove.
update public.tournament_editors e
set profile_id = (
  select p.id from public.profiles p where p.user_id = e.profile_id
);

-- The actor column. Unmatched becomes NULL, which is the documented allowance for
-- attribution.
update public.tournament_editors e
set added_by_profile_id = (
  select p.id from public.profiles p where p.user_id = e.added_by_profile_id
);

alter table public.tournament_editors
  add constraint tournament_editors_profile_id_fkey
  foreign key (profile_id) references public.profiles(id) on delete cascade;

alter table public.tournament_editors
  add constraint tournament_editors_added_by_profile_id_fkey
  foreign key (added_by_profile_id) references public.profiles(id) on delete set null;

comment on column public.tournament_editors.profile_id is
  'The person who may operate the tournament. A profile id, so the grant survives the identity being recreated.';
comment on column public.tournament_editors.added_by_profile_id is
  'The profile that granted membership. Attribution only; NULL when unmatchable, because losing it is preferable to losing the membership.';

--------------------------------------------------------------------------------
-- 2.3 tournament_registrations
--------------------------------------------------------------------------------

alter table public.tournament_registrations rename column user_id to profile_id;
alter table public.tournament_registrations rename column decided_by to decided_by_profile_id;

update public.tournament_registrations r
set profile_id = (
  select p.id from public.profiles p where p.user_id = r.profile_id
);

update public.tournament_registrations r
set decided_by_profile_id = (
  select p.id from public.profiles p where p.user_id = r.decided_by_profile_id
);

alter table public.tournament_registrations
  add constraint tournament_registrations_profile_id_fkey
  foreign key (profile_id) references public.profiles(id) on delete cascade;

alter table public.tournament_registrations
  add constraint tournament_registrations_decided_by_profile_id_fkey
  foreign key (decided_by_profile_id) references public.profiles(id) on delete set null;

comment on column public.tournament_registrations.profile_id is
  'The person who asked to take part. A profile id, so the request survives the identity being recreated.';
comment on column public.tournament_registrations.decided_by_profile_id is
  'The profile that decided the request. Attribution only; NULL when unmatchable.';

-- ===========================================================================
-- PART 3 - Predicates, guards, RPCs and policies
-- ===========================================================================
--
-- Everything below re-points at `current_profile_id()`. The `profiles.user_id`
-- comparisons in `current_system_role()`, `current_tournament_id()`,
-- `set_current_tournament()`, `create_tournament()` and the `profiles self read`
-- policy are deliberately untouched: there `user_id` *is* the auth link, and
-- comparing it to `auth.uid()` is the correct question to ask.

--------------------------------------------------------------------------------
-- 3.1 The access predicates
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_tournament_owner(p_tournament_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  -- Ownership is a profile, so this is a direct comparison now: no join through the
  -- auth link is needed to answer "is the caller the owner". An identity that has no
  -- profile yet resolves to NULL, and `x = NULL` is never true, so such a caller
  -- owns nothing - which is correct.
  SELECT EXISTS (
    SELECT 1
    FROM public.tournaments t
    WHERE t.id = p_tournament_id
      AND t.owner_profile_id = public.current_profile_id()
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
      AND e.profile_id = public.current_profile_id()
  );
$$;

CREATE OR REPLACE FUNCTION public.has_any_tournament_edit()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_platform_admin()
      OR EXISTS (
        SELECT 1 FROM public.tournaments t
        WHERE t.owner_profile_id = public.current_profile_id()
      )
      OR EXISTS (
        SELECT 1 FROM public.tournament_editors e
        WHERE e.profile_id = public.current_profile_id()
      );
$$;

--------------------------------------------------------------------------------
-- 3.2 The registration guards
--------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tournament_registrations_guard_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- A submitted request is always pending. Anything else in the payload is discarded
  -- rather than refused, so an over-eager client cannot write a decision and a
  -- well-meaning one cannot read the refusal as a bug.
  NEW.status := 'pending';
  NEW.decided_by_profile_id := NULL;
  NEW.decided_at := NULL;
  NEW.decision_note := NULL;

  -- The requester is the caller's own profile, never the payload's, so a request
  -- cannot be filed on somebody else's behalf. The `IS NOT NULL` guard is kept from
  -- Phase 1 on purpose: a service-role write carries no JWT, and fixtures seed rows
  -- that way. A signed-in caller with no profile yet is refused by the RPC, and the
  -- NOT NULL on the column is the backstop if anything ever got past it.
  IF public.current_profile_id() IS NOT NULL THEN
    NEW.profile_id := public.current_profile_id();
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tournament_registrations_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id THEN
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
  NEW.decided_by_profile_id := public.current_profile_id();
  NEW.decided_at := statement_timestamp();
  NEW.updated_at := statement_timestamp();

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tournament_registrations_guard_insert() FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION public.tournament_registrations_guard_update() FROM anon, authenticated, public;

--------------------------------------------------------------------------------
-- 3.3 Submitting and reading a request
--------------------------------------------------------------------------------
--
-- The shape is Phase 1's; only the requester key moves. Phase 2 step 9 replaces
-- `submit_tournament_registration` with the entries form, and rewrites the two reads
-- to carry entries and capacity. Until then this must keep working exactly as it did.

CREATE OR REPLACE FUNCTION public.submit_tournament_registration(p_tournament_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_profile uuid := public.current_profile_id();
BEGIN
  -- Signed in *and* has a profile. An identity with no profile has no person to file
  -- the request as, and the column is NOT NULL, so it is refused here with a sentence
  -- rather than at the constraint with a code.
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'Sign in to register';
  END IF;

  PERFORM public.assert_registration_not_shut(p_tournament_id, now());

  IF NOT public.tournament_is_ready(p_tournament_id) THEN
    RAISE EXCEPTION 'This tournament is not accepting registration requests yet';
  END IF;

  INSERT INTO public.tournament_registrations (tournament_id, profile_id)
  VALUES (p_tournament_id, v_profile)
  -- The unique (tournament_id, profile_id) constraint makes a second tap harmless,
  -- which matters on the imperfect wifi this is operated on. It returns the existing
  -- request rather than raising, so a retry is not an error the user has to read.
  ON CONFLICT (tournament_id, profile_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT r.id INTO v_id
    FROM public.tournament_registrations r
    WHERE r.tournament_id = p_tournament_id AND r.profile_id = v_profile;
  END IF;

  RETURN v_id;
END;
$$;

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
    AND r.profile_id = public.current_profile_id();
$$;

-- Dropped and re-created rather than replaced: the returned column is renamed, and
-- Postgres refuses to change a function's OUT parameter names in place. The grant is
-- re-issued below.
DROP FUNCTION IF EXISTS public.review_tournament_registrations(uuid);

CREATE FUNCTION public.review_tournament_registrations(p_tournament_id uuid)
RETURNS TABLE (
  id uuid,
  profile_id uuid,
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
  SELECT r.id, r.profile_id, p.email, r.status, r.decided_at, r.decision_note, r.created_at
  FROM public.tournament_registrations r
  LEFT JOIN public.profiles p ON p.id = r.profile_id
  WHERE r.tournament_id = p_tournament_id
  ORDER BY r.created_at DESC;
END;
$$;

comment on function public.review_tournament_registrations(uuid) is
  'The reviewer list for one tournament: editor-gated, carries the requester''s profile and email. Replaced in Phase 2 step 9 by the entries-bearing review read.';

--------------------------------------------------------------------------------
-- 3.4 The editor roster RPCs
--------------------------------------------------------------------------------

-- Dropped and re-created because the returned `user_id` is renamed to `profile_id`.
DROP FUNCTION IF EXISTS public.list_tournament_editors(uuid);

CREATE FUNCTION public.list_tournament_editors(p_tournament_id uuid)
RETURNS TABLE (profile_id uuid, email text, is_owner boolean, created_at timestamptz)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT e.profile_id, COALESCE(p.email, ''), false, e.created_at
  FROM public.tournament_editors e
  LEFT JOIN public.profiles p ON p.id = e.profile_id
  WHERE e.tournament_id = p_tournament_id
  UNION ALL
  -- The owner is rendered in the same list because "who can edit this" is one
  -- question, but they are not an editor row: a platform admin is override, never an
  -- implicit editor, and the owner is not an implicit editor either.
  --
  -- `profile_id` is the owner's profile, which is NOT NULL and always exists - so a
  -- row here is always a person the panel can act on, unlike the Phase 1 shape where
  -- an owner who had not signed in had no identity to manage.
  SELECT t.owner_profile_id, COALESCE(p.email, ''), true, t.created_at
  FROM public.tournaments t
  LEFT JOIN public.profiles p ON p.id = t.owner_profile_id
  WHERE t.id = p_tournament_id
  ORDER BY 3 DESC, 2;
END;
$$;

comment on function public.list_tournament_editors(uuid) is
  'The "who can edit this tournament" list: the editor rows plus the owner, flagged, all keyed by profiles.id. Readable by any editor.';

CREATE OR REPLACE FUNCTION public.add_tournament_editor(p_tournament_id uuid, p_email text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := public.normalize_email(p_email);
  v_profile uuid;
BEGIN
  IF NOT public.can_manage_tournament_access(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Enter an email address';
  END IF;

  -- The profile must already be linked to an identity. Kept from Phase 1: an
  -- unlinked profile would be a membership that silently starts working whenever
  -- somebody signs up with that address, and this panel is not the place to make
  -- that decision.
  SELECT p.id INTO v_profile
  FROM public.profiles p
  WHERE p.email = v_email AND p.user_id IS NOT NULL;

  IF v_profile IS NULL THEN
    RAISE EXCEPTION
      'Nobody with the address % has signed in yet. Ask them to sign up first.', v_email;
  END IF;

  -- Ownership is a profile, so this is a direct comparison.
  IF EXISTS (
    SELECT 1 FROM public.tournaments t
    WHERE t.id = p_tournament_id AND t.owner_profile_id = v_profile
  ) THEN
    RAISE EXCEPTION 'That is already the owner of this tournament';
  END IF;

  INSERT INTO public.tournament_editors (tournament_id, profile_id, added_by_profile_id)
  VALUES (p_tournament_id, v_profile, public.current_profile_id())
  ON CONFLICT (tournament_id, profile_id) DO NOTHING;

  RETURN v_profile;
END;
$$;

comment on function public.add_tournament_editor(uuid, text) is
  'Owner or platform admin only. Resolves an email to an already-linked profile; refuses rather than storing a membership for somebody who has never signed in.';

-- Dropped and re-created because the parameter is renamed: Postgres refuses to change
-- an input parameter name in place, and `p_user_id` would hold a profile id.
DROP FUNCTION IF EXISTS public.remove_tournament_editor(uuid, uuid);

CREATE FUNCTION public.remove_tournament_editor(p_tournament_id uuid, p_profile_id uuid)
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
    WHERE t.id = p_tournament_id AND t.owner_profile_id = p_profile_id
  ) THEN
    -- An owner cannot be demoted by this path. Ownership transfer is Phase 2, and a
    -- half-built transfer here would be an ownerless tournament.
    RAISE EXCEPTION 'The owner of a tournament cannot be removed as an editor';
  END IF;

  DELETE FROM public.tournament_editors
  WHERE tournament_id = p_tournament_id AND profile_id = p_profile_id;
END;
$$;

comment on function public.remove_tournament_editor(uuid, uuid) is
  'Owner or platform admin only. Refuses to remove the owner, because that would leave the tournament unattributable.';

--------------------------------------------------------------------------------
-- 3.5 create_tournament
--------------------------------------------------------------------------------

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
    owner_profile_id
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

--------------------------------------------------------------------------------
-- 3.6 The two row policies that named the caller
--------------------------------------------------------------------------------

alter table public.tournament_editors enable row level security;

-- An editor may see who else is on the tournament; anyone signed in may see their
-- own membership, so the app can tell "I can edit this" without reading the list.
-- `added_by_profile_id` is kept in the read arm so the person who granted a
-- membership can still see it after the column is converted.
drop policy if exists "tournament_editors member read" on public.tournament_editors;
create policy "tournament_editors member read" on public.tournament_editors
for select to authenticated
using (
  public.can_edit_tournament(tournament_id)
  or profile_id = public.current_profile_id()
  or added_by_profile_id = public.current_profile_id()
);

alter table public.tournament_registrations enable row level security;

-- SELECT only, and only your own request. The reviewer list is an RPC, not a policy:
-- the row contains another person's identity, and a policy cannot express "editors of
-- this tournament" without handing the whole table to an unfiltered query.
drop policy if exists "tournament_registrations own read" on public.tournament_registrations;
create policy "tournament_registrations own read" on public.tournament_registrations
for select to authenticated
using (profile_id = public.current_profile_id());

-- ===========================================================================
-- PART 4 - Column privileges, re-issued
-- ===========================================================================
--
-- Phase 1's grant is re-stated here, in the file that renames the column, so that
-- this file is self-contained about what an editor may and may not write. The list
-- of allowed columns is unchanged - `owner_profile_id` is exactly as withheld as
-- `owner_user_id` was, and for the same reason: identity is set by
-- `create_tournament` (and, later, an explicit transfer), never by a client UPDATE.
--
--   withheld - lifecycle, set only by start_tournament / complete_tournament:
--     status
--   withheld - presentation pointer, set only by set_active_tournament:
--     is_active
--   withheld - identity, set only by create_tournament (and Phase 2 transfer):
--     owner_profile_id
--   withheld - derived, maintained by the day writers:
--     day_count, court_count
--   withheld - legacy duplicate of group_rest_gap_minutes, written by nothing:
--     rest_gap_minutes
--   withheld - immutable:
--     id, created_at

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

comment on column public.tournaments.owner_profile_id is
  'The profile that owns this tournament. Not in the authenticated UPDATE grant, so a direct client write fails at the privilege layer; it is set by create_tournament and, in Phase 2, by an explicit transfer.';

-- ===========================================================================
-- PART 5 - The executable surface
-- ===========================================================================

-- The new predicate. Same grant as `current_system_role()`: the querying role has to
-- be able to run it, because an RLS policy is evaluated as the caller.
grant execute on function public.current_profile_id() to authenticated;

-- Grants lost when the three functions were dropped to change their signatures.
GRANT EXECUTE ON FUNCTION public.review_tournament_registrations(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_tournament_editors(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_tournament_editor(uuid, uuid) TO authenticated;

-- ===========================================================================
-- PART 6 - Verification
-- ===========================================================================
--
-- Raises rather than warns. A rename migration has exactly one dishonest failure
-- mode - it applies, and one column still points at the old key - and that failure
-- is silent at the application layer right up until somebody's editor grant
-- disappears when their identity is recreated.

do $verify$
declare
  v_bad text;
begin
  -- 1. `current_profile_id()` exists and is callable by the querying role.
  if to_regprocedure('public.current_profile_id()') is null then
    raise exception 'identity canon: current_profile_id() was not created';
  end if;

  -- 2. No foreign key on the converted tables still points at auth.users.
  select string_agg(format('%s.%s', c.relname, con.conname), ', ')
    into v_bad
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where con.contype = 'f'
    and con.confrelid = 'auth.users'::regclass
    and n.nspname = 'public'
    and c.relname in ('tournament_editors', 'tournament_registrations');

  if v_bad is not null then
    raise exception 'identity canon: still reference auth.users: %', v_bad;
  end if;

  -- 3. Every identity column now references profiles, not merely "some table".
  select string_agg(format('%s.%s', want.tbl, want.col), ', ')
    into v_bad
  from (values
    ('tournament_editors', 'profile_id'),
    ('tournament_editors', 'added_by_profile_id'),
    ('tournament_registrations', 'profile_id'),
    ('tournament_registrations', 'decided_by_profile_id'),
    ('tournaments', 'owner_profile_id')
  ) as want(tbl, col)
  where not exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
    where con.contype = 'f'
      and con.confrelid = 'public.profiles'::regclass
      and n.nspname = 'public'
      and c.relname = want.tbl
      and a.attname = want.col
  );

  if v_bad is not null then
    raise exception 'identity canon: do not reference profiles(id): %', v_bad;
  end if;

  -- 4. No policy on the two converted tables reads auth.uid(). `profiles self read`
  --    still does, and must: there `user_id` is the auth link.
  select string_agg(format('%s.%s', c.relname, pol.polname), ', ')
    into v_bad
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('tournament_editors', 'tournament_registrations')
    and (
      coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~ 'auth\.uid\(\)'
      or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ 'auth\.uid\(\)'
    );

  if v_bad is not null then
    raise exception 'identity canon: policy still reads auth.uid(): %', v_bad;
  end if;

  -- 5. No function compares a profile column against auth.uid(). This is the
  --    assertion that would have caught the whole migration being a no-op.
  select string_agg(p.proname, ', ')
    into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (
      p.prosrc ~ 'owner_profile_id\s*=\s*auth\.uid\(\)'
      or p.prosrc ~ '\mprofile_id\s*=\s*auth\.uid\(\)'
      or p.prosrc ~ 'added_by_profile_id\s*=\s*auth\.uid\(\)'
      or p.prosrc ~ 'decided_by_profile_id\s*=\s*auth\.uid\(\)'
    );

  if v_bad is not null then
    raise exception 'identity canon: these functions still compare a profile column to auth.uid(): %', v_bad;
  end if;

  -- 6. The client still cannot write identity. Restated here rather than trusted from
  --    Phase 1, because this is the file that renamed the column.
  if has_column_privilege('authenticated', 'public.tournaments', 'owner_profile_id', 'update') then
    raise exception 'identity canon: authenticated holds UPDATE on tournaments.owner_profile_id';
  end if;

  -- 7. No column stores a profile id under a name ending `user_id`. Such a column reads
  --    as an auth uid and joins to the wrong table, which is the mismatch this migration
  --    exists to remove. `profiles.user_id` is the only `..._user_id` that may survive,
  --    and it is the link rather than a relationship, so it has no foreign key here.
  select string_agg(format('%s.%s', c.relname, a.attname), ', ')
    into v_bad
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
  where con.contype = 'f'
    and con.confrelid = 'public.profiles'::regclass
    and n.nspname = 'public'
    and a.attname ~ '_user_id$';

  if v_bad is not null then
    raise exception 'identity canon: a profile id is held under a user_id name: %', v_bad;
  end if;
end;
$verify$;
