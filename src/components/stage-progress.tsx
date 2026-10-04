/**
 * Stage progress, rendered.
 *
 * Two columns of labels and counts with no idea what produced them: every label arrives from an
 * adapter in `stage-progress.ts`. That is what keeps stage and tier names out of the shared
 * view — a new format means a new adapter, not an edit here.
 *
 * The only words this file owns are the generic ones, which are true of every format.
 */

import { EmptyState } from "@/components/app-shell";
import type { StageProgressRow } from "@/lib/tournament/stage-progress";
import { cn } from "@/lib/utils";

function remainingLabel(count: number): string {
  return `${count} match${count === 1 ? "" : "es"} remaining`;
}

export function StageProgressList({ rows }: { rows: readonly StageProgressRow[] }) {
  if (!rows.length) {
    return (
      <EmptyState
        title="No stages yet"
        hint="Generate the placement rounds to see progress here."
      />
    );
  }

  return (
    <ul className="divide-y divide-hairline">
      {rows.map((row) => (
        <li
          key={row.key}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm"
        >
          <span>
            <span className="font-semibold">{row.eventLabel ?? "Event"}</span>{" "}
            <span className="text-muted-foreground">
              {row.stageLabel}
              {row.roundLabel ? ` · ${row.roundLabel}` : ""}
            </span>
          </span>
          <span className="flex items-center gap-3">
            {row.total > 0 ? (
              <span className="font-score text-xs text-muted-foreground">
                {row.completed} / {row.total} matches completed
              </span>
            ) : row.status === "waiting" ? (
              <span className="font-score text-xs text-muted-foreground">No matches yet</span>
            ) : null}
            {row.remaining > 0 ? (
              <span className="text-xs text-muted-foreground">
                {remainingLabel(row.remaining)}
              </span>
            ) : row.action ? (
              <span className="text-xs font-semibold text-primary">{row.action.label}</span>
            ) : row.note ? (
              <span
                className={cn(
                  "text-xs",
                  row.status === "waiting" ? "text-warn-foreground" : "text-muted-foreground",
                )}
              >
                {row.note}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
