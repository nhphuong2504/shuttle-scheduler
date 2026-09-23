// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("opens the popup from the click", () => {
    const { container } = render(<PickerInput type="date" pickerLabel="Open the calendar" />);
    const field = fieldOf(container);
    const showPicker = vi.fn();
    asPicker(field).showPicker = showPicker;

    fireEvent.click(buttonOf(container));
    // Called from the handler rather than an effect or a timeout: the API needs transient
    // user activation, which only exists while the click is being handled.
    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  it("falls back to the field where the engine has no picker", () => {
    const { container } = render(<PickerInput type="date" pickerLabel="Open the calendar" />);
    const field = fieldOf(container);
    delete asPicker(field).showPicker;

    fireEvent.click(buttonOf(container));
    // Focus rather than nothing: a reader who cannot open the popup still lands on the
    // field, so the affordance degrades instead of disappearing.
    expect(document.activeElement).toBe(field);
  });

  it("falls back to the field where the engine refuses the picker", () => {
    const { container } = render(<PickerInput type="date" pickerLabel="Open the calendar" />);
    const field = fieldOf(container);
    asPicker(field).showPicker = () => {
      // What a disabled or read-only input throws, and what an engine without the feature
      // threw before the API existed.
      throw new DOMException("not allowed", "InvalidStateError");
    };

    expect(() => fireEvent.click(buttonOf(container))).not.toThrow();
    expect(document.activeElement).toBe(field);
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
