import { Panel } from "@/components/app-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MAX_TOURNAMENT_DAYS,
  buildDayRange,
  countIsoDays,
  shiftIsoDate,
  type DraftForm,
} from "./types";

/**
 * How long the tournament runs, as a start and end date.
 *
 * Nothing else is asked for here. Each day's hours, courts and breaks are set at
 * the first build, once the venue's courts exist — asking for them before the
 * tournament is even active is what made setup feel like it was asking twice.
 */
export function DaysStep({
  form,
  onChange,
}: {
  form: DraftForm;
  onChange: (patch: Partial<DraftForm>) => void;
}) {
  const days = form.days;
  const start = days[0]?.date ?? "";
  const end = days.length ? (days[days.length - 1]?.date ?? "") : "";
  // The picker mirrors the database's own limit, so a range that could never be
  // saved is not selectable in the first place.
  const lastAllowed = start ? shiftIsoDate(start, MAX_TOURNAMENT_DAYS - 1) : undefined;

  /**
   * Rebuilds the day rows from a start/end pair.
   *
   * The end is clamped into range rather than rejected, so dragging the range
   * around never produces an error the host has to undo: moving the start past
   * the end collapses to a single day instead of failing.
   */
  const applyRange = (nextStart: string, nextEnd: string) => {
    if (!nextStart) {
      onChange({ days: [] });
      return;
    }
    let nextLast = nextEnd || nextStart;
    if (nextLast < nextStart) nextLast = nextStart;
    const ceiling = shiftIsoDate(nextStart, MAX_TOURNAMENT_DAYS - 1);
    if (nextLast > ceiling) nextLast = ceiling;
    onChange({ days: buildDayRange(nextStart, nextLast) });
  };

  const span = start ? countIsoDays(start, end || start) : 0;

  return (
    <div className="space-y-4">
      <Panel title="Tournament dates">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="t-range-start">Start date</Label>
            <Input
              id="t-range-start"
              type="date"
              value={start}
              onChange={(e) => applyRange(e.target.value, end)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-range-end">End date</Label>
            <Input
              id="t-range-end"
              type="date"
              value={end}
              min={start || undefined}
              max={lastAllowed}
              disabled={!start}
              onChange={(e) => applyRange(start, e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              One date is a one-day tournament. The range can be at most {MAX_TOURNAMENT_DAYS} days.
            </p>
          </div>
        </div>
      </Panel>

      <Panel
        title="Days"
        right={
          <span className="font-score text-[11px] text-muted-foreground">
            {span ? `${span} day${span === 1 ? "" : "s"}` : "No dates"}
          </span>
        }
      >
        {days.length === 0 ? (
          <p className="text-sm text-muted-foreground">Pick a start date to set the range.</p>
        ) : (
          <ol className="divide-y divide-hairline">
            {days.map((day, index) => (
              <li key={day.date} className="flex items-center gap-3 py-2 text-sm">
                <span className="font-display w-14 shrink-0 text-xs font-semibold text-muted-foreground">
                  Day {index + 1}
                </span>
                <span className="font-score">{day.date}</span>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel title="Set up at the first build">
        <p className="text-xs text-muted-foreground">
          Each day&apos;s opening and closing times, the courts it plays on and its breaks are
          configured on the Schedule page, where the courts actually exist. Match lengths and
          scoring rules are set there too. Nothing is lost by leaving them until then — they are not
          needed until the schedule is built.
        </p>
      </Panel>
    </div>
  );
}
