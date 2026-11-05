import type { TournamentDay } from "@/lib/tournament/data";
import { cn } from "@/lib/utils";

/** A tournament day as a reader names it: "Sat, Oct 18". The stored date is a calendar date, so it is read in UTC. */
export function readerDayLabel(day: Pick<TournamentDay, "date">): string {
  const date = new Date(`${day.date}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return day.date;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** The day switch, drawn only when there is more than one day to choose between. */
export function ReaderDayPicker({
  days,
  selectedId,
  onSelect,
}: {
  days: readonly TournamentDay[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (days.length < 2) return null;
  return (
    // One row that scrolls sideways on a phone, as Schedule's filters do, so a long event never
    // spends a second row of the screen on its days.
    // A segmented switch: one grey track, the chosen day lifted out of it in white, so the days
    // read as one control rather than a row of buttons competing with the page's links.
    <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
      <div role="group" aria-label="Day" className="inline-flex gap-1 rounded-xl bg-muted p-1">
        {days.map((day) => {
          const active = day.id === selectedId;
          return (
            <button
              key={day.id}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(day.id)}
              className={cn(
                "min-h-11 shrink-0 whitespace-nowrap rounded-lg px-3.5 text-sm tabular-nums transition-colors",
                active
                  ? "bg-surface font-bold text-foreground shadow-sm"
                  : "font-semibold text-muted-foreground hover:bg-surface/60 hover:text-foreground",
              )}
            >
              {readerDayLabel(day)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
