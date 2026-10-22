import type { Category, Tournament } from "@/lib/tournament/data";
import { hydrateForm } from "./hydrate";
import type { DraftForm } from "./types";

/** The same calendar date a year on; 29 February lands on 1 March. Blank stays blank. */
export function oneYearOn(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]) + 1, Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10);
}

/** "City Open 2026" becomes "City Open 2027"; a name with no year gets " (copy)". */
export function nextName(name: string): string {
  const trimmed = name.trim();
  if (/\b(19|20)\d{2}\b/.test(trimmed)) {
    return trimmed.replace(/\b((?:19|20)\d{2})\b/, (year) => String(Number(year) + 1));
  }
  return `${trimmed} (copy)`;
}

/**
 * A new tournament's answers, started from a finished one.
 *
 * Keeps what stays the same year to year - venue, organiser, events, caps - and moves what
 * does not: the name and the dates go a year on, and the registration window is left to its
 * defaults (open now, close the evening before the start) instead of copying times that are
 * already in the past. Players, entries, courts and the schedule are not carried: they belong
 * to the event that happened. The result goes into the create flow's draft, so the host
 * reviews all four steps before anything is created.
 */
export function cloneDraft(tournament: Tournament, categories: Category[]): DraftForm {
  const form = hydrateForm(tournament, categories);
  return {
    ...form,
    basics: { ...form.basics, name: nextName(form.basics.name) },
    startsOn: oneYearOn(form.startsOn),
    endsOn: oneYearOn(form.endsOn),
    registration: { enabled: true, opensAt: "", closesAt: "" },
  };
}
