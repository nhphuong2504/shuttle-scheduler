import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * One block of a setup step: a title, a line saying what it is for, and the fields.
 *
 * The wizard's steps used to be stacks of the app's generic `Panel`, whose header is a small
 * all-caps label. A step is a form a host reads from the top, so each block here names what
 * it asks for in a real heading and says in one line why, and an optional block says so on
 * its own title rather than leaving the host to find out by leaving it empty.
 */
export function SetupSection({
  title,
  hint,
  optional = false,
  headingId,
  children,
  className,
}: {
  title: string;
  hint?: string;
  optional?: boolean;
  /** The id of the heading, which names the section for assistive technology. */
  headingId: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "rounded-2xl border border-hairline bg-surface p-5 shadow-panel sm:p-6",
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="font-display text-xl font-bold">
          {title}
        </h2>
        {optional ? (
          <span className="text-sm font-medium text-muted-foreground">Optional</span>
        ) : null}
      </div>
      {hint ? <p className="mt-1 text-base text-muted-foreground">{hint}</p> : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** A label with its "Required" mark on the right, for the one field a step cannot do without. */
export function FieldHeading({
  htmlFor,
  children,
  required = false,
}: {
  htmlFor: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-base font-semibold">
        {children}
      </label>
      {required ? <span className="text-sm text-muted-foreground">Required</span> : null}
    </div>
  );
}

/** What a field says when the host has tried to move on without it. */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-1.5 text-sm font-semibold text-danger-foreground">
      {children}
    </p>
  );
}
