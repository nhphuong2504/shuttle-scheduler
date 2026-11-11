-- Pilot defaults: no age inference, no public real names for real events.
-- Existing accounts/data are preserved. Service-provisioned identities are not
-- represented as having personally accepted terms; review them before pilot access.
BEGIN;

CREATE TABLE public.account_policy_acceptances (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  terms_version text NOT NULL,
  adult_confirmed boolean NOT NULL CHECK (adult_confirmed),
  accepted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.account_policy_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_policy_acceptances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_policy_acceptances TO authenticated;
GRANT ALL ON public.account_policy_acceptances TO service_role;
CREATE POLICY "read own policy acceptance" ON public.account_policy_acceptances
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE FUNCTION public.record_pilot_signup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Only the privileged Auth admin API can set raw_app_meta_data. Never trust
  -- a similarly named value inside editable raw_user_meta_data for this exception.
  IF NEW.raw_app_meta_data->>'pilot_provisioned' = 'true' THEN
    RETURN NEW;
  END IF;
  IF NEW.raw_user_meta_data->'pilot_adult_confirmed' IS DISTINCT FROM 'true'::jsonb
     OR NEW.raw_user_meta_data->>'pilot_terms_version' IS DISTINCT FROM '2026-11-11-pilot-draft' THEN
    RAISE EXCEPTION 'Adult account acknowledgement and current pilot terms are required';
  END IF;
  INSERT INTO public.account_policy_acceptances (user_id, terms_version, adult_confirmed)
    VALUES (NEW.id, '2026-11-11-pilot-draft', true);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.record_pilot_signup() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER on_auth_user_created_pilot_policy
  AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.record_pilot_signup();

CREATE OR REPLACE FUNCTION public.tournament_players(p_tournament_id uuid)
RETURNS TABLE (id uuid, name text, gender text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT p.id,
    CASE WHEN public.can_edit_tournament(p_tournament_id) OR tmt.is_demo
      THEN p.name ELSE 'Player ' || left(p.id::text, 8) END AS name,
    CASE WHEN public.can_edit_tournament(p_tournament_id) OR tmt.is_demo
      THEN p.gender ELSE NULL::text END AS gender
  FROM public.teams t
  JOIN public.tournaments tmt ON tmt.id = t.tournament_id
  JOIN public.players p ON p.id IN (t.player_1_id, t.player_2_id)
  WHERE t.tournament_id = p_tournament_id
  ORDER BY name, p.id;
$$;
REVOKE ALL ON FUNCTION public.tournament_players(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tournament_players(uuid) TO anon, authenticated;
COMMENT ON FUNCTION public.tournament_players(uuid) IS
  'Tournament-scoped players including withdrawn. Real names/gender only for its operators; generated labels and no gender for other readers. Demo events retain fictional names. IDs/participation remain public, not anonymous.';

CREATE OR REPLACE FUNCTION public.search_players(
  p_tournament_id uuid, p_query text, p_limit integer DEFAULT 20
)
RETURNS TABLE (id uuid, name text, gender text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_query text := btrim(COALESCE(p_query, ''));
BEGIN
  IF NOT public.can_edit_tournament(p_tournament_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF char_length(v_query) < 2 THEN RETURN; END IF;
  RETURN QUERY
  SELECT p.id, p.name, p.gender FROM public.players p
  WHERE NOT p.is_demo
    AND EXISTS (SELECT 1 FROM public.teams t WHERE t.tournament_id = p_tournament_id
      AND p.id IN (t.player_1_id, t.player_2_id))
    AND p.name ILIKE '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  ORDER BY p.name, p.id
  LIMIT least(greatest(COALESCE(p_limit, 20), 1), 50);
END;
$$;
REVOKE ALL ON FUNCTION public.search_players(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_players(uuid, text, integer) TO authenticated;
COMMENT ON FUNCTION public.search_players(uuid, text, integer) IS
  'Editor-only search within the specified tournament entries. Does not discover people from other tournaments or unentered walk-ins; excludes demo people.';

DO $verify$
BEGIN
  IF has_table_privilege('anon', 'public.account_policy_acceptances', 'SELECT')
     OR has_table_privilege('authenticated', 'public.account_policy_acceptances', 'INSERT')
     OR has_table_privilege('authenticated', 'public.account_policy_acceptances', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.account_policy_acceptances', 'DELETE') THEN
    RAISE EXCEPTION 'Policy acceptance privileges are too broad';
  END IF;
  IF has_function_privilege('anon', 'public.record_pilot_signup()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_pilot_signup()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Signup trigger must not be directly callable';
  END IF;
END;
$verify$;
COMMIT;
