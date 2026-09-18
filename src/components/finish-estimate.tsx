/**
 * The shared rendering of a finish estimate.
 *
 * Everything that answers "when does this tournament finish?" goes through here, so the
 * `/placement-schedule` summary bar, its rebuild preview and the Desk KPI cannot invent three
 * different phrasings of the same number. The wording itself lives in
 * `finish-wording.ts`; this file only chooses between an inline sentence and a tile.
 */

import { StatTile } from "@/components/app-shell";
import type { FinishEstimate as FinishEstimateValue } from "@/lib/tournament/finish-estimate";
import { finishEstimateWording } from "@/lib/tournament/finish-wording";

interface FinishEstimateProps {
  estimate: FinishEstimateValue;
  /** The same estimator run against the live rows, for a rebuilt-vs-current comparison. */
  current?: FinishEstimateValue | null | undefined;
  variant?: "inline" | "tile";
}

export function FinishEstimate({
  estimate,
  current = null,
  variant = "inline",
}: FinishEstimateProps) {
  const wording = finishEstimateWording(estimate, current);

  if (variant === "tile") {
    const hint = [wording.tileHint, wording.comparison].filter(Boolean).join(" · ");
    return (
      <StatTile label="Estimated finish" value={wording.value} hint={hint} tone={wording.tone} />
    );
  }

  return (
    <span title={wording.note}>
      {wording.headline}
      {wording.detail ? <span className="text-muted-foreground"> · {wording.detail}</span> : null}
      {wording.comparison ? (
        <span className="text-muted-foreground"> · {wording.comparison}</span>
      ) : null}
    </span>
  );
}
