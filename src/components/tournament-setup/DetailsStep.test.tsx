// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DetailsStep } from "@/components/tournament-setup/DetailsStep";
import type { DraftForm } from "@/components/tournament-setup/types";

/**
 * The wizard's first step, rendered rather than driven.
 *
 * The hermetic suite reaches the create flow's first step, but it cannot see what a lock does
 * to a field or what the date handlers do to the pair of dates - rendering the step directly
 * is the layer that can. It is the same argument `status-pill.test.tsx` makes for the state
 * matrix.
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
  startsOn: "2026-09-23",
  endsOn: "2026-09-24",
  events: [],
  maxCategoriesPerPlayer: 2,
  registration: { enabled: true, opensAt: "", closesAt: "" },
};

const dateFields = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLInputElement>('input[type="date"]'),
];

describe("the tournament window is presented by the app, not by the engine", () => {
  it("gives the first and last day a named picker control", () => {
    const { container } = render(<DetailsStep form={form} onChange={() => {}} isNew={false} />);

    const fields = dateFields(container);
    expect(fields).toHaveLength(2);

    const names = fields.map((field) => {
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

  it("labels the two dates as the tournament's own, not as playing days", () => {
    render(<DetailsStep form={form} onChange={() => {}} isNew={false} />);
    expect(screen.getByLabelText("Tournament starts")).toBeTruthy();
    expect(screen.getByLabelText("Tournament ends")).toBeTruthy();
    expect(screen.getByText(/choose which days you actually play/i)).toBeTruthy();
  });

  it("keeps the window editable, so the control did not replace the field", () => {
    const { container } = render(<DetailsStep form={form} onChange={() => {}} isNew={false} />);
    const [start, end] = dateFields(container);
    expect(start?.value).toBe("2026-09-23");
    expect(end?.value).toBe("2026-09-24");
    // The last date cannot be picked before the first.
    expect(end?.getAttribute("min")).toBe("2026-09-23");
  });

  it("has no ceiling on how long the window is", () => {
    const long: DraftForm = { ...form, startsOn: "2026-10-20", endsOn: "2026-12-31" };
    const { container } = render(<DetailsStep form={long} onChange={() => {}} isNew={false} />);
    const [, end] = dateFields(container);
    expect(end?.getAttribute("max")).toBeNull();
    expect(screen.getByText(/73 days/)).toBeTruthy();
  });

  it("leaves the last-day control disabled until a first day exists", () => {
    const empty: DraftForm = { ...form, startsOn: "", endsOn: "" };
    const { container } = render(<DetailsStep form={empty} onChange={() => {}} isNew={false} />);

    const [start, end] = dateFields(container);
    expect((start as HTMLInputElement).disabled).toBe(false);
    expect((end as HTMLInputElement).disabled).toBe(true);
    // The pair moves together: a live button over a disabled field would open a popup
    // onto a value the host is not allowed to set yet.
    expect((end?.parentElement?.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("drags the last date along when the first moves past it", () => {
    const onChange = vi.fn();
    const { container } = render(<DetailsStep form={form} onChange={onChange} isNew={false} />);
    const [start] = dateFields(container);
    fireEvent.change(start as HTMLInputElement, { target: { value: "2026-09-30" } });
    expect(onChange).toHaveBeenCalledWith({ startsOn: "2026-09-30", endsOn: "2026-09-30" });
  });

  it("starts the last date on the first when it was empty", () => {
    const onChange = vi.fn();
    const empty: DraftForm = { ...form, startsOn: "", endsOn: "" };
    const { container } = render(<DetailsStep form={empty} onChange={onChange} isNew={false} />);
    const [start] = dateFields(container);
    fireEvent.change(start as HTMLInputElement, { target: { value: "2026-10-20" } });
    expect(onChange).toHaveBeenCalledWith({ startsOn: "2026-10-20", endsOn: "2026-10-20" });
  });

  it("asks for the dates only once the host has tried to continue", () => {
    const empty: DraftForm = { ...form, startsOn: "", endsOn: "" };
    const { rerender } = render(
      <DetailsStep form={empty} onChange={() => {}} isNew={false} showErrors={false} />,
    );
    expect(screen.queryByText("Pick the first day.", { selector: "[id=t-window-error]" })).toBeNull();
    rerender(<DetailsStep form={empty} onChange={() => {}} isNew={false} showErrors />);
    expect(document.getElementById("t-window-error")?.textContent).toBe("Pick the first day.");
  });
});

describe("what a started tournament can no longer change", () => {
  it("locks the first date and the timezone, and says why", () => {
    const { container } = render(
      <DetailsStep
        form={form}
        onChange={() => {}}
        isNew={false}
        lock={{ start: true, timezone: true }}
      />,
    );
    const [start, end] = dateFields(container);
    expect(start?.disabled).toBe(true);
    // The last date can still be extended.
    expect(end?.disabled).toBe(false);
    expect(screen.getByText(/first day can no longer move/i)).toBeTruthy();
    expect(screen.getByText(/every match time is read in this zone/i)).toBeTruthy();
    expect(document.getElementById("t-tz")?.hasAttribute("disabled")).toBe(true);
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).disabled).toBe(false);
  });

  it("takes the whole form away from a completed tournament", () => {
    const { container } = render(
      <DetailsStep form={form} onChange={() => {}} isNew={false} lock={{ all: true }} />,
    );
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
  });
});
