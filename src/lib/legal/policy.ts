/** Keep in sync with the append-only signup guard migration. */
export const PILOT_TERMS_VERSION = "2026-11-11-pilot-draft";
export const OPERATOR_NAME = "Phuong Nguyen";
export const SUPPORT_EMAIL = "nhphuong@iastate.edu";

export function pilotSignupMetadata() {
  return { pilot_adult_confirmed: true, pilot_terms_version: PILOT_TERMS_VERSION };
}
