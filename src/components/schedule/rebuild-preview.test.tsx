// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RebuildPreviewDialog, rebuildVerdict, type RebuildPreviewProps } from "./rebuild-preview";
import type { DayFinishComparison, PlanChange } from "@/lib/tournament/schedule-diff";

/**
 * The preview is a decision surface, so these pin what a reader can decide from it: whether the
 * change is an improvement, what moves and where, and why a plan cannot be applied.
 */

afterEach(cleanup);

const T = Date.parse("2026-10-26T13:00:00");

const change = (over: Partial<PlanChange> = {}): PlanChange => ({
  matchId: "m1",
  kind: "time-moved",
  fromStart: new Date(T).toISOString(),
  toStart: new Date(T + 6 * 60_000).toISOString(),
  fromCourtNumber: 7,
  toCourtNumber: 1,
  shiftMinutes: 6,
  dayNumber: 1,
  startsSoon: false,
  isNew: false,
  ...over,
});

const day = (over: Partial<DayFinishComparison> = {}): DayFinishComparison => ({
  dayNumber: 1,
  date: "2026-10-26",
  finishNowMs: Date.parse("2026-10-26T14:00:00"),
  finishAfterMs: Date.parse("2026-10-26T13:54:00"),
  moved: 1,
  newlyPlaced: 0,
  largestShiftMinutes: 6,
  overrunAfterMinutes: 0,
  ...over,
});

const summary = (over: Partial<RebuildPreviewProps["summary"]> = {}) => ({
  currentProjectedFinish: new Date(T + 60 * 60_000).toISOString(),
  projectedFinish: new Date(T + 54 * 60_000).toISOString(),
  projectedFinishDeltaMinutes: -6,
  movedCount: 1,
  newlyPlacedCount: 0,
  movesSoonCount: 0,
  anchorCount: 9,
  ...over,
});

function renderPreview(over: Partial<RebuildPreviewProps> = {}) {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  render(
    <RebuildPreviewDialog
      open
      onOpenChange={() => {}}
      invariant="Anchors stay fixed; only matches still to be played may move."
      summary={summary()}
      days={[day()]}
      changes={[change()]}
      describe={() => ({ identity: "MD R1", names: "Team A vs Team B" })}
      blocked={{ count: 0, reason: null, labels: [] }}
      awaitingTeams={0}
      busy={false}
      onCancel={onCancel}
      onApply={onApply}
      {...over}
    />,
  );
  return { dialog: screen.getByRole("dialog"), onApply, onCancel };
}

describe("rebuildVerdict", () => {
  it("states the finish it would replace, not only the one it would set", () => {
    const verdict = rebuildVerdict(summary(), [change()]);
    expect(verdict.headline).toBe("1 match would move.");
    expect(verdict.detail).toBe(
      "The last match would finish at 13:54 instead of 14:00 — 6 min earlier.",
    );
  });

  it("says nothing moves when the plan only slots matches in", () => {
    const verdict = rebuildVerdict(summary({ newlyPlacedCount: 3 }), [
      change({ kind: "newly-placed", fromStart: null }),
    ]);
    expect(verdict.headline).toBe("Nothing would move — 3 matches would be slotted in");
    expect(verdict.detail).toMatch(/stays exactly where it is/);
  });

  it("prices an imminent move, which is the cost a rebuild is paid in", () => {
    const verdict = rebuildVerdict(summary({ movesSoonCount: 1 }), [change({ startsSoon: true })]);
    expect(verdict.headline).toBe("1 match would move, and it starts within the hour.");
    expect(verdict.tone).toBe("warn");
  });

  it("counts only the imminent ones when a plan moves several", () => {
    const verdict = rebuildVerdict(summary({ movedCount: 3, movesSoonCount: 2 }), [
      change({ matchId: "a", startsSoon: true }),
      change({ matchId: "b", startsSoon: true }),
      change({ matchId: "c" }),
    ]);
    expect(verdict.headline).toBe("3 matches would move, 2 of them starting within the hour.");
  });

  it("does not claim a comparison it does not have", () => {
    const verdict = rebuildVerdict(
      summary({ currentProjectedFinish: null, projectedFinishDeltaMinutes: null }),
      [change()],
    );
    expect(verdict.detail).toBe("The last match would finish at 13:54.");
  });

  it("does not say 'instead of the same time' when the finish is unchanged", () => {
    // A move that trades court without moving the last match. Saying "13:05 instead of 13:05"
    // reads as a bug in the panel rather than as a fact about the plan.
    const verdict = rebuildVerdict(summary({ projectedFinishDeltaMinutes: 0 }), [change()]);
    expect(verdict.detail).toBe("The last match would still finish at 13:54.");
  });
});

