// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlayingDayPicker } from "@/components/schedule/playing-day-picker";

afterEach(cleanup);

function setup(over: Partial<React.ComponentProps<typeof PlayingDayPicker>> = {}) {
  const onAdd = vi.fn();
  const onRemove = vi.fn();
  const view = render(
    <PlayingDayPicker
      startsOn="2030-10-20"
      endsOn="2030-10-30"
      chosen={new Set(["2030-10-22"])}
      locked={new Map()}
      disabled={false}
      onAdd={onAdd}
      onRemove={onRemove}
      {...over}
    />,
  );
  return { onAdd, onRemove, ...view };
}

describe("choosing playing days inside the tournament window", () => {
  it("offers exactly the window's dates, no more", () => {
    setup();
    const dates = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(dates).toHaveLength(11);
    expect(dates[0]).toMatch(/Oct 20/);
    expect(dates[10]).toMatch(/Oct 30/);
  });

  it("does not need the days to be consecutive", () => {
    const { onAdd } = setup({ chosen: new Set(["2030-10-20", "2030-10-22", "2030-10-29"]) });
    fireEvent.click(screen.getByRole("button", { name: /Oct 25/ }));
    expect(onAdd).toHaveBeenCalledWith("2030-10-25");
    expect(screen.getByText("3 of 11 days chosen.")).toBeTruthy();
  });

  it("says which days are chosen with more than a colour", () => {
    setup();
    const chosen = screen.getByRole("button", { name: /Oct 22, playing day/ });
    expect(chosen.getAttribute("aria-pressed")).toBe("true");
    expect(chosen.querySelector("svg")).not.toBeNull();
    const other = screen.getByRole("button", { name: /Oct 21/ });
    expect(other.getAttribute("aria-pressed")).toBe("false");
  });

  it("switches a chosen day off", () => {
    const { onRemove } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Oct 22/ }));
    expect(onRemove).toHaveBeenCalledWith("2030-10-22");
  });

  it("keeps a day that has matches on it switched on, and says why", () => {
    const { onRemove } = setup({
      locked: new Map([["2030-10-22", "This day has matches on it. Clear or move them first."]]),
    });
    const day = screen.getByRole("button", { name: /Oct 22/ }) as HTMLButtonElement;
    expect(day.disabled).toBe(true);
    expect(day.title).toMatch(/matches on it/);
    fireEvent.click(day);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("is read-only for somebody who cannot edit", () => {
    const { onAdd } = setup({ disabled: true });
    const day = screen.getByRole("button", { name: /Oct 25/ }) as HTMLButtonElement;
    expect(day.disabled).toBe(true);
    fireEvent.click(day);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("starts with none chosen and says so", () => {
    setup({ chosen: new Set() });
    expect(screen.getByText(/None of the 11 days/)).toBeTruthy();
  });

  it("groups a long window by month instead of drawing one endless row", () => {
    setup({ startsOn: "2030-10-20", endsOn: "2031-01-10", chosen: new Set() });
    const groups = screen.getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toHaveLength(4);
    expect(screen.getAllByRole("button")).toHaveLength(83);
  });

  it("has nothing to offer a tournament with no dates", () => {
    setup({ startsOn: "", endsOn: "" });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText(/no dates yet/i)).toBeTruthy();
  });
});
