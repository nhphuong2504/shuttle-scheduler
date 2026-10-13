import { ArrowLeft, ArrowRight, Check, Lock } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import {
  DEMO_MATCHES,
  DEMO_RESULT_STEP,
  DEMO_SPAN,
  DEMO_STEPS,
  DEMO_TOAST,
  demoClock,
  demoPlacement,
  type DemoMatch,
} from "./schedule-demo-data";

const LANE_EASE = "transition-[left,width,background-color,border-color,color,top] duration-700 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none";
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function pct(minute: number): string {
  return `${((minute / DEMO_SPAN) * 100).toFixed(2)}%`;
}

/**
 * How one match looks at one step.
 *
 * Emphasis is carried by fill and edge, never by opacity: a faded block would take its text
 * below the contrast floor, and every block here carries text. A match outside the step's
 * story falls back to a quiet version of its own family instead.
 */
function look(match: DemoMatch, step: number): string {
  const lit = step === 0 || (match.focus?.includes(step) ?? false);
  const resolved = step >= DEMO_RESULT_STEP;
  if (match.kind === "played") return "border-transparent bg-muted text-muted-foreground";
  if (match.kind === "live") return lit ? "border-play bg-play-surface text-play-foreground" : "border-hairline bg-surface text-muted-foreground";
  if (match.kind === "late") {
    if (step === 0) return "border-play bg-play-surface text-play-foreground";
    return lit ? "border-warn-foreground bg-warn-surface text-warn-foreground" : "border-warn-border bg-warn-surface text-warn-foreground";
  }
  if (!resolved) return "border-hairline bg-surface text-foreground";
  if (match.kind === "moved") {
    if (match.review && step >= 4) return "border-warn-foreground bg-primary text-primary-foreground ring-2 ring-inset ring-warn-foreground";
    return lit ? "border-primary bg-primary text-primary-foreground" : "border-info-border bg-info-surface text-info-foreground";
  }
  if (match.kind === "absorbed" && step === DEMO_RESULT_STEP) return "border-foreground bg-surface text-foreground";
  if (match.kind === "held" && step >= 4)
    return "border-warn-foreground text-warn-foreground bg-[repeating-linear-gradient(135deg,var(--surface)_0_6px,var(--warn-surface)_6px_12px)]";
  return "border-hairline bg-surface text-muted-foreground";
}

function label(match: DemoMatch, step: number): string {
  if (match.kind === "late" && step >= 1) return `${match.label} · +12`;
  if (match.kind === "held" && step >= 4) return `Review · ${match.label}`;
  if (match.kind === "absorbed" && step === DEMO_RESULT_STEP) return `No move · ${match.label}`;
  return match.label;
}

/**
 * The front door's scheduling demonstration: one late match, stepped through.
 *
 * The step track is split the way the app behaves. The first two steps happen while the
 * match is still on court; the last three are a single update the moment its result is
 * recorded, so they sit under one "Report result" bracket rather than reading as three
 * separate events. The timeline itself is decorative and hidden from assistive technology;
 * the live caption above it says what each step shows.
 */
