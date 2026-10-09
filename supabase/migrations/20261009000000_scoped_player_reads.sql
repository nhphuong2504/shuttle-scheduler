-- The player roster is no longer readable as a whole.
--
-- WHY
--
-- `players` is the one global table: no `tournament_id`, one row per person ever entered or added at
-- a desk. `public_players` (`20260927000000`) is a definer view over it that `anon` and
-- `authenticated` could both `SELECT`, and the app read all of it on every page - so the Entries
-- screen reported the whole roster as "Players" (384, for a tournament of fifty), every other page
-- downloaded it to look up a few names, and anybody on the internet could list the name and gender
-- of everyone who had ever played in any tournament on the platform.
--
-- What a screen actually needs is one of two things, and each now has a call that answers exactly
-- it:
--
--   tournament_players(tournament)       the people who have an entry in THIS tournament. Public, as
--                                        the entries themselves are: `teams` is publicly readable,
--                                        so the names of the people on them were never private.
--   search_players(tournament, text)     the global roster, one match at a time, for the desk picking
--                                        a person to enter. Editors of that tournament only.
--
-- and creating a walk-in returns the new id (`add_walk_in_player`), which the table insert cannot:
-- `RETURNING` is checked against the `SELECT` policy and a fresh walk-in has no entry yet, so the
-- screens had to re-read the roster to find the person they had just created.
--
-- With those in place the view's grants are withdrawn. The view itself stays, for the definer
-- functions that read the table directly and for anything that wants to re-grant it deliberately.
--
-- NOT CHANGED: `players` itself (RLS, column grants, the link guard) and `can_add_walk_in_player()`,
-- which is still the create-side predicate. Participants and the registration flow never read the
-- roster, so nothing on that path moves.

-------------------------------------------------------------------------------
-- 1. The people in one tournament
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tournament_players(p_tournament_id uuid)
RETURNS TABLE (id uuid, name text, gender text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT p.id, p.name, p.gender
  FROM public.teams t
  JOIN public.players p ON p.id IN (t.player_1_id, t.player_2_id)
  WHERE t.tournament_id = p_tournament_id
  ORDER BY p.name, p.id;
$$;

REVOKE ALL ON FUNCTION public.tournament_players(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tournament_players(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.tournament_players(uuid) IS
  'Id, name and gender of everyone with a team row in the tournament, withdrawn included. Public, like teams itself; carries no email, phone or link.';

-------------------------------------------------------------------------------
-- 2. Finding a person to enter
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.search_players(
  p_tournament_id uuid,
  p_query text,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (id uuid, name text, gender text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_query text := btrim(COALESCE(p_query, ''));
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Two characters or more: a single letter matches a third of the roster and is a listing, not a
  -- search. The caller gets an empty answer rather than an error, so a half-typed box is quiet.
  IF char_length(v_query) < 2 THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.id, p.name, p.gender
  FROM public.players p
  -- `%`, `_` and the escape character are literal in what somebody types.
  WHERE p.name ILIKE '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  ORDER BY p.name, p.id
  LIMIT least(greatest(COALESCE(p_limit, 20), 1), 50);
END;
$$;

REVOKE ALL ON FUNCTION public.search_players(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_players(uuid, text, integer) TO authenticated;

COMMENT ON FUNCTION public.search_players(uuid, text, integer) IS
  'Name search over the global roster for the desk adding an entry. Editors of the tournament only; at least two characters; at most 50 rows.';

-------------------------------------------------------------------------------
-- 3. Creating a walk-in, and getting its id back
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_walk_in_player(
  p_name text,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_gender text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.can_add_walk_in_player() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF btrim(COALESCE(p_name, '')) = '' THEN
    RAISE EXCEPTION 'A player needs a name';
  END IF;

  -- `profile_id` is not a parameter and is left NULL: a walk-in has no account, and the link is made
  -- only by approving a registration request.
  INSERT INTO public.players (name, email, phone, gender)
  VALUES (
    btrim(p_name),
    NULLIF(btrim(COALESCE(p_email, '')), ''),
    NULLIF(btrim(COALESCE(p_phone, '')), ''),
    NULLIF(btrim(COALESCE(p_gender, '')), '')
  )
  RETURNING players.id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.add_walk_in_player(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_walk_in_player(text, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.add_walk_in_player(text, text, text, text) IS
  'Adds an unlinked person to the global roster and returns the new id. The create side is can_add_walk_in_player(); the direct table insert still works but cannot return the row it made.';

-------------------------------------------------------------------------------
-- 4. Close the roster
-------------------------------------------------------------------------------

REVOKE SELECT ON public.public_players FROM anon, authenticated;

COMMENT ON VIEW public.public_players IS
  'id, name, gender, created_at over players, excluding email, phone and the profile link. NOT granted to anon or authenticated: read people through tournament_players(uuid) and search_players(uuid, text, integer).';

-------------------------------------------------------------------------------
-- Verify
-------------------------------------------------------------------------------

DO $verify$
BEGIN
  IF has_table_privilege('anon', 'public.public_players', 'SELECT')
     OR has_table_privilege('authenticated', 'public.public_players', 'SELECT') THEN
    RAISE EXCEPTION 'players: public_players is still readable';
  END IF;
  IF NOT has_function_privilege('anon', 'public.tournament_players(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'players: tournament_players must stay public';
  END IF;
  IF has_function_privilege('anon', 'public.search_players(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.add_walk_in_player(text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'players: search_players and add_walk_in_player must not be callable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.search_players(uuid, text, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.add_walk_in_player(text, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'players: search_players and add_walk_in_player must be callable by authenticated';
  END IF;
END
$verify$;
