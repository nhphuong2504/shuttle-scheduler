/** Keep in sync with the append-only signup guard migration. */
export const PILOT_TERMS_VERSION = "2026-11-11-pilot-draft";
/** Shown on every policy page; bump whenever policy wording changes. */
export const POLICY_UPDATED = "November 11, 2026";
export const OPERATOR_NAME = "Phuong Nguyen";
export const SUPPORT_EMAIL = "support@tournova.app";

export function pilotSignupMetadata() {
  return { pilot_adult_confirmed: true, pilot_terms_version: PILOT_TERMS_VERSION };
}
