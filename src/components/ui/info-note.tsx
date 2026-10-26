import { Info } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * An (i) that holds the explanation a screen does not need to show all the time.
 *
 * Hover opens it; click and keyboard focus do too, so touch and keyboard users reach the same
 * words. Keep the visible line to what the reader must act on, and put the "why" and "how it is
 * worked out" here.
 */
export function InfoNote({
  label,
  children,
  className,
}: {
  /** What the note is about, for the button's accessible name. */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground",
            className,
          )}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <Info className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="max-w-xs space-y-2 text-sm"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        /**
         * Focus leaving is not a reason to close.
         *
         * The content is portalled to `document.body`, so inside a modal `Dialog` it sits
         * outside that dialog's focus scope: opening moved focus into the note, the
         * dialog's trapped scope pulled it straight back, and the move out read as a
         * dismissal. Open and close landed in the same tick, so the reader saw nothing -
         * in every Call next dialog, and in any other note rendered inside one.
         *
         * A click elsewhere still closes it: that arrives as `pointerDownOutside`, a
         * separate dismissal this does not touch. So does the (i) itself, which toggles.
         * Escape is the one that does not reach here - the enclosing dialog claims the key
         * first, so it closes the dialog and the note with it.
         */
        onFocusOutside={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
