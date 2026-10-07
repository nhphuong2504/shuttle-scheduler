import type { TournamentEventInput } from "@/lib/tournament/actions";

export type SetupStep = "details" | "events" | "structure" | "review";

/**
 * The steps, in order. `hint` is the one line the step rail prints beneath the name, so a host
 * can tell what a step is for without opening it.
 *
 * The last step is "Review and create" while a tournament is being made and "Review" once it
 * exists, so it is named by `setupSteps(existing)` rather than read from here directly.
 */
export const SETUP_STEPS: { id: SetupStep; label: string; hint: string }[] = [
  { id: "details", label: "Details", hint: "Name, dates, venue" },
  { id: "events", label: "Events", hint: "What is played, and who can register" },
  { id: "structure", label: "Structure", hint: "How it is played" },
  { id: "review", label: "Review and create", hint: "Check, then create" },
];

/** The steps as the rail names them: creating a tournament, or setting up one that exists. */
export function setupSteps(existing: boolean): { id: SetupStep; label: string; hint: string }[] {
  if (!existing) return SETUP_STEPS;
  return SETUP_STEPS.map((step) =>
    step.id === "review" ? { ...step, label: "Review", hint: "Checks and summary" } : step,
  );
}

/**
 * Which step fixes a readiness check.
 *
 * The database names its checks by id (`basics`, `timezone`, `categories`, `category_caps`) and
 * the wizard adds two of its own (`window`, `registration`); a failing one is only useful if it
 * says where to go. A check this does not know leads nowhere rather than to a guess.
 */
export function stepForCheck(checkId: string): SetupStep | null {
  switch (checkId) {
    case "basics":
    case "timezone":
    case "window":
      return "details";
    case "categories":
    case "category_caps":
    case "registration":
      return "events";
    default:
      return null;
  }
}

export function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === "string" && SETUP_STEPS.some((step) => step.id === value);
}

export function setupStepIndex(step: SetupStep): number {
  return SETUP_STEPS.findIndex((entry) => entry.id === step);
}

export interface BasicsForm {
  name: string;
  /** A note about the event. Written to be read, not a private reminder. */
  notes: string;
  venueName: string;
  venueAddress: string;
  venueTimezone: string;
  organizerName: string;
  organizerEmail: string;
  organizerPhone: string;
}

/**
 * The registration window as the host types it: wall-clock `YYYY-MM-DDTHH:mm` strings in the
 * venue's timezone, which is the form a `datetime-local` input speaks and the form that
 * compares chronologically as text. They become instants only at the edge, where the
 * tournament is saved.
 *
 * An empty `opensAt` means "as soon as the tournament is created", and an empty `closesAt`
 * means the suggestion (the end of the day before the tournament starts); both are shown in
 * the field so the host sees what they will get.
 */
export interface RegistrationForm {
  enabled: boolean;
  opensAt: string;
  closesAt: string;
}

export interface DraftForm {
  basics: BasicsForm;
  /**
   * The tournament window: the first and last date, `YYYY-MM-DD`, in the venue's timezone.
   * It is what the public sees. Which days are actually played, and the hours and courts of
   * each, are chosen on the Schedule page when the schedule is built - inside this window.
   */
  startsOn: string;
  endsOn: string;
  events: TournamentEventInput[];
  maxCategoriesPerPlayer: number;
  registration: RegistrationForm;
}

/** The date part of "now" in the host's own timezone, as `YYYY-MM-DD`. */
export function todayIso(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

/** Adds whole days to a `YYYY-MM-DD` string, staying clear of local-time drift. */
export function shiftIsoDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  // An unreadable date stays unreadable (blank), rather than throwing from `toISOString`
  // into a render.
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Inclusive day count between two `YYYY-MM-DD` strings; at least 1. */
export function countIsoDays(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

/** "2026-10-20 to 2026-10-30", "2026-10-20" for one day, or a prompt if there is no window. */
export function windowLabel(startsOn: string, endsOn: string): string {
  if (!startsOn) return "No dates yet";
  const last = endsOn || startsOn;
  return last === startsOn ? startsOn : `${startsOn} to ${last}`;
}

export function defaultForm(): DraftForm {
  return {
    basics: {
      name: "",
      notes: "",
      venueName: "",
      venueAddress: "",
      venueTimezone: "America/Chicago",
      organizerName: "",
      organizerEmail: "",
      organizerPhone: "",
    },
    startsOn: "",
    endsOn: "",
    events: [],
    maxCategoriesPerPlayer: 2,
    registration: { enabled: true, opensAt: "", closesAt: "" },
  };
}
