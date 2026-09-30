-- ============================================================================
-- Retire `is_active`
-- ============================================================================
--
-- Phase 1 carried one global "active tournament": a boolean column, a partial unique
-- index that allowed exactly one row to hold it, and `set_active_tournament` to move it.
-- That was navigation state, not tournament state - it decided which event a visitor who
-- had not chosen one landed on.
--
-- Phase 2 replaced the meaning with two separate things. A signed-in caller has a real
-- pointer of their own (`profiles.current_tournament_id`, written by
-- `set_current_tournament`), and a caller with no pointer - anonymous, or signed in and
-- not yet choosing - browses `/explore`. Neither needs a global default, so the column is
-- a reader-less leftover that can only drift from what the app actually does.
--
-- This migration removes it, and with it the last global navigation state. Afterward
-- `current_tournament_id()` answers with the caller's pointer or NULL, and every surface
-- that used to lean on the fallback already handles NULL: Home renders its empty state
-- and the flat-path redirect sends the caller to `/explore`, both shipped in S5/S6.
--
-- Order is: re-scope the reader, drop the writer, drop the index, drop the column. The
-- reverse order would leave `current_tournament_id()` briefly reading a column that no
-- longer exists.
--
-- No grant change is needed. Phase 1 already withheld `is_active` from the `authenticated`
-- UPDATE list, so dropping the column withdraws nothing a client held. The `tournaments`
-- column grant belongs to the identity migration and is not restated here.

--------------------------------------------------------------------------------
-- 1. current_tournament_id() becomes pointer-only
--------------------------------------------------------------------------------
--
-- The fallback to the globally live tournament was Phase 1 compatibility, and the
-- migration that introduced it said so: it kept the single-tournament pages rendering for
-- a signed-in user who had not chosen one, and it gave an anonymous caller the public
-- default. Phase 2 wants neither. An unpointed caller is a caller who has not chosen yet,
-- and the answer to "which tournament" is then "none" - which the surfaces above already
-- render.
--
-- An anonymous caller gets NULL deliberately: `auth.uid()` is NULL during server rendering
-- too, and a server-rendered page must never be redirected to a tournament on the strength
-- of a request the rendering process made.

create or replace function public.current_tournament_id()
returns uuid
language plpgsql
stable security definer
set search_path = public
as $$
declare
  v_own uuid;
begin
  if auth.uid() is null then
    return null;
  end if;

  select p.current_tournament_id into v_own
  from public.profiles p
  where p.user_id = auth.uid();

  return v_own;
end;
$$;

--------------------------------------------------------------------------------
-- 2. Drop the global pointer and its writer
--------------------------------------------------------------------------------

-- The only writer left. `activate_tournament` was already dropped by the role redesign,
-- which moved its Draft -> In Progress meaning to `start_tournament`, so nothing calls
-- this. Dropping the function makes the column unreachable by any application path before
-- the column itself goes.
drop function if exists public.set_active_tournament(uuid);

-- The partial unique index is what enforced "exactly one active tournament". It is dropped
-- explicitly rather than left to `drop column`, so the intent is legible here.
drop index if exists public.tournaments_single_active;

-- Dropping the column also drops `tournaments_active_status_check`, the CHECK that tied
-- the boolean to `status = 'in_progress'` - the coupling the role redesign already replaced
-- with the three-state machine. Nothing else depends on the column: no policy and no view
-- reads it, and re-scoping `current_tournament_id()` above removed the last function that
-- did. Deliberately no CASCADE, so if that ever stops being true this migration fails
-- loudly instead of silently taking a dependent object with it.
alter table public.tournaments drop column if exists is_active;

--------------------------------------------------------------------------------
-- 3. Verify
--------------------------------------------------------------------------------

do $verify$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tournaments'
      and column_name = 'is_active'
  ) then
    raise exception 'retire is_active: the column survived';
  end if;

  if to_regclass('public.tournaments_single_active') is not null then
    raise exception 'retire is_active: the single-active index survived';
  end if;

  if to_regprocedure('public.set_active_tournament(uuid)') is not null then
    raise exception 'retire is_active: set_active_tournament survived';
  end if;

  if to_regprocedure('public.current_tournament_id()') is null then
    raise exception 'retire is_active: current_tournament_id() disappeared';
  end if;

  -- The fallback is gone exactly when the body no longer names the column. `prosrc` is the
  -- only place that answer lives inside the database; the repository test asks the same
  -- question of the file.
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'current_tournament_id'
      and p.prosrc ilike '%is_active%'
  ) then
    raise exception 'retire is_active: current_tournament_id() still reads is_active';
  end if;
end;
$verify$;
