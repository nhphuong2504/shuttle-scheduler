import { Link, useLocation } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import type { ReactNode } from "react";

import { PublicShell } from "@/components/app-shell";
import { signInSearch } from "@/lib/routing/redirect";
import { cn } from "@/lib/utils";

import { DeskPreview } from "./desk-preview";
import { ReaderPreview } from "./reader-preview";
import { ScheduleDemo } from "./schedule-demo";

const WRAP = "mx-auto w-full max-w-[1240px] px-4 sm:px-6";
const H2 = "font-display text-[clamp(34px,4.6vw,60px)] leading-[0.98] font-extrabold tracking-[-0.045em]";
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
const PRIMARY_LINK = cn(
  "inline-flex min-h-[52px] items-center gap-2.5 rounded-xl bg-primary px-[22px] text-base font-bold text-primary-foreground transition-colors hover:bg-primary-hover",
  FOCUS_RING,
);
const TEXT_LINK = cn(
  "inline-flex min-h-11 items-center gap-2 text-base font-bold text-foreground underline underline-offset-4 hover:text-primary-ink",
  FOCUS_RING,
);

/**
 * The front door for a visitor: the Desk first, then the schedule behind it, then the
 * people who only watch.
 *
 * Everything shown of the product is the product's own vocabulary (see `DeskPreview`,
 * `ScheduleDemo` and `ReaderPreview`), and every claim about scheduling is one the live
 * reflow keeps - the reasons are written beside the demo's data in `schedule-demo-data.ts`.
 * The page draws its own full-width sections inside the public shell's header and footer.
 */
export function Landing() {
  const href = useLocation({ select: (location) => location.href });

  return (
    <PublicShell bare>
      <section className={cn(WRAP, "flex flex-wrap items-end justify-between gap-x-16 gap-y-7 pt-[clamp(32px,6vw,72px)]")}>
        <h1 className="flex-[1_1_640px] font-display text-[clamp(48px,7.8vw,108px)] leading-[0.92] font-extrabold tracking-[-0.055em]">
          The tournament desk that knows what&rsquo;s next.
        </h1>
        <div className="flex flex-[0_1_360px] flex-col gap-5 pb-2.5">
          <p className="text-[19px] leading-relaxed text-foreground/80">
            Every court, the next match, and a schedule that keeps up when the day runs late.
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link to="/tournaments/new" className={PRIMARY_LINK}>
              Run a tournament
              <ArrowRight className="size-[18px]" aria-hidden="true" />
            </Link>
            <Link to="/explore" className={TEXT_LINK}>
              Browse tournaments
            </Link>
          </div>
        </div>
      </section>

      <section id="desk" aria-label="The desk" className={cn(WRAP, "pt-14")}>
        <DeskPreview />
        <div className="grid gap-x-10 gap-y-6 px-1 pt-7 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
          <Caption title="Needs action">What to chase next, each with the one button that clears it.</Caption>
          <Caption title="Court board">Every court in words, not just colour — and why a match can&rsquo;t start yet.</Caption>
          <Caption title="Live">Always know if updates are coming through, even on patchy hall wifi.</Caption>
        </div>
      </section>

      <section
        id="schedule"
        aria-labelledby="landing-schedule"
        className="mt-32 border-y border-hairline bg-surface"
      >
        <div className={cn(WRAP, "flex flex-col gap-8 py-24")}>
          <div className="flex flex-wrap items-end justify-between gap-5">
            <div className="flex flex-col gap-3">
              <span className="text-[15px] font-semibold text-muted-foreground">Behind the desk</span>
              <h2 id="landing-schedule" className={H2}>
                Let the schedule
                <br />
                do the juggling.
              </h2>
            </div>
            <p className="max-w-[360px] text-[17px] leading-relaxed text-muted-foreground">
              That late match on Court 2 — step through what happens when its result comes in.
            </p>
          </div>
          <ScheduleDemo />
          <div className="grid gap-x-10 gap-y-6 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
            <Caption title="Only later, only as needed">
              A match moves just far enough to fit — never earlier, never into another day.
            </Caption>
            <Caption title="Results stay put">Matches already played or on court never move.</Caption>
            <Caption title="You decide the hard ones">
              If a match can&rsquo;t move safely, it keeps its time and waits for your review.
            </Caption>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="landing-players"
        className={cn(WRAP, "flex flex-wrap items-center gap-x-[72px] gap-y-12 py-32")}
      >
        <div className="flex flex-[1_1_360px] flex-col gap-[18px]">
          <span className="text-[15px] font-semibold text-muted-foreground">For players and spectators</span>
          <h2 id="landing-players" className={H2}>
            Fewer &ldquo;which court am I on?&rdquo; questions.
          </h2>
          <p className="max-w-[460px] text-lg leading-relaxed text-muted-foreground">
            Anyone can follow the court board on their phone, no account needed. Players sign in to
            register from the tournament page.
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Link to="/explore" className={TEXT_LINK}>
              See what&rsquo;s on
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <Link to="/auth" search={signInSearch(href)} className={TEXT_LINK}>
              Sign in
            </Link>
          </div>
        </div>
        <ReaderPreview />
      </section>

      <section aria-labelledby="landing-close" className="bg-foreground text-background">
        <div className={cn(WRAP, "flex flex-wrap items-end justify-between gap-14 pt-[104px] pb-[88px]")}>
          <div className="flex flex-[1_1_440px] flex-col gap-[22px]">
            <span className="font-mono text-sm text-background/70 tabular-nums">Saturday, 08:00</span>
            <h2
              id="landing-close"
              className="font-display text-[clamp(44px,6vw,80px)] leading-[0.96] font-extrabold tracking-[-0.05em]"
            >
              Doors open.
              <br />
              You&rsquo;re ready.
            </h2>
            <p className="max-w-[440px] text-lg leading-relaxed text-background/80">
              Set it up in the weeks before. On the day, it&rsquo;s one desk.
            </p>
            <Link
              to="/tournaments/new"
              className={cn(
                "inline-flex min-h-[52px] items-center gap-2.5 self-start rounded-xl bg-background px-[22px] text-base font-bold text-foreground transition-colors hover:bg-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background focus-visible:ring-offset-2 focus-visible:ring-offset-foreground",
              )}
            >
              Create a tournament
              <ArrowRight className="size-[18px]" aria-hidden="true" />
            </Link>
          </div>
          <ul className="flex flex-[0_1_400px] flex-col border-t border-background/20">
            <Ready>Registration closed, requests decided</Ready>
            <Ready>Schedule built for every playing day</Ready>
            <Ready>Editors added under Access</Ready>
            <Ready>Court board open for anyone to follow</Ready>
          </ul>
        </div>
      </section>
    </PublicShell>
  );
}

function Caption({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-t-2 border-foreground pt-3.5">
      <h3 className="font-display text-[19px] font-extrabold tracking-[-0.02em]">{title}</h3>
      <p className="text-[15px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

function Ready({ children }: { children: string }) {
  return (
    <li className="flex items-center gap-3.5 border-b border-background/20 py-4 text-[17px]">
      <Check className="size-5 shrink-0" aria-hidden="true" />
      {children}
    </li>
  );
}
