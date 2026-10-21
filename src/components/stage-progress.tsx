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

const STATUS_GLYPH = { completed: "✓", current: "●", waiting: "○" } as const;
const STATUS_WORD = { completed: "Completed", current: "In progress", waiting: "Waiting" } as const;
const GLYPH_TONE = {
  completed: "text-success-foreground",
  current: "text-foreground",
  waiting: "text-muted-foreground",
} as const;

interface EventBlock {
  key: string;
  label: string;
  rows: StageProgressRow[];
}

/** Rows arrive ordered by event, so grouping is a single pass that keeps that order. */
function blocksByEvent(rows: readonly StageProgressRow[]): EventBlock[] {
  const groups = new Map<string, EventBlock>();
  for (const row of rows) {
    const label = row.eventLabel ?? "Event";
    const group = groups.get(label) ?? { key: label, label, rows: [] };
    group.rows.push(row);
    groups.set(label, group);
  }
  return [...groups.values()];
}

function Bar({ row }: { row: StageProgressRow }) {
  if (row.total <= 0) {
    return <span aria-hidden className="block h-0 border-t border-dashed border-hairline" />;
  }
  const pct = Math.min(100, Math.round((row.completed / row.total) * 100));
  return (
    <span aria-hidden className="block h-1.5 overflow-hidden rounded-full bg-muted">
      <span
        className={cn(
          "block h-full rounded-full",
          row.status === "completed" ? "bg-success" : "bg-foreground",
        )}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
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
    <div className="divide-y divide-hairline">
      {blocksByEvent(rows).map((group) => {
        const done = group.rows.reduce((sum, r) => sum + r.completed, 0);
        const total = group.rows.reduce((sum, r) => sum + r.total, 0);
        return (
          <section key={group.key} className="py-2 sm:grid sm:grid-cols-[4.5rem_1fr] sm:gap-x-3">
            <div className="flex items-baseline justify-between gap-2 sm:block">
              <h3 className="text-sm font-semibold">{group.label}</h3>
              {total > 0 ? (
                <span className="font-score text-t4 text-muted-foreground">
                  {done} / {total}
                  <span className="sr-only"> matches completed in this event</span>
                </span>
              ) : null}
            </div>
            <ul className="mt-1 grid gap-x-4 gap-y-2 sm:mt-0 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
              {group.rows.map((row) => (
                <li key={row.key} className="min-w-0 space-y-1 text-t4">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="flex min-w-0 items-baseline gap-1">
                      <span aria-hidden className={cn(GLYPH_TONE[row.status])}>
                        {STATUS_GLYPH[row.status]}
                      </span>
                      <span
                        className={cn(
                          "truncate text-sm",
                          row.status === "waiting" && "text-muted-foreground",
                        )}
                      >
                        {row.stageLabel}
                        {row.roundLabel ? `, ${row.roundLabel}` : ""}
                      </span>
                      <span className="sr-only">{STATUS_WORD[row.status]}</span>
                    </span>
                    {row.total > 0 ? (
                      <span className="font-score shrink-0 text-muted-foreground">
                        {row.completed} / {row.total}
                        <span className="sr-only"> matches completed</span>
                      </span>
                    ) : row.status === "waiting" ? (
                      <span className="shrink-0 text-muted-foreground">No matches yet</span>
                    ) : null}
                  </div>
                  <Bar row={row} />
                  {row.remaining > 0 ? (
                    <div className="text-muted-foreground">
                      <span aria-hidden>{row.remaining} left</span>
                      <span className="sr-only">
                        {row.remaining} match{row.remaining === 1 ? "" : "es"} remaining
                      </span>
                    </div>
                  ) : row.action ? (
                    <div className="font-semibold text-primary">{row.action.label}</div>
                  ) : row.note ? (
                    <div
                      className={
                        row.status === "waiting" ? "text-warn-foreground" : "text-muted-foreground"
                      }
                    >
                      {row.note}
                    </div>
                  ) : null}
                  {row.waitingMatches?.length ? (
                    <details className="text-muted-foreground">
                      <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                        {row.waitingMatches.length} awaiting opponents
                      </summary>
                      <ul className="mt-2 space-y-2">
                        {row.waitingMatches.map((m) => (
                          <li key={m.label}>
                            <span className="font-medium">{m.label}: </span>
                            {m.sourceA} vs {m.sourceB}
                </li>
              ))}
            </ul>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
