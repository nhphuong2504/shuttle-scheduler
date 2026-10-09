-- ============================================================================
-- Editing a tournament's details after it has started
-- ============================================================================
--
-- `save_tournament_config` rewrites the whole configuration and is upcoming-only, which is
-- right for the events, the format and the rules: they cannot change under matches already
-- played. A tournament's *details* are different. Its name, venue, address, note and
-- organiser's contact do not alter any game, and a host who finds a typo in the venue on the
-- second day of the event needs to fix it then.
--
-- So this is a narrow writer for exactly those fields, open until the tournament is
-- completed. It is deliberately not a second way to change anything else: the payload is
-- read for the seven keys below and nothing more, the timezone is left to
-- `save_tournament_config` (and its guard under a schedule), and the window is
-- `update_tournament_window`'s.
--
-- "Until completed" is `assert_tournament_writable`: a completed tournament is writable
-- only by a platform admin, the same rule every other late edit follows.

CREATE OR REPLACE FUNCTION public.update_tournament_details(p_tournament_id uuid, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  PERFORM public.assert_tournament_writable(p_tournament_id);

  v_name := NULLIF(btrim(COALESCE(p_payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'A tournament needs a name';
  END IF;

  UPDATE public.tournaments SET
    name = v_name,
    -- Unlike a number, a note or a contact may be cleared, so an omitted key and an empty
    -- string both mean "none".
    notes = public.notes_trim(p_payload->>'notes'),
    venue_name = NULLIF(btrim(COALESCE(p_payload->>'venue_name', '')), ''),
    venue_address = NULLIF(btrim(COALESCE(p_payload->>'venue_address', '')), ''),
    organizer_name = NULLIF(btrim(COALESCE(p_payload->>'organizer_name', '')), ''),
    organizer_email = NULLIF(btrim(COALESCE(p_payload->>'organizer_email', '')), ''),
    organizer_phone = NULLIF(btrim(COALESCE(p_payload->>'organizer_phone', '')), '')
  WHERE id = p_tournament_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.update_tournament_details(uuid, jsonb) IS
  'Name, note, venue, address and organiser contact, for an owner, an editor or a platform admin, until the tournament is completed. Changes nothing that alters a game: events, format, rules, window and timezone have their own writers.';

REVOKE ALL ON FUNCTION public.update_tournament_details(uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.update_tournament_details(uuid, jsonb) TO authenticated;

DO $verify$
BEGIN
  IF has_function_privilege('anon', 'public.update_tournament_details(uuid, jsonb)', 'execute') THEN
    RAISE EXCEPTION 'M4: update_tournament_details must not be executable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.update_tournament_details(uuid, jsonb)', 'execute') THEN
    RAISE EXCEPTION 'M4: update_tournament_details must be executable by authenticated';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
