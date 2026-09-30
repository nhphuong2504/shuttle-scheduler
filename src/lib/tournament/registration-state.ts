/**
 * The registration window's vocabulary, as one word.
 *
 * The database decides this - `tournament_registration_state(p_tournament_id)` - and the
 * client only reads the answer. The client must not re-derive the rule from the two
 * timestamps: the RPC that accepts a submission consults the window, readiness and the
 * lifecycle in a particular order, and a browser that answered the question with its own
 * clock and its own idea of readiness would disagree with it in exactly the cases a person
 * complains about ("the button was green and it refused me").
 *
 * So the union here is a mirror, and the labels are the only thing this file owns.
 */
export type RegistrationState =
  | "not_offered"
  | "not_ready"
  | "opens_soon"
  | "open"
  | "closed"
  | "started"
  | "completed";

export const REGISTRATION_STATES: readonly RegistrationState[] = [
  "not_offered",
  "not_ready",
  "opens_soon",
  "open",
  "closed",
  "started",
  "completed",
] as const;

/**
 * An unrecognised answer reads as `not_offered`.
 *
 * The safe direction is "this tournament is not taking requests": a value nobody planned
 * for must not render as an open invitation to register, because the failure that produces
 * is a participant filling in a form that the server will refuse.
 */
export function normalizeRegistrationState(value: unknown): RegistrationState {
  return typeof value === "string" && (REGISTRATION_STATES as readonly string[]).includes(value)
    ? (value as RegistrationState)
    : "not_offered";
}

/** Whether a request may be submitted right now. One branch, so it cannot disagree with a label. */
export function isRegistrationOpen(state: RegistrationState): boolean {
  return state === "open";
}

/** The one word for the window, and the only place these strings exist. */
export function registrationStateLabel(state: RegistrationState): string {
  switch (state) {
    case "not_offered":
      return "Not offered";
    case "not_ready":
      return "Not ready";
    case "opens_soon":
      return "Opens soon";
    case "open":
      return "Open";
    case "closed":
      return "Closed";
    case "started":
      return "Started";
    case "completed":
      return "Completed";
  }
}

/**
 * What a submitted request's own state is, as one word.
 *
 * A different question from the window's: `RegistrationState` is "may I ask", and this is
 * "what did they say". The two are separate vocabularies because a window can close while a
 * request is still awaiting a decision, and one word cannot answer both without lying about
 * one of them.
 *
 * `pending` is the safe fallback an unrecognised answer reads as, on the same reasoning as
 * the window's `not_offered`: it must not render as a decision that was never taken. A
 * request the browser believes is approved while the database has decided nothing is the one
 * wrong direction, because it tells the person they are in the draw when they are not.
 */
export type RegistrationDecision = "pending" | "approved" | "rejected";

export const REGISTRATION_DECISIONS: readonly RegistrationDecision[] = [
  "pending",
  "approved",
  "rejected",
] as const;

export function normalizeRegistrationDecision(value: unknown): RegistrationDecision {
  return typeof value === "string" && (REGISTRATION_DECISIONS as readonly string[]).includes(value)
    ? (value as RegistrationDecision)
    : "pending";
}

/** The one word for a request's state, and the only place these strings exist. */
export function registrationDecisionLabel(d: RegistrationDecision): string {
  switch (d) {
    case "pending":
      return "Awaiting decision";
    case "approved":
      return "Approved";
    case "rejected":
      return "Not accepted";
  }
}

/**
 * What the decision means for the person reading it.
 *
 * `rejected` is deliberately not called "rejected" on screen. The host decides; the
 * participant is told the outcome as a fact about their request rather than as a verdict
 * on them, and the note the host wrote is what carries the reason.
 */
export function registrationDecisionHint(d: RegistrationDecision): string {
  switch (d) {
    case "pending":
      return "Your request is with the tournament organisers. You can withdraw it while they decide.";
    case "approved":
      return "You are in. The organiser will place you in the draw.";
    case "rejected":
      return "This request was not accepted. You can ask again with different events.";
  }
}

/**
 * What the word means for the person reading it.
 *
 * `not_ready` deliberately does not say what is missing: readiness is an editor's
 * checklist, and a participant told "no playing days configured" learns a detail about the
 * host's setup that is none of their business. The host sees the detail on the review step.
 */
export function registrationStateHint(state: RegistrationState): string {
  switch (state) {
    case "not_offered":
      return "This tournament is not taking registration requests.";
    case "not_ready":
      return "Registration has not opened yet.";
    case "opens_soon":
      return "Registration opens soon.";
    case "open":
      return "Registration is open.";
    case "closed":
      return "Registration has closed.";
    case "started":
      return "This tournament has already started.";
    case "completed":
      return "This tournament has finished.";
  }
}
