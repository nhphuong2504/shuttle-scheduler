// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DetailsStep } from "@/components/tournament-setup/DetailsStep";
import { buildDayRange, type DraftForm } from "@/components/tournament-setup/types";

/**
 * The wizard's first step, rendered rather than driven.
 *
 * `/setup` shows its review step whenever a tournament is live, so the hermetic suite never
 * mounts this one: the route sweep on `/setup` finds no field to scan and the staff sweep
 * never goes there. Rendering it directly is the only layer that reaches it, and the reason
 * the date range is not left to the source guard in `src/lib/design/pickers.test.ts` alone.
 *
 * The guard proves no field goes back to a raw `<input type="date">`; it cannot prove the
 * step still renders, which is what these do.
 */

afterEach(cleanup);

const form: DraftForm = {
  basics: {
    name: "City Open",
    notes: "",
    venueName: "",
    venueAddress: "",
    venueTimezone: "UTC",
    organizerName: "",
    organizerEmail: "",
    organizerPhone: "",
  },
  days: buildDayRange("2026-09-23", "2026-09-24"),
  events: [],
  maxCategoriesPerPlayer: 2,
};

const dateFields = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLInputElement>('input[type="date"]'),
];

describe("the setup date range is presented by the app, not by the engine", () => {
  it("gives the first and last day a named picker control", () => {
    const { container } = render(<DetailsStep form={form} onChange={() => {}} isNew={false} />);

    const fields = dateFields(container);
    expect(fields).toHaveLength(2);

    const names = fields.map((field) => {
      // The class is what ties the field to the rule in `styles.css` that removes the
      // browser's own calendar glyph; without it the field would draw two icons.
      expect(field.className).toContain("picker-field");
      const button = field.parentElement?.querySelector("button");
      expect(button, "the date field has no picker control").not.toBeNull();
      return button?.getAttribute("aria-label");
    });

    // Named for the field each one opens rather than both reading "Open the calendar":
    // two identically-named buttons on one surface name neither of them.
    expect(names).toEqual([
      "Open the calendar for the first day",
      "Open the calendar for the last day",
    ]);
  });

  it("keeps the range editable, so the control did not replace the field", () => {
    const { container } = render(<DetailsStep form={form} onChange={() => {}} isNew={false} />);
    const [start, end] = dateFields(container);
    expect(start?.value).toBe("2026-09-23");
    expect(end?.value).toBe("2026-09-24");
    // The second day is clamped to the first, which is the step's own rule and not this
    // work's: a picker that swallowed the field's value would show it here.
    expect(end?.getAttribute("min")).toBe("2026-09-23");
  });

  it("leaves the last-day control disabled until a first day exists", () => {
    const empty: DraftForm = { ...form, days: [] };
    const { container } = render(<DetailsStep form={empty} onChange={() => {}} isNew={false} />);

    const [start, end] = dateFields(container);
    expect((start as HTMLInputElement).disabled).toBe(false);
    expect((end as HTMLInputElement).disabled).toBe(true);
    // The pair moves together: a live button over a disabled field would open a popup
    // onto a value the host is not allowed to set yet.
    expect((end?.parentElement?.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });
});
