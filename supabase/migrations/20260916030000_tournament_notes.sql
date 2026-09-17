-- ============================================================================
-- Free-text notes on a tournament
-- ============================================================================
--
-- A public-facing note about the event: parking, warm-up times, kit to bring, a
-- late change to the running order. It is shown on the control desk, which every
-- role uses, so it is written for anyone to read rather than being a private
-- scratchpad. Note that `tournaments` already has a public read policy, so the
-- text is readable by anyone who can read the tournament at all.
--
-- Both draft RPCs are redefined because both write this field and both whitelist
-- their payload keys: `create_tournament_draft` inserts it, and `save_tournament_draft`
-- updates it. The first step of the wizard creates the draft directly and never
-- calls the save path, so a note typed on the Basics step would be lost if only
-- the save RPC knew about it.

ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS notes text;

-- 2000 characters is a note, not a document. The app enforces the same limit, so
-- this only ever catches a caller going around the UI.
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_notes_length_check;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_notes_length_check
  CHECK (notes IS NULL OR char_length(notes) <= 2000);

-- `btrim(x)` trims spaces only, which is fine for the single-line fields above
-- but wrong here: a note is multi-line, so a box containing just a newline would
-- otherwise be stored as "\n" instead of being treated as empty.
-- `public.notes_trim` is that trim, named once so the three writers cannot drift.
CREATE OR REPLACE FUNCTION public.notes_trim(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(btrim(COALESCE(p_value, ''), E' \t\n\r\f\v'), '');
$$;

-- Only the two draft RPCs call this, and they do so as their definer, so nobody
-- else needs it. Revoking PUBLIC is what keeps anon out, as with every new
-- function; the grant to authenticated is belt-and-braces, not a requirement.
REVOKE ALL ON FUNCTION public.notes_trim(text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.notes_trim(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- create_tournament_draft: carry notes through the insert
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_tournament_draft(p_payload jsonb)
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
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
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
    name, status, format, is_active, notes,
    venue_name, venue_address, venue_timezone,
    organizer_name, organizer_email, organizer_phone
  )
  VALUES (
    v_name, 'draft', v_format, false, v_notes,
    NULLIF(btrim(COALESCE(p_payload->>'venue_name', '')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'venue_address', '')), ''),
    COALESCE(NULLIF(btrim(COALESCE(p_payload->>'venue_timezone', '')), ''), 'America/Chicago'),
    NULLIF(btrim(COALESCE(p_payload->>'organizer_name', '')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'organizer_email', '')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'organizer_phone', '')), '')
  )
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- save_tournament_draft: same, for the update path
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_tournament_draft(
  p_tournament_id uuid,
  p_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_name text;
  v_tz text;
  v_format text;
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT status INTO v_status FROM public.tournaments WHERE id = p_tournament_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'This tournament is no longer a draft';
  END IF;

  v_name := NULLIF(btrim(COALESCE(p_payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'A tournament needs a name';
  END IF;

  v_format := COALESCE(NULLIF(p_payload->>'format', ''), 'two_round_placement');
  IF v_format NOT IN ('round_robin', 'two_round_placement') THEN
    RAISE EXCEPTION 'Unsupported competition format';
  END IF;

  v_tz := COALESCE(NULLIF(btrim(COALESCE(p_payload->>'venue_timezone', '')), ''), 'America/Chicago');
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    RAISE EXCEPTION 'Unknown timezone: %', v_tz;
  END IF;

  IF (p_payload ? 'max_categories_per_player') THEN
    IF (p_payload->>'max_categories_per_player')::int NOT BETWEEN 1 AND 5 THEN
      RAISE EXCEPTION 'The category cap must be between 1 and 5';
    END IF;
  END IF;

  IF (p_payload ? 'knockout_best_of')
     AND (p_payload->>'knockout_best_of')::int NOT IN (1, 3, 5, 7, 9) THEN
    RAISE EXCEPTION 'A knockout match is a single game or an odd best of 3, 5, 7 or 9';
  END IF;
  IF (p_payload ? 'placement_best_of')
     AND (p_payload->>'placement_best_of')::int NOT IN (1, 3, 5, 7, 9) THEN
    RAISE EXCEPTION 'A placement match is a single game or an odd best of 3, 5, 7 or 9';
  END IF;

  UPDATE public.tournaments SET
    name = v_name,
    format = v_format,
    -- Unlike the numeric fields, notes may be cleared, so an omitted key and an
    -- empty string both mean "no note" rather than "leave it alone".
    notes = public.notes_trim(p_payload->>'notes'),
    venue_name = NULLIF(btrim(COALESCE(p_payload->>'venue_name', '')), ''),
    venue_address = NULLIF(btrim(COALESCE(p_payload->>'venue_address', '')), ''),
    venue_timezone = v_tz,
    organizer_name = NULLIF(btrim(COALESCE(p_payload->>'organizer_name', '')), ''),
    organizer_email = NULLIF(btrim(COALESCE(p_payload->>'organizer_email', '')), ''),
    organizer_phone = NULLIF(btrim(COALESCE(p_payload->>'organizer_phone', '')), ''),
    max_categories_per_player = COALESCE(
      (p_payload->>'max_categories_per_player')::int, max_categories_per_player
    ),
    placement_games_to = COALESCE((p_payload->>'placement_games_to')::int, placement_games_to),
    placement_win_by = COALESCE((p_payload->>'placement_win_by')::int, placement_win_by),
    placement_best_of = COALESCE((p_payload->>'placement_best_of')::int, placement_best_of),
    knockout_games_to = COALESCE((p_payload->>'knockout_games_to')::int, knockout_games_to),
    knockout_win_by = COALESCE((p_payload->>'knockout_win_by')::int, knockout_win_by),
    knockout_best_of = COALESCE((p_payload->>'knockout_best_of')::int, knockout_best_of),
    group_slot_minutes = COALESCE((p_payload->>'group_slot_minutes')::int, group_slot_minutes),
    knockout_slot_minutes = COALESCE(
      (p_payload->>'knockout_slot_minutes')::int, knockout_slot_minutes
    ),
    group_rest_gap_minutes = COALESCE(
      (p_payload->>'group_rest_gap_minutes')::int, group_rest_gap_minutes
    ),
    knockout_rest_gap_minutes = COALESCE(
      (p_payload->>'knockout_rest_gap_minutes')::int, knockout_rest_gap_minutes
    )
  WHERE id = p_tournament_id;
END;
$$;

-- CREATE OR REPLACE keeps the function's OID, and therefore its existing ACL, so
-- the hardening revokes still hold and these redefinitions cannot reopen access
-- to anon. Re-granting is harmless and keeps this readable on its own.
GRANT EXECUTE ON FUNCTION public.create_tournament_draft(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_tournament_draft(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- Editing the note after activation
-- ---------------------------------------------------------------------------
--
-- The draft save path deliberately refuses anything that is not a Draft, because
-- most of what it writes is structure that a running event must not have moved
-- underneath it. The note is different: it exists to carry news, and news does not
-- wait for a draft. Late arrivals, a court taken out of service, a changed warm-up
-- time — all of that is worth saying mid-event, so it gets its own RPC with no
-- status guard.
--
-- Everything else about the tournament stays frozen; this writes one column.
CREATE OR REPLACE FUNCTION public.set_tournament_notes(
  p_tournament_id uuid,
  p_notes text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_staff_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tournaments WHERE id = p_tournament_id) THEN
    RAISE EXCEPTION 'Unknown tournament';
  END IF;

  -- The 2000 character check constraint on the column is the real limit and will
  -- raise its own error if this is exceeded.
  UPDATE public.tournaments
  SET notes = public.notes_trim(p_notes)
  WHERE id = p_tournament_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_tournament_notes(uuid, text) FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_tournament_notes(uuid, text) TO authenticated;
