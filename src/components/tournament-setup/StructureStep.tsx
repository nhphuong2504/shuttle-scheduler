import { ArrowRight, Info } from "lucide-react";
import type { ReactNode } from "react";

import {
  SUPPORTED_FORMAT,
  type CompetitionFormat,
} from "@/lib/tournament/competition-format";
import { SetupSection } from "./section";

/**
 * The formats a host can choose between.
 *
 * There is one today, because the engine implements one. The step is laid out as a list of
 * cards so a second format is one more entry here, not a new screen - but while there is one,
 * the step must not pretend there is a decision. So the card is not a radio and does not look
 * clickable: it is marked "Selected", and a line under it says it is the only one. When a
 * second format exists, the cards become a radio group and `toDraftInput` stops fixing it.
 */
const FORMATS: CompetitionFormat[] = [SUPPORTED_FORMAT];

/**
 * The third step: how the competition is run.
 *
 * Read-only for now (see `FORMATS`). The selected card explains the format as two stages
 * side by side - what happens first, and the draws it sorts entrants into - rather than as
 * a page of prose, and keeps the rule for an odd number of entrants one press away.
 */
export function StructureStep() {
  const selected = SUPPORTED_FORMAT.id;

  return (
    <div className="space-y-5">
      <SetupSection
        headingId="setup-format"
        title="Competition format"
        hint="How entrants are sorted and who plays whom. The same format applies to every event."
      >
        <div className="space-y-3">
          {FORMATS.map((format) => {
            const isSelected = format.id === selected;
            return (
              <div
                key={format.id}
                className={`flex gap-4 rounded-2xl border-2 p-5 ${
                  isSelected ? "border-primary bg-info-surface/40" : "border-hairline bg-surface"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                    <span className="font-display text-lg font-bold leading-snug">
                      {format.name}
                    </span>
                    {isSelected ? (
                      <span className="rounded-full bg-info-surface px-3 py-0.5 text-sm font-bold text-info-foreground">
                        Selected
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1.5 block text-base text-muted-foreground">
                    {format.summary}
                  </span>
                  <span className="mt-3 flex flex-wrap gap-2 text-sm">
                    <Tag>{format.placement.rounds} placement rounds</Tag>
                    <Tag>{format.tiers.length} knockout draws</Tag>
                    <Tag>{format.knockout.elimination}</Tag>
                  </span>

                  {isSelected ? <HowItRuns format={format} /> : null}
                </span>
              </div>
            );
          })}
        </div>

        <p className="mt-4 flex items-start gap-2.5 text-sm text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-[18px] shrink-0" />
          This is the only format available at the moment. When there are more, they appear here
          as cards to choose between.
        </p>
      </SetupSection>
    </div>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-secondary px-3 py-0.5 text-muted-foreground ring-1 ring-inset ring-hairline">
      {children}
    </span>
  );
}

/** The two stages of a format, as two boxes with an arrow between them. */
function HowItRuns({ format }: { format: CompetitionFormat }) {
  return (
    <span className="mt-5 block border-t border-hairline pt-4">
      <span className="block text-sm font-bold uppercase tracking-wide text-muted-foreground">
        How it runs
      </span>
      <span className="mt-3 grid items-stretch gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.5fr)]">
        <span className="block rounded-xl border border-hairline bg-surface p-4">
          <span className="block text-base font-bold">Stage 1 — Placement</span>
          <span className="mt-2.5 flex flex-col gap-2 text-sm text-muted-foreground">
            <Step n={1}>Round one: entrants are paired.</Step>
            <Step n={2}>Round two: winners play winners, losers play losers.</Step>
          </span>
        </span>
        <span
          aria-hidden="true"
          className="hidden items-center text-muted-foreground md:flex"
        >
          <ArrowRight className="size-6" />
        </span>
        <span className="block rounded-xl border border-hairline bg-surface p-4">
          <span className="block text-base font-bold">Stage 2 — Knockout draws</span>
          <span className="mt-2.5 grid grid-cols-2 gap-2 text-sm">
            {format.tiers.map((tier) => (
              <span key={tier.tier} className="block rounded-lg bg-background px-3 py-2">
                <span className="block">
                  <strong>{tier.label}</strong>, {tier.title}
                </span>
                <span className="block text-sm text-muted-foreground">{tier.detail}</span>
              </span>
            ))}
          </span>
        </span>
      </span>
      <details className="group mt-3">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-primary-ink [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ▸
          </span>
          Odd number of entrants
        </summary>
        <span className="block pb-1 text-sm text-muted-foreground">{format.placement.detail}</span>
      </details>
    </span>
  );
}

function Step({ n, children }: { n: number; children: string }) {
  return (
    <span className="flex items-start gap-2.5">
      <span
        aria-hidden="true"
        className="grid size-[22px] shrink-0 place-items-center rounded-full bg-info-surface font-score text-sm font-bold text-info-foreground"
      >
        {n}
      </span>
      <span>{children}</span>
    </span>
  );
}
