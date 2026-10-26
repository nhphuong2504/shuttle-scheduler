import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ScheduleSummary } from "@/lib/tournament/actions";
import { dayDateLabel, timeLabel } from "@/lib/tournament/format";
import type { DayFinishComparison, PlanChange } from "@/lib/tournament/schedule-diff";
import { cn } from "@/lib/utils";

/**
 * The rebuild preview, shared by both scheduling editors.
 *
 * It exists as one component because the two formats used to draw two dialogs with one title and
 * different amounts of information: the round-robin one led with a projected finish and its
 * delta, the placement one with a per-day table and no delta at all. A reader could not tell,
 * from the dialog, which of the two they were looking at or whether the change was an
 * improvement.
 *
 * The order is the order the decision is made in:
 *
 *   1. what would change, in one sentence, with the cost that is actually paid - moves that land
 *      on a match starting soon;
 *   2. each day's finish now against its finish after, which is the comparison a preview exists
 *      to make;
 *   3. the moves themselves, grouped by the day they land on;
 *   4. what could not be placed, which is the one case where the answer is "no".
 *
 * Nothing here writes. The dry-run promise is the caller's, and it is stated in the header.
 */

export interface RebuildPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * What this editor may promise the reader. The two formats state the same guarantee in
   * slightly different words, so the sentence is the caller's.
   */
  invariant: string;
  summary?: Pick<
    ScheduleSummary,
    | "currentProjectedFinish"
    | "projectedFinish"
    | "projectedFinishDeltaMinutes"
    | "movedCount"
    | "newlyPlacedCount"
    | "movesSoonCount"
    | "anchorCount"
  > | null;
  days: readonly DayFinishComparison[];
  changes: readonly PlanChange[];
  /** The compact identity and the full pairing for one change. */
  describe: (change: PlanChange) => { identity: string; names: string };
  blocked: { count: number; reason: string | null; labels: readonly string[] };
  awaitingTeams: number;
  busy: boolean;
  onCancel: () => void;
  onApply: () => void;
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * What the dialog draws while it is closed.
 *
 * `Dialog` stays mounted so its exit animation can run, so the props are read on a frame where
 * there is no plan at all. One shared empty value keeps that frame from being a second code path.
 */
const EMPTY_SUMMARY = {
  currentProjectedFinish: null,
  projectedFinish: null,
  projectedFinishDeltaMinutes: null,
  movedCount: 0,
  newlyPlacedCount: 0,
  movesSoonCount: 0,
  anchorCount: 0,
} as const;

/** `+6 min` / `-18 min` / `—`. */
function shiftLabel(shiftMinutes: number): string {
  if (shiftMinutes === 0) return "—";
  return `${shiftMinutes > 0 ? "+" : ""}${shiftMinutes} min`;
}

