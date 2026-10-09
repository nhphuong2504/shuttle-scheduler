import { isValidTimeZone, nowInZone } from "@/lib/tournament/zoned-time";
import { shiftIsoDate, type DraftForm, type SetupStep } from "./types";

/**
 * What is wrong with the form, step by step. The database re-validates everything; this is
 * what lets a host be told before a round trip, and it is the same list the review step
 * draws as its checks, so what the rail marks, what the step says and what Review lists
 * cannot disagree.
 */

const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** The end of the day before the tournament starts: the last moment registration may run. */
export function suggestedRegistrationClose(startsOn: string): string {
  const before = startsOn ? shiftIsoDate(startsOn, -1) : "";
  return before ? `${before}T23:59` : "";
}

/**
 * The registration window with its blanks filled: an empty opening time means "as soon as the
 * tournament exists" (now, at the venue), and an empty closing time means the suggestion.
 */
export function effectiveRegistration(
  form: DraftForm,
  now: Date = new Date(),
): { opensAt: string; closesAt: string } {
  const zone = form.basics.venueTimezone;
  return {
    opensAt: form.registration.opensAt || (isValidTimeZone(zone) ? (nowInZone(zone, now) ?? "") : ""),
    closesAt: form.registration.closesAt || suggestedRegistrationClose(form.startsOn),
  };
}

/** Problems with the registration window, or none when registration is switched off. */
export function registrationProblems(form: DraftForm, now: Date = new Date()): string[] {
  if (!form.registration.enabled) return [];
  const { opensAt, closesAt } = effectiveRegistration(form, now);
  const issues: string[] = [];
  if (!WALL_CLOCK.test(opensAt)) issues.push("Choose when registration opens.");
  if (!WALL_CLOCK.test(closesAt)) issues.push("Choose when registration closes.");
  if (issues.length) return issues;
  if (opensAt >= closesAt) issues.push("Registration must close after it opens.");
  if (form.startsOn && closesAt > `${form.startsOn}T00:00`) {
    issues.push(
      `Registration must close before the tournament starts (${form.startsOn}, 00:00).`,
    );
  }
  return issues;
}

export interface LocalCheck {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

/** Whether the name, timezone and window are usable. */
function detailsProblems(form: DraftForm): { name: string | null; zone: string | null; window: string | null } {
  return {
    name: form.basics.name.trim() ? null : "Give the tournament a name.",
    zone: isValidTimeZone(form.basics.venueTimezone.trim()) ? null : "Choose a timezone.",
    window: !form.startsOn
      ? "Pick the first day."
      : !form.endsOn
        ? "Pick the last day."
        : form.endsOn < form.startsOn
          ? "The tournament cannot end before it starts."
          : null,
  };
}

/** Client-side checks per step. */
export function problemsForStep(step: SetupStep, form: DraftForm, now: Date = new Date()): string[] {
  const issues: string[] = [];

  if (step === "details") {
    const found = detailsProblems(form);
    for (const issue of [found.name, found.zone, found.window]) if (issue) issues.push(issue);
    return issues;
  }

  if (step === "events") {
    if (form.events.length === 0) issues.push("Add at least one event.");
    const codes = form.events.map((event) => event.code);
    if (new Set(codes).size !== codes.length) issues.push("Two events share a code.");
    for (const event of form.events) {
      if (event.gender === "mixed" && event.entryType !== "pair") {
        issues.push(`${event.code} is mixed, so it must be a doubles event.`);
      }
      if (event.maxEntries != null && event.maxEntries < 2) {
        issues.push(`${event.code} needs an entry cap of 2 or more, or no cap.`);
      }
    }
    if (form.maxCategoriesPerPlayer < 1 || form.maxCategoriesPerPlayer > 5) {
      issues.push("The per-player event limit must be between 1 and 5.");
    }
    issues.push(...registrationProblems(form, now));
    return issues;
  }

  return issues;
}

/**
 * The checks Review lists while the tournament does not exist yet. Their ids are the ones the
 * database uses for the same questions (`basics`, `timezone`, `categories`, `category_caps`)
 * plus `window` and `registration`, so `stepForCheck` points each at the step that fixes it.
 */
export function localChecks(form: DraftForm, now: Date = new Date()): LocalCheck[] {
  const details = detailsProblems(form);
  const overCapped = form.events.filter((event) => event.maxEntries != null && event.maxEntries < 2);
  const registration = registrationProblems(form, now);

  const checks: LocalCheck[] = [
    check("basics", "Tournament has a name", details.name),
    check("timezone", "Timezone is valid", details.zone),
    check("window", "The tournament has a first and last day", details.window),
    check(
      "categories",
      "At least one event is switched on",
      form.events.length ? null : "Add at least one event.",
    ),
    check(
      "category_caps",
      "Entry caps leave room for a pool",
      overCapped.length ? `${overCapped.length} event(s) have a cap below 2.` : null,
    ),
  ];
  if (form.registration.enabled) {
    checks.push(
      check("registration", "Registration closes before the tournament starts", registration[0] ?? null),
    );
  }
  return checks;
}

function check(id: string, label: string, problem: string | null): LocalCheck {
  return problem ? { id, label, ok: false, detail: problem } : { id, label, ok: true };
}
