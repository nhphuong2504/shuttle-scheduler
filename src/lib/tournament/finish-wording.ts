/**
 * The one place that turns a `FinishEstimate` into words.
 *
 * All three surfaces that answer "when does this tournament finish?" — the
 * `/placement-schedule` summary bar, its rebuild preview and the Desk KPI — render
 * through here, so they cannot drift into three different phrasings of the same
 * number. The rules are deliberately conservative:
 *
 *   * a placed tournament reads `Finishes 01:30`;
 *   * forecast work that fits reads `Estimated finish ~01:45` plus how much is left;
 *   * work that only fits by overrunning names the extension, never the official
 *     close as if it were the finish;
 *   * work that cannot be placed at all names no clock time, only the match count;
 *   * rows that are already an impossible layout say so rather than inventing a time.
 *
 * The forecast is structural: it assumes every slot takes its configured duration and
 * that one person can play in every event they are entered in. It is labelled as an
 * estimate for exactly that reason, so the UI never implies a guarantee.
 */

import type { FinishEstimate } from "./finish-estimate";
import { timeLabel } from "./format";
import { formatProjectedFinishDelta } from "./schedule-diff";

const MINUTE = 60_000;

export interface FinishWording {
  /** The line the desk reads first. */
  headline: string;
  /** The supporting line, or null when there is nothing useful to add. */
  detail: string | null;
  /** Structural-estimate disclosure, shown as a caption or a tooltip. */
  note: string;
  /** How the comparison against the current state reads, or null when there is none. */
  comparison: string | null;
  /** A compact value for a tile: the estimated clock time, or "—" when none can be named. */
  value: string;
  /** A tile's supporting line: the one thing that adds meaning under the value. */
  tileHint: string;
  tone: "normal" | "good" | "warn" | "danger";
}

const NOTE =
  "Structural estimate: assumes every slot takes its full duration and does not account for one player appearing in several events.";

function matches(count: number): string {
  return `${count} ${count === 1 ? "match" : "matches"}`;
}

function days(count: number): string {
  return `${count} ${count === 1 ? "day" : "days"}`;
}

/**
 * `estimate` is the forecast being shown. `current` is the same estimator run against the live
 * rows, when there is a rebuilt-vs-current comparison to make.
 */
export function finishEstimateWording(
  estimate: FinishEstimate,
  current?: FinishEstimate | null,
): FinishWording {
  const time = estimate.finish ? timeLabel(estimate.finish) : null;
  const comparison = comparisonWording(estimate, current ?? null);

  if (estimate.basis === "placed") {
    return {
      headline: time ? `Finishes ${time}` : "Finishes —",
      detail: null,
      note: NOTE,
      comparison,
      value: time ?? "—",
      tileHint: comparison ?? "Nothing left to place",
      tone: "good",
    };
  }

  if (estimate.basis === "projected") {
    const detail = `${matches(estimate.remainingMatches)} still to place`;
    return {
      headline: time ? `Estimated finish ~${time}` : "Estimated finish —",
      detail,
      note: NOTE,
      comparison,
      value: time ? `~${time}` : "—",
      tileHint: detail,
      tone: "normal",
    };
  }

  // The rows as they stand cannot be simulated at all. Naming no time is the honest answer; naming
  // one would be inventing it.
  if (estimate.basis === "invalid") {
    const detail = `${matches(estimate.remainingMatches)} still to place`;
    return {
      headline: "Finish estimate unavailable",
      detail: `The current court layout already conflicts · ${detail}`,
      note: NOTE,
      comparison,
      value: "—",
      tileHint: "Court layout conflicts — resolve them to get a forecast",
      tone: "warn",
    };
  }

  // Overflow. Two honest renderings, never a made-up official close.
  if (estimate.finish != null && estimate.deficitMinutes != null) {
    const headline = `Needs ~${estimate.deficitMinutes} min beyond the tournament window`;
    return {
      headline,
      detail: `Estimated finish ~${time} if courts remain available`,
      note: NOTE,
      comparison,
      value: `~${time}`,
      tileHint: headline,
      tone: "warn",
    };
  }

  const dayCount = estimate.days > 0 ? days(estimate.days) : "the configured days";
  const headline = `Cannot finish in ${dayCount}`;
  return {
    headline,
    detail: `${matches(estimate.remainingMatches)} still need capacity`,
    note: NOTE,
    comparison,
    value: "—",
    tileHint: headline,
    tone: "danger",
  };
}

/** Forecast-against-forecast only; a floor is never compared with a forecast. */
function comparisonWording(
  estimate: FinishEstimate,
  current: FinishEstimate | null,
): string | null {
  if (!estimate.finish || current?.finish == null) return null;
  const delta = Math.round((Date.parse(estimate.finish) - Date.parse(current.finish)) / MINUTE);
  return formatProjectedFinishDelta(delta);
}
