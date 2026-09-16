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
  const done = draftId ? currentIndex : 0;
  const pct = Math.round((done / (SETUP_STEPS.length - 1)) * 100);

  return (
    <div>
      <div className="mb-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Progress
          </span>
          <span className="font-score text-[11px] text-muted-foreground">{pct}%</span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <nav aria-label="Tournament setup steps" className="relative">
        <span
          aria-hidden
          className="absolute left-[1.4rem] top-3 bottom-3 w-px bg-hairline"
          style={{ zIndex: 0 }}
        />
        <ul className="relative space-y-0.5">
          {SETUP_STEPS.map((step, index) => {
            const isCurrent = step.id === current;
            const isDone = index < currentIndex && !!draftId;
            return (
              <li key={step.id}>
                <button
                  type="button"
                  onClick={() => onSelect(step.id)}
                  aria-current={isCurrent ? "step" : undefined}
                  className={cn(
                    "group relative flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-all",
                    isCurrent
                      ? "bg-primary/10 ring-1 ring-inset ring-primary/30"
                      : "hover:bg-muted/60",
                  )}
                >
                  <span
                    className={cn(
                      "relative z-10 mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border font-score text-[10px] font-bold transition-colors",
                      isCurrent
                        ? "border-primary bg-primary text-primary-foreground shadow-panel"
                        : isDone
                          ? "border-mint bg-mint/40 text-foreground"
                          : "border-hairline bg-surface text-muted-foreground",
                    )}
                  >
                    {isDone ? "✓" : index + 1}
                  </span>
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block text-sm font-semibold leading-tight",
                        isCurrent ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {step.label}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                      {step.hint}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
