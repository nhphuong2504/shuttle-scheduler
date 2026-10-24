import { ArrowLeft, ArrowRight, Check, Lock, Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import {
  DEMO_LAST_STEP,
  DEMO_MATCHES,
  DEMO_RESULT_STEP,
  DEMO_SLOT,
  DEMO_SPAN,
  DEMO_STEPS,
  DEMO_TOAST,
  demoClock,
  demoCounts,
  demoGroup,
  demoPlacement,
  type DemoGroup,
  type DemoMatch,
  type DemoStep,
} from "./schedule-demo-data";

/** How long autoplay rests on each step. Long enough to read the caption once. */
const STEP_MS = 2600;
const EASE = "duration-700 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none";
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function pct(minute: number): string {
  return `${((minute / DEMO_SPAN) * 100).toFixed(2)}%`;
}

const BADGE_TONE: Record<DemoStep["badgeTone"], string> = {
  neutral: "bg-muted text-foreground/80",
  waiting: "bg-warn-surface text-warn-foreground",
  auto: "bg-info-surface text-info-foreground",
  review: "bg-warn-surface text-warn-foreground",
};

const GROUPS: readonly { key: DemoGroup; title: string; detail: string; swatch: string; count: string }[] = [
  {
    key: "auto",
    title: "Moved by Tournova",
    detail: "Automatic. Later only, and only as far as needed — up to 12 min here.",
    swatch: "bg-primary",
    count: "text-primary-ink",
  },
  {
    key: "locked",
    title: "Locked",
    detail: "Played or on court. These never move.",
    swatch: "bg-muted",
    count: "text-muted-foreground",
  },
  {
    key: "review",
    title: "Your review",
    detail: "No safe slot, so the match keeps its time and waits for you.",
    swatch:
      "bg-[repeating-linear-gradient(135deg,var(--surface)_0_4px,var(--warn-surface)_4px_8px)] ring-2 ring-inset ring-warn-foreground",
    count: "text-warn-foreground",
  },
];

/**
 * How one match looks: its fill says what happened to it, and the story decides only
 * whether it is in focus. Out-of-focus matches keep their meaning in a quieter fill rather
 * than through opacity, so no text drops below contrast.
 */
function look(match: DemoMatch, step: number, lit: boolean): string {
  const resolved = step >= DEMO_RESULT_STEP;
  const quiet = "border-hairline bg-surface text-muted-foreground";
  switch (match.kind) {
    case "played":
      return "border-transparent bg-muted text-muted-foreground";
    case "live":
      return lit ? "border-play bg-play-surface text-play-foreground" : quiet;
    case "late":
      if (step === 0) return "border-play bg-play-surface text-play-foreground";
      // Still the match that ran over whatever the story points at; only a group filter mutes it.
      return lit ? "border-warn-foreground bg-warn-surface text-warn-foreground" : "border-warn-border bg-warn-surface text-warn-foreground";
    case "moved":
      if (!resolved) return lit ? "border-border-control bg-surface text-foreground" : quiet;
      if (lit) return match.review
        ? "border-warn-foreground bg-primary text-primary-foreground ring-2 ring-inset ring-warn-foreground"
        : "border-primary bg-primary text-primary-foreground shadow-[0_8px_16px_-10px_var(--primary)]";
      return match.review
        ? "border-warn-foreground bg-info-surface text-info-foreground"
        : "border-info-border bg-info-surface text-info-foreground";
    case "absorbed":
      return resolved && lit ? "border-foreground bg-surface text-foreground" : quiet;
    case "held":
      if (!resolved) return lit ? "border-border-control bg-surface text-foreground" : quiet;
      return cn(
        "bg-[repeating-linear-gradient(135deg,var(--surface)_0_6px,var(--warn-surface)_6px_12px)] text-warn-foreground",
        lit ? "border-2 border-warn-foreground" : "border-warn-border",
      );
    default:
      return step === 0 ? "border-border-control bg-surface text-foreground" : quiet;
  }
}

function label(match: DemoMatch, step: number, lit: boolean): string {
  const resolved = step >= DEMO_RESULT_STEP;
  if (match.kind === "late" && step >= 1) return `${match.label}, +12`;
  if (match.kind === "held" && resolved) return `Review, ${match.label}`;
  if (match.kind === "absorbed" && resolved && lit) return `No move, ${match.label}`;
  return match.label;
}

/**
 * The front door's scheduling demonstration: one late match, stepped through.
 *
 * The track is split the way the app behaves. The first two steps happen while the match is
 * still on court; the last three are a single update the moment its result is recorded, so
 * they sit under one "Report result" bracket, and the counts and the picture show the whole
 * update from the first of them on. The story only moves the spotlight.
 *
 * The legend doubles as a filter: choosing a group jumps to the end and lights only its
 * matches, which is the quickest answer to "what did Tournova do, what can't it touch, and
 * what is left for me".
 */
export function ScheduleDemo() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [group, setGroup] = useState<DemoGroup | null>(null);
  const current = DEMO_STEPS[step]!;
  const resolved = step >= DEMO_RESULT_STEP;
  const counts = demoCounts(step);
  const now = step === 0 ? 25 : 37;

  useEffect(() => {
    if (!playing) return;
    if (step >= DEMO_LAST_STEP) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setStep((s) => Math.min(DEMO_LAST_STEP, s + 1)), STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, step]);

  const goTo = (next: number) => {
    setPlaying(false);
    setGroup(null);
    setStep(Math.max(0, Math.min(DEMO_LAST_STEP, next)));
  };

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    setGroup(null);
    if (step >= DEMO_LAST_STEP) setStep(0);
    setPlaying(true);
  };

  const isLit = (m: DemoMatch) =>
    group ? demoGroup(m) === group : step === 0 || (m.focus?.includes(step) ?? false);
  const blockLook = (m: DemoMatch) => {
    const lit = isLit(m);
    // A group filter mutes everything outside the group, the late match included.
    if (m.kind === "late" && group && !lit) return "border-hairline bg-surface text-muted-foreground";
    return look(m, step, lit);
  };

  return (
    <div className="flex flex-col gap-7 rounded-[28px] bg-surface p-4 shadow-[0_0_0_1px_var(--info-border),0_50px_100px_-50px_var(--info-foreground)] sm:p-8 lg:p-10">
      {/* Step track */}
      <div className="flex flex-col gap-2.5">
        <div className="flex font-mono text-[11px]">
          <span className="flex-[2] text-muted-foreground">While it plays</span>
          <span className="flex flex-[3] items-center gap-2 text-info-foreground">
            <span>Report result, one update</span>
            <span aria-hidden="true" className="flex-1 border-t-[1.5px] border-primary" />
          </span>
        </div>
        <div className="relative">
          <div aria-hidden="true" className="absolute top-[17px] right-[10%] left-[10%] h-[3px] rounded-full bg-info-surface">
            <div
              className={cn("h-full rounded-full transition-[width]", EASE, resolved ? "bg-primary" : "bg-foreground")}
              style={{ width: `${step * 25}%` }}
            />
          </div>
          <div className="relative grid grid-cols-5 gap-1">
            {DEMO_STEPS.map((s, i) => {
              const on = i === step;
              const seen = i < step;
              const after = i >= DEMO_RESULT_STEP;
              return (
                <button
                  key={s.name}
                  type="button"
                  aria-pressed={on}
                  onClick={() => goTo(i)}
                  className={cn("flex min-h-[72px] cursor-pointer flex-col items-center gap-2 rounded-xl px-0.5", FOCUS_RING)}
                >
                  <span
                    className={cn(
                      "grid size-9 place-items-center rounded-full text-[15px] font-bold transition-all duration-300",
                      on
                        ? after
                          ? "bg-primary text-primary-foreground ring-[5px] ring-primary/20"
                          : "bg-foreground text-background ring-[5px] ring-foreground/10"
                        : seen
                          ? after
                            ? "bg-info-surface text-info-foreground ring-[1.5px] ring-info-border"
                            : "bg-muted text-foreground ring-[1.5px] ring-hairline"
                          : "bg-surface text-muted-foreground ring-[1.5px] ring-hairline",
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className="flex flex-col items-center text-center">
                    <span className="font-mono text-[11px] text-muted-foreground">{s.when}</span>
                    <span className={cn("text-sm font-bold", on ? "text-foreground" : "text-muted-foreground")}>
                      {s.name}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Caption and controls */}
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div aria-live="polite" className="flex min-h-[124px] flex-[1_1_440px] flex-col gap-2">
          <span className={cn("self-start rounded-full px-2.5 py-1 text-xs font-bold", BADGE_TONE[current.badgeTone])}>
            {current.badge}
          </span>
          <p className="font-display text-[clamp(26px,2.8vw,36px)] leading-[1.05] font-extrabold tracking-[-0.035em]">
            {current.title}
          </p>
          <p className="max-w-[640px] text-[17px] leading-relaxed text-foreground/80">{current.body}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            aria-label="Previous step"
            disabled={step === 0}
            onClick={() => goTo(step - 1)}
            className={cn(
              "grid size-12 cursor-pointer place-items-center rounded-2xl bg-surface text-foreground ring-[1.5px] ring-hairline ring-inset disabled:cursor-default disabled:text-muted-foreground",
              FOCUS_RING,
            )}
          >
            <ArrowLeft className="size-[18px]" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={togglePlay}
            className={cn(
              "inline-flex h-12 min-w-[120px] cursor-pointer items-center justify-center gap-2 rounded-2xl bg-primary px-5 text-[15px] font-bold text-primary-foreground shadow-[0_12px_24px_-12px_var(--primary)] transition-colors hover:bg-primary-hover",
              FOCUS_RING,
            )}
          >
            {playing ? (
              <Pause className="size-4" aria-hidden="true" />
            ) : step >= DEMO_LAST_STEP ? (
              <RotateCcw className="size-4" aria-hidden="true" />
            ) : (
              <Play className="size-4" aria-hidden="true" />
            )}
            {playing ? "Pause" : step >= DEMO_LAST_STEP ? "Replay" : "Play"}
          </button>
          <button
            type="button"
            aria-label="Next step"
            disabled={step === DEMO_LAST_STEP}
            onClick={() => goTo(step + 1)}
            className={cn(
              "grid size-12 cursor-pointer place-items-center rounded-2xl bg-surface text-foreground ring-[1.5px] ring-hairline ring-inset disabled:cursor-default disabled:text-muted-foreground",
              FOCUS_RING,
            )}
          >
            <ArrowRight className="size-[18px]" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Legend: what each colour means, and a filter onto it */}
      <div role="group" aria-label="What happens to each match" className="grid gap-3 md:grid-cols-3">
        {GROUPS.map((g) => {
          const on = group === g.key;
          return (
            <button
              key={g.key}
              type="button"
              aria-pressed={on}
              onClick={() => {
                setPlaying(false);
                setGroup(on ? null : g.key);
                setStep(DEMO_LAST_STEP);
              }}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl px-4 py-3.5 text-left transition-[background-color,box-shadow] duration-200",
                FOCUS_RING,
                on
                  ? "bg-surface shadow-[inset_0_0_0_2px_var(--primary),0_10px_24px_-14px_var(--info-foreground)]"
                  : "bg-info-surface/40 shadow-[inset_0_0_0_1px_var(--info-border)] hover:bg-info-surface/70",
              )}
            >
              <span className={cn("mt-0.5 grid h-[22px] w-[30px] shrink-0 place-items-center rounded-md", g.swatch)}>
                {g.key === "locked" ? <Lock className="size-3 text-muted-foreground" aria-hidden="true" /> : null}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span className="text-base font-bold">{g.title}</span>
                  <span className={cn("font-display text-xl font-extrabold tabular-nums", g.count)}>
                    {counts[g.key]}
                  </span>
                </span>
                <span className="hidden text-sm leading-snug text-muted-foreground sm:block">{g.detail}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Timeline: decorative, the caption above is the accessible account of it */}
      <div aria-hidden="true" className="rounded-[18px] bg-info-surface/40 px-3 pt-5 pb-10 shadow-[inset_0_0_0_1px_var(--info-border)] sm:px-5">
        <div className="flex flex-col gap-2.5">
          <div className="flex gap-3">
            <span className="w-7 shrink-0 text-[11px] text-muted-foreground sm:w-16 sm:invisible">Court</span>
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
                <span key={c} className="flex h-[62px] items-center font-display text-[15px] font-bold">
                  <span className="sm:hidden">{c}</span>
                  <span className="hidden sm:inline">Court {c}</span>
                </span>
              ))}
            </div>
            <div className="relative flex flex-1 flex-col gap-2.5">
              <div
                className={cn("absolute -top-2 -bottom-2 z-10 w-0 border-l-2 border-foreground transition-[left]", EASE)}
                style={{ left: pct(now) }}
              >
                <span className="absolute -bottom-7 -left-[22px] rounded-md bg-foreground px-1.5 py-0.5 font-mono text-[11px] font-bold text-background tabular-nums">
                  {demoClock(now)}
                </span>
              </div>
              <span className="absolute right-0 -bottom-7 font-mono text-[11px] font-bold">Close 16:45</span>
              {[1, 2, 3].map((court) => (
                <div
                  key={court}
                  className="relative h-[62px] rounded-xl bg-surface shadow-[inset_-2px_0_0_var(--foreground),inset_0_0_0_1px_var(--info-border)]"
                >
                  {resolved && (!group || group === "auto")
                    ? DEMO_MATCHES.filter((m) => m.court === court && m.movedTo != null).map((m) => (
                        <div
                          key={`ghost-${m.label}`}
                          className="absolute top-[7px] bottom-[7px] rounded-lg border-[1.5px] border-dashed border-primary/60"
                          style={{ left: `calc(${pct(m.start)} + 2px)`, width: `calc(${pct(DEMO_SLOT)} - 4px)` }}
                        />
                      ))
                    : null}
                  {DEMO_MATCHES.filter((m) => m.court === court).map((m) => {
                    const lit = isLit(m);
                    const { start, length } = demoPlacement(m, step);
                    const held = m.kind === "held" && resolved;
                    const moved = resolved && m.movedTo != null;
                    const locked = demoGroup(m) === "locked";
                    return (
                      <div
                        key={m.label}
                        className={cn(
                          "absolute flex items-center gap-1.5 overflow-hidden rounded-lg border px-1 text-[11px] font-bold whitespace-nowrap transition-[left,width,background-color,border-color,color,top]",
                          "sm:px-2 sm:text-xs",
                          EASE,
                          held ? "top-[22px] -bottom-1.5 z-[5]" : "top-[7px] bottom-[7px]",
                          m.kind === "late" ? "z-[4]" : "z-[2]",
                          blockLook(m),
                        )}
                        style={{ left: `calc(${pct(start)} + 2px)`, width: `calc(${pct(length)} - 4px)` }}
                      >
                        {locked ? <Lock className="hidden size-3 shrink-0 sm:block" /> : null}
                        <span className="flex min-w-0 flex-col">
                          <span className="font-mono text-[10px] tabular-nums sm:text-[11px]">
                            {demoClock(start)}
                            {moved ? <span className="hidden sm:inline"> +{start - m.start}</span> : null}
                          </span>
                          <span className="hidden truncate sm:block">{label(m, step, lit)}</span>
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
        <p className="max-w-[520px] text-[13px] leading-normal text-muted-foreground">
          Dashed outline: where a moved match was published. Amber: the match that ran over, still on
          court. Choose a group above to pick out its matches.
        </p>
        {resolved ? (
          <p className="flex max-w-[480px] items-start gap-2.5 rounded-xl bg-foreground px-4 py-3 text-sm leading-normal text-background shadow-[0_20px_40px_-20px_var(--foreground)]">
            <Check className="mt-0.5 size-[18px] shrink-0" aria-hidden="true" />
            <span>
              <span className="sr-only">The desk then shows: </span>
              {DEMO_TOAST}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
