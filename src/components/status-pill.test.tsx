// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ByeMarker, StatusPill } from "@/components/app-shell";
import {
  displayStateFor,
  MATCH_DISPLAY_LABEL,
  MATCH_DISPLAY_STATES,
  MATCH_DISPLAY_TIER,
  PERSISTED_MATCH_STATUSES,
} from "@/lib/tournament/match-status";

/**
 * Layer 1 of the staff-surface strategy: component rendering.
 *
 * This file is the exemplar for the state matrix. It exists because the matrix is
 * not reachable by driving the app: every route renders for every visitor, and a
 * live tournament holds one status per match, so routing can only ever sample the
 * vocabulary. Mounting the component directly is the only way to cover every
 * permutation at once, and it needs no credentials, so it cannot rot when a
 * session expires.
 *
 * The surface tests in `src/routes/-surfaces.test.ts` read route sources with
 * regex, so they can assert that `StatusPill` is *called* but never what it
 * *renders*. These tests render it, which is the layer that can see the vocabulary
 * itself.
 *
 * Phase 5 rewrote this file's expectations. It previously pinned two defects as
 * current behaviour, so that a rewrite could not happen silently:
 *
 *   - `void` had no label and no tier, and rendered identically to a typo.
 *   - a bye was rendered as a match status - "Walkover" on one surface and
 *     "Completed" on another - when it is a draw condition.
 *
 * Both are fixed, so both are now asserted as *closed* rather than pinned. The
 * loop over `PERSISTED_MATCH_STATUSES` below is the guard that replaces them: it
 * is derived from the vocabulary rather than restating it, so a status added to
 * the schema without a label, a tier or a glyph fails here instead of shipping.
 */

afterEach(cleanup);

const pill = (status: string) => {
  const { container } = render(<StatusPill status={status} />);
  return container.querySelector("span")!;
};

describe("StatusPill renders the status vocabulary", () => {
  it("renders a live match with its label and a glyph", () => {
    const live = pill("in-progress");
    expect(live.textContent).toBe("Live");
    // Every state carries a glyph, so colour is never the only channel.
    expect(live.querySelector("svg")).not.toBeNull();
  });

  /**
   * The guard that replaced the pinned gap.
   *
   * Derived from `PERSISTED_MATCH_STATUSES`, so it cannot fall out of step with the
   * schema the way a hand-written list can. If a sixth status is ever permitted by
   * a migration and not added to the vocabulary, this loop renders nothing for it
   * and the assertions below fail - which is the point.
   */
  it("gives every persisted status a label, a tier and a glyph", () => {
    for (const status of PERSISTED_MATCH_STATUSES) {
      const display = displayStateFor(status);
      expect(display, `${status} has no display state`).not.toBeNull();
      if (!display) continue;

      expect(MATCH_DISPLAY_LABEL[display], `${status} has no label`).toBeTruthy();
      expect(MATCH_DISPLAY_TIER[display], `${status} has no tier`).toBeGreaterThanOrEqual(1);

      const rendered = pill(status);
      expect(rendered.textContent, `${status} label not rendered`).toBe(
        MATCH_DISPLAY_LABEL[display],
      );
      expect(rendered.querySelector("svg"), `${status} has no glyph`).not.toBeNull();
      // Not the fallback: an unplanned value prints its own raw string.
      expect(rendered.textContent).not.toBe(status);
    }
  });

  it("renders void as a known status, not as an unrecognised value", () => {
    // `void` is in the CHECK constraint on every match table, so it is a status the
    // domain can hold; it previously fell through to the same branch as a typo.
    const voided = pill("void");
    expect(voided.textContent).toBe("Void");
    expect(voided.querySelector("svg")).not.toBeNull();
  });

  it("separates the two archived statuses by label", () => {
    expect(pill("reported").textContent).toBe("Completed");
    expect(pill("walkover").textContent).toBe("Walkover");
  });

  it("prints an unrecognised status rather than rendering nothing", () => {
    expect(pill("something-new").textContent).toBe("something-new");
  });

  it("never presents a bye as a match status", () => {
    // `bye` is permitted by two CHECK constraints and written by nothing, and the
    // vocabulary is a closed set of five statuses that does not include it. It is
    // routed to ByeMarker at every render site instead - see `match-status.test.ts`
    // for the predicate and the surface tests for the call sites.
    expect(displayStateFor("bye")).toBeNull();
    expect(MATCH_DISPLAY_STATES).not.toContain("bye");
  });
});

describe("ByeMarker draws a draw condition, not a status", () => {
  it("has its own label and glyph", () => {
    const { container } = render(<ByeMarker />);
    const marker = container.querySelector("span")!;

    expect(marker.textContent).toBe("Bye");
    expect(marker.querySelector("svg")).not.toBeNull();
  });

  it("advances rather than reusing the walkover glyph", () => {
    // The most confusable pair in the vocabulary, so they are asserted to differ.
    const { container: bye } = render(<ByeMarker />);
    const { container: walkover } = render(<StatusPill status="walkover" />);
    const byePaths = [...bye.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    const walkoverPaths = [...walkover.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    expect(byePaths).not.toEqual(walkoverPaths);
    expect(byePaths.length).toBeGreaterThan(0);
  });
});
