/**
 * The live-connection readout, shared by the two surfaces that show one.
 *
 * It was the Desk's alone, and the Schedule page had grown its own copy: a bare span with
 * no `role`, no treatment, and a ternary that collapsed `error` into "Offline". Three
 * things were wrong with the copy, and only the first is cosmetic.
 *
 * - **It said the wrong thing.** A `CHANNEL_ERROR` or `TIMED_OUT` is a connection error,
 *   not a loss of connectivity, and the two need different reactions: offline is usually
 *   the venue's wifi and clears itself, an error usually does not. The Desk had always
 *   distinguished them; the Schedule page reported both as "Offline", so a host watching
 *   a rebuild had no way to tell "wait" from "something is broken".
 * - **It was not a live region.** The Desk's carried `role="status"`, so a screen reader
 *   announces the transition. The Schedule page's did not, so the same fact that is
 *   announced on one surface was silent on the other.
 * - **"Live" alone was ambiguous where it sat.** On the Desk the badge is in the page's
 *   header and reads as the screen's own health. On the Schedule page it sat in a stats
 *   strip beside "13 matches scheduled", where a bare "Live" can be read as a match being
 *   live - which is a meaning this design system reserves for `--state-live-*`, the very
 *   token pair the badge draws in. The wording below disambiguates both non-live states
 *   ("live updates paused") so the word never stands alone. The age of the last change is
 *   kept out of the chip: a connected screen with nothing new to report is healthy.
 *
 * The clock is owned here rather than passed in. It was a prop because the Desk already
 * ticks a `now` for overdue detection and court state, so the badge could borrow it; but
 * that made the age a function of whichever caller happened to have a timer, and a second
 * caller did not. A component that renders an age is the thing that should age it.
 */
import { useEffect, useState } from "react";

/** How often the "last change" age is re-read. Matches the Desk's own tick. */
const TICK_MS = 30_000;

export function ConnectionBadge({
  status,
  lastUpdatedAt,
}: {
  status: "connecting" | "live" | "offline" | "error";
  /** When the last realtime change arrived, so the age is real rather than decorative. */
  lastUpdatedAt: number;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(tick);
  }, []);

  const ageMinutes = Math.max(0, Math.floor((now - lastUpdatedAt) / 60_000));
  const label =
    status === "live"
      ? "Live"
      : status === "offline"
        ? "Offline · live updates paused"
        : status === "error"
          ? "Connection problem · live updates paused"
          : "Connecting";
  // The age is a second, quiet fact: a connected screen with nothing new to report is healthy,
  // so it is kept out of the chip and never recolours it. Only a healthy connection shows it.
  const quiet = status === "live" && ageMinutes > 1;
  return (
    <span role="status" className="inline-flex items-center gap-2">
      <span
        className={`rounded-full px-2.5 py-1 text-sm font-semibold ${
          status === "live"
            ? "bg-state-live-chip text-state-live-ink"
            : status === "offline" || status === "error"
              ? "bg-danger-surface text-danger-foreground"
              : "bg-warn-surface text-warn-foreground"
        }`}
      >
        {label}
      </span>
      {quiet ? (
        <span className="text-sm text-muted-foreground">
          <span aria-hidden="true">· </span>last change {ageMinutes} min ago
        </span>
      ) : null}
    </span>
  );
}
