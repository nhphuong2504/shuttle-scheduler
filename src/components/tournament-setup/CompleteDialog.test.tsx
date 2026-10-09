// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompleteDialog } from "@/components/tournament-setup/CompleteDialog";

afterEach(cleanup);

function setup(over: Partial<React.ComponentProps<typeof CompleteDialog>> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <CompleteDialog
      open
      onOpenChange={onOpenChange}
      name="Spring Cup"
      check={{ onCourt: 0, unplayed: 0, total: 48 }}
      loading={false}
      error={null}
      busy={false}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onConfirm, onOpenChange };
}

const confirm = () => screen.getByRole("button", { name: "Complete tournament" }) as HTMLButtonElement;

describe("completing a tournament", () => {
  it("names the tournament and says it cannot be undone", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Complete Spring Cup?" })).toBeTruthy();
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
  });

  it("is one sentence and one button when every match is settled", () => {
    const { onConfirm } = setup();
    expect(screen.getByText("All 48 matches are played.")).toBeTruthy();
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("is blocked while a match is on court, and says how many", () => {
    const { onConfirm } = setup({ check: { onCourt: 2, unplayed: 9, total: 48 } });
    expect(screen.getByText("2 matches are still being played")).toBeTruthy();
    expect(confirm().disabled).toBe(true);
    fireEvent.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
    // Blocking comes before warning: the unplayed matches are not the first thing to fix.
    expect(screen.queryByText(/have not been played/)).toBeNull();
  });

  it("uses the singular for one match on court", () => {
    setup({ check: { onCourt: 1, unplayed: 0, total: 3 } });
    expect(screen.getByText("1 match is still being played")).toBeTruthy();
  });

  it("allows unplayed matches, but only once the host has said they understand", () => {
    const { onConfirm } = setup({ check: { onCourt: 0, unplayed: 9, total: 48 } });
    expect(screen.getByText("9 matches have not been played")).toBeTruthy();
    expect(confirm().disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /9 matches will not be played/ }));
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("will not complete while it is still counting, or if the count failed", () => {
    cleanup();
    setup({ check: undefined, loading: true });
    expect(screen.getByText(/checking what is left/i)).toBeTruthy();
    expect(confirm().disabled).toBe(true);

    cleanup();
    setup({ check: undefined, error: "network down" });
    expect(screen.getByRole("alert").textContent).toMatch(/network down/);
    expect(confirm().disabled).toBe(true);
  });

  it("can always be cancelled", () => {
    const { onOpenChange } = setup({ check: { onCourt: 2, unplayed: 0, total: 5 } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
