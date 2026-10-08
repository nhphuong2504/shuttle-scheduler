import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The panels `PickerInput` opens in place of the engine's own calendar and clock.
 *
 * The engine's popup is drawn by the browser: it cannot take a token, a radius or a type
 * scale, and it looks different in every engine. These two panels are built from the same
 * tokens as the rest of the app and are driven by the same string values the native fields
 * use (`YYYY-MM-DD`, `HH:mm`), so a field behaves identically whether it is typed into or
 * picked from.
 *
 * Both are keyboard-complete. The day grid and each time column hold a single tab stop and
 * move with the arrow keys, so a panel costs one Tab rather than forty.
 */

const pad = (n: number) => String(n).padStart(2, "0");

type Ymd = { y: number; m: number; d: number };

/** A `YYYY-MM-DD` prefix as a real calendar date, or null for anything the calendar rejects. */
export function parseDate(value: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) {
    return null;
  }
  return { y, m, d };
}

/** Local date as `YYYY-MM-DD`, without going through UTC and shifting a day. */
export function toDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function atDay(date: Date, offset: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
}

/** Same day-of-month in another month, held at the month's last day when it is shorter. */
function atMonth(date: Date, offset: number): Date {
  const first = new Date(date.getFullYear(), date.getMonth() + offset, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), last));
}

const NAV_BUTTON =
  "inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export interface DatePanelProps {
  /** The field's current value, `YYYY-MM-DD` or empty. */
  value: string;
  min?: string | undefined;
  max?: string | undefined;
  onSelect: (value: string) => void;
  /** Move focus to the day on mount, so the panel opens where the keyboard can use it. */
  autoFocus?: boolean;
}

