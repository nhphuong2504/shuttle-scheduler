import type { ReactNode } from "react";

import { RegistrationDecisionPill, RegistrationStatePill } from "@/components/app-shell";
import {
  COURT_STATE_CHIP,
  COURT_STATE_LABEL,
  COURT_STATE_TILE,
  type CourtState,
} from "@/lib/tournament/court-state";
import { entryTypeLabel } from "@/lib/tournament/registration";
import { registrationDecisionHint, registrationStateHint } from "@/lib/tournament/registration-state";

/**
 * Two phones for the people who only watch and play: the read-only board, and the
 * tournament page as a registered player sees it.
 *
 * Both use the app's own words and pills - the read-only notice, the registration window
 * pill and hint, the decision pill and hint, the entry line - so the front door promises
 * exactly what a visitor finds. The player is Ben Carter, whose matches the Desk still above
 * and the schedule demo already follow. One image to assistive technology.
 */
export function ReaderPreview() {
  return (
    <div
      role="img"
      aria-label="Two phones: the court board, read-only, and Ben Carter's approved registration on the tournament page."
      className="relative h-[460px] overflow-hidden rounded-[32px] bg-[radial-gradient(120%_90%_at_70%_20%,var(--info-border)_0%,var(--info-surface)_55%,var(--background)_100%)] sm:h-[500px]"
    >
      <Phone className="top-14 left-1/2 -translate-x-1/2 -rotate-[4deg] sm:left-[8%] sm:translate-x-0">
        <p className="rounded-lg border border-info-border bg-info-surface px-2.5 py-2 text-xs leading-snug text-info-foreground">
          Read-only view. Sign in to start, score and schedule matches.
        </p>
        <p className="font-display text-lg font-bold">Control desk</p>
        <div className="flex gap-1">
          <span className="rounded-md bg-primary px-2 py-1.5 text-xs font-semibold text-primary-foreground tabular-nums">
            Sat, Oct 18
          </span>
          <span className="rounded-md bg-muted px-2 py-1.5 text-xs font-semibold text-muted-foreground tabular-nums">
            Sun, Oct 19
          </span>
        </div>
        <PhoneTile court={1} state="playing" names="Hannah Kim vs Grace Lowe" timer="12′ on court" />
        <PhoneTile
          court={2}
          state="overrun"
          names="Ben Carter / Leo Nguyen vs Max Walsh / Owen Brooks"
          timer="37′ on court · +12 over slot"
        />
      </Phone>

      <Phone className="top-32 right-[7%] hidden rotate-[3deg] sm:flex">
        <div>
          <p className="font-display text-lg leading-tight font-bold">Riverside Open</p>
          <p className="text-xs text-muted-foreground">Riverside Sports Hall</p>
        </div>
        <div className="flex flex-col gap-1.5 rounded-xl border border-hairline bg-surface p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-display text-sm font-bold">Registration</span>
            <span className="origin-right scale-[0.8]">
              <RegistrationStatePill state="closed" />
            </span>
          </div>
          <span className="text-xs text-muted-foreground">{registrationStateHint("closed")}</span>
        </div>
        <div className="flex flex-col gap-1.5 rounded-xl border border-hairline bg-surface p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-display text-sm font-bold">Your registration</span>
            <span className="origin-right scale-[0.8]">
              <RegistrationDecisionPill decision="approved" />
            </span>
          </div>
          <span className="text-xs leading-snug">{registrationDecisionHint("approved")}</span>
          <ul className="flex flex-col gap-1 border-t border-hairline pt-1.5 text-xs">
            <li>
              Men&rsquo;s Doubles with Leo Nguyen
              <span className="text-muted-foreground"> · {entryTypeLabel("pair")}</span>
            </li>
            <li>
              Mixed Doubles with Amy Young
              <span className="text-muted-foreground"> · {entryTypeLabel("pair")}</span>
            </li>
          </ul>
        </div>
      </Phone>
    </div>
  );
}

function Phone({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div
      className={`absolute flex w-[270px] flex-col gap-2.5 rounded-[36px] bg-background px-3.5 pt-5 pb-4 shadow-[0_0_0_8px_var(--foreground),0_40px_80px_-30px_var(--info-foreground)] ${className}`}
    >
      {children}
    </div>
  );
}

function PhoneTile({
  court,
  state,
  names,
  timer,
}: {
  court: number;
  state: CourtState;
  names: string;
  timer: string;
}) {
  return (
    <div className={`flex flex-col gap-1 rounded-xl border p-2.5 ${COURT_STATE_TILE[state]}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold">Court {court}</span>
        <span
          className={`rounded-full px-2 py-0.5 font-score text-xs font-semibold uppercase tracking-wide ${COURT_STATE_CHIP[state]}`}
        >
          {COURT_STATE_LABEL[state]}
        </span>
      </div>
      <span className="text-sm font-semibold leading-snug">{names}</span>
      <span
        className={`text-xs tabular-nums ${state === "overrun" ? "font-semibold text-warn-foreground" : "text-muted-foreground"}`}
      >
        {timer}
      </span>
      <span className="text-xs font-semibold text-primary-ink">View match</span>
    </div>
  );
}
