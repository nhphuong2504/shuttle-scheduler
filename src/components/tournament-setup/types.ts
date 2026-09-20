import type { TournamentDayInput, TournamentEventInput } from "@/lib/tournament/actions";

export type SetupStep = "basics" | "days" | "events" | "structure" | "review";

export const SETUP_STEPS: { id: SetupStep; label: string; hint: string }[] = [
  { id: "basics", label: "Basics", hint: "Identity, venue and contact" },
  { id: "days", label: "Dates", hint: "How many days the tournament runs" },
  { id: "events", label: "Events", hint: "Categories and limits" },
  { id: "structure", label: "Structure", hint: "How the competition runs" },
  { id: "review", label: "Review", hint: "Checks and activation" },
];

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

export interface DraftForm {
  basics: BasicsForm;
  /**
   * One row per tournament date. Setup only decides *which* dates the tournament
   * runs on; the hours, courts and breaks each day plays on are configured at the
   * first build, where the courts actually exist.
   */
  days: TournamentDayInput[];
  events: TournamentEventInput[];
  maxCategoriesPerPlayer: number;
}

/** What a day looks like before the first build gives it hours and courts. */
export const DEFAULT_DAY_START = "09:00";
export const DEFAULT_DAY_END = "18:30";

/**
 * The database refuses more than this many days (`save_tournament_days`), so the
 * picker stops the host at the same limit rather than letting a save fail.
 */
export const MAX_TOURNAMENT_DAYS = 7;

/** The date part of "now" in the host's own timezone, as `YYYY-MM-DD`. */
export function todayIso(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

/** Adds whole days to a `YYYY-MM-DD` string, staying clear of local-time drift. */
export function shiftIsoDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Inclusive day count between two `YYYY-MM-DD` strings; at least 1. */
export function countIsoDays(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * Expands a start/end date range into one row per day, in date order.
 *
 * A single date is a one-day tournament. Zero-padded `YYYY-MM-DD` strings compare
 * chronologically as text, so the range checks are plain string comparisons.
 */
export function buildDayRange(start: string, end: string): TournamentDayInput[] {
  if (!start) return [];
  const last = end || start;
  if (last < start) {
    throw new Error("The end date cannot be before the start date.");
  }
  const span = countIsoDays(start, last);
  if (span > MAX_TOURNAMENT_DAYS) {
    throw new Error(`A tournament can span at most ${MAX_TOURNAMENT_DAYS} days.`);
  }
  return Array.from({ length: span }, (_, index) => ({
    date: shiftIsoDate(start, index),
    startTime: DEFAULT_DAY_START,
    endTime: DEFAULT_DAY_END,
    courts: [],
    breaks: [],
  }));
}

/**
 * The date range is derived from the day rows rather than stored separately, so
 * the summary always agrees with what the host configured.
 */
export function dateRangeLabel(days: TournamentDayInput[]): string {
  const dates = days
    .map((day) => day.date)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  if (!dates.length) return "No days yet";
  const first = dates[0] as string;
  const last = dates[dates.length - 1] as string;
  return first === last ? first : `${first} to ${last}`;
}

export function defaultForm(): DraftForm {
  const today = todayIso();
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
    days: buildDayRange(today, today),
    events: [],
    maxCategoriesPerPlayer: 2,
  };
}
