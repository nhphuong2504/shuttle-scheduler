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
    <div role="group" aria-label="Day" className="flex flex-wrap gap-1.5">
      {days.map((day) => {
        const active = day.id === selectedId;
        return (
          <button
            key={day.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(day.id)}
            className={cn(
              "min-h-11 rounded-full border px-4 text-sm font-semibold tabular-nums transition-colors",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-input bg-surface text-muted-foreground hover:bg-muted/60",
            )}
          >
            {readerDayLabel(day)}
          </button>
        );
      })}
    </div>
  );
}
