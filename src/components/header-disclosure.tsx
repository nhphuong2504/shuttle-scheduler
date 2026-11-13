import { useEffect, useState, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import "./header-interactions.css";

/** Keep a closing panel painted briefly, while removing it from interaction immediately. */
export function HeaderDisclosure({
  open,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"div"> & { open: boolean }) {
  const [present, setPresent] = useState(open);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timeout = window.setTimeout(() => setPresent(false), 100);
    return () => window.clearTimeout(timeout);
  }, [open]);

  if (!open && !present) return null;

  return (
    <div
      {...props}
      className={cn("header-disclosure", className)}
      data-state={open ? "open" : "closed"}
      aria-hidden={open ? undefined : true}
      inert={!open}
    >
      {children}
    </div>
  );
}
