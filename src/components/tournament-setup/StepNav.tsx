import { cn } from "@/lib/utils";
import { SETUP_STEPS, setupStepIndex, type SetupStep } from "./types";

/**
 * The step rail. Steps are always navigable so a host can jump back to fix
 * something without losing the rest of the draft; the review step does the
 * gating, because the database is what actually refuses an incomplete
 * activation.
 */
export function StepNav({
  current,
  draftId,
  onSelect,
}: {
  current: SetupStep;
  draftId: string | null;
  onSelect: (step: SetupStep) => void;
}) {
  const currentIndex = setupStepIndex(current);

  return (
    <nav aria-label="Tournament setup steps" className="space-y-1">
      {SETUP_STEPS.map((step, index) => {
        const isCurrent = step.id === current;
        const isDone = index < currentIndex && !!draftId;
        return (
          <button
            key={step.id}
            type="button"
            onClick={() => onSelect(step.id)}
            aria-current={isCurrent ? "step" : undefined}
            className={cn(
              "flex w-full items-start gap-3 rounded-md px-3 py-2 text-left transition-colors",
              isCurrent ? "bg-secondary/70" : "hover:bg-secondary/40",
            )}
          >
            <span
              className={cn(
                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
                isCurrent
                  ? "bg-primary text-primary-foreground"
                  : isDone
                    ? "bg-mint/40 text-foreground"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {index + 1}
            </span>
            <span className="min-w-0">
              <span
                className={cn(
                  "block text-sm font-semibold",
                  isCurrent ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
              <span className="block text-[11px] text-muted-foreground">{step.hint}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