export function ScheduleDemo() {
  const [step, setStep] = useState(0);
  const last = DEMO_STEPS.length - 1;
  const current = DEMO_STEPS[step]!;
  const resolved = step >= DEMO_RESULT_STEP;
  const now = step === 0 ? 25 : 37;

  const stepButton = (index: number) => {
    const s = DEMO_STEPS[index]!;
    const on = index === step;
    const seen = index < step;
    return (
      <button
        key={s.name}
        type="button"
        aria-pressed={on}
        onClick={() => setStep(index)}
        className={cn(
          "flex min-h-14 min-w-0 flex-1 cursor-pointer flex-col items-start justify-center gap-0.5 rounded-xl border px-3 py-2 text-left text-sm font-bold transition-colors",
          FOCUS_RING,
          on
            ? index >= DEMO_RESULT_STEP
              ? "border-primary bg-primary text-primary-foreground"
              : "border-foreground bg-foreground text-background"
            : seen
              ? "border-border-control bg-background text-foreground"
              : "border-hairline bg-surface text-muted-foreground hover:text-foreground",
        )}
      >
        <span className="font-mono text-[11px] font-medium">{s.when}</span>
        <span>{s.name}</span>
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-stretch gap-x-2 gap-y-3">
        <div className="flex min-w-0 flex-[2_1_220px] flex-col gap-1.5">
          <span className="pl-0.5 font-mono text-[11px] text-muted-foreground">While it plays</span>
          <div className="flex flex-1 gap-1.5">{[0, 1].map(stepButton)}</div>
        </div>
        <div className="flex min-w-0 flex-[3_1_330px] flex-col gap-1.5">
          <span className="flex items-center gap-2 pl-0.5 font-mono text-[11px] text-info-foreground">
            <span>Report result · one update</span>
            <span aria-hidden="true" className="h-0 flex-1 border-t-[1.5px] border-primary" />
          </span>
          <div className="flex flex-1 gap-1.5">{[2, 3, 4].map(stepButton)}</div>
        </div>
      </div>

      <div className="flex flex-col gap-6 rounded-2xl bg-background p-4 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
          <div aria-live="polite" className="flex min-h-[108px] flex-[1_1_420px] flex-col gap-2">
            <p className="font-display text-2xl leading-tight font-extrabold tracking-tight sm:text-[32px]">
              {current.title}
            </p>
            <p className="max-w-[620px] text-[17px] leading-relaxed text-foreground/85">{current.body}</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              aria-label="Previous step"
              disabled={step === 0}
              onClick={() => setStep(Math.max(0, step - 1))}
              className={cn(
                "grid size-12 cursor-pointer place-items-center rounded-xl border border-border-control bg-surface text-foreground disabled:cursor-default disabled:border-hairline disabled:text-muted-foreground",
                FOCUS_RING,
              )}
            >
              <ArrowLeft className="size-[18px]" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setStep(step === last ? 0 : step + 1)}
              className={cn(
                "inline-flex h-12 cursor-pointer items-center gap-2 rounded-xl bg-primary px-5 text-[15px] font-bold text-primary-foreground transition-colors hover:bg-primary-hover",
                FOCUS_RING,
              )}
            >
              {step === 1 ? "Report result" : step === last ? "Start again" : "Next"}
              <ArrowRight className="size-[18px]" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div aria-hidden="true" className="pt-1 pb-8">
          <div className="flex flex-col gap-2.5">
            <div className="flex gap-3">
              <span className="w-7 shrink-0 sm:w-16" />
              <div className="relative h-[18px] flex-1 font-mono text-[11px] text-muted-foreground tabular-nums">
                {[0, 60, 120].map((m) => (
                  <span key={m} className="absolute top-0" style={{ left: pct(m) }}>
                    {demoClock(m)}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex w-7 shrink-0 flex-col gap-2.5 sm:w-16">
                {[1, 2, 3].map((c) => (
                  <span key={c} className="flex h-[60px] items-center font-display text-[15px] font-bold">
                    <span className="sm:hidden">C{c}</span>
                    <span className="hidden sm:inline">Court {c}</span>
                  </span>
                ))}
              </div>
              <div className="relative flex flex-1 flex-col gap-2.5">
                <div
                  className={cn("absolute -top-1.5 -bottom-1.5 z-10 w-0 border-l-2 border-foreground", LANE_EASE)}
                  style={{ left: pct(now) }}
                >
                  <span className="absolute -bottom-6 -left-5 rounded-md bg-foreground px-1.5 py-px font-mono text-[11px] font-bold text-background tabular-nums">
                    {demoClock(now)}
                  </span>
                </div>
                <span className="absolute right-0 -bottom-7 font-mono text-[11px] font-bold">Close 16:45</span>
                {[1, 2, 3].map((court) => (
                  <div
                    key={court}
                    className="relative h-[60px] rounded-lg border border-hairline bg-surface shadow-[inset_-2px_0_0_var(--foreground)]"
                  >
                    {resolved
                      ? DEMO_MATCHES.filter((m) => m.court === court && m.movedTo != null).map((m) => (
                          <div
                            key={`ghost-${m.label}`}
                            className="absolute top-[7px] bottom-[7px] rounded-[7px] border-[1.5px] border-dashed border-primary/60"
                            style={{ left: `calc(${pct(m.start)} + 2px)`, width: `calc(${pct(25)} - 4px)` }}
                          />
                        ))
                      : null}
                    {DEMO_MATCHES.filter((m) => m.court === court).map((m) => {
                      const { start, length } = demoPlacement(m, step);
                      const held = m.kind === "held" && step >= 4;
                      const moved = resolved && m.movedTo != null;
                      const locked = m.kind === "played" || m.kind === "live" || m.kind === "late";
                      return (
                        <div
                          key={m.label}
                          className={cn(
                            "absolute flex items-center gap-1.5 overflow-hidden rounded-[7px] border px-1.5 text-xs font-bold whitespace-nowrap sm:px-2",
                            LANE_EASE,
                            held ? "top-5 -bottom-1 z-[5]" : "top-[7px] bottom-[7px]",
                            m.kind === "late" ? "z-[4]" : "z-[2]",
                            look(m, step),
                          )}
                          style={{ left: `calc(${pct(start)} + 2px)`, width: `calc(${pct(length)} - 4px)` }}
                        >
                          {locked ? <Lock className="size-3 shrink-0" aria-hidden="true" /> : null}
                          <span className="flex min-w-0 flex-col">
                            <span className="font-mono text-[11px] tabular-nums">
                              {demoClock(start)}
                              {moved ? <span className="hidden sm:inline"> +{start - m.start}</span> : null}
                            </span>
                            <span className="hidden truncate sm:block">{label(m, step)}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3.5">
          <ul className="flex flex-wrap gap-x-4 gap-y-2 text-[13px] text-muted-foreground" aria-label="Key">
            <Key swatch="bg-muted">Played · locked</Key>
            <Key swatch="border border-play bg-play-surface">On court · locked</Key>
            <Key swatch="border border-warn-foreground bg-warn-surface">Over its slot</Key>
            <Key swatch="bg-primary">Moved later</Key>
            <Key swatch="border-[1.5px] border-dashed border-primary/60">Where it was</Key>
            <Key swatch="border-2 border-warn-foreground bg-surface">Schedule review</Key>
          </ul>
          {resolved ? (
            <p className="flex max-w-[460px] items-start gap-2.5 rounded-xl bg-foreground px-4 py-3 text-sm leading-normal text-background">
              <Check className="mt-0.5 size-[18px] shrink-0" aria-hidden="true" />
              <span>
                <span className="sr-only">The desk then shows: </span>
                {DEMO_TOAST}
              </span>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Key({ swatch, children }: { swatch: string; children: string }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("h-[11px] w-4 rounded-[3px]", swatch)} />
      {children}
    </li>
  );
}
