import { Check } from "lucide-react";
import { useMemo } from "react";

import {
  isoDatesBetween,
  monthLabel,
  shortDateLabel,
} from "@/lib/tournament/iso-date";
import { cn } from "@/lib/utils";

/**
 * Which days of the tournament window are actually played.
 *
 * The window is what the tournament promises; the playing days are the ones inside it that
 * get matches, court hours and breaks. They need not be consecutive - a window of 20 to 30
 * October may be played on the 20th, the 22nd and the 29th - and there is no limit on how
 * many. So the choice is a calendar of the window's own dates, each one a toggle, rather than
 * a free date field: a date outside the window is not offered, which is the same rule the
 * database enforces for every writer, drawn here so it cannot be broken by typing.
 *
 * Dates are grouped by month because a window has no maximum length, and a single row of a
 * year's days is not something a person can read. A chosen day says so with a tick as well as
 * a fill. A day that already has matches on it cannot be switched off, and says why.
 */
export interface PlayingDayPickerProps {
  /** The window, `YYYY-MM-DD`. */
  startsOn: string;
  endsOn: string;
  /** The dates that are playing days now. */
  chosen: ReadonlySet<string>;
  /** Dates that cannot be switched off, with the reason. */
  locked: ReadonlyMap<string, string>;
  /** True while a write is in flight, or the reader cannot edit. */
  disabled: boolean;
  onAdd: (date: string) => void;
  onRemove: (date: string) => void;
}

export function PlayingDayPicker({
  startsOn,
  endsOn,
  chosen,
  locked,
  disabled,
  onAdd,
  onRemove,
}: PlayingDayPickerProps) {
  const months = useMemo(() => {
    const groups: { key: string; label: string; dates: string[] }[] = [];
    for (const date of isoDatesBetween(startsOn, endsOn)) {
      const key = date.slice(0, 7);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.dates.push(date);
      else groups.push({ key, label: monthLabel(date), dates: [date] });
    }
    return groups;
  }, [startsOn, endsOn]);

  if (months.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This tournament has no dates yet, so there is nothing to choose from.
      </p>
    );
  }

  const inWindow = months.reduce((sum, month) => sum + month.dates.length, 0);
  const chosenInWindow = months.reduce(
    (sum, month) => sum + month.dates.filter((date) => chosen.has(date)).length,
    0,
  );

  return (
    <div className="space-y-4">
      <p className="text-t4 text-muted-foreground" aria-live="polite">
        {chosenInWindow === 0
          ? `None of the ${inWindow} days in the tournament window is chosen yet.`
          : `${chosenInWindow} of ${inWindow} days chosen.`}
      </p>
      {months.map((month) => (
        <div key={month.key} role="group" aria-label={month.label}>
          <h4 className="mb-1.5 font-display text-sm font-semibold">{month.label}</h4>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(5.75rem,1fr))] gap-1.5">
            {month.dates.map((date) => {
              const on = chosen.has(date);
              const reason = on ? locked.get(date) : undefined;
              return (
                <button
                  key={date}
                  type="button"
                  aria-pressed={on}
                  aria-label={`${shortDateLabel(date)}${on ? ", playing day" : ""}`}
                  aria-description={reason}
                  title={reason}
                  disabled={disabled || Boolean(reason)}
                  onClick={() => (on ? onRemove(date) : onAdd(date))}
                  className={cn(
                    "flex min-h-11 items-center justify-between gap-1 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    on
                      ? "border-primary bg-info-surface font-semibold"
                      : "border-border-control bg-surface hover:bg-muted",
                  )}
                >
                  <span>
                    <span className="block text-t4 text-muted-foreground">
                      {shortDateLabel(date).split(",")[0]}
                    </span>
                    <span className="font-score">{date.slice(8)}</span>
                  </span>
                  {on ? <Check aria-hidden="true" className="size-4 text-info-foreground" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
