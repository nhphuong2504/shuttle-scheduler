import type { ReactNode } from "react";

import { RegistrationDecisionPill, RegistrationStatePill } from "@/components/app-shell";
import { entryTypeLabel } from "@/lib/tournament/registration";
import {
  registrationDecisionHint,
  registrationStateHint,
} from "@/lib/tournament/registration-state";

/**
 * Two phones for the people who only watch and play: My matches, and the tournament page as a
 * registered player sees it.
 *
 * Both use the app's own words - the "Called to Court N" state a Desk call lights, the
 * placement path and its "Win it for Draw A" line, the registration window pill and hint, the
 * decision pill and hint, the entry line - so the front door promises exactly what a visitor
 * finds. The player is Ben Carter, whose matches the Desk still above and the schedule demo
 * already follow. One image to assistive technology.
 */
export function ReaderPreview() {
  return (
    <div
      role="img"
      aria-label="Two phones: Ben Carter's My matches, called to Court 3 with the draw a win leads to, and his approved registration on the tournament page."
      className="relative h-[460px] overflow-hidden rounded-[32px] bg-[radial-gradient(120%_90%_at_70%_20%,var(--info-border)_0%,var(--info-surface)_55%,var(--background)_100%)] sm:h-[500px]"
    >
      <Phone className="top-14 left-1/2 -translate-x-1/2 -rotate-[4deg] sm:left-[8%] sm:translate-x-0">
        <p className="font-display text-lg font-bold">My matches</p>
        <div className="flex flex-col gap-1.5 rounded-xl border border-primary/40 bg-primary/5 p-2.5">
          <span className="text-xs font-semibold text-primary-ink">Called to Court 3</span>
          <span className="text-xs text-muted-foreground">Against</span>
          <span className="font-display text-base leading-tight font-bold">
            Max Walsh / Owen Brooks
          </span>
          <span className="font-display text-sm font-bold tabular-nums">Court 3, 14:50</span>
          <span className="font-score text-xs text-muted-foreground">MD R2</span>
        </div>
        <div className="flex flex-col gap-1.5 rounded-xl border border-hairline bg-surface p-2.5">
          <span className="font-display text-sm font-bold">Men&rsquo;s Doubles</span>
          <div className="flex flex-wrap gap-1">
            <span className="rounded-md border border-success-foreground/40 bg-success-surface px-2 py-1 text-xs font-semibold text-success-foreground">
              Placement 1: won
            </span>
            <span className="rounded-md border border-dashed border-border-control bg-surface px-2 py-1 text-xs font-semibold text-muted-foreground">
              Placement 2: to play
            </span>
          </div>
          <span className="text-xs leading-snug text-muted-foreground">
            Win the next placement match for Draw A. Lose it for Draw B.
          </span>
        </div>
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
              <span className="text-muted-foreground"> ({entryTypeLabel("pair")})</span>
            </li>
            <li>
              Mixed Doubles with Amy Young
              <span className="text-muted-foreground"> ({entryTypeLabel("pair")})</span>
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
