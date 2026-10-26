// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/info-note";

/**
 * The state that matters: a note opened from inside a modal dialog.
 *
 * A note on its own page was never the problem. Inside a dialog the content is portalled
 * out of the dialog's focus scope, so opening it used to move focus in and have the dialog
 * pull it back - read as a dismissal, open and close in one tick. What a test can pin here
 * is that the words stay on screen once opened, and that the reader can put them away.
 */

afterEach(cleanup);

const NOTE = "Team A did not play in Round 1 and plays both placement matches in Round 2.";

function renderInsideDialog() {
  render(
    <Dialog open onOpenChange={() => {}}>
      <DialogContent>
        <DialogTitle>Scores</DialogTitle>
        <DialogDescription asChild>
          <div>
            <span>MD R2</span>
            <InfoNote label="About this pairing">{NOTE}</InfoNote>
          </div>
        </DialogDescription>
      </DialogContent>
    </Dialog>,
  );
  return screen.getByRole("button", { name: "About this pairing" });
}

describe("InfoNote", () => {
  it("stays open when it is opened inside a modal dialog", () => {
    const trigger = renderInsideDialog();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  it("is put away by the note's own trigger", () => {
    const trigger = renderInsideDialog();
    fireEvent.click(trigger);
    expect(screen.getByText(NOTE)).toBeTruthy();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it("stays open when focus moves on to something else in the dialog", () => {
    // This is the exact event that used to close it: the dialog's focus trap moving focus
    // back out of the portalled note.
    const trigger = renderInsideDialog();
    fireEvent.click(trigger);
    expect(screen.getByText(NOTE)).toBeTruthy();

    fireEvent.focus(screen.getByRole("heading", { name: "Scores" }));

    expect(screen.getByText(NOTE)).toBeTruthy();
  });
});
