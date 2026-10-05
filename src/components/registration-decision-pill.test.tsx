// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RegistrationDecisionPill, RegistrationStatePill } from "@/components/app-shell";
import {
  REGISTRATION_DECISIONS,
  registrationDecisionLabel,
} from "@/lib/tournament/registration-state";

/**
 * The participant's own request, as a rendered chip.
 *
 * Each decision carries a glyph and a word, so colour is never the only channel.
 * The word comes from `registration-state.ts` and the glyph is drawn in `app-shell.tsx`, and
 * only a render sees both - which is exactly the gap the source-level guards cannot cover.
 *
 * The other half is the pair that *could* be confused: this is the second registration
 * vocabulary, and the window's own pill sits above it on the same page. They are asserted to
 * be different components with different words, because "Open" and "Awaiting decision" are
 * two answers to two questions that are both live at once.
 */

afterEach(cleanup);

const chip = (decision: (typeof REGISTRATION_DECISIONS)[number]) => {
  const { container } = render(<RegistrationDecisionPill decision={decision} />);
  return container.querySelector("span")!;
};

describe("RegistrationDecisionPill", () => {
  it("gives every decision a word and a glyph", () => {
    // Derived from the vocabulary rather than restating it, so a fourth decision added to
    // the union without a treatment fails here instead of shipping as bare text.
    for (const decision of REGISTRATION_DECISIONS) {
      const rendered = chip(decision);
      expect(rendered.textContent, `${decision} label`).toBe(registrationDecisionLabel(decision));
      expect(rendered.querySelector("svg"), `${decision} glyph`).not.toBeNull();
    }
  });

  it("does not reuse the window's own chip", () => {
    // Both render on the tournament page, and both are registration-shaped: one is "may I
    // ask", the other is "what did they say". Two questions, two vocabularies, two glyphs -
    // and the words differ, which is the channel a reader actually reads.
    const { container: window } = render(<RegistrationStatePill state="open" />);
    const open = window.querySelector("span")!;
    const pending = chip("pending");

    expect(open.textContent).not.toBe(pending.textContent);
    const openPaths = [...open.querySelectorAll("path, circle, rect")].map((n) =>
      n.getAttribute("d") ?? `${n.tagName}${n.getAttribute("cx")}`,
    );
    const pendingPaths = [...pending.querySelectorAll("path, circle, rect")].map((n) =>
      n.getAttribute("d") ?? `${n.tagName}${n.getAttribute("cx")}`,
    );
    expect(pendingPaths).not.toEqual(openPaths);
  });
});
