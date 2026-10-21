import type { DraftForm, SetupStep } from "./types";

/**
 * What one step of an existing tournament owns, and so what leaving it has to save.
 *
 * The rail, "Back" and Review's links all move between steps, and a step that has been
 * edited is saved on the way out rather than only by "Save and continue" - the page says
 * "Saved as you go", and a host who changes a date and then clicks the rail has every reason
 * to believe it. Structure and Review own nothing, so leaving them never writes.
 */
export function stepSlice(step: SetupStep, form: DraftForm): Partial<DraftForm> {
  switch (step) {
    case "details":
      return { basics: form.basics, startsOn: form.startsOn, endsOn: form.endsOn };
    case "events":
      return {
        events: form.events,
        maxCategoriesPerPlayer: form.maxCategoriesPerPlayer,
        registration: form.registration,
      };
    default:
      return {};
  }
}

/** Whether a step's answers differ from what was last read from or written to the database. */
export function stepDirty(step: SetupStep, form: DraftForm, saved: DraftForm | null): boolean {
  if (!saved) return false;
  return JSON.stringify(stepSlice(step, form)) !== JSON.stringify(stepSlice(step, saved));
}

/** The saved snapshot once a step has been written: that step's answers, and nothing else. */
export function markStepSaved(step: SetupStep, form: DraftForm, saved: DraftForm): DraftForm {
  return { ...saved, ...stepSlice(step, form) };
}
