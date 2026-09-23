import * as React from "react";
import { CalendarDays, Clock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A native date or time field with its picker glyph replaced by an icon from the set.
 *
 * The browsers paint their own calendar and clock affordances inside `input[type=date]`
 * and `input[type=time]`. They are drawn by the engine rather than by the page, so they
 * never belonged to the design system: their size was whatever the engine chose, no token
 * could colour them, and the only thing the theme could do to them was `color-scheme`. On
 * a surface built from tokens they were the one element that did not follow.
 *
 * The glyph is therefore removed (`.picker-field` in `styles.css`) and replaced with the
 * same icon set the rest of the app draws from.
 *
 * The replacement is a real button, and that is the point rather than a side effect. The
 * native glyph was already a distinct click target, so replacing it with decoration would
 * have quietly removed a way in. As a control it keeps an entry in the tab order, an
 * accessible name, the shared focus ring, and a box the target-size rules can be applied
 * to - none of which the engine-drawn glyph could be given.
 *
 * `showPicker()` needs transient user activation, so it is called straight from the click
 * rather than from an effect or a timeout. It is absent in older engines and throws on a
 * disabled or read-only field, so focus is the fallback rather than a failure: a reader
 * who cannot open the popup is still put on the field it belongs to.
 */
const GLYPHS = {
  date: { Icon: CalendarDays, name: "Open the calendar" },
  time: { Icon: Clock, name: "Open the time picker" },
} as const;

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
}

export const PickerInput = React.forwardRef<HTMLInputElement, PickerInputProps>(
  ({ className, type, pickerLabel, ...props }, ref) => {
    // The wrapper needs the node to call `showPicker()`, and the caller may need it too,
    // so both refs are attached rather than one displacing the other.
    const field = React.useRef<HTMLInputElement>(null);
    const { Icon, name } = GLYPHS[type];

    const attach = (node: HTMLInputElement | null) => {
      field.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    };

    const open = () => {
      const input = field.current;
      if (!input || input.disabled) return;
      try {
        input.showPicker();
      } catch {
        input.focus();
      }
    };

    return (
      // `className` lands here, so a call site keeps sizing the field the way it sized
      // the input: `w-36` on the wrapper, and the input fills it. `h-9` is only a default
      // for the sites that never set a height.
      <div className={cn("relative h-9", className)}>
        <Input
          ref={attach}
          type={type}
          // `pr-9` clears the 28px button and its 4px inset, so the field's own text can
          // never run underneath it.
          className="picker-field h-full pr-9"
          {...props}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={pickerLabel ?? name}
          // Inset rather than a fixed height, so the button tracks whatever height the call
          // site gave the field: `h-auto` with both insets set is what lets it, because a
          // fixed height would overflow an `h-8` break row - the button sizes itself against
          // the wrapper, not the input.
          className="absolute inset-y-1 right-1 h-auto w-7 text-muted-foreground"
          disabled={props.disabled}
          onClick={open}
        >
          <Icon />
        </Button>
      </div>
    );
  },
);
PickerInput.displayName = "PickerInput";
