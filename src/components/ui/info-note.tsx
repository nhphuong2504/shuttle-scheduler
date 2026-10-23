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
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