/** `45 min`, or `1 h 10 min` once it is an hour or more. */
function minutesLabel(minutes: number): string {
  const abs = Math.abs(minutes);
  if (abs < 60) return `${abs} min`;
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * The one sentence the reader came for.
 *
 * It states the finish they have, the finish they would get, and by how much it moves - the
 * comparison the dialog used to leave implicit. When there is nothing to compare (a first build,
 * or a plan that moves nothing) it says so instead of printing a table of zeroes.
 */
export function rebuildVerdict(
  summary: Pick<
    ScheduleSummary,
    | "currentProjectedFinish"
    | "projectedFinish"
    | "projectedFinishDeltaMinutes"
    | "newlyPlacedCount"
    | "movesSoonCount"
  >,
  changes: readonly PlanChange[],
): { headline: string; detail: string; tone: "neutral" | "warn" } {
  const moves = changes.filter(
    (change) => change.kind !== "unchanged" && change.kind !== "newly-placed",
  );
  const soon = moves.filter((change) => change.startsSoon).length;
  const delta = summary.projectedFinishDeltaMinutes;
  const after = summary.projectedFinish ? timeLabel(summary.projectedFinish) : null;
  const before = summary.currentProjectedFinish
    ? timeLabel(summary.currentProjectedFinish)
    : null;

  if (moves.length === 0) {
    const newly = summary.newlyPlacedCount ?? changes.length;
    return {
      headline:
        newly === 0
          ? "Nothing would move"
          : `Nothing would move — ${plural(newly, "match", "matches")} would be slotted in`,
      detail:
        newly === 0
          ? "The current schedule is already the plan."
          : "Every time already published stays exactly where it is.",
      tone: "neutral",
    };
  }

  const changeWord =
    delta == null || delta === 0
      ? ""
      : `${minutesLabel(delta)} ${delta > 0 ? "later" : "earlier"}`;
  const finish =
    after && before
      ? delta === 0
        ? `The last match would still finish at ${after}.`
        : `The last match would finish at ${after} instead of ${before}${
            changeWord ? ` — ${changeWord}` : ""
          }.`
      : after
        ? `The last match would finish at ${after}.`
        : "";

  const moved = `${plural(moves.length, "match", "matches")} would move`;
  const cost =
    soon === 0
      ? ""
      : soon === moves.length
        ? `, and ${moves.length === 1 ? "it starts" : "all of them start"} within the hour`
        : `, ${soon} of them starting within the hour`;

  return {
    headline: `${moved}${cost}.`,
    detail: finish,
    tone: soon > 0 ? "warn" : "neutral",
  };
}

export function RebuildPreviewDialog(props: RebuildPreviewProps) {
  const { open, onOpenChange, days, changes, describe, blocked, awaitingTeams } = props;
  const summary = props.summary ?? EMPTY_SUMMARY;
  const verdict = rebuildVerdict(summary, changes);

  // A first build places everything, and a list of eighty-five new rows is not the answer the
  // reader needs. Only real moves are listed; the count of first placements is in the verdict.
  const moves = changes.filter(
    (change) => change.kind !== "unchanged" && change.kind !== "newly-placed",
  );
  const byDay = new Map<number | null, PlanChange[]>();
  for (const change of moves) {
    const key = change.dayNumber ?? null;
    byDay.set(key, [...(byDay.get(key) ?? []), change]);
  }
  const dayNumbers = [...byDay.keys()].sort((a, b) => (a ?? 0) - (b ?? 0));

  const applyBlocked = blocked.count > 0;
  const applyReason = applyBlocked
    ? `${plural(blocked.count, "match", "matches")} could not be placed, so this plan is not ready to apply.`
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Rebuild preview</DialogTitle>
          <DialogDescription>
            Nothing is written until you apply. {props.invariant}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 overflow-y-auto pr-1">
          <div
            className={cn(
              "rounded-lg border px-3 py-2.5",
              verdict.tone === "warn"
                ? "border-warn-border bg-warn-surface text-warn-foreground"
                : "border-hairline bg-surface",
            )}
          >
            <p className="text-base font-semibold">{verdict.headline}</p>
            {verdict.detail ? (
              <p className="mt-0.5 text-sm text-muted-foreground">{verdict.detail}</p>
            ) : null}
          </div>

          {days.length > 1 ? (
            <div className="overflow-x-auto rounded-md border border-hairline">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="w-28">Finish now</th>
                    <th className="w-28">Finish after</th>
                    <th className="w-20">Moves</th>
                    <th className="w-32">Largest shift (min)</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((day) => (
                    <tr key={day.dayNumber}>
                      <td className="text-sm">
                        {dayDateLabel(day.date)}
                        {day.overrunAfterMinutes > 0 ? (
                          <span className="ml-2 text-sm text-warn-foreground">
                            {day.overrunAfterMinutes} min past close
                          </span>
                        ) : null}
                      </td>
                      <td className="font-score text-sm">
                        {day.finishNowMs != null ? timeLabel(new Date(day.finishNowMs)) : "—"}
                      </td>
                      <td className="font-score text-sm">
                        {day.finishAfterMs != null ? timeLabel(new Date(day.finishAfterMs)) : "—"}
                      </td>
                      <td className="font-score text-sm">{day.moved}</td>
                      <td className="font-score text-sm">
                        {day.largestShiftMinutes > 0 ? day.largestShiftMinutes : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {applyBlocked ? (
            <div className="rounded-md bg-danger-surface px-3 py-2 text-sm text-danger-foreground">
              <p className="font-semibold">
                {plural(blocked.count, "match", "matches")} could not be placed.
              </p>
              {blocked.reason ? <p className="mt-1 text-sm">{blocked.reason}</p> : null}
              <ul className="mt-2 space-y-1 text-sm">
                {blocked.labels.map((label, index) => (
                  <li key={`${label}-${index}`}>{label}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {awaitingTeams > 0 ? (
            <div className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              {plural(awaitingTeams, "match", "matches")} waiting on a bracket and will stay
              unscheduled.
            </div>
          ) : null}

          {moves.length === 0 && !applyBlocked ? (
            <p className="text-sm text-muted-foreground">
              {changes.length > 0
                ? `${plural(changes.length, "match", "matches")} would be placed for the first time.`
                : "Nothing is left to place."}
            </p>
          ) : (
            <div className="space-y-4">
              {dayNumbers.map((dayNumber) => {
                const rows = byDay.get(dayNumber) ?? [];
                const date = days.find((day) => day.dayNumber === dayNumber)?.date;
                return (
                  <section key={dayNumber ?? "unknown"} className="space-y-2">
                    <h3 className="font-display text-sm font-semibold">
                      {date ? dayDateLabel(date) : "Day not set"}{" "}
                      <span className="ml-2 font-score text-sm font-normal text-muted-foreground">
                        {plural(rows.length, "move", "moves")}
                      </span>
                    </h3>
                    <div className="overflow-hidden rounded-md border border-hairline">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Match</th>
                            <th className="w-32">Time</th>
                            <th className="w-40">Court</th>
                            <th className="w-24">Shift</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((change) => {
                            const { identity, names } = describe(change);
                            return (
                              <tr key={change.matchId}>
                                <td className="text-sm" title={names}>
                                  <span className="font-semibold">{identity}</span>
                                  <span className="ml-2 text-muted-foreground"> {names}</span>
                                  {change.startsSoon ? (
                                    <span className="mt-1 block text-sm font-semibold text-warn-foreground">
                                      Starts within the hour
                                    </span>
                                  ) : null}
                                </td>
                                <td className="whitespace-nowrap font-score text-sm">
                                  {change.fromStart ? timeLabel(change.fromStart) : "—"} →{" "}
                                  {timeLabel(change.toStart)}
                                </td>
                                <td className="whitespace-nowrap font-score text-sm">
                                  {change.fromCourtNumber != null
                                    ? `Court ${change.fromCourtNumber}`
                                    : "—"}{" "}
                                  → Court {change.toCourtNumber}
                                </td>
                                <td className="whitespace-nowrap font-score text-sm">
                                  {shiftLabel(change.shiftMinutes)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          {applyReason ? (
            <p id="apply-blocked-reason" className="text-sm text-danger-foreground">
              {applyReason}
            </p>
          ) : (
            <span />
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
              Keep current schedule
            </Button>
            <Button
              disabled={props.busy || applyBlocked}
              aria-describedby={applyReason ? "apply-blocked-reason" : undefined}
              onClick={props.onApply}
            >
              Apply rebuild
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
