-- All new identities, including recovered accounts, require an acknowledgement.
-- Do not create an exception for privileged provisioning or fabricate assent.
BEGIN;
CREATE OR REPLACE FUNCTION public.record_pilot_signup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
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
COMMIT;
