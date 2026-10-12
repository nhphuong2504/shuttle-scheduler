// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConnectionBadge } from "@/components/connection-badge";

/**
 * The connection readout is shared by the Desk and the Schedule page, and this file is
 * why it is shared rather than copied.
 *
 * The Schedule page used to render its own: a bare span whose ternary sent both `offline`
 * and `error` to the word "Offline". Two of the four states in the union therefore reached
 * the reader as the same word, and the one it hid - `error`, which the hook sets on
 * `CHANNEL_ERROR` and `TIMED_OUT` - is the one that needs a different reaction. Offline is
 * usually the venue's wifi and clears itself; a channel error usually does not. Copies drift,
 * so there is now one component and these assertions are about the vocabulary itself.
 *
 * The rendered checks are the half a source grep cannot do: `role="status"` is what makes
 * a screen reader announce the change, and it was on the Desk's copy and missing from the
 * Schedule page's.
 */

afterEach(cleanup);

const badge = (status: "connecting" | "live" | "offline" | "error", lastUpdatedAt?: number) => {
  const { container } = render(
    <ConnectionBadge status={status} lastUpdatedAt={lastUpdatedAt ?? Date.now()} />,
  );
  return container.querySelector("span")!;
};

describe("ConnectionBadge gives every connection state its own word", () => {
  it("names the four states distinctly, so no two are conflated", () => {
    const words = (["connecting", "live", "offline", "error"] as const).map(
      (status) => badge(status).textContent,
    );
    expect(words).toEqual([
      "Connecting",
      "Live",
      "Offline · live updates paused",
      "Connection problem · live updates paused",
    ]);
    expect(new Set(words).size).toBe(words.length);
  });

  it("reports a channel error as a problem rather than as being offline", () => {
    // The defect this component closes. Both states are failures, but only one is the
    // reader's to fix by waiting, and a shared word would say they are the same problem.
    expect(badge("error").textContent).not.toBe(badge("offline").textContent);
    expect(badge("error").textContent).toContain("Connection problem");
  });

  it("says what an offline screen cannot do, rather than only that it is offline", () => {
    // "Live" alone sat in a stats strip beside "13 matches scheduled", where it could be
    // read as a match being live - the meaning `--state-live-*` is reserved for. Both
    // non-live failure words carry their consequence so the word never stands alone.
    expect(badge("offline").textContent).toBe("Offline · live updates paused");
  });

  it("keeps connection health apart from the time of the last change", () => {
    // A connected screen with nothing new is healthy: the chip stays "Live" and the age is
    // a separate, quiet note. It is shown only while connected - on a failed connection an
    // age would read as the cause rather than as a fact.
    expect(badge("live").textContent).toBe("Live");
    const { container } = render(
      <ConnectionBadge status="live" lastUpdatedAt={Date.now() - 5 * 60_000} />,
    );
    const chip = container.querySelector("span > span")!;
    expect(chip.textContent).toBe("Live");
    expect(container.textContent).toContain("last change 5 min ago");
    expect(badge("offline", Date.now() - 5 * 60_000).textContent).not.toContain("last change");
  });
});

describe("ConnectionBadge announces its state", () => {
  it("is a live region, so the transition is announced", () => {
    // Absent from the Schedule page's copy, which is the accessibility half of the defect:
    // the same fact was announced on one surface and silent on the other.
    for (const status of ["connecting", "live", "offline", "error"] as const) {
      expect(badge(status).getAttribute("role"), `${status} is not a live region`).toBe("status");
    }
  });
});
