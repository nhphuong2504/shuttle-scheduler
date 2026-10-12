import type { TournamentStatus } from "@/lib/auth/authorization";

/**
 * Where a tournament is, in the words a person uses: its stored status read against the clock.
 *
 * The status is three words and only ever moves because somebody did something - the first
 * match was started, the host pressed Complete. The clock keeps going regardless, so a stored
 * status can sit behind it: a tournament whose first day has begun with no match started is
 * still `upcoming`, and one past its last day is still `in_progress` until its host completes
 * it. This says so, without changing a thing. A phase is only ever a label and a reminder;
 * nothing here, and nothing that reads it, moves a tournament.
 *
 *   upcoming        created, and its first day has not come
 *   starts_today    the tournament window opens within the last 24 hours
 *   live            in progress, within its playing days
 *   not_started     upcoming, but its first playing day has begun and no match has started
 *   past_last_day   in progress, but its last playing day has ended and it is not completed
 *   completed       the host has completed it
 *
 * ## Two sets of dates, two anchors
 *
 * The *window* is what the tournament promised the public, and the *playing days* are the ones
 * it actually plays. "Starts today" is about the promise. "Not started" and "past its last day"
 * are about the plan, because a window of 20-30 October played only on the 25th is not late on
 * the 20th. So the reminders use the first and last playing day when there are any, and the
 * window only when there are none.
 *
 * "Today" needs no timezone: the window's start is the instant 00:00 at the venue, so "within
 * 24 hours of it" is a plain comparison of instants.
 */
export type TournamentPhase =
  | "upcoming"
  | "starts_today"
  | "live"
  | "not_started"
  | "past_last_day"
  | "completed";

export interface PhaseInput {
  status: TournamentStatus;
  /** The tournament window as instants: 00:00 of its first date, and 00:00 after its last. */
  starts_at: string | null;
  ends_at: string | null;
  /** The first and last playing day as instants, or null until playing days are chosen. */
  play_starts_at?: string | null | undefined;
  play_ends_at?: string | null | undefined;
}

const DAY = 86_400_000;

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

export function tournamentPhase(input: PhaseInput, now: Date = new Date()): TournamentPhase {
  const at = now.getTime();

  if (input.status === "completed") return "completed";

  if (input.status === "in_progress") {
    const last = ms(input.play_ends_at) ?? ms(input.ends_at);
    return last !== null && at >= last ? "past_last_day" : "live";
  }

  const first = ms(input.play_starts_at) ?? ms(input.starts_at);
  if (first !== null && at >= first) return "not_started";

  const opens = ms(input.starts_at);
  if (opens !== null && at >= opens && at < opens + DAY) return "starts_today";

  return "upcoming";
}

const LABELS: Record<TournamentPhase, string> = {
  upcoming: "Upcoming",
  starts_today: "Starts today",
  live: "Live",
  not_started: "Not started",
  past_last_day: "Past its last day",
  completed: "Completed",
};

/** The word for a phase. The one place these are spelled, so no surface words one differently. */
export function phaseLabel(phase: TournamentPhase): string {
  return LABELS[phase];
}

/** A phase that is a reminder for the host rather than a plain fact, and is drawn as one. */
export function isReminderPhase(phase: TournamentPhase): boolean {
  return phase === "not_started" || phase === "past_last_day";
}

/** What the reminder asks of the host, in a sentence, or null for a phase that asks nothing. */
export function phaseReminder(phase: TournamentPhase, name: string): string | null {
  switch (phase) {
    case "not_started":
      return `${name} was due to start, but no match has been started yet.`;
    case "past_last_day":
      return `${name} has finished its last day. Complete it to publish the results.`;
    default:
      return null;
  }
}
