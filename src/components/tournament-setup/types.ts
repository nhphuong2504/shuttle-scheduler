import type { TournamentDayInput, TournamentEventInput } from "@/lib/tournament/actions";
import {
  DEFAULT_KNOCKOUT_RULE,
  DEFAULT_PLACEMENT_RULE,
  type ScoringRule,
} from "@/lib/tournament/scoring";

export type SetupStep = "basics" | "days" | "events" | "structure" | "rules" | "review";

export const SETUP_STEPS: { id: SetupStep; label: string; hint: string }[] = [
  { id: "basics", label: "Basics", hint: "Identity, venue and contact" },
  { id: "days", label: "Days & courts", hint: "Dates, hours, courts and breaks" },
  { id: "events", label: "Events", hint: "Categories and limits" },
  { id: "structure", label: "Structure", hint: "How the competition runs" },
  { id: "rules", label: "Match rules", hint: "Scoring, duration and rest" },
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

export interface RulesForm {
  /** Placement (the two-round stage) scoring and scheduling. */
  placementRule: ScoringRule;
  placementSlotMinutes: number;
  placementRestGapMinutes: number;
  /** Knockout (the A/B/C/D draws) scoring and scheduling. */
  knockoutRule: ScoringRule;
  knockoutSlotMinutes: number;
  knockoutRestGapMinutes: number;
}

export interface DraftForm {
  basics: BasicsForm;
  days: TournamentDayInput[];
  events: TournamentEventInput[];
  maxCategoriesPerPlayer: number;
  rules: RulesForm;
}

export function emptyDay(index: number): TournamentDayInput {
  const date = new Date();
  date.setDate(date.getDate() + index);
  const offset = date.getTimezoneOffset();
  return {
    date: new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10),
    startTime: "09:00",
    endTime: "18:30",
    courts: [],
    breaks: [],
  };
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
    days: [emptyDay(0)],
    events: [],
    maxCategoriesPerPlayer: 2,
    rules: {
      placementRule: { ...DEFAULT_PLACEMENT_RULE },
      placementSlotMinutes: 20,
      placementRestGapMinutes: 10,
      knockoutRule: { ...DEFAULT_KNOCKOUT_RULE },
      knockoutSlotMinutes: 25,
      knockoutRestGapMinutes: 30,
    },
  };
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

export function courtPoolSize(days: TournamentDayInput[]): number {
  let max = 0;
  for (const day of days) {
    for (const court of day.courts) {
      if (court > max) max = court;
    }
  }
  return max;
}

/** The courts a host can pick from, derived from the days' own selections. */
export function courtOptionsFor(days: TournamentDayInput[], upTo: number): number[] {
  return Array.from({ length: Math.max(upTo, 0) }, (_, index) => index + 1);
}
