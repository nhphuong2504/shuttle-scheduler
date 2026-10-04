-- ===========================================================================
-- Phase 2, steps 8 and 9: registration entries and the identity bridge
-- ===========================================================================
--
-- Step 8 is the schema and the policies - the parts below, with the file's own
-- catalogue gate as the last of them. Step 9 appends the RPCs to the same file,
-- because they are one transaction against one concern: a request that carries
-- categories and partners, and the bridge that turns an approved one into
-- players and teams.
--
-- Two things this file establishes, and both are about *whose* data something is.
--
--   * `players.profile_id` gives a player row an owner, and exactly one code
--     path may set it - the approval bridge. Until Phase 2 a player row had no
--     identity column at all, so "the person this row belongs to" was answered
--     by matching an email address. Email is not an identity: it is a string a
--     person types, it is neither unique nor normalized on this table, and a
--     participant could therefore be handed somebody else's contact data by
--     typing their address into a form. The column, the column grant and the
--     transition guard are three answers to that, and part 2 of this file
--     states why two of them are not enough on their own.
--
--   * `can_manage_player` derives "may the caller see this person's contact
--     data" from the **entry**, never from a projection of it. The projection
--     that exists - `placement_entrants` - is generated and cleared by the
--     placement stage, so reading membership from it would make a contact read
--     depend on whether somebody had run generation: access that comes and goes,
--     and refused for exactly the players who entered but have not been placed.
--
-- Invariants: I2 (a partner is never claimed by email, and one path links a
-- player) and I3 (competition membership comes from the entry).

-- ===========================================================================
-- PART 1 - `players.profile_id`, and the grant that withholds it
-- ===========================================================================
--
-- The link, not a second key: `profiles.id` is the durable person, and a player
-- row is one tournament-domain view of one of them. NULL is the ordinary value
-- and stays ordinary - a walk-in typed in at the desk and a partner supplied by
-- name have no account to be linked to, and force-linking them would be the
-- claim this file exists to prevent.

alter table public.players
  add column profile_id uuid references public.profiles(id) on delete set null;

-- One row per person. Partial, because NULL is the common case and many rows
-- carry it: a plain unique index would allow exactly one unlinked player in the
-- whole database.
create unique index players_profile_id_key
  on public.players (profile_id)
  where profile_id is not null;

-- ---------------------------------------------------------------------------
-- 1.1 The column grant
-- ---------------------------------------------------------------------------
--
-- `players` was granted table-wide write at creation (`20260909220619`), and a
-- later `REVOKE`/`GRANT` pair on `tournaments` shows the shape this table needs
-- (see `20260929000000_identity_canon.sql`, PART 4): withhold the one column
-- that decides identity, leave every other column writable.
--
-- The privilege is the primary mechanism and the trigger in part 2 is the
-- durable one. They are deliberately redundant: a future migration that re-adds
-- a table-wide grant would reopen the column silently if the guard were not
-- there, and the guard is the half that can be asserted from a function body.
--
-- Every non-identity column stays writable, so no legitimate edit path is lost -
-- a player correcting their own phone number, an operator fixing a misspelt
-- name. `DELETE` is deliberately *not* revoked from `authenticated`: the policy
-- restricts it to a platform admin, and withdrawing the privilege as well would
-- make the admin path unreachable. `anon` gets no write of any kind.

revoke insert, update, truncate, references, trigger
  on public.players from anon, authenticated;

grant insert (name, email, phone, gender) on public.players to authenticated;
grant update (name, email, phone, gender) on public.players to authenticated;

comment on column public.players.profile_id is
  'The person this player row belongs to. NULL for a walk-in and for a partner who was supplied by name - an unlinked row is the ordinary state, not a defect. Set by the registration approval''s requester branch and by nothing else; see players_profile_link_guard.';

-- ===========================================================================
-- PART 2 - `players_profile_link_guard`
-- ===========================================================================
--
-- A policy cannot say "this column is written by one code path". `UPDATE own or
-- admin` is *meant* to admit a platform admin, so under that policy alone an
-- admin UI - or any `authenticated` client satisfying the own-row arm - could
-- assign a link, and the rule would be a comment rather than a constraint.
--
-- So the guard decides by **state transition**, not by trying to identify who is
-- writing. That choice is what makes the `ON DELETE SET NULL` arm expressible:
-- an FK action is an ordinary `UPDATE ... SET profile_id = NULL` performed by the
-- database as the referencing table's cascading action, and nothing about the
-- session distinguishes it from a client doing the same thing. Rather than
-- depend on an assumption that it "arrives as a system action", the table makes
-- `profile_id -> NULL` legal for everyone.
--
-- That is safe precisely because de-linking is not a *claim*: it removes contact
-- access, grants nothing, and the only way back is the flagged arm. A client
-- cannot reach any arm that sets a link, because part 1 withholds the column.
--
-- | transition                      | rule                                      |
-- | ------------------------------- | ----------------------------------------- |
-- | INSERT, NULL                    | allowed - walk-in, unlinked partner       |
-- | INSERT, non-null                | the flag only                             |
-- | UPDATE, unchanged               | allowed - a name/email-only write         |
-- | UPDATE, non-null -> NULL        | allowed unconditionally - the de-link     |
-- | UPDATE, A -> B (both non-null)  | refused always, **even with the flag**    |
-- | UPDATE, NULL -> non-null        | the flag only                             |
--
-- The flag is transaction-local and is set by exactly one function: the
-- requester branch of `decide_tournament_registration`. A `SECURITY DEFINER`
-- function runs as its owner and is therefore *not* limited by the column grant
-- in part 1, so the flag is what tells the sanctioned writer apart from a client
-- - without depending on a role name, and without leaking between requests.