export function DatePanel({ value, min, max, onSelect, autoFocus }: DatePanelProps) {
  const selected = parseDate(value);
  const todayString = toDateString(new Date());
  const [cursor, setCursor] = React.useState(() =>
    selected ? new Date(selected.y, selected.m - 1, selected.d) : new Date(),
  );
  const grid = React.useRef<HTMLDivElement>(null);
  const moveFocus = React.useRef(!!autoFocus);

  // After a keyboard move the day that holds the tab stop changes, and the browser leaves
  // focus on the button that just unmounted its stop; carry it across.
  React.useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    grid.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
  });

  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    cursor,
  );
  const weekdays = React.useMemo(() => {
    // 2024-01-01 was a Monday; the week starts there.
    const format = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    return Array.from({ length: 7 }, (_, i) => format.format(new Date(2024, 0, 1 + i)));
  }, []);

  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const leading = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full" });

  const outOfRange = (date: string) => (!!min && date < min) || (!!max && date > max);

  const move = (next: Date) => {
    moveFocus.current = true;
    setCursor(next);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const week = (cursor.getDay() + 6) % 7;
    const next = (
      {
        ArrowLeft: () => atDay(cursor, -1),
        ArrowRight: () => atDay(cursor, 1),
        ArrowUp: () => atDay(cursor, -7),
        ArrowDown: () => atDay(cursor, 7),
        PageUp: () => atMonth(cursor, -1),
        PageDown: () => atMonth(cursor, 1),
        Home: () => atDay(cursor, -week),
        End: () => atDay(cursor, 6 - week),
      } as Record<string, () => Date>
    )[event.key];
    if (!next) return;
    event.preventDefault();
    move(next());
  };

  return (
    <div className="w-[17.5rem]">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          className={NAV_BUTTON}
          aria-label="Previous month"
          onClick={() => setCursor(atMonth(cursor, -1))}
        >
          <ChevronLeft className="size-4" />
        </button>
        <p aria-live="polite" className="font-display text-sm font-bold capitalize">
          {monthLabel}
        </p>
        <button
          type="button"
          className={NAV_BUTTON}
          aria-label="Next month"
          onClick={() => setCursor(atMonth(cursor, 1))}
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 text-center text-t4 font-semibold text-muted-foreground">
        {weekdays.map((name) => (
          <span key={name} className="py-1">
            {name}
          </span>
        ))}
      </div>

      <div
        ref={grid}
        role="group"
        aria-label={monthLabel}
        onKeyDown={onKeyDown}
        className="grid grid-cols-7 gap-y-0.5"
      >
        {Array.from({ length: leading }, (_, i) => (
          <span key={`blank-${i}`} aria-hidden />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const date = new Date(cursor.getFullYear(), cursor.getMonth(), day);
          const text = toDateString(date);
          const isSelected = text === value.slice(0, 10);
          const isToday = text === todayString;
          const disabled = outOfRange(text);
          return (
            <button
              key={day}
              type="button"
              tabIndex={day === cursor.getDate() ? 0 : -1}
              aria-label={dayFormat.format(date)}
              aria-pressed={isSelected}
              aria-disabled={disabled || undefined}
              aria-current={isToday ? "date" : undefined}
              onClick={() => {
                if (!disabled) onSelect(text);
              }}
              className={cn(
                "mx-auto inline-flex size-9 items-center justify-center rounded-lg text-sm font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isSelected
                  ? "bg-primary font-bold text-primary-foreground"
                  : "hover:bg-muted",
                isToday && !isSelected && "font-bold text-primary ring-1 ring-inset ring-primary/50",
                disabled && "cursor-not-allowed opacity-35 hover:bg-transparent",
              )}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const hourCycle12 = () =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === true;

const MINUTE_STEP = 5;
const DEFAULT_HOUR = 9;

export interface TimePanelProps {
  /** The field's current value, `HH:mm` or empty. */
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

export function TimePanel({ value, onChange, autoFocus }: TimePanelProps) {
  const twelve = React.useMemo(hourCycle12, []);
  const match = /^(\d{2}):(\d{2})/.exec(value);
  const hour = match ? Number(match[1]) : null;
  const minute = match ? Number(match[2]) : null;
  const root = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    // Open on the selected hour so the keyboard starts where the value is.
    if (!autoFocus) return;
    const target =
      root.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]') ?? null;
    target?.focus({ preventScroll: true });
    // Only on mount: later renders are the operator's own movements.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = (h: number, m: number) => onChange(`${pad(h)}:${pad(m)}`);
  const baseHour = hour ?? DEFAULT_HOUR;
  const baseMinute = minute ?? 0;

  const hours = twelve
    ? Array.from({ length: 12 }, (_, i) => (i === 0 ? 12 : i))
    : Array.from({ length: 24 }, (_, i) => i);
  const shownHour = hour === null ? null : twelve ? hour % 12 || 12 : hour;
  const pm = baseHour >= 12;

  const minutes = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);
  // A value typed off the step still has to be visible and selected.
  if (minute !== null && !minutes.includes(minute)) {
    minutes.push(minute);
    minutes.sort((a, b) => a - b);
  }

  return (
    <div ref={root} className="flex w-full gap-2">
      <Column label="Hour">
        {hours.map((h) => (
          <Option
            key={h}
            on={shownHour === h}
            first={shownHour === null && h === hours[0]}
            onPick={() => commit(twelve ? (h % 12) + (pm ? 12 : 0) : h, baseMinute)}
          >
            {twelve ? String(h) : pad(h)}
          </Option>
        ))}
      </Column>
      <Column label="Minute">
        {minutes.map((m) => (
          <Option
            key={m}
            on={minute === m}
            first={minute === null && m === 0}
            onPick={() => commit(baseHour, m)}
          >
            {pad(m)}
          </Option>
        ))}
      </Column>
      {twelve ? (
        <Column label="AM or PM" scroll={false}>
          {(["AM", "PM"] as const).map((period) => (
            <Option
              key={period}
              on={hour !== null && (period === "PM") === pm}
              first={hour === null && period === "AM"}
              onPick={() => commit((baseHour % 12) + (period === "PM" ? 12 : 0), baseMinute)}
            >
              {period}
            </Option>
          ))}
        </Column>
      ) : null}
    </div>
  );
}

function Column({
  label,
  children,
  scroll = true,
}: {
  label: string;
  children: React.ReactNode;
  scroll?: boolean;
}) {
  const column = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    // Centre the selected option, by scrolling the column itself: `scrollIntoView` would
    // also scroll the page behind the popup.
    const node = column.current;
    const chosen = node?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (node && chosen) {
      node.scrollTop = chosen.offsetTop - node.clientHeight / 2 + chosen.clientHeight / 2;
    }
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const options = [...(column.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const target =
      event.key === "ArrowDown"
        ? options[Math.min(at + 1, options.length - 1)]
        : event.key === "ArrowUp"
          ? options[Math.max(at - 1, 0)]
          : event.key === "Home"
            ? options[0]
            : event.key === "End"
              ? options[options.length - 1]
              : undefined;
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <div
      ref={column}
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "relative flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg bg-muted/50 p-1",
        scroll && "max-h-48 overflow-y-auto",
      )}
    >
      {children}
    </div>
  );
}

function Option({
  on,
  first,
  onPick,
  children,
}: {
  on: boolean;
  /** Holds the column's tab stop when nothing is selected. */
  first: boolean;
  onPick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      tabIndex={on || first ? 0 : -1}
      onClick={onPick}
      className={cn(
        "inline-flex h-9 shrink-0 items-center justify-center rounded-md text-sm font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "bg-primary font-bold text-primary-foreground" : "hover:bg-background",
      )}
    >
      {children}
    </button>
  );
}
