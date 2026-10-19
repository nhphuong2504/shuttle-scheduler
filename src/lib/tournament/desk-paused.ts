/**
 * When the Desk's live updates stopped, so the page can say "as of" that moment.
 *
 * The connection badge already says *that* updates are paused. This keeps *since when*: the
 * instant the status first left live for offline or error. Everything the Desk derives from the
 * clock - lateness, overruns, when a court frees - is then computed at that instant rather than
 * now, because the data it is computed from is that old: a match that has started since would
 * otherwise read as later and later. The venue clock keeps running; only the derived numbers
 * hold still, and the page marks them "as of".
 *
 * "Connecting" does not pause anything: it is the first moments of a reconnect, and the data
 * has not had time to go stale.
 */

export type LiveStatus = "connecting" | "live" | "offline" | "error";

/** Whether live updates are paused: the browser is offline, or the channel has failed. */
export function isPaused(status: LiveStatus): boolean {
  return status === "offline" || status === "error";
}

/**
 * The next "paused since" value. Keeps the first instant of a pause through every later status
 * that is still a pause (offline then error is one outage), clears it once live again, and
 * leaves it alone while reconnecting.
 */
export function nextPausedSince(previous: number | null, status: LiveStatus, now: number): number | null {
  if (isPaused(status)) return previous ?? now;
  if (status === "live") return null;
  return previous;
}
