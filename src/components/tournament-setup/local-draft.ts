import { defaultForm, type DraftForm } from "./types";

/**
 * The answers a host has typed into the create flow, kept in the browser until the
 * tournament is created.
 *
 * Nothing is stored in the database before then: a tournament is created complete or not at
 * all. But the people who create them do it at a desk, often on imperfect wifi, and a form of
 * four steps lost to a reload or a flat battery is a form nobody finishes. So the form is
 * written to `sessionStorage` as it changes and read back when the page opens.
 *
 * `sessionStorage` rather than `localStorage` on purpose: it survives a reload and a crash of
 * the tab's page, and it is gone when the tab is closed, so a forgotten half-finished form
 * does not reappear weeks later with dates in the past.
 *
 * Every call is wrapped, because storage can be missing (server render, a private window),
 * full, or refuse access, and none of those may stop the wizard from working - it just does
 * not remember.
 */
const KEY = "tournova:new-tournament:v1";

/** A saved form is only trusted if it still looks like one. */
function revive(raw: unknown): DraftForm | null {
  if (!raw || typeof raw !== "object") return null;
  const saved = raw as Partial<DraftForm>;
  const base = defaultForm();
  return {
    basics: { ...base.basics, ...(saved.basics ?? {}) },
    startsOn: typeof saved.startsOn === "string" ? saved.startsOn : base.startsOn,
    endsOn: typeof saved.endsOn === "string" ? saved.endsOn : base.endsOn,
    events: Array.isArray(saved.events) ? saved.events : base.events,
    maxCategoriesPerPlayer:
      typeof saved.maxCategoriesPerPlayer === "number"
        ? saved.maxCategoriesPerPlayer
        : base.maxCategoriesPerPlayer,
    registration: { ...base.registration, ...(saved.registration ?? {}) },
  };
}

export function loadLocalDraft(): DraftForm | null {
  try {
    const text = window.sessionStorage.getItem(KEY);
    if (!text) return null;
    return revive(JSON.parse(text));
  } catch {
    return null;
  }
}

export function saveLocalDraft(form: DraftForm): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(form));
  } catch {
    // Not remembering is better than refusing to work.
  }
}

export function clearLocalDraft(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Same.
  }
}

/**
 * A name typed somewhere else - the front door's sheet - for the create flow to start from.
 *
 * Kept apart from the draft so the flow can still begin from its own blank form (which reads
 * the browser's zone), and taken once so it cannot rename a later tournament.
 */
const OFFERED_NAME_KEY = "tournova:new-tournament-name:v1";

export function offerTournamentName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    window.sessionStorage.setItem(OFFERED_NAME_KEY, trimmed);
  } catch {
    // The flow opens with an empty name instead.
  }
}

export function takeOfferedTournamentName(): string | null {
  try {
    const name = window.sessionStorage.getItem(OFFERED_NAME_KEY);
    window.sessionStorage.removeItem(OFFERED_NAME_KEY);
    return name?.trim() || null;
  } catch {
    return null;
  }
}

/** Whether the saved form holds anything beyond the defaults, for "your answers were kept". */
export function hasLocalDraft(): boolean {
  const saved = loadLocalDraft();
  if (!saved) return false;
  return JSON.stringify(saved) !== JSON.stringify(defaultForm());
}
