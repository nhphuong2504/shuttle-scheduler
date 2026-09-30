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
    expect(words).toEqual(["Connecting", "Live", "Offline · changes unavailable", "Connection error"]);
    expect(new Set(words).size).toBe(words.length);
  });

  it("reports a channel error as an error rather than as being offline", () => {
    // The defect this component closes. Both states are failures, but only one is the
    // reader's to fix by waiting, and a shared word would say they are the same problem.
    expect(badge("error").textContent).not.toBe(badge("offline").textContent);
    expect(badge("error").textContent).toContain("Connection error");
  });

  it("says what an offline screen cannot do, rather than only that it is offline", () => {
    // "Live" alone sat in a stats strip beside "13 matches scheduled", where it could be
    // read as a match being live - the meaning `--state-live-*` is reserved for. Both
    // non-live failure words carry their consequence so the word never stands alone.
    expect(badge("offline").textContent).toBe("Offline · changes unavailable");
  });

  it("carries the age of the last change once it is worth reporting", () => {
    // A stale "Live" is the failure this addresses: a screen that stopped receiving and
    // never said so. Under a minute the age is noise; past it, it is the signal.
    expect(badge("live").textContent).toBe("Live");
    expect(badge("live", Date.now() - 5 * 60_000).textContent).toBe("Live · last change 5m ago");
  });
});

describe("ConnectionBadge renders through the shared vocabulary", () => {
  it("is a live region, so the transition is announced", () => {
    // Absent from the Schedule page's copy, which is the accessibility half of the defect:
    // the same fact was announced on one surface and silent on the other.
    for (const status of ["connecting", "live", "offline", "error"] as const) {
      expect(badge(status).getAttribute("role"), `${status} is not a live region`).toBe("status");
    }
  });

  it("draws each state in an existing token pair rather than a new one", () => {
    // Live borrows the live state pair; both failures take the danger pair; connecting
    // takes the warn pair. Nothing here is a new colour, which is the rule the design
    // system states for a state that reuses an existing meaning.
    expect(badge("live").className).toContain("bg-state-live-chip");
    expect(badge("live").className).toContain("text-state-live-ink");
    for (const status of ["offline", "error"] as const) {
      expect(badge(status).className).toContain("bg-danger-surface");
      expect(badge(status).className).toContain("text-danger-foreground");
    }
    expect(badge("connecting").className).toContain("bg-warn-surface");
    expect(badge("connecting").className).toContain("text-warn-foreground");
  });

  it("stays on the scaled tiers", () => {
    // `text-xs` is the 12px floor, which is where the Desk has always drawn it. Pinned
    // because the badge moved file in this change and a size could have moved with it.
    expect(badge("live").className).toContain("text-xs");
  });
});
