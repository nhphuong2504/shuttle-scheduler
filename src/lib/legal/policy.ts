/** Keep in sync with the append-only signup guard migration. */
export const PILOT_TERMS_VERSION = "1.0";
/** Shown on every policy page; bump whenever policy wording changes. */
export const POLICY_UPDATED = "November 13, 2026";
/** Public service name; this does not assert a registered legal entity. */
export const SERVICE_NAME = "Tournova";
export const SUPPORT_EMAIL = "support@tournova.app";

export function pilotSignupMetadata() {
  return {
    pilot_adult_confirmed: true,
    pilot_terms_version: PILOT_TERMS_VERSION,
  };
}