describe("RebuildPreviewDialog", () => {
  it("leads with the verdict, then the move it describes", () => {
    const { dialog } = renderPreview();
    expect(within(dialog).getByText("1 match would move.")).toBeTruthy();
    // The identity comes before the pairing, so a row can be found before it is read.
    const row = within(dialog).getByRole("row", { name: /MD R1/ });
    expect(row.textContent).toContain("MD R1");
    expect(row.textContent).toContain("Team A vs Team B");
    expect(row.textContent).toContain("+6 min");
    expect(row.textContent).toContain("Court 7");
  });

  it("groups moves under the day they land on", () => {
    const { dialog } = renderPreview({
      days: [day(), day({ dayNumber: 2, date: "2026-10-27", moved: 1 })],
      changes: [
        change({ matchId: "a", dayNumber: 1 }),
        change({ matchId: "b", dayNumber: 2 }),
      ],
      summary: summary({ movedCount: 2 }),
    });
    // Two days also brings the comparison table, which one day does not.
    expect(within(dialog).getByRole("columnheader", { name: "Finish now" })).toBeTruthy();
    expect(within(dialog).getByRole("columnheader", { name: "Finish after" })).toBeTruthy();
    expect(within(dialog).getAllByRole("row").length).toBeGreaterThanOrEqual(4);
    // The day appears both as the table's row and as the moves' group heading.
    expect(within(dialog).getAllByText("Tue, Oct 27").length).toBe(2);
  });

  it("hides the day table for a single day, where the verdict already says it", () => {
    const { dialog } = renderPreview();
    expect(within(dialog).queryByRole("columnheader", { name: "Finish now" })).toBeNull();
  });

  it("marks a move that starts within the hour", () => {
    const { dialog } = renderPreview({ changes: [change({ startsSoon: true })] });
    // Once for the phone block, once for the desktop table: only one is displayed at a time.
    expect(within(dialog).getAllByText("Starts within the hour").length).toBe(2);
  });

  it("does not print a move table when nothing moves", () => {
    const { dialog } = renderPreview({
      changes: [change({ kind: "newly-placed", fromStart: null })],
      summary: summary({ movedCount: 0, newlyPlacedCount: 1 }),
    });
    expect(within(dialog).queryByRole("columnheader", { name: "Shift" })).toBeNull();
    expect(within(dialog).getByText(/placed for the first time/)).toBeTruthy();
  });

  it("refuses to apply a plan that could not place everything, and says why beside the button", () => {
    const { dialog, onApply } = renderPreview({
      blocked: { count: 2, reason: "No court is free for these.", labels: ["MD R1", "MS R2"] },
    });
    const apply = within(dialog).getByRole("button", { name: "Apply rebuild" });
    expect(apply.hasAttribute("disabled")).toBe(true);
    // The reason is in the footer, pointed at by the control it disables.
    const reason = dialog.querySelector("#apply-blocked-reason");
    expect(reason?.textContent).toMatch(/2 matches could not be placed/);
    expect(apply.getAttribute("aria-describedby")).toBe("apply-blocked-reason");
    expect(within(dialog).getByText("No court is free for these.")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("offers a cancel named after the outcome rather than the widget", () => {
    const { dialog, onCancel } = renderPreview();
    within(dialog).getByRole("button", { name: "Keep current schedule" }).click();
    expect(onCancel).toHaveBeenCalled();
  });

  it("keeps the dry-run promise in the header", () => {
    const { dialog } = renderPreview();
    expect(dialog.textContent).toContain("Nothing is written until you apply.");
  });
});
