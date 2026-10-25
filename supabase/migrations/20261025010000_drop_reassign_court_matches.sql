-- Drop `reassign_court_matches`: a court failure is not handled as its own act.
--
-- The function (`20261022040000_mid_tournament_changes.sql`, section 4) moved one day's unstarted
-- matches off a failed court onto another, and refused whenever the target court had anything
-- scheduled that day. A venue with every court in use - Viet Nam Open 2026 used all eight on both days -
-- never has such a court, so it could not be used where it was needed; and no surface ever called it.
-- The organiser's way out of a failed court is the Schedule page: remove the court from the day and
-- review a rebuild. Nothing applied is edited.

DROP FUNCTION IF EXISTS public.reassign_court_matches(uuid, uuid, uuid, uuid);

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'reassign_court_matches'
  ) THEN
    RAISE EXCEPTION 'reassign_court_matches is still defined';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
