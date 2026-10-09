import * as React from "react";
import { CalendarClock, CalendarDays, Clock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DatePanel, TimePanel, toDateString } from "@/components/ui/picker-panels";
import { cn } from "@/lib/utils";

/**
 * A native date, time or date-and-time field with its picker replaced by one from the set.
 *
 * The browsers paint their own calendar and clock inside `input[type=date]`,
 * `input[type=time]` and `input[type=datetime-local]`. They are drawn by the engine rather
 * than by the page, so they never belonged to the design system: the glyph's size was
 * whatever the engine chose, the popup that opens from it cannot take a token, a radius or
 * a type scale, and it looks different in every browser.
 *
 * Both are therefore replaced. The engine's glyph is removed (`.picker-field` in
 * `styles.css`) and an icon from the same set the rest of the app draws from takes its
 * place; the popup it opens is `DatePanel` / `TimePanel`, built from the app's tokens.
 *
 * The field underneath stays a real native input. It is still typed into, still validated
 * by the engine, still read by the callers through the same `value` / `onChange` they
 * always used, and still the thing a test finds. The panels write to it the way a
 * keystroke would - through the input's own value setter and an `input` event - so a
 * controlled field and an uncontrolled one both see an ordinary change, and a caller that
 * refuses the value (a locked day) simply puts the old one back.
 *
 * The replacement for the glyph is a real button, and that is the point rather than a side
 * effect. The native glyph was already a distinct click target, so replacing it with
 * decoration would have quietly removed a way in. As a control it keeps an entry in the
 * tab order, an accessible name, the shared focus ring, and a box the target-size rules can
 * be applied to - none of which the engine-drawn glyph could be given.
 *
 * ## The width belongs to the call site, and it is load-bearing
 *
 * A date or time value is laid out from its field's content-box left edge, so `padding-right`
 * cannot create the space between the value and the icon - a field too narrow for its value
 * paints through that padding and under the glyph. The only lever is the field's width, and
 * the value's painted width moves with the type size, which is 16px below `md` and 14px
 * above it (`Input` carries `text-base md:text-sm`, there to stop a phone zooming on focus).
 *
 * So the width steps down at the same breakpoint the type does: `w-33 md:w-32` for a time,
 * `w-38 md:w-36` for a date, both leaving the value several px inside the padding's
 * reservation and the value's right edge around 12-18px clear of the icon. Sizing for the
 * narrower rendering instead is what put the mobile value 8px underneath the icon; the
 * `e2e/staff-surfaces.spec.ts` fit guard measures this rather than trusting the class list.
 * A date-and-time field is left to fill its column, which is wide enough on every surface
 * that uses one.
 */
const GLYPHS = {
  date: { Icon: CalendarDays, name: "Open the calendar" },
  time: { Icon: Clock, name: "Open the time picker" },
  "datetime-local": { Icon: CalendarClock, name: "Open the calendar and time picker" },
} as const;

/** What a time takes when a day is chosen before any time has been. */
const DEFAULT_TIME = "09:00";

