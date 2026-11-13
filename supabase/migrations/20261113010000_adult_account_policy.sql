-- Account holders must be adults; tournament participation has no platform age floor.
-- Preserve previous acceptance evidence, including historical teen declarations.
BEGIN;

CREATE OR REPLACE FUNCTION public.record_pilot_signup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.raw_user_meta_data->'pilot_adult_confirmed' IS DISTINCT FROM 'true'::jsonb
     OR NEW.raw_user_meta_data->>'pilot_terms_version' IS DISTINCT FROM '2026-11-13-adult-pilot-draft'
     OR (NEW.raw_user_meta_data ? 'pilot_age_band'
         AND NEW.raw_user_meta_data->>'pilot_age_band' IS DISTINCT FROM '18_plus')
     OR (NEW.raw_user_meta_data ? 'pilot_guardian_permission_confirmed'
         AND NEW.raw_user_meta_data->'pilot_guardian_permission_confirmed' IS DISTINCT FROM 'false'::jsonb) THEN
    RAISE EXCEPTION 'Adult account acknowledgement and current pilot terms are required';
  END IF;
  INSERT INTO public.account_policy_acceptances
    (user_id, terms_version, adult_confirmed, age_band, guardian_permission_confirmed)
  VALUES (NEW.id, '2026-11-13-adult-pilot-draft', true, '18_plus', false);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.record_pilot_signup() FROM PUBLIC, anon, authenticated;

DO $verify$
BEGIN
  IF has_table_privilege('anon', 'public.account_policy_acceptances', 'SELECT')
     OR has_table_privilege('authenticated', 'public.account_policy_acceptances', 'INSERT')
     OR has_table_privilege('authenticated', 'public.account_policy_acceptances', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.account_policy_acceptances', 'DELETE')
     OR has_function_privilege('anon', 'public.record_pilot_signup()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_pilot_signup()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Policy acceptance security boundary changed';
  END IF;
END;
$verify$;
COMMIT;
