-- ---------------------------------------------------------------------------
-- Close the two placement helper functions to `anon`.
--
-- `20260917010000_placement_stage_rpcs.sql` states that every function it creates
-- repeats its own `REVOKE ... FROM anon, PUBLIC`, because `CREATE FUNCTION` grants
-- EXECUTE to PUBLIC by default. Two of them did not: the read-only helpers
-- `placement_required_matches` and `placement_decided_matches`. They therefore
-- kept the default PUBLIC grant, and a probe against the deployed database
-- confirmed it — `placement_required_matches` answered an unauthenticated call
-- with HTTP 200 while every other function in that file correctly answered 401.
--
-- This is NOT a data leak, and it is worth being precise about why:
--
--   * Both helpers are `LANGUAGE sql` and NOT `SECURITY DEFINER`, so they run with
--     the caller's rights and are bound by the RLS policies on the tables they
--     read.
--   * Those policies (`placement_entrants public read`, `placement_matches public
--     read`) are `USING (true)` and explicitly `GRANT SELECT ... TO anon`, because
--     the desk has a read-only unauthenticated view. An anonymous caller could
--     already read the same rows directly.
--
-- So what this migration fixes is consistency with the stated gating, not a
-- security hole: someone auditing the surface by reading that header comment
-- would otherwise be auditing the wrong set of functions.
--
-- Safe to apply: neither helper is reachable from the client. The TypeScript
-- engine recomputes both numbers in `placement.ts`, and the only real callers are
-- the `SECURITY DEFINER` functions in the same file, which resolve the call with
-- the owner's rights and are unaffected by this revoke.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.placement_required_matches(uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.placement_required_matches(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.placement_decided_matches(uuid, uuid) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.placement_decided_matches(uuid, uuid) TO authenticated;