create or replace function public.players_profile_link_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_linking boolean :=
    coalesce(current_setting('tournova.allow_profile_link', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if new.profile_id is not null and not v_linking then
      raise exception
        'players.profile_id is set by an approved registration, not by a client write';
    end if;
    return new;
  end if;

  -- No transition, so no rule to apply: this is a name, phone or email edit.
  if new.profile_id is not distinct from old.profile_id then
    return new;
  end if;

  -- The de-link, and the arm `ON DELETE SET NULL` needs. Legal for everyone, and
  -- it grants nothing.
  if new.profile_id is null then
    return new;
  end if;

  -- A -> B. Phase 2 has no relink path at all, so this is refused even under the
  -- flag: "approved for this person once" is not a licence to hand the row to
  -- somebody else, and a flag-only relink is exactly the claim this file exists
  -- to prevent.
  if old.profile_id is not null then
    raise exception
      'A player who is already linked to a person cannot be linked to another one';
  end if;

  if not v_linking then
    raise exception
      'players.profile_id is set by an approved registration, not by a client write';
  end if;

  return new;
end;
$$;

drop trigger if exists players_profile_link_guard on public.players;
create trigger players_profile_link_guard
  before insert or update on public.players
  for each row execute function public.players_profile_link_guard();

comment on function public.players_profile_link_guard() is
  'Keeps players.profile_id to one writer. Transition-based, not actor-based, because the ON DELETE SET NULL arm has no recognisable actor; the transaction-local flag tournova.allow_profile_link is the sanctioned writer''s only mark.';

-- ===========================================================================
-- PART 3 - `can_manage_player`: membership comes from the entry
-- ===========================================================================
--
-- Three ways to be allowed to read a player's contact data: you are the player,
-- you own or edit a tournament the player has entered as a competitor, or you
-- are a platform admin.
--
-- The entry path, and why it is written from `teams`:
--
--   players.id <- teams.player_1_id | teams.player_2_id   (the entry)
--     -> teams.tournament_id                              (NOT NULL, indexed,
--                                                          derived from the
--                                                          category by trigger)
--       -> tournaments.owner_profile_id | tournament_editors.profile_id
--
-- `teams.tournament_id` rather than the `categories` join: it is NOT NULL, it is
-- indexed, and it is the same hop the rest of the authorization surface already
-- reads. `categories.tournament_id` is that column's *source*, so reading it
-- would answer the same question through one more join - and a join that is not
-- indexed for this direction.
--
-- `placement_entrants` is deliberately not consulted anywhere here. It is
-- derived placement data, built by `sync_placement_entrants` after a draw exists
-- and cleared by `reset_placement_stage`, so a membership answer derived from it
-- would appear and disappear with the placement stage.

create or replace function public.can_manage_player(p_player_id uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  SELECT public.is_platform_admin()
      OR EXISTS (
        SELECT 1
        FROM public.players pl
        WHERE pl.id = p_player_id
          -- `x = NULL` is never true, so an anonymous caller (whose profile
          -- resolves to NULL) matches nothing here - which is correct, and is
          -- why no explicit IS NOT NULL is needed on either side.
          AND pl.profile_id = public.current_profile_id()
      )
      OR EXISTS (
        SELECT 1
        FROM public.teams t
        JOIN public.tournaments tr ON tr.id = t.tournament_id
        WHERE (t.player_1_id = p_player_id OR t.player_2_id = p_player_id)
          AND (
            tr.owner_profile_id = public.current_profile_id()
            OR EXISTS (
              SELECT 1
              FROM public.tournament_editors e
              WHERE e.tournament_id = tr.id
                AND e.profile_id = public.current_profile_id()
            )
          )
      );
$$;

comment on function public.can_manage_player(uuid) is
  'May the caller read this player''s contact data: the player themselves, the owner or an editor of a tournament the player has entered as a competitor, or a platform admin. Membership is read from the entry (teams), never from derived placement data.';

-- ===========================================================================
-- PART 4 - the `players` policies
-- ===========================================================================
--
-- This also closes a Phase 1 fidelity gap. The migration that shipped the role
-- redesign created one `FOR ALL` policy admitting any tournament editor, while
-- `docs/authorization.md` documented `UPDATE`/`DELETE` as admin-only. The three
-- verbs are separate now, because they answer three different questions:
--
--   SELECT  - own, or a player the caller's tournament has entered
--   INSERT  - self-service, or an operator adding an unlinked walk-in
--   UPDATE  - own, or a platform admin
--   DELETE  - a platform admin, and nobody else
--
-- `has_any_tournament_edit()` is the walk-in arm, kept from Phase 1 rather than
-- replaced by something narrower here. It is the existing, deliberately
-- awkwardly-named debt: `players` has no tournament scope, so "may this person
-- create a player row" cannot be answered per tournament - and this step is not
-- the place to narrow it. One consequence is worth stating plainly, because it
-- looks like a hole and is not: an operator may *create* a player row and may
-- not *read* it back, because contact data is readable only through an entry and
-- a freshly created walk-in has none. Creation is therefore broader than reading,
-- and the roster these screens render comes from `public_players`, which carries
-- three non-contact columns and no email.

drop policy if exists "players read" on public.players;
drop policy if exists "players editor write" on public.players;
drop policy if exists "players insert" on public.players;
drop policy if exists "players update" on public.players;
drop policy if exists "players delete" on public.players;

create policy "players read" on public.players
for select to authenticated
using (
  profile_id = public.current_profile_id()
  or public.can_manage_player(id)
);

-- `profile_id is null` is redundant with the column grant in part 1 and is kept
-- anyway: a policy that only *happens* to be safe because of a grant two
-- sections above is a policy that reopens if the grant is ever re-issued, and
-- this is the assertion the guard in part 2 backstops.
--
-- The self-service arm reads the caller's own address out of the JWT. It is the
-- only identifier available here, because the column that would say "this is me"
-- is the one withheld - and it grants nothing: the row it admits is unlinked, so
-- nobody gains access to anybody. It is deliberately *not* how the approval
-- bridge links a player, which matches by `profile_id` and never by email.
create policy "players insert" on public.players
for insert to authenticated
with check (
  profile_id is null
  and (
    public.normalize_email(email) = public.normalize_email(auth.jwt() ->> 'email')
    or public.has_any_tournament_edit()
  )
);

create policy "players update" on public.players
for update to authenticated
using (
  profile_id = public.current_profile_id()
  or public.is_platform_admin()
)
with check (
  profile_id = public.current_profile_id()
  or public.is_platform_admin()
);

create policy "players delete" on public.players
for delete to authenticated
using (public.is_platform_admin());

-- ===========================================================================
-- PART 5 - `tournament_registration_entries`
-- ===========================================================================
--
-- A request said "may I take part". It now says *in what*: one row per category
-- asked for, carrying the named partner for a pair event.
--
-- The partner lives here as a **name and an email**, and never as a `players.id`.
-- That is I2's shape rather than an omission: the partner has not claimed
-- anything, may not be an account holder, and resolving them to a player row at
-- submission time would either invent a person or claim one. The approval decides
-- later, and even then it only *matches* an unlinked row - it never links it.
--
-- `UNIQUE (registration_id, category_id)` is one row per category requested, so a
-- resubmit replaces a set rather than accumulating a second copy of it.

create table public.tournament_registration_entries (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null
    references public.tournament_registrations(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  partner_name text,
  partner_email text,
  created_at timestamptz not null default now(),
  constraint tournament_registration_entries_one_per_category
    unique (registration_id, category_id)
);

-- The FK to `categories` needs its own index: nothing about the unique constraint
-- above covers it, and deleting a category would otherwise scan the table.
create index tournament_registration_entries_category_idx
  on public.tournament_registration_entries (category_id);

comment on table public.tournament_registration_entries is
  'The categories a registration request asked for, one row each. Partner fields carry a name and an email, never a player id: a partner is created or reused at approval time, and is never linked to an account by this row.';
comment on column public.tournament_registration_entries.partner_name is
  'The partner the requester named. NULL for a singles event, and required for a pair event - the RPC enforces the pair shape, because only it knows the category''s entry_type at submission time.';
comment on column public.tournament_registration_entries.partner_email is
  'The partner''s address as supplied. Its only permitted job is deduplication at approval time, against unlinked player rows; it never decides identity.';

alter table public.tournament_registration_entries enable row level security;

-- Closed at the privilege layer as well as by the absent policy, for the reason the
-- request table is: the refusal then does not depend on a policy staying absent, and a
-- later migration that adds one cannot silently re-open a direct write. Entries are
-- written by `submit_tournament_registration`, which runs as its owner.
revoke insert, update, delete, truncate, references, trigger
  on public.tournament_registration_entries from anon, authenticated;

-- The requester reads their own request's entries. The subquery is evaluated as
-- the caller, so `tournament_registrations`'' own-read policy applies inside it
-- and the arm matches exactly the requests they filed.
create policy "registration entries own read" on public.tournament_registration_entries
for select to authenticated
using (
  exists (
    select 1
    from public.tournament_registrations r
    where r.id = registration_id
      and r.profile_id = public.current_profile_id()
  )
);

-- Deliberately no reviewer-read policy here, and the reason is worth writing
-- down because the omission looks like an oversight and is not.
--
-- The reviewer list is an RPC (`review_tournament_registrations`), not a policy,
-- for the reason the request table already carries: the row holds another
-- person's identity, and the queue wants it shaped and joined rather than raw.
-- More concretely, a policy's subquery runs as the *caller*, so a reviewer arm
-- that reached through `tournament_registrations` would find nothing - that
-- table's own policy admits only the requester - and expressing it without that
-- hop would need a new resolver granted to every signed-in client. The definer
-- RPC is the smaller surface, so it is the one that answers.
--
-- One consequence is that this table's publication membership (step 9) is not by
-- itself enough for a reviewer's realtime subscription to receive rows: Realtime
-- authorizes `postgres_changes` through each table's SELECT policies, so a queue
-- that subscribes to these tables needs the reviewer read policy that step 11
-- adds alongside the queue that wants it.

-- ===========================================================================
-- PART 6 - the executable surface
-- ===========================================================================
--
-- `create function` grants EXECUTE to PUBLIC, so a new function is an API until it is
-- closed - and the two here are opposites.
--
-- `can_manage_player` is *meant* to be callable by a signed-in client: an RLS policy
-- is evaluated as the querying role, so a policy that calls it fails for everyone
-- unless that role holds EXECUTE. It is a predicate, not a writer, and it answers
-- only about the caller's own access, so granting it exposes a boolean and nothing
-- else.
--
-- The guard is the reverse. Nothing calls it: a trigger fires it, and firing checks
-- no privilege, so revoking EXECUTE from every client takes nothing away.

revoke all on function public.can_manage_player(uuid) from public, anon;
grant execute on function public.can_manage_player(uuid) to authenticated;

revoke all on function public.players_profile_link_guard() from public, anon, authenticated;

-- ===========================================================================
-- PART 7 - realtime membership
-- ===========================================================================
--
-- Publication membership is a separate switch from a grant, and it fails in the
-- quietest possible way: a table with no membership never pushes, and the screen that
-- expected it looks like it is not reloading. `useRealtimeRefresh` subscribes with one
-- unfiltered `postgres_changes` channel - there is no table filter - so an unpublished
-- table does not narrow the subscription, it drops that table's events.
--
-- Idempotent, mirroring `20260920000000` and the role redesign: adding a member twice
-- raises.
--
-- What this does *not* buy, stated here because it is the thing to check when the
-- queue does not react: Realtime authorizes `postgres_changes` through each table's
-- SELECT policies, so membership delivers entries to the **requester**, who has a read
-- policy here, and not yet to a reviewer, who reads through the definer RPC. Step 11
-- adds the reviewer arm alongside the queue that needs it.

do $realtime$
declare
  t text;
  v_tables text[] := array['tournament_registration_entries'];
begin
  foreach t in array v_tables loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$realtime$;

-- ===========================================================================
-- PART 8 - one live request per person, and re-application after a rejection
-- ===========================================================================
--
-- Phase 1 keyed the request uniquely on `(tournament_id, profile_id)`
-- unconditionally, which makes a rejection permanent: the row stays, the unique
-- constraint keeps it, and a person who was turned down once can never apply
-- again. That is not a policy anybody chose - it is what an unconditional unique
-- key means.
--
-- The partial index is the rule as it was intended: at most one *live* request
-- per person per tournament. A rejected row stops being live, so re-applying is
-- a new request with a new decision rather than a reopened one - which is also
-- why the decision stays terminal (`pending -> approved | rejected`, no reverse).

alter table public.tournament_registrations
  drop constraint if exists tournament_registrations_unique_request;

create unique index tournament_registrations_live_request_idx
  on public.tournament_registrations (tournament_id, profile_id)
  where status <> 'rejected';

comment on index public.tournament_registrations_live_request_idx is
  'One live request per person per tournament. Rejected rows leave the index, which is what makes re-application a new request rather than a reopened decision.';

-- The arbiter `submit_tournament_registration` infers has moved from a constraint
-- to this partial index, and an `ON CONFLICT (a, b)` clause no longer resolves
-- without its predicate - it raises at run time rather than at apply time, so
-- leaving the Phase 1 body alone here would ship a registration form that throws.
-- Step 9 replaces this function wholesale; this is the one clause that has to
-- move with the index it infers, and it is stated in the same breath as the
-- index so the two cannot drift.
create or replace function public.submit_tournament_registration(p_tournament_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_profile uuid := public.current_profile_id();
begin
  if v_profile is null then
    raise exception 'Sign in to register';
  end if;

  perform public.assert_registration_not_shut(p_tournament_id, now());

  if not public.tournament_is_ready(p_tournament_id) then
    raise exception 'This tournament is not accepting registration requests yet';
  end if;

  insert into public.tournament_registrations (tournament_id, profile_id)
  values (p_tournament_id, v_profile)
  -- The *live* request index makes a second tap harmless, which matters on the
  -- imperfect wifi this is operated on. It returns the existing request rather than
  -- raising, so a retry is not an error the user has to read.
  on conflict (tournament_id, profile_id) where status <> 'rejected' do nothing
  returning id into v_id;

  if v_id is null then
    -- The predicate is repeated here rather than left off: a rejected row and a live
    -- row can now coexist, and without it this read could return the rejected one.
    select r.id into v_id
    from public.tournament_registrations r
    where r.tournament_id = p_tournament_id
      and r.profile_id = v_profile
      and r.status <> 'rejected';
  end if;

  return v_id;
end;
$$;

-- ===========================================================================
-- PART 9 - Verification
-- ===========================================================================
--
-- Everything here is a question that stays true only if the file above is true.
-- The two that matter most are the pair that a later migration is most likely to
-- undo by accident: the column grant (one `grant all` away from reopening) and
-- the trigger's transition table.

do $verify$
declare
  v_bad text;
begin
  -- 1. The link exists, is a profile reference, and may be null.
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'players'
      and column_name = 'profile_id'
      and is_nullable = 'YES'
  ) then
    raise exception 'registration: players.profile_id is missing or NOT NULL';
  end if;

  select string_agg(format('%s.%s', c.relname, con.conname), ', ')
    into v_bad
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
  where con.contype = 'f'
    and con.confrelid = 'public.profiles'::regclass
    and n.nspname = 'public'
    and c.relname = 'players'
    and a.attname = 'profile_id';

  if v_bad is null then
    raise exception 'registration: players.profile_id does not reference profiles(id)';
  end if;

  -- 2. One linked row per person. A partial index, so NULL may repeat.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'players_profile_id_key'
  ) then
    raise exception 'registration: the partial unique index on players.profile_id is missing';
  end if;

  -- 3. The client cannot write the column, and every other column stays writable.
  --    Both halves matter: a migration that withheld the whole row's write access
  --    would pass the first assertion and break the roster.
  if has_column_privilege('authenticated', 'public.players', 'profile_id', 'update')
     or has_column_privilege('authenticated', 'public.players', 'profile_id', 'insert') then
    raise exception 'registration: authenticated holds INSERT or UPDATE on players.profile_id';
  end if;
  if has_column_privilege('anon', 'public.players', 'profile_id', 'insert')
     or has_column_privilege('anon', 'public.players', 'profile_id', 'update') then
    raise exception 'registration: anon holds INSERT or UPDATE on players.profile_id';
  end if;

  foreach v_bad in array array['name', 'email', 'phone', 'gender'] loop
    if not has_column_privilege('authenticated', 'public.players', v_bad, 'update') then
      raise exception 'registration: authenticated lost UPDATE on players.%', v_bad;
    end if;
  end loop;

  -- 4. The link guard is installed on both the verbs it decides.
  select string_agg(t.tgname, ', ')
    into v_bad
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  where c.relname = 'players'
    and not t.tgisinternal
    and t.tgname = 'players_profile_link_guard'
    and (t.tgtype & 2) = 2
    and (t.tgtype & 4) = 4
    and (t.tgtype & 16) = 16;

  if v_bad is null then
    raise exception 'registration: players_profile_link_guard is not a BEFORE INSERT OR UPDATE trigger on players';
  end if;

  -- 5. The guard's transition table, read out of its own body: the de-link arm
  --    must be unconditional, or the FK's ON DELETE SET NULL would fail.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'players_profile_link_guard'
      and p.prosrc ~ 'new\.profile_id is null'
      and p.prosrc ~ 'is not distinct from old\.profile_id'
  ) then
    raise exception 'registration: players_profile_link_guard does not implement its transition table';
  end if;

  -- 6. `public_players` must not carry the link. It is the anonymous-safe
  --    projection, and adding a column to it is a one-line change that would
  --    publish who is who.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_players'
      and column_name = 'profile_id'
  ) then
    raise exception 'registration: public_players exposes players.profile_id';
  end if;

  -- 7. `can_manage_player` reads the entry and never a projection. This is the
  --    assertion M4 makes about the function body, and it is here as well because
  --    a body is the one thing no later catalogue query can see.
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'can_manage_player'
      and (p.prosrc ~ 'placement_entrants' or p.prosrc ~ 'seed')
  ) then
    raise exception 'registration: can_manage_player reads derived placement data';
  end if;

  -- 8. The entries table, its cascade and its one-per-category rule.
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'tournament_registration_entries'
  ) then
    raise exception 'registration: tournament_registration_entries is missing';
  end if;

  select string_agg(format('%s.%s', c.relname, con.confdeltype), ', ')
    into v_bad
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  where con.contype = 'f'
    and c.relname = 'tournament_registration_entries'
    and con.confdeltype <> 'c';

  if v_bad is not null then
    raise exception 'registration: these entries FKs do not cascade: %', v_bad;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tournament_registration_entries'::regclass
      and contype = 'u'
  ) then
    raise exception 'registration: the one-row-per-category constraint is missing';
  end if;

  -- 9. The entries table is readable by its requester and by nobody else. Row-level
  --    security on with one policy, because a second policy here would be an
  --    oversight rather than an intention - and the reviewer path is the RPC.
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'tournament_registration_entries'
      and c.relrowsecurity
  ) then
    raise exception 'registration: row-level security is not enabled on tournament_registration_entries';
  end if;

  select string_agg(p.polname, ', ')
    into v_bad
  from pg_policy p
  where p.polrelid = 'public.tournament_registration_entries'::regclass;

  if v_bad is distinct from 'registration entries own read' then
    raise exception 'registration: the entries table carries unexpected policies: %', coalesce(v_bad, 'none');
  end if;

  -- ... and no client may write it directly: entries are written by the submit RPC, which
  -- runs as its owner. Checked as a privilege rather than trusted to the absent policy.
  if has_table_privilege('authenticated', 'public.tournament_registration_entries', 'insert')
     or has_table_privilege('authenticated', 'public.tournament_registration_entries', 'update')
     or has_table_privilege('anon', 'public.tournament_registration_entries', 'insert') then
    raise exception 'registration: a client holds a write grant on tournament_registration_entries';
  end if;
  if not has_table_privilege('authenticated', 'public.tournament_registration_entries', 'select') then
    raise exception 'registration: the requester''s read policy cannot work without SELECT';
  end if;

  -- 10. Exactly one *live* request per person, and the Phase 1 unconditional key
  --    is gone. Two keys would look like this rule and quietly enforce the older
  --    one, which is the failure this assertion exists for.
  if to_regclass('public.tournament_registrations_live_request_idx') is null then
    raise exception 'registration: the partial live-request index is missing';
  end if;
  if exists (
    select 1 from pg_constraint
    where conname = 'tournament_registrations_unique_request'
  ) then
    raise exception 'registration: the unconditional request key is still present, so a rejection is still permanent';
  end if;

  -- 11. The Phase 1 submit function's arbiter moved with the index it infers.
  --     Left behind, it raises at run time rather than here - so it is checked
  --     here rather than trusted.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'submit_tournament_registration'
      and p.prosrc ~ 'where status <> ''rejected'''
  ) then
    raise exception 'registration: submit_tournament_registration still infers the dropped unique key';
  end if;

  -- 12. The executable surface. A predicate no client can call breaks every policy
  --     that names it, and a guard any client can call is a guard with a back door.
  if not has_function_privilege('authenticated', 'public.can_manage_player(uuid)', 'execute') then
    raise exception 'registration: authenticated cannot execute can_manage_player, so its policies fail';
  end if;
  if has_function_privilege('anon', 'public.can_manage_player(uuid)', 'execute') then
    raise exception 'registration: can_manage_player is callable without a session';
  end if;
  if has_function_privilege('anon', 'public.players_profile_link_guard()', 'execute')
     or has_function_privilege('authenticated', 'public.players_profile_link_guard()', 'execute') then
    raise exception 'registration: players_profile_link_guard is exposed as an API';
  end if;

  -- 13. The entries table is published, because a missing member drops its events
  --     without an error - the requester''s own panel would simply never update.
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'tournament_registration_entries'
  ) then
    raise exception 'registration: tournament_registration_entries is not in the supabase_realtime publication';
  end if;
