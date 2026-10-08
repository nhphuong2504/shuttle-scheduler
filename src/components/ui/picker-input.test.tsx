// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PickerInput } from "@/components/ui/picker-input";

/**
 * The replacement for the engine's picker glyph, rendered rather than driven.
 *
 * `e2e/staff-surfaces.spec.ts` proves the real control is reachable by Tab and takes the
 * focus ring, but it runs in Chromium, where `showPicker()` exists and does not throw. The
 * branch that matters when it does not - an engine without the API, or a field it refuses -
 * is unreachable there, and that is the branch where a missing fallback turns the button
 * into a dead end rather than merely an unreachable one. This is the layer that can hold
 * it.
 */

afterEach(cleanup);

beforeAll(() => {
  // The popup positions itself with a ResizeObserver, which jsdom does not provide.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

/** jsdom implements neither `showPicker()` nor the engines' own glyph. */
type Picker = { showPicker?: () => void };
const asPicker = (field: HTMLInputElement) => field as unknown as Picker;

const fieldOf = (container: HTMLElement) => container.querySelector("input")!;
const buttonOf = (container: HTMLElement) => container.querySelector("button")!;

describe("PickerInput replaces the engine's glyph with a real control", () => {
  it("draws the calendar for a date and the clock for a time", () => {
    const date = render(<PickerInput type="date" pickerLabel="Open the calendar" />);
    const time = render(<PickerInput type="time" pickerLabel="Open the time picker" />);

    // The paths are the only stable way to tell two icons apart from the DOM.
    const paths = (container: HTMLElement) =>
      [...buttonOf(container).querySelectorAll("path")].map((p) => p.getAttribute("d")).join("|");

    expect(paths(date.container).length).toBeGreaterThan(0);
    expect(paths(date.container)).not.toBe(paths(time.container));
  });

  it("keeps the field a real date field, and the button a real button", () => {
    const { container } = render(<PickerInput type="date" pickerLabel="Open the calendar" />);
    expect(fieldOf(container).getAttribute("type")).toBe("date");
    // A decorative span would look identical and be unreachable from the keyboard.
    expect(buttonOf(container).tagName.toLowerCase()).toBe("button");
    // Not `submit`: these sit inside the settings form and must not post it.
    expect(buttonOf(container).getAttribute("type")).toBe("button");
  });

  it("ties the field to the rule that removes the glyph", () => {
    // `styles.css` hides `::-webkit-calendar-picker-indicator` under this class only. The
    // indicator is a user-agent pseudo-element that `getComputedStyle` reports the default
    // for, so the class is the assertion rather than the resolved style.
    const { container } = render(<PickerInput type="date" pickerLabel="Open the calendar" />);
    expect(fieldOf(container).className).toContain("picker-field");
    // The field's own text must not run under the button.
    expect(fieldOf(container).className).toContain("pr-9");
  });

  it("names the control for the field it opens", () => {
    const generic = render(<PickerInput type="date" />);
    expect(buttonOf(generic.container).getAttribute("aria-label")).toBe("Open the calendar");

    const named = render(
      <PickerInput type="time" pickerLabel="Open the start time picker for day 3" />,
    );
    expect(buttonOf(named.container).getAttribute("aria-label")).toBe(
      "Open the start time picker for day 3",
    );
  });

  it("opens the app's own calendar rather than the engine's", () => {
    const { container } = render(<PickerInput type="date" pickerLabel="Open the calendar" />);
    const field = fieldOf(container);
    const showPicker = vi.fn();
    asPicker(field).showPicker = showPicker;

    fireEvent.click(buttonOf(container));
    expect(screen.getByRole("group", { name: /\d{4}/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next month" })).toBeTruthy();
    // The engine's popup is the thing being replaced; it must not open as well.
    expect(showPicker).not.toHaveBeenCalled();
  });

  it("writes a chosen day to the field as an ordinary change", () => {
    const seen: string[] = [];
    const { container } = render(
      <PickerInput
        type="date"
        pickerLabel="Open the calendar"
        defaultValue="2026-10-08"
        onChange={(event) => seen.push(event.target.value)}
      />,
    );

    fireEvent.click(buttonOf(container));
    fireEvent.click(screen.getByRole("button", { name: /October 15, 2026/ }));

    expect(seen).toEqual(["2026-10-15"]);
    expect(fieldOf(container).value).toBe("2026-10-15");
    // A day is the whole of a date, so choosing one closes the calendar.
    expect(screen.queryByRole("button", { name: "Next month" })).toBeNull();
  });

  it("keeps the time of a date-and-time field when another day is chosen", () => {
    const { container } = render(
      <PickerInput
        type="datetime-local"
        pickerLabel="Open it"
        defaultValue="2026-10-08T14:30"
      />,
    );

    fireEvent.click(buttonOf(container));
    fireEvent.click(screen.getByRole("button", { name: /October 20, 2026/ }));

    expect(fieldOf(container).value).toBe("2026-10-20T14:30");
  });

  it("builds a time from the hour and the minute", () => {
    const { container } = render(
      <PickerInput type="time" pickerLabel="Open the time picker" defaultValue="" />,
    );

    fireEvent.click(buttonOf(container));
    const hour = screen.getByRole("group", { name: "Hour" });
    const minute = screen.getByRole("group", { name: "Minute" });
    const twelve = !!screen.queryByRole("group", { name: "AM or PM" });

    fireEvent.click(within(hour).getByRole("button", { name: twelve ? "8" : "08" }));
    fireEvent.click(within(minute).getByRole("button", { name: "45" }));
    if (twelve) fireEvent.click(screen.getByRole("button", { name: "PM" }));

    expect(fieldOf(container).value).toBe(twelve ? "20:45" : "08:45");
  });

  it("does not open for a disabled field", () => {
    const { container } = render(
      <PickerInput type="date" pickerLabel="Open the calendar" readOnly />,
    );
    fireEvent.click(buttonOf(container));
    expect(screen.queryByRole("button", { name: "Next month" })).toBeNull();
  });

  it("disables the control with the field, so the pair cannot separate", () => {
    // A button that stayed live would open a popup onto a field the operator is not
    // allowed to change - and on a locked first day that is a real state, not a test one.
    const { container } = render(
      <PickerInput type="date" pickerLabel="Open the calendar" disabled />,
    );
    expect((fieldOf(container) as HTMLInputElement).disabled).toBe(true);
    expect((buttonOf(container) as HTMLButtonElement).disabled).toBe(true);
  });

  it("still hands the caller the field it asked for", () => {
    // The wrapper attaches its own ref for `showPicker()`, so the caller's ref is the one
    // that goes missing if only one is kept.
    let seen: HTMLInputElement | null = null;
    render(
      <PickerInput
        type="date"
        pickerLabel="Open the calendar"
        ref={(node) => {
          seen = node;
        }}
      />,
    );
    expect(seen).not.toBeNull();
    expect((seen as unknown as HTMLInputElement).type).toBe("date");
  });
});
