import { describe, expect, it } from "vitest";

import { markStepSaved, stepDirty } from "./dirty";
import { defaultForm, type DraftForm } from "./types";

function stored(): DraftForm {
  const base = defaultForm();
  return {
    ...base,
    basics: { ...base.basics, name: "City Open" },
    startsOn: "2026-10-20",
    endsOn: "2026-10-22",
  };
}

describe("stepDirty", () => {
  it("is clean while nothing has been read back", () => {
    expect(stepDirty("details", stored(), null)).toBe(false);
  });

  it("sees an edit only on the step that owns the field", () => {
    const saved = stored();
    const form = { ...saved, basics: { ...saved.basics, name: "Spring Open" } };
    expect(stepDirty("details", form, saved)).toBe(true);
    expect(stepDirty("events", form, saved)).toBe(false);
    expect(stepDirty("structure", form, saved)).toBe(false);
    expect(stepDirty("review", form, saved)).toBe(false);
  });

  it("counts the registration window and the per-player limit as the events step's", () => {
    const saved = stored();
    expect(stepDirty("events", { ...saved, maxCategoriesPerPlayer: 3 }, saved)).toBe(true);
    const reg = { ...saved, registration: { ...saved.registration, enabled: false } };
    expect(stepDirty("events", reg, saved)).toBe(true);
    expect(stepDirty("details", reg, saved)).toBe(false);
  });
});

describe("markStepSaved", () => {
  it("takes the saved step's answers and leaves another step's edit unsaved", () => {
    const saved = stored();
    const form = {
      ...saved,
      basics: { ...saved.basics, name: "Spring Open" },
      maxCategoriesPerPlayer: 3,
    };
    const next = markStepSaved("details", form, saved);
    expect(stepDirty("details", form, next)).toBe(false);
    expect(stepDirty("events", form, next)).toBe(true);
  });
});
