import { Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { courtOptionsFor, courtPoolSize, dateRangeLabel, emptyDay, type DraftForm } from "./types";

const MAX_DAYS = 7;
const MAX_COURTS = 64;

/**
 * Days, with each day owning its own hours, court set and breaks. The court pool
 * is the union of every day's selection, so adding a court to one day grows the
 * pool for the tournament.
 */
export function DaysStep({
  form,
  onChange,
}: {
  form: DraftForm;
  onChange: (patch: Partial<DraftForm>) => void;
}) {
  const days = form.days;
  const poolSize = courtPoolSize(days);
  // Always offer one more court than the pool, so the host can grow it.
  const options = courtOptionsFor(days, Math.min(poolSize + 1, MAX_COURTS));

  const setDay = (index: number, patch: Partial<DraftForm["days"][number]>) =>
    onChange({ days: days.map((day, i) => (i === index ? { ...day, ...patch } : day)) });

  const addDay = () => {
    if (days.length >= MAX_DAYS) return;
    const previous = days[days.length - 1];
    const next = emptyDay(days.length);
    onChange({
      days: [
        ...days,
        {
          ...next,
          startTime: previous?.startTime ?? next.startTime,
          endTime: previous?.endTime ?? next.endTime,
          courts: previous ? [...previous.courts] : [],
        },
      ],
    });
  };

  const removeDay = (index: number) => onChange({ days: days.filter((_, i) => i !== index) });

  const toggleCourt = (index: number, court: number, checked: boolean) => {
    const current = days[index];
    if (!current) return;
    const next = checked
      ? [...new Set([...current.courts, court])].sort((a, b) => a - b)
      : current.courts.filter((c) => c !== court);
    setDay(index, { courts: next });
  };

  const addBreak = (index: number) =>
    setDay(index, {
      breaks: [
        ...(days[index]?.breaks ?? []),
        { label: "Break", startTime: "12:00", endTime: "13:00" },
      ],
    });

  const setBreak = (
    index: number,
    breakIndex: number,
    patch: Partial<{ label: string; startTime: string; endTime: string }>,
  ) => {
    const current = days[index];
    if (!current) return;
    setDay(index, {
      breaks: current.breaks.map((br, i) => (i === breakIndex ? { ...br, ...patch } : br)),
    });
  };

  const removeBreak = (index: number, breakIndex: number) => {
    const current = days[index];
    if (!current) return;
    setDay(index, { breaks: current.breaks.filter((_, i) => i !== breakIndex) });
  };

  return (
    <div className="space-y-4">
      <Panel
        title="Tournament days"
        right={
          <Button size="sm" variant="outline" disabled={days.length >= MAX_DAYS} onClick={addDay}>
            Add day
          </Button>
        }
      >
        <p className="mb-3 text-xs text-muted-foreground">
          Date range: <span className="font-score text-foreground">{dateRangeLabel(days)}</span>.
          The range is derived from the days, not stored separately.
        </p>
        {days.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add at least one day. A tournament cannot be activated without a day that has courts.
          </p>
        ) : null}
      </Panel>

      {days.map((day, index) => (
        <Panel
          key={index}
          title={`Day ${index + 1}`}
          right={
            <Button size="sm" variant="ghost" onClick={() => removeDay(index)}>
              Remove
            </Button>
          }
        >
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor={`d${index}-date`}>Date</Label>
                <Input
                  id={`d${index}-date`}
                  type="date"
                  value={day.date}
                  onChange={(e) => setDay(index, { date: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`d${index}-start`}>Opens</Label>
                <Input
                  id={`d${index}-start`}
                  type="time"
                  value={day.startTime}
                  onChange={(e) => setDay(index, { startTime: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`d${index}-end`}>Closes</Label>
                <Input
                  id={`d${index}-end`}
                  type="time"
                  value={day.endTime}
                  onChange={(e) => setDay(index, { endTime: e.target.value })}
                />
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Courts available
                </p>
                <div className="flex items-center gap-1">
                  <span className="font-score text-[11px] text-muted-foreground">
                    {day.courts.length} selected
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDay(index, { courts: [...options] })}
                  >
                    All
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDay(index, { courts: [] })}>
                    None
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {options.map((court) => {
                  const checked = day.courts.includes(court);
                  return (
                    <label
                      key={court}
                      title={`Court ${court}`}
                      className={`grid size-10 cursor-pointer place-items-center rounded-lg border font-score text-sm transition-all ${
                        checked
                          ? "border-primary bg-primary text-primary-foreground shadow-panel"
                          : "border-hairline bg-surface text-muted-foreground hover:border-primary/40 hover:text-foreground"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        onChange={(e) => toggleCourt(index, court, e.target.checked)}
                      />
                      {court}
                    </label>
                  );
                })}
                {options.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No courts to choose yet.</p>
                ) : null}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Tap a number to open or close that court for this day. The last tile adds a new
                court to the pool.
              </p>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Breaks
                </p>
                <Button size="sm" variant="ghost" onClick={() => addBreak(index)}>
                  Add break
                </Button>
              </div>
              {day.breaks.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No breaks. Play runs continuously between opening and closing.
                </p>
              ) : (
                <ul className="space-y-2">
                  {day.breaks.map((br, breakIndex) => (
                    <li key={breakIndex} className="flex flex-wrap items-end gap-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={`d${index}-b${breakIndex}-label`}>Label</Label>
                        <Input
                          id={`d${index}-b${breakIndex}-label`}
                          className="w-36"
                          value={br.label}
                          onChange={(e) => setBreak(index, breakIndex, { label: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`d${index}-b${breakIndex}-start`}>From</Label>
                        <Input
                          id={`d${index}-b${breakIndex}-start`}
                          type="time"
                          value={br.startTime}
                          onChange={(e) =>
                            setBreak(index, breakIndex, { startTime: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`d${index}-b${breakIndex}-end`}>To</Label>
                        <Input
                          id={`d${index}-b${breakIndex}-end`}
                          type="time"
                          value={br.endTime}
                          onChange={(e) => setBreak(index, breakIndex, { endTime: e.target.value })}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeBreak(index, breakIndex)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Panel>
      ))}

      <Panel title="Note">
        <p className="text-xs text-muted-foreground">
          Per-day courts and breaks are stored with the tournament and shown in the review summary.
          The schedulers still treat every court as free all day, so honouring these windows when
          matches are placed is a later pass.
        </p>
      </Panel>
    </div>
  );
}