const setNativeValue = (input: HTMLInputElement, value: string) => {
  // The prototype's setter, not `input.value =`: React tracks the instance's own property,
  // and assigning through it would update the tracker and swallow the change event.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

export interface PickerInputProps extends Omit<React.ComponentProps<"input">, "type"> {
  type: keyof typeof GLYPHS;
  /**
   * The accessible name for the icon button.
   *
   * A generic name is right when the field is the only picker on the surface. Pass one
   * when several share a page - a day list holds three per day - so the button announces
   * which field it opens rather than repeating an identical name down the page.
   */
  pickerLabel?: string;
  /** Classes for the field itself; `className` sizes the wrapper around it. */
  inputClassName?: string | undefined;
  /**
   * Offers "Clear" in the panel. Off by default: most of these fields are windows a
   * schedule is built from, and emptying one is a mistake rather than a feature.
   */
  allowClear?: boolean;
}

export const PickerInput = React.forwardRef<HTMLInputElement, PickerInputProps>(
  ({ className, inputClassName, type, pickerLabel, allowClear = false, ...props }, ref) => {
    // The wrapper needs the node to write to it, and the caller may need it too, so both
    // refs are attached rather than one displacing the other.
    const field = React.useRef<HTMLInputElement>(null);
    const { Icon, name } = GLYPHS[type];
    const [open, setOpen] = React.useState(false);
    // What the panel draws. Read from the field on open and after every write, so it is
    // the field's own answer - including a refusal - rather than a second copy of the value.
    const [current, setCurrent] = React.useState("");

    const attach = (node: HTMLInputElement | null) => {
      field.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    };

    const onOpenChange = (next: boolean) => {
      if (next) {
        const input = field.current;
        // A disabled or read-only field is not the operator's to change, so nothing opens.
        if (!input || input.disabled || input.readOnly) return;
        setCurrent(input.value);
      }
      setOpen(next);
    };

    const write = (next: string) => {
      const input = field.current;
      if (!input) return;
      setNativeValue(input, next);
      setCurrent(input.value);
    };

    const [datePart = "", timePart = ""] =
      type === "datetime-local"
        ? current.split("T")
        : type === "date"
          ? [current, ""]
          : ["", current];
    const today = toDateString(new Date());

    const min = typeof props.min === "string" ? props.min.slice(0, 10) : undefined;
    const max = typeof props.max === "string" ? props.max.slice(0, 10) : undefined;
    const clearable = allowClear && !props.required && current !== "";

    return (
      <Popover open={open} onOpenChange={onOpenChange}>
        {/* `className` lands here, so a call site keeps sizing the field the way it sized
            the input: `w-33 md:w-32` on the wrapper, and the input fills it. `h-9` is only
            a default for the sites that never set a height. */}
        <PopoverAnchor asChild>
          <div className={cn("relative h-9", className)}>
            <Input
              ref={attach}
              type={type}
              /**
               * `pr-9` is a reservation, not the spacing.
               *
               * The icon's footprint is 32px from the field's right edge (4px inset plus a
               * 28px button), so this padding ends the content box 4px ahead of it. That is
               * the floor - the value cannot reach the glyph *while it fits its content box*.
               *
               * It is not what creates the visible gap. A date or time value is laid out from
               * the content box's left edge, so a field too narrow for its value paints
               * straight through this padding and under the icon: at the 7rem the day windows
               * used, a desktop value ended 2px short of the icon and the 16px mobile value
               * overlapped it by 8px, with this padding in place throughout. The gap is set
               * by the call site's width; the widths in use are sized so the value fits the
               * box below.
               */
              className={cn("picker-field h-full pr-9", inputClassName)}
              {...props}
            />
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={pickerLabel ?? name}
                // Inset rather than a fixed height, so the button tracks whatever height the
                // call site gave the field: `h-auto` with both insets set is what lets it,
                // because a fixed height would overflow an `h-8` break row - the button sizes
                // itself against the wrapper, not the input.
                className="absolute inset-y-1 right-1 h-auto w-7 text-muted-foreground"
                disabled={props.disabled}
              >
                <Icon />
              </Button>
            </PopoverTrigger>
          </div>
        </PopoverAnchor>

        <PopoverContent
          // The panel puts focus where its value is; letting the popup grab the first
          // control instead would land on "Previous month".
          onOpenAutoFocus={(event) => event.preventDefault()}
          className={cn(type === "time" ? "w-56" : "w-auto")}
        >
          {type !== "time" ? (
            <DatePanel
              autoFocus
              value={datePart}
              min={min}
              max={max}
              onSelect={(date) => {
                write(type === "date" ? date : `${date}T${timePart || DEFAULT_TIME}`);
                // A date alone is finished by choosing a day; a date with a time still
                // wants its time.
                if (type === "date") setOpen(false);
              }}
            />
          ) : null}

          {type === "datetime-local" ? <div className="my-3 border-t border-hairline" /> : null}

          {type !== "date" ? (
            <TimePanel
              autoFocus={type === "time"}
              value={timePart}
              onChange={(time) => write(type === "time" ? time : `${datePart || today}T${time}`)}
            />
          ) : null}

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-hairline pt-3">
            {clearable ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 text-sm"
                onClick={() => {
                  write("");
                  setOpen(false);
                }}
              >
                Clear
              </Button>
            ) : (
              <span />
            )}
            {type === "date" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 text-sm"
                onClick={() => {
                  write(today);
                  setOpen(false);
                }}
              >
                Today
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                className="h-9 text-sm"
                onClick={() => setOpen(false)}
              >
                Done
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    );
  },
);
PickerInput.displayName = "PickerInput";
