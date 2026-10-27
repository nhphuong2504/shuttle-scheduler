/** Cache identities are unchanged so queue badges and review pages share a fetch. */
export const registrationKeys = {
  registrationState: ["registration_state"] as const,
  myRegistration: ["my_registration"] as const,
  registrationQueue: ["registration_queue"] as const,
};

export function registrationKey(base: readonly unknown[], tournamentId: string | null | undefined) {
  return [...base, tournamentId ?? null];
}
