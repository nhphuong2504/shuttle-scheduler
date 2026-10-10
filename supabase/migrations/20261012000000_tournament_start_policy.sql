-- ============================================================================
-- The "block a start on short rest" switch, while the tournament runs
-- ============================================================================
--
-- `tournaments.block_start_on_short_rest` (20261010000000) makes the server refuse to start a
-- match when one of its players has not had their full rest. It defaults off, so the desk warns
-- and the moderator decides; a tournament that wants it enforced turns it on.
--
-- That switch is an on-the-day policy, not a detail of the event, so it cannot ride in
-- `update_tournament_details`. That writer's contract is "a detail that changes nothing about a
-- game", its seven-column list is pinned by `db-invariants.test.ts`, and its form is the setup
-- wizard's. The switch changes how a match may start, and it has to stay usable while the
-- tournament is playing - the exact state in which the wizard's configuration steps are frozen.
--
-- So this is a writer for exactly one column, open until the tournament is completed, for the
-- same people who may edit the details: the owner, an editor, or a platform admin. It is
-- deliberately not a second way to change anything else - the payload is a single boolean and no
-- other column is named.
--
-- "Until completed" is `assert_tournament_writable`: a completed tournament is writable only by
-- a platform admin, the same rule every other late edit follows.

CREATE OR REPLACE FUNCTION public.set_tournament_start_policy(
  p_tournament_id uuid,
  p_block_start_on_short_rest boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

  -- A missing value is not "off". The flag decides whether a start is refused, so an absent
  -- answer is refused rather than silently taken as the permissive default.
  IF p_block_start_on_short_rest IS NULL THEN
    RAISE EXCEPTION 'A start policy needs a value';
  END IF;

  UPDATE public.tournaments SET
  block_start_on_short_rest = p_block_start_on_short_rest
  WHERE id = p_tournament_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.set_tournament_start_policy(uuid, boolean) IS
  'Whether the server refuses to start a match when a player is short of rest, for an owner, an editor or a platform admin, until the tournament is completed. Writes tournaments.block_start_on_short_rest and nothing else.';

REVOKE ALL ON FUNCTION public.set_tournament_start_policy(uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_tournament_start_policy(uuid, boolean) TO authenticated;

DO $verify$
BEGIN
  -- Exactly one signature, so a later edit cannot leave an overload behind and make PostgREST
  -- unable to choose between two candidates.
  IF (
    SELECT count(*)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'set_tournament_start_policy'
  ) <> 1 THEN
    RAISE EXCEPTION 'M7: set_tournament_start_policy must exist exactly once';
  END IF;

  IF to_regprocedure(
    'public.set_tournament_start_policy(uuid, boolean)'
  ) IS NULL THEN
    RAISE EXCEPTION 'M7: set_tournament_start_policy has the wrong signature';
  END IF;

  -- Both guards, and the one column.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'set_tournament_start_policy'
      AND p.prosrc LIKE '%can_edit_tournament%'
      AND p.prosrc LIKE '%assert_tournament_writable(%'
      AND p.prosrc LIKE '%block_start_on_short_rest%'
  ) THEN
    RAISE EXCEPTION 'M7: set_tournament_start_policy is missing a guard or the column it writes';
  END IF;

  IF has_function_privilege('anon', 'public.set_tournament_start_policy(uuid, boolean)', 'execute') THEN
    RAISE EXCEPTION 'M7: set_tournament_start_policy must not be executable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.set_tournament_start_policy(uuid, boolean)', 'execute') THEN
    RAISE EXCEPTION 'M7: set_tournament_start_policy must be executable by authenticated';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
