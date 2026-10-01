-- ============================================================================
-- Name the walk-in arm: `has_any_tournament_edit()` -> `can_add_walk_in_player()`
-- ============================================================================
--
-- Phase 1 created one predicate whose name described the wrong thing. It answers "may
-- this caller add an unlinked person to the *global* player roster", but it was called
-- `has_any_tournament_edit()`, which reads as a capability over tournaments. The reading
-- matters: the correct per-tournament question already exists (`can_edit_tournament(uuid)`),
-- so the old name invited a future writer to reach for this one at a call site that should
-- have used that one - and the broad answer would have "worked".
--
-- Phase 2 removed the ambiguity on the read side by adding `can_manage_player(uuid)`,
-- which is per player and reads membership from the entry. This file finishes the pair:
-- the *create* question keeps its platform-wide answer - it cannot be narrowed, because
-- `players` has no tournament scope and the entry that would scope it does not exist
-- until the player has been created - but it now carries a name that says exactly that.
--
-- The body is unchanged. This is a rename, not a policy change: a walk-in created by an
-- operator is still unlinked, still readable only through an entry once one exists, and
-- still refused a read-back by the author (contact data is readable only through an
-- entry, and a fresh walk-in has none). See `docs/authorization.md`, Section 7.

-- ---------------------------------------------------------------------------
-- 1. The predicate, under the name that says what it authorises
-- ---------------------------------------------------------------------------
--
-- Same shape as before: a platform admin, or the owner or an editor of any tournament.
-- It stays keyed on a platform-wide right, and that is the documented debt rather than
-- an accident - `can_manage_player` is the per-player read predicate, and this is the
-- create predicate, which has nothing to scope to yet.

create or replace function public.can_add_walk_in_player()
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select public.is_platform_admin()
      or exists (
        select 1 from public.tournaments t
        where t.owner_profile_id = public.current_profile_id()
      )
      or exists (
        select 1 from public.tournament_editors e
        where e.profile_id = public.current_profile_id()
      );
$$;

-- `create or replace` restores the implicit EXECUTE grant to PUBLIC, and this function is
-- evaluated inside an RLS policy, so it must be runnable by the querying role. Close the
-- implicit grant first, then hand it to `authenticated` alone.
revoke all on function public.can_add_walk_in_player() from anon, public;
grant execute on function public.can_add_walk_in_player() to authenticated;

comment on function public.can_add_walk_in_player() is
  'May the caller add an unlinked person to the global player roster: a platform admin, or the owner or an editor of any tournament. The create side of the players policy; can_manage_player(uuid) is the read side and is per player.';

-- ---------------------------------------------------------------------------
-- 2. Re-point the one policy that names it, then drop the old name
-- ---------------------------------------------------------------------------
--
-- Order is load-bearing. A policy is a dependent object, so `drop function` refuses while
-- one still names it; `alter policy` rewrites the stored expression, which is what releases
-- the dependency. Dropping first fails loudly rather than silently, but there is no reason
-- to attempt the failing order.

alter policy "players insert" on public.players
with check (
  profile_id is null
  and (
    public.normalize_email(email) = public.normalize_email(auth.jwt() ->> 'email')
    or public.can_add_walk_in_player()
  )
);

drop function public.has_any_tournament_edit();

-- ---------------------------------------------------------------------------
-- 3. Verify
-- ---------------------------------------------------------------------------

do $verify$
begin
  if to_regprocedure('public.can_add_walk_in_player()') is null then
    raise exception 'walk-in predicate: can_add_walk_in_player() was not created';
  end if;

  if to_regprocedure('public.has_any_tournament_edit()') is not null then
    raise exception 'walk-in predicate: has_any_tournament_edit() survived';
  end if;

  -- The old name must not survive in any function body either: `create or replace` on a
  -- caller would have kept the dropped name alive as a live reference.
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc ilike '%has_any_tournament_edit%'
  ) then
    raise exception 'walk-in predicate: a function still names has_any_tournament_edit';
  end if;

  -- The policy is the only caller, and it must name the new function. `pg_policies` is the
  -- catalogue view for exactly this, so the check reads what the planner will read.
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'players'
      and policyname = 'players insert'
      and with_check ilike '%can_add_walk_in_player%'
  ) then
    raise exception 'walk-in predicate: the players insert policy was not re-pointed';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.can_add_walk_in_player()',
    'execute'
  ) then
    raise exception 'walk-in predicate: authenticated cannot execute it';
  end if;

  if has_function_privilege('anon', 'public.can_add_walk_in_player()', 'execute') then
    raise exception 'walk-in predicate: anon holds execute';
  end if;
end;
$verify$;
