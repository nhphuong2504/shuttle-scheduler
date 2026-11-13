-- Preserve historical adult attestations; record teen permission separately.
BEGIN;

ALTER TABLE public.account_policy_acceptances
  ADD COLUMN age_band text,
  ADD COLUMN guardian_permission_confirmed boolean NOT NULL DEFAULT false;
UPDATE public.account_policy_acceptances SET age_band = '18_plus';
ALTER TABLE public.account_policy_acceptances
  ALTER COLUMN age_band SET NOT NULL,
  DROP CONSTRAINT account_policy_acceptances_adult_confirmed_check,
  ADD CONSTRAINT account_policy_acceptances_age_eligibility CHECK (
    (age_band = '18_plus' AND adult_confirmed AND NOT guardian_permission_confirmed)
    OR (age_band = '13_17' AND NOT adult_confirmed AND guardian_permission_confirmed)
  );

CREATE OR REPLACE FUNCTION public.record_pilot_signup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_age_band text := NEW.raw_user_meta_data->>'pilot_age_band';
  v_guardian_permission jsonb := NEW.raw_user_meta_data->'pilot_guardian_permission_confirmed';
BEGIN
  IF v_age_band IS NULL OR v_age_band NOT IN ('13_17', '18_plus')
     OR NEW.raw_user_meta_data->>'pilot_terms_version' IS DISTINCT FROM '2026-11-13-pilot-draft'
     OR (v_age_band = '13_17' AND v_guardian_permission IS DISTINCT FROM 'true'::jsonb)
     OR (v_age_band = '18_plus' AND v_guardian_permission IS DISTINCT FROM 'false'::jsonb) THEN
    RAISE EXCEPTION 'Age 13 or older, guardian permission for ages 13-17, and current pilot terms are required';
  END IF;
  INSERT INTO public.account_policy_acceptances
    (user_id, terms_version, adult_confirmed, age_band, guardian_permission_confirmed)
  VALUES
    (NEW.id, '2026-11-13-pilot-draft', v_age_band = '18_plus', v_age_band, v_age_band = '13_17');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.record_pilot_signup() FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.account_policy_acceptances.age_band IS
  'Self-reported signup age range; historical adult attestations retain 18_plus. Not verified age.';
COMMENT ON COLUMN public.account_policy_acceptances.guardian_permission_confirmed IS
  'Teen account holder states parental/guardian review and permission. Not verified parental consent.';

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
