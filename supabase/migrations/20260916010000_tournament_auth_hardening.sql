-- ============================================================================
-- Auth hardening: close the staff-role gate
-- ============================================================================
--
-- Two defects combined to let an unauthenticated caller (the publishable / anon
-- key) invoke the admin-only RPCs, including creating and ACTIVATING a
-- tournament.
--
-- 1. `has_staff_role()` returns NULL, not false, for a caller with no staff row.
--    `current_staff_role()` selects from `staff_roles` matching `auth.uid()` or
--    the JWT email. With neither, the SELECT returns no row, so the function
--    returns NULL, and therefore so does `has_staff_role()`.
--
--    Every guard in the codebase is written `IF NOT public.has_staff_role(...)`.
--    In PL/pgSQL `NOT NULL` is NULL and `IF NULL THEN` does not run, so the
--    guard silently passed and execution continued. This affected all 35 guards
--    across eight migrations, not only the creation-flow ones.
--
-- 2. `CREATE FUNCTION` grants EXECUTE to PUBLIC by default. The creation-flow
--    migration granted EXECUTE to `authenticated` but never revoked that
--    implicit PUBLIC grant, so `anon` retained access through PUBLIC. The older
--    RPCs were protected because an earlier migration revoked them explicitly;
--    `create_tournament` and the seven new draft RPCs were not.
--
-- Either defect alone would have been enough for a logged-in non-staff user to
-- reach these functions. Together they exposed them to anonymous callers.
--
-- Fixing `has_staff_role()` to coalesce to false repairs every call site at once,
-- including the RLS policies, which until now relied on NULL incidentally denying
-- access. The revokes below then remove the anonymous reachability.

--------------------------------------------------------------------------------
-- 1. Make the gate three-valued-logic proof
--------------------------------------------------------------------------------

-- COALESCE(..., false) turns "no staff row" into an explicit false rather than an
-- unknown, so `IF NOT has_staff_role(...)` raises as intended. A caller holding a
-- matching role still gets true, so no legitimate path changes.
CREATE OR REPLACE FUNCTION public.has_staff_role(needed text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(public.current_staff_role() = ANY(needed), false);
$$;

-- `current_staff_role` is how the app renders the signed-in role, and null is the
-- correct answer for an anonymous visitor. It stays callable by anon because it
-- can only ever report the caller's own role.
--
-- `has_staff_role` likewise stays callable: RLS policies evaluate it for
-- anonymous reads, and it now simply returns false. It is not a write path.
GRANT EXECUTE ON FUNCTION public.current_staff_role() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_staff_role(text[]) TO anon, authenticated;

--------------------------------------------------------------------------------
-- 2. Remove anonymous EXECUTE from every mutating RPC
--------------------------------------------------------------------------------
--
-- Matched by name rather than by signature: several of these functions were
-- redefined with different argument lists across migrations (apply_day_schedule
-- in particular), so a hardcoded signature list is a correctness trap. The loop
-- resolves every overload that currently exists and revokes each one.

DO $$
DECLARE
  target record;
  mutating text[] := ARRAY[
    -- creation flow
    'create_tournament_draft',
    'save_tournament_draft',
    'save_tournament_days',
    'save_tournament_categories',
    'tournament_readiness',
    'activate_tournament',
    'delete_tournament_draft',
    -- tournament + pool/draw generation
    'create_tournament',
    'apply_pool_generation',
    'apply_draw_generation',
    -- scheduling
    'apply_day_schedule',
    'shift_live_schedule_after_match',
    -- live scoring
    'report_pool_result',
    'report_draw_result',
    'reset_and_repair_match',
    'resolve_match_exception',
    'assert_match_eligible'
  ];
BEGIN
  FOR target IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.proname = ANY (mutating)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, PUBLIC', target.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', target.signature);
    RAISE NOTICE 'locked down %', target.signature;
  END LOOP;
END $$;
