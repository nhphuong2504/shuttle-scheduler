-- Keep staff_roles.user_id pointing at an identity that exists.
--
-- WHY THIS EXISTS
--
-- `link_staff_role()` (20260909233700) links a seeded staff row to an auth user when that
-- user is created. Its guard is deliberately narrow:
--
--   AND (user_id IS NULL OR user_id = NEW.id)
--
-- which refuses to re-point a row that is already linked. That guard is worth keeping: drop
-- it and anyone who signed up with a colleague's email would inherit that colleague's role.
--
-- The guard has a consequence, though. `staff_roles.user_id` has no foreign key to
-- `auth.users`, so deleting an identity leaves the column holding a uuid that no longer
-- exists. That value is neither NULL nor the new user's id, so a recreated identity with the
-- same email is never linked: the guard skips it, and nothing else will ever clear the
-- column, because `unique(email)` permits only the one row.
--
-- OBSERVED, NOT THEORISED
--
-- On production, the admin identity was deleted and recreated with the same email. The role
-- row was left pointing at the deleted uuid. Admin still resolved, because
-- `current_staff_role()` and the `staff_roles` policies fall back to matching
-- `normalize_email(auth.jwt() ->> 'email')` - the email is the durable key, which is why the
-- account was not locked out. But the row was stale, the fallback was doing the work, and the
-- INSERT trigger could no longer repair it.
--
-- Clearing `user_id` on delete restores the invariant the INSERT trigger's guard assumes: by
-- the time a new identity appears, the row is either unlinked or already pointing at it.
-- Delete, recreate, link. That is precisely the sequence recreating staff logins involves, so
-- the trap would otherwise be waiting at cutover.
--
-- WHY A TRIGGER AND NOT A FOREIGN KEY
--
-- A foreign key with `ON DELETE SET NULL` would state the same rule more strongly, and it is
-- the better end state. It cannot be added here: rows may already be dangling, so the
-- constraint would fail on existing data, and it would tie public-schema DDL to the auth
-- schema. This mirrors `link_staff_role()` instead, which is the shape already in use.
--
-- A note for whoever adds the foreign key later: run the repair first, then the constraint.
-- The update below is the repair, restricted to rows whose pointer is already dead.

CREATE OR REPLACE FUNCTION public.unlink_staff_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.staff_roles
     SET user_id = NULL
   WHERE user_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_deleted_unlink_staff ON auth.users;
CREATE TRIGGER on_auth_user_deleted_unlink_staff
AFTER DELETE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.unlink_staff_role();

-- Same treatment `link_staff_role()` gets in 20260910000115: a SECURITY DEFINER function is
-- not something anon or authenticated should be able to call directly. The trigger still
-- fires; EXECUTE is checked when the trigger is created, not when it fires.
REVOKE ALL ON FUNCTION public.unlink_staff_role() FROM anon, authenticated, public;