end;
$verify$;

-- ===========================================================================
-- PART 10 - Step 9: the registration RPCs
-- ===========================================================================
--
-- Step 8 gave a request somewhere to say *what* it is for. This is the code that
-- writes and reads that, and the bridge that turns an approved request into real
-- entrants.
--
-- Four properties, none of which the Phase 1 single-argument form had:
--
--   * The gates are the same three `tournament_registration_state` reports from -
--     lifecycle, then window, then readiness, in that order - so the Register
--     button and the RPC cannot disagree about whether registration is open. The
--     gates this part *adds* are all per-caller or per-entry (a resolved profile,
--     the active categories, the cap on how many events one request may ask for,
--     the partner's shape), and that is exactly why they are not part of the
--     tournament-level state: a visitor reading the button has no entries yet.
--
--   * A retry replaces the set of entries rather than filing a second request, and
--     a request that has already been decided is refused rather than silently
--     reopened.
--
--   * Withdrawal deletes the request and its entries and nothing else.
--
--   * Approval is the only code path that sets a non-null `players.profile_id`, and
--     it opens the transaction-local flag for that one insert and nothing else.
--
-- `tournament_registration_state` is deliberately not redefined here. It shipped in
-- `20260929001000_tournament_summary.sql` from the same predicates, and this part
-- adds no tournament-level gate for it to learn.

-- ---------------------------------------------------------------------------
-- 10.1 Submitting: three gates, then the entries
-- ---------------------------------------------------------------------------
--
-- The one-argument form is dropped rather than left beside the new one. A leftover
-- one-argument function would shadow the new form for a client that sends only the
-- tournament id, and that client would file an empty request through the old body -
-- the entry-less request this part exists to make impossible.
--
-- `p_entries` still defaults to an empty array, so that same client gets the
-- sentence about choosing an event rather than a "function does not exist" from
-- PostgREST. The refusal is reachable, not theoretical.

drop function if exists public.submit_tournament_registration(uuid);

create or replace function public.submit_tournament_registration(
  p_tournament_id uuid,
  p_entries jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile uuid := public.current_profile_id();
  v_id uuid;
  v_status text;
  v_cap int;
  v_entry jsonb;
  v_category uuid;
  v_cat_tournament uuid;
  v_cat_entry_type text;
  v_cat_active boolean;
  v_partner_name text;
  v_partner_email text;
  v_caller_email text;
  v_seen uuid[] := '{}';
begin
  -- First, because everything below is about *their* entries: an identity with no
  -- profile has no person to file the request as, and the column is NOT NULL, so
  -- it is refused here with a sentence rather than at the constraint with a code.
  if v_profile is null then
    raise exception 'Sign in to register';
  end if;

  -- The three gates, in the order the person experiences them. A shut window is
  -- not a configuration problem on their side, so it is answered before readiness.
  perform public.assert_registration_not_shut(p_tournament_id, now());

  if not public.tournament_is_ready(p_tournament_id) then
    raise exception 'This tournament is not accepting registration requests yet';
  end if;

  -- `jsonb_typeof` rather than a cast, so a client that sends an object where an
  -- array belongs is told what is wrong instead of failing on a syntax error.
  if p_entries is null
     or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) = 0 then
    raise exception 'Choose at least one event to enter';
  end if;

  select t.max_categories_per_player into v_cap
  from public.tournaments t
  where t.id = p_tournament_id;

  if v_cap is not null and jsonb_array_length(p_entries) > v_cap then
    raise exception 'This tournament allows at most % event(s) per player', v_cap;
  end if;

  -- The caller's own address, for the one comparison available before the partner
  -- has a row: "is the person you named you".
  select public.normalize_email(p.email) into v_caller_email
  from public.profiles p
  where p.id = v_profile;

  -- The live request, or a new one. `ON CONFLICT` infers the *partial* index, so
  -- the predicate travels with the clause that infers it; and a second tap
  -- returns the same request rather than raising, which is the whole point on the
  -- wifi this is operated on.
  --
  -- `do nothing` rather than `do update`: an UPDATE would fire
  -- `tournament_registrations_guard_update`, which requires the new status to be a
  -- decision, so a `pending` resubmit cannot go through that path at all. The
  -- entries are replaced below instead, which is the only part of a pending request
  -- a resubmit is allowed to change.
  insert into public.tournament_registrations (tournament_id, profile_id)
  values (p_tournament_id, v_profile)
  on conflict (tournament_id, profile_id) where status <> 'rejected' do nothing
  returning id into v_id;

  if v_id is null then
    select r.id, r.status into v_id, v_status
    from public.tournament_registrations r
    where r.tournament_id = p_tournament_id
      and r.profile_id = v_profile
      and r.status <> 'rejected';
  end if;

  -- A live request that has already been decided is the approved entrant's row.
  -- Replacing its entries would rewrite what they were approved for, so it is
  -- refused. The update guard says the same thing; this is the sentence a person
  -- reads.
  if v_status is not null and v_status <> 'pending' then
    raise exception 'Your registration has already been decided';
  end if;

  -- Idempotent in the sense that matters: a retry replaces the set of entries
  -- rather than accumulating a second copy of it. Deleting first is safe because
  -- the whole function is one transaction - a refusal below rolls the delete back
  -- with everything else.
  delete from public.tournament_registration_entries e
  where e.registration_id = v_id;

  for v_entry in select value from jsonb_array_elements(p_entries) loop
    v_category := nullif(btrim(coalesce(v_entry ->> 'category_id', '')), '')::uuid;
    if v_category is null then
      raise exception 'Every entry needs an event';
    end if;
    if v_category = any (v_seen) then
      raise exception 'Each event may only be chosen once';
    end if;
    v_seen := v_seen || v_category;

    -- Three different answers for three different mistakes, because "that event is
    -- not in this tournament" and "that event has closed" are not the same sentence
    -- to the person reading it.
    select c.tournament_id, c.entry_type, c.active
    into v_cat_tournament, v_cat_entry_type, v_cat_active
    from public.categories c
    where c.id = v_category;

    if not found then
      raise exception 'Unknown event';
    end if;
    if v_cat_tournament <> p_tournament_id then
      raise exception 'That event belongs to another tournament';
    end if;
    if not v_cat_active then
      raise exception 'That event is not open for registration';
    end if;

    v_partner_name := nullif(btrim(coalesce(v_entry ->> 'partner_name', '')), '');
    v_partner_email := nullif(btrim(coalesce(v_entry ->> 'partner_email', '')), '');

    if v_cat_entry_type = 'pair' then
      if v_partner_name is null or v_partner_email is null then
        raise exception 'A doubles event needs a partner name and email';
      end if;
      -- Normalized, because that is how the approval will deduplicate the partner
      -- and the two must agree about who counts as the same address.
      if v_caller_email is not null
         and public.normalize_email(v_partner_email) = v_caller_email then
        raise exception 'You cannot enter a doubles event with yourself as your partner';
      end if;
    else
      -- A singles event has no partner, so the fields are discarded rather than
      -- refused: a form that always sends them is not an error to read, and storing
      -- them would leave a row claiming a partner for a singles entry.
      v_partner_name := null;
      v_partner_email := null;
    end if;

    insert into public.tournament_registration_entries
      (registration_id, category_id, partner_name, partner_email)
    values (v_id, v_category, v_partner_name, v_partner_email);
  end loop;

  return v_id;
end;
$$;

comment on function public.submit_tournament_registration(uuid, jsonb) is
  'Files or replaces the caller''s pending registration request for one tournament. Gates: a signed-in caller with a resolved profile, the lifecycle, the configured window, readiness, at least one entry, every event this tournament''s and active, the per-player event cap, and a named partner who is not the caller. Idempotent: a retry returns the same request and replaces its entries. Creates no player, team or entrant.';

-- ---------------------------------------------------------------------------
-- 10.2 Withdrawing: the requester, while pending, and nothing else
-- ---------------------------------------------------------------------------
--
-- Deliberately not editor-gated. Withdrawing one's own unanswered request is not a
-- decision about the tournament, and routing it through an editor would make a
-- person's mistake somebody else's task.
--
-- The request row is the only thing deleted. The entries follow it by cascade, and
-- no player, team or entrant is touched - which is what keeps "withdraw" from being
-- a quiet deletion of competition data.
create or replace function public.withdraw_tournament_registration(p_registration_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile uuid;
  v_status text;
begin
  select r.profile_id, r.status into v_profile, v_status
  from public.tournament_registrations r
  where r.id = p_registration_id;

  if not found then
    raise exception 'Unknown registration request';
  end if;

  -- `is distinct from`, not `<>`: an anonymous caller's profile resolves to NULL,
  -- and `<> NULL` is never true - which would let exactly the caller this refuses
  -- through the refusal.
  if v_profile is distinct from public.current_profile_id() then
    raise exception 'Not authorized';
  end if;

  if v_status <> 'pending' then
    raise exception 'This request has already been decided';
  end if;

  delete from public.tournament_registrations where id = p_registration_id;
end;
$$;

comment on function public.withdraw_tournament_registration(uuid) is
  'Deletes the caller''s own pending registration request and its entries, and nothing else. Refuses an anonymous caller, another person''s request, and a request that has already been decided.';

-- ---------------------------------------------------------------------------
-- 10.3 Reading: the reviewer's queue and the participant's own panel
-- ---------------------------------------------------------------------------
--
-- Both are dropped and re-created rather than replaced: Postgres refuses to change
-- a function's OUT parameter names in place, and both now carry entries.
--
-- Each returns one row per *entry*, so a queue renders a request's categories
-- without a second read and the request columns repeat per row. A request that
-- somehow has no entries still appears, once, with null entry columns - which is
-- what a Phase 1 row decided under the old form looks like.

drop function if exists public.review_tournament_registrations(uuid);

create function public.review_tournament_registrations(p_tournament_id uuid)
returns table (
  registration_id uuid,
  profile_id uuid,
  email text,
  status text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz,
  entry_id uuid,
  category_id uuid,
  category_code text,
  category_name text,
  entry_type text,
  partner_name text,
  partner_email text,
  player_id uuid,
  partner_player_id uuid
)
language plpgsql
stable security definer
set search_path = public
as $$
begin
  if not public.can_edit_tournament(p_tournament_id) then
    raise exception 'Not authorized';
  end if;

  return query
  with request as (
    select
      r.id,
      r.profile_id,
      r.status,
      r.decided_at,
      r.decision_note,
      r.created_at,
      -- The requester's player row. `players_profile_id_key` is unique where not
      -- null, so this is at most one row and needs no ordering.
      (select pl.id from public.players pl where pl.profile_id = r.profile_id) as player_id
    from public.tournament_registrations r
    where r.tournament_id = p_tournament_id
  )
  select
    r.id,
    r.profile_id,
    p.email,
    r.status,
    r.decided_at,
    r.decision_note,
    r.created_at,
    e.id,
    e.category_id,
    c.code,
    c.name,
    c.entry_type,
    e.partner_name,
    e.partner_email,
    r.player_id,
    -- The other member of the approved team. The partner is never the linked row -
    -- the bridge never links one - so identifying them by elimination is exact
    -- rather than a guess. `r.player_id is not null` is what keeps this null until
    -- the request has been approved, which is the honest answer for a pending one:
    -- this read reports what happened, it does not preview what would.
    (select case
              when t.player_1_id = r.player_id then t.player_2_id
              else t.player_1_id
            end
     from public.teams t
     where t.tournament_id = p_tournament_id
       and t.category_id = e.category_id
       and r.player_id is not null
       and (t.player_1_id = r.player_id or t.player_2_id = r.player_id)
     limit 1) as partner_player_id
  from request r
  left join public.profiles p on p.id = r.profile_id
  left join public.tournament_registration_entries e on e.registration_id = r.id
  left join public.categories c on c.id = e.category_id
  order by r.created_at desc, c.sort_order, c.code;
end;
$$;

comment on function public.review_tournament_registrations(uuid) is
  'The reviewer list for one tournament, one row per requested entry: the requester''s profile and email, the decision, the entry''s category code, name and type, the partner as supplied, and the player rows the entry has resolved to. Editor-gated.';

drop function if exists public.my_tournament_registration(uuid);

create function public.my_tournament_registration(p_tournament_id uuid)
returns table (
  registration_id uuid,
  status text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz,
  entry_id uuid,
  category_id uuid,
  category_code text,
  category_name text,
  entry_type text,
  partner_name text,
  partner_email text
)
language sql
stable security definer
set search_path = public
as $$
  with mine as (
    select r.id, r.status, r.decided_at, r.decision_note, r.created_at
    from public.tournament_registrations r
    where r.tournament_id = p_tournament_id
      and r.profile_id = public.current_profile_id()
    -- The live request wins over a rejected older one, so somebody who was turned
    -- down and applied again reads what they just asked for rather than the refusal
    -- they already know about. `false` sorts after `true`, so the predicate is
    -- `desc` on purpose.
    order by (r.status <> 'rejected') desc, r.created_at desc
    limit 1
  )
  select
    m.id,
    m.status,
    m.decided_at,
    m.decision_note,
    m.created_at,
    e.id,
    e.category_id,
    c.code,
    c.name,
    c.entry_type,
    e.partner_name,
    e.partner_email
  from mine m
  left join public.tournament_registration_entries e on e.registration_id = m.id
  left join public.categories c on c.id = e.category_id
  order by c.sort_order, c.code;
$$;

comment on function public.my_tournament_registration(uuid) is
  'The caller''s own registration for one tournament - the live request if there is one, otherwise the most recent decision - with the entries it asked for, one row per entry. Returns no rows for somebody who has not applied.';

-- ---------------------------------------------------------------------------
-- 10.4 Approval: the bridge from a request to real entrants
-- ---------------------------------------------------------------------------
--
-- The signature, the `can_edit_tournament` gate and the `assert_tournament_writable`
-- guard are Phase 1's and deliberately unchanged (I4): one RPC for both decisions is
-- what keeps approval and rejection from drifting apart in their authorization, their
-- lifecycle rule or their stamping. Only the approved branch grows.
--
-- The bridge does four things, in one transaction:
--
--   1. ensures the **requester's** player row - reused by `profile_id`, never by an
--      email, and created when it does not exist. This is the only place a non-null
--      `players.profile_id` is established anywhere in the code base, so it is the
--      only place that opens the transaction-local flag the guard requires.
--   2. resolves each entry's partner as an **unlinked** player, or creates one with
--      `profile_id` explicitly null. A linked row is not a candidate and is never
--      touched, and a partner who happens to hold an account is not linked and is
--      not told.
--   3. inserts the `teams` row, which is the entry.
--   4. refuses the whole approval, naming the category, when the category's
--      `max_entries` or the per-player cap would be broken.
--
-- Of those, only (1) writes a non-null `players.profile_id`. Nothing else touches
-- the column, so the flag is opened for the requester's row and is not what
-- authorizes the partner's - the partner's row is simply unlinked, which needs no
-- permission at all.
--
-- Rejection creates nothing and grants nothing. Neither decision touches
-- `owner_profile_id`, `tournament_editors`, `current_tournament_id` or any
-- management right.

create or replace function public.decide_tournament_registration(
  p_registration_id uuid,
  p_decision text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament uuid := public.tournament_of_registration(p_registration_id);
  v_requester_profile uuid;
  v_requester_player uuid;
  v_requester_email text;
  v_requester_name text;
  v_entry record;
  v_candidates uuid[];
  v_partner_player uuid;
  v_category_count int;
  v_player_count int;
  v_player_cap int;
  v_player uuid;
begin
  -- Resolved from the row, not taken on trust from the caller, so the predicate is
  -- always asked about the tournament the request actually belongs to.
  if v_tournament is null then
    raise exception 'Unknown registration request';
  end if;
  if not public.can_edit_tournament(v_tournament) then
    raise exception 'Not authorized';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'A decision is either approved or rejected';
  end if;

  -- The writable guard, not the configurable one. A window is only required to close
  -- by the derived start, so the last requests can legitimately arrive minutes before
  -- it and be decided after it: an approval is a decision about a request, not a
  -- change to the tournament's configuration. It still cannot be decided once the
  -- event is completed.
  perform public.assert_tournament_writable(v_tournament);

  if p_decision = 'rejected' then
    -- Creates nothing and grants nothing. The guard trigger stamps the decider and
    -- the clock; this only carries the note and the terminal status.
    update public.tournament_registrations
    set status = 'rejected',
        decision_note = nullif(btrim(coalesce(p_note, '')), '')
    where id = p_registration_id;

    if not found then
      raise exception 'Unknown registration request';
    end if;
    return;
  end if;

  -- -------------------------------------------------------------------------
  -- The approved branch. The requester is read from the request's *stored*
  -- profile, never from the deciding editor and never from an email match.
  -- -------------------------------------------------------------------------
  select r.profile_id into v_requester_profile
  from public.tournament_registrations r
  where r.id = p_registration_id
    and r.status = 'pending';

  if not found then
    -- `v_tournament` resolved, so the row exists; it is simply not pending. The
    -- update guard would raise the same sentence a moment later, but raising it here
    -- keeps the bridge from creating a player for a request it cannot decide.
    raise exception 'This request has already been decided';
  end if;

  -- 1. The requester's player row: reused by `profile_id`, created otherwise.
  select pl.id into v_requester_player
  from public.players pl
  where pl.profile_id = v_requester_profile;

  if v_requester_player is null then
    select coalesce(p.email, '') into v_requester_email
    from public.profiles p
    where p.id = v_requester_profile;

    -- A profile carries no display name, so the address's local part names the row.
    -- It is a starting point, not a claim: the person can correct it through the
    -- own-row UPDATE policy, whose column grant includes `name`.
    v_requester_name := coalesce(nullif(split_part(v_requester_email, '@', 1), ''), 'Player');

    -- Transaction-local (`is_local = true`), set for this insert and nothing else.
    -- The guard reads it as a setting rather than as a role, so the sanctioned writer
    -- is recognisable without naming it; being local, it cannot ride a later
    -- statement on a pooled connection.
    perform set_config('tournova.allow_profile_link', 'on', true);

    insert into public.players (name, email, profile_id)
    values (v_requester_name, nullif(v_requester_email, ''), v_requester_profile)
    returning id into v_requester_player;
  end if;

  select t.max_categories_per_player into v_player_cap
  from public.tournaments t
  where t.id = v_tournament;

  -- 2 and 3. Each entry: the partner first, then the entry itself.
  for v_entry in
    select e.category_id,
           e.partner_name,
           e.partner_email,
           c.code as category_code,
           c.name as category_name,
           c.entry_type,
           c.max_entries
    from public.tournament_registration_entries e
    join public.categories c on c.id = e.category_id
    where e.registration_id = p_registration_id
    order by c.sort_order, c.code
  loop
    v_partner_player := null;

    if v_entry.entry_type = 'pair' and v_entry.partner_email is not null then
      -- Matching is by the **normalized** address and only among unlinked rows: a
      -- linked row is not a candidate and is never touched, because email
      -- deduplicates and never identifies. The aggregate is one statement so the
      -- count and the row cannot disagree.
      select array_agg(pl.id) into v_candidates
      from public.players pl
      where pl.profile_id is null
        and public.normalize_email(pl.email) = public.normalize_email(v_entry.partner_email);

      -- A single unambiguous candidate is reused. Zero candidates means nobody to
      -- reuse; more than one means a guess, and a guess is exactly the claim this
      -- rule exists to prevent - so a fresh unlinked row is created either way.
      if array_length(v_candidates, 1) = 1 then
        v_partner_player := v_candidates[1];
      end if;

      if v_partner_player is null then
        -- `profile_id` is written as NULL explicitly rather than left to the
        -- default: the partner is not linked, and saying so in the insert is what
        -- makes "this branch never links" visible where it is read.
        insert into public.players (name, email, profile_id)
        values (coalesce(v_entry.partner_name, 'Partner'), v_entry.partner_email, null)
        returning id into v_partner_player;
      end if;
    end if;

    -- 4. The caps, checked before the insert so the refusal can name the category.
    --    `enforce_category_cap`, `enforce_two_category_cap` and the unique keys
    --    remain the final word; this only turns their refusal into a message about
    --    the right event, and it deliberately takes no lock - the triggers already
    --    serialize, and a second lock in a different order is how two approvals
    --    deadlock.
    if v_entry.max_entries is not null then
      select count(*) into v_category_count
      from public.teams t
      where t.category_id = v_entry.category_id
        and t.withdrawn = false;

      if v_category_count >= v_entry.max_entries then
        raise exception 'Category % (%) is full: % of % entries',
          v_entry.category_code, v_entry.category_name,
          v_category_count, v_entry.max_entries;
      end if;
    end if;

    if v_player_cap is not null then
      foreach v_player in array array[v_requester_player, v_partner_player] loop
        if v_player is null then continue; end if;

        -- Mirrors `enforce_two_category_cap`'s count, including entries this same
        -- approval has already inserted, so the sentence names the category that
        -- would break the cap rather than the trigger's bare player id.
        select count(distinct t.category_id) into v_player_count
        from public.teams t
        where t.tournament_id = v_tournament
          and t.withdrawn = false
          and t.category_id <> v_entry.category_id
          and (t.player_1_id = v_player or t.player_2_id = v_player);

        if v_player_count >= v_player_cap then
          raise exception
            'Category % (%): a player is already entered in % event(s) and this tournament allows %',
            v_entry.category_code, v_entry.category_name, v_player_count, v_player_cap;
        end if;
      end loop;
    end if;

    insert into public.teams (category_id, player_1_id, player_2_id)
    values (v_entry.category_id, v_requester_player, v_partner_player);
  end loop;

  -- The terminal status, last. The guard trigger requires the row to still be
  -- `pending` and stamps `decided_by_profile_id` and `decided_at` from the caller and
  -- the transaction clock, never from the payload.
  update public.tournament_registrations
  set status = 'approved',
      decision_note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_registration_id;

  if not found then
    raise exception 'Unknown registration request';
  end if;
end;
$$;

comment on function public.decide_tournament_registration(uuid, text, text) is
  'Approves or rejects one pending request. Editor-gated, upcoming-only, and terminal. Approval runs the identity bridge in one transaction: it creates or reuses the requester''s linked player row, creates or reuses each entry''s partner as an unlinked row, writes the teams, and refuses rather than overfills a category. It grants no management right and creates no entrant beyond the approvals'' own teams.';

-- ---------------------------------------------------------------------------
-- 10.5 The executable surface
-- ---------------------------------------------------------------------------
--
-- `create function` grants EXECUTE to PUBLIC, so each name here is an API until it
-- is closed - and all five are meant to be called: three by a participant or a
-- reviewer, and two through the submission and the decision. The `REVOKE` is
-- repeated for the two replaced functions because that is this repository's
-- established shape, not because a replacement loses its grant.

revoke all on function public.submit_tournament_registration(uuid, jsonb) from public, anon;
grant execute on function public.submit_tournament_registration(uuid, jsonb) to authenticated;

revoke all on function public.withdraw_tournament_registration(uuid) from public, anon;
grant execute on function public.withdraw_tournament_registration(uuid) to authenticated;

revoke all on function public.review_tournament_registrations(uuid) from public, anon;
grant execute on function public.review_tournament_registrations(uuid) to authenticated;

revoke all on function public.my_tournament_registration(uuid) from public, anon;
grant execute on function public.my_tournament_registration(uuid) to authenticated;

revoke all on function public.decide_tournament_registration(uuid, text, text) from public, anon;
grant execute on function public.decide_tournament_registration(uuid, text, text) to authenticated;

-- ===========================================================================
-- PART 11 - Step 9 verification
-- ===========================================================================
--
-- The same shape as Step 8's block: every question here is one that stays true only
-- if the SQL above is true, and the two that matter most are the pair a later edit
-- is most likely to undo quietly - the one-argument submission reappearing beside
-- the new one, and the approval setting a link anywhere other than the requester's
-- own row.

do $verify_rpcs$
declare
  v_bad text;
begin
  -- 1. The Phase 1 single-argument submission is gone. Left in place it would shadow
  --    the new form for a client that omits the entries, and that client would file
  --    the empty request this part exists to make impossible.
  if to_regprocedure('public.submit_tournament_registration(uuid)') is not null then
    raise exception 'registration rpcs: the Phase 1 single-argument submission still exists';
  end if;
  if to_regprocedure('public.submit_tournament_registration(uuid, jsonb)') is null then
    raise exception 'registration rpcs: submit_tournament_registration(uuid, jsonb) was not created';
  end if;
  if to_regprocedure('public.withdraw_tournament_registration(uuid)') is null then
    raise exception 'registration rpcs: withdraw_tournament_registration(uuid) was not created';
  end if;

  -- 2. The submission writes entries and still infers the partial index with its
  --    predicate. A `do nothing` clause without the predicate raises at run time,
  --    not at apply time - which is why it is asserted here rather than trusted.
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'submit_tournament_registration'
      and p.pronargs = 2
      and p.prosrc ~ 'insert into public\.tournament_registration_entries'
      and p.prosrc ~ 'on conflict \(tournament_id, profile_id\) where status <> ''rejected'' do nothing'
  ) then
    raise exception 'registration rpcs: the submission does not write entries or no longer infers the live-request index';
  end if;

  -- 3. Withdrawal deletes the request and nothing else: one delete, and it targets
  --    the request table only.
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'withdraw_tournament_registration'
      and p.prosrc ~ 'delete from public\.tournament_registrations'
      and p.prosrc !~ 'delete from public\.(players|teams|tournament_registration_entries)'
  ) then
    raise exception 'registration rpcs: withdrawal does not delete exactly the request row';
  end if;

  -- 4. The approval is the only writer of a link. It opens the flag, creates the
  --    requester's row, restricts the partner match to unlinked rows, and inserts
  --    the team - and it is also the *only* function that mentions the flag.
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'decide_tournament_registration'
      and p.prosrc ~ 'set_config\(''tournova\.allow_profile_link'', ''on'', true\)'
      and p.prosrc ~ 'insert into public\.players'
      and p.prosrc ~ 'insert into public\.teams'
      and p.prosrc ~ 'pl\.profile_id is null'
      and p.prosrc ~ 'normalize_email'
  ) then
    raise exception 'registration rpcs: the approval does not implement the bridge';
  end if;

  select string_agg(p.proname, ', ')
    into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosrc ~ 'set_config\(''tournova\.allow_profile_link'''
    and p.proname <> 'decide_tournament_registration';

  if v_bad is not null then
    raise exception 'registration rpcs: these functions also open the link flag: %', v_bad;
  end if;

  --    The approval names `profile_id` in exactly one insert - the requester's. The
  --    partner's insert says NULL, which is the property M2 asserts from the body.
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'decide_tournament_registration'
      and (
        p.prosrc !~ 'values \(coalesce\(v_entry\.partner_name, ''Partner''\), v_entry\.partner_email, null\)'
        or (
          length(p.prosrc) - length(replace(p.prosrc, 'insert into public.players', ''))
        ) / length('insert into public.players') <> 2
      )
  ) then
    raise exception 'registration rpcs: the approval must create exactly two kinds of player row, and only the requester''s carries a link';
  end if;

  -- 5. The review read carries the entries and the resolved players; the
  --    participant read carries the entries. Both are per-entry rows.
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'review_tournament_registrations'
      and 'category_code' = any (p.proargnames)
      and 'partner_email' = any (p.proargnames)
      and 'player_id' = any (p.proargnames)
      and 'partner_player_id' = any (p.proargnames)
  ) then
    raise exception 'registration rpcs: the review read does not return the entries and their resolved players';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'my_tournament_registration'
      and 'entry_id' = any (p.proargnames)
      and 'category_code' = any (p.proargnames)
      and 'decision_note' = any (p.proargnames)
  ) then
    raise exception 'registration rpcs: my_tournament_registration does not return the request and its entries';
  end if;

  -- 6. The executable surface: every one of the five is callable by a signed-in
  --    client, and none by an anonymous one.
  foreach v_bad in array array[
    'public.submit_tournament_registration(uuid, jsonb)',
    'public.withdraw_tournament_registration(uuid)',
    'public.review_tournament_registrations(uuid)',
    'public.my_tournament_registration(uuid)',
    'public.decide_tournament_registration(uuid, text, text)'
  ] loop
    if not has_function_privilege('authenticated', v_bad, 'execute') then
      raise exception 'registration rpcs: authenticated cannot execute %', v_bad;
    end if;
    if has_function_privilege('anon', v_bad, 'execute') then
      raise exception 'registration rpcs: % is callable without a session', v_bad;
    end if;
  end loop;
end;
$verify_rpcs$;
