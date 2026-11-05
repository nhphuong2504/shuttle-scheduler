import { Link, useLocation } from "@tanstack/react-router";
import { ArrowRight, CalendarClock, Check, Clock, LayoutGrid, SquareCheck, UserRound, Zap } from "lucide-react";
import type { ReactNode } from "react";

import { PublicShell } from "@/components/app-shell";
import { signInSearch } from "@/lib/routing/redirect";
import { cn } from "@/lib/utils";

import { DeskPreview } from "./desk-preview";
import { ReaderPreview } from "./reader-preview";
import { ScheduleDemo } from "./schedule-demo";

const WRAP = "mx-auto w-full max-w-[1240px] px-4 sm:px-6";
const H2 = "font-display text-[clamp(34px,4.8vw,62px)] leading-[0.98] font-extrabold tracking-[-0.045em]";
const EYEBROW =
  "inline-flex items-center gap-2 self-start rounded-full bg-primary/10 py-1.5 pr-3 pl-2.5 text-xs font-bold tracking-[0.08em] text-info-foreground uppercase";
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
const PRIMARY_LINK = cn(
  "inline-flex min-h-14 items-center gap-2.5 rounded-2xl bg-primary px-6 text-[17px] font-bold text-primary-foreground shadow-[0_14px_30px_-14px_var(--primary)] transition-colors hover:bg-primary-hover",
  FOCUS_RING,
);
const TEXT_LINK = cn(
  "inline-flex min-h-11 items-center gap-2 text-base font-bold text-foreground underline underline-offset-[6px] hover:text-primary-ink sm:text-[17px]",
  FOCUS_RING,
);

/**
 * The front door for a visitor: the Desk first, then the schedule behind it, then the
 * people who only watch and play.
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
      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-b from-info-surface via-info-surface/80 to-background">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-[360px] -right-[300px] size-[1150px] rounded-full bg-primary/[0.07]"
        />
        <div className={cn(WRAP, "relative grid items-center gap-x-10 gap-y-10 pt-6 pb-16 sm:pt-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:pb-20")}>
          <div className="flex max-w-[520px] flex-col gap-[22px]">
            <span className={EYEBROW}>
              <span aria-hidden="true" className="size-[7px] rounded-full bg-primary" />
              Live tournament operations
            </span>
            <h1 className="font-display text-[clamp(46px,5.8vw,84px)] leading-[0.93] font-extrabold tracking-[-0.052em]">
              Every match.
              <br />
              Every court.
              <br />
              <span className="text-primary">One place.</span>
            </h1>
            <p className="max-w-[470px] text-lg leading-relaxed text-foreground/80 sm:text-[19px]">
              One control desk for the whole day — every court, the next match, and a schedule that
              keeps up when a match runs late.
            </p>
            <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
              <Link to="/tournaments/new" className={PRIMARY_LINK}>
                Run a tournament
                <ArrowRight className="size-5" aria-hidden="true" />
              </Link>
              <Link to="/explore" className={TEXT_LINK}>
                Browse tournaments
                <ArrowRight className="size-[18px]" aria-hidden="true" />
              </Link>
            </div>
            <ul className="mt-1 flex flex-wrap gap-x-6 gap-y-3 border-t border-info-border pt-[18px] text-sm font-semibold text-foreground/80">
              <HeroPoint icon={<Zap className="size-4" />}>Live on every screen</HeroPoint>
              <HeroPoint icon={<CalendarClock className="size-4" />}>Schedule that keeps up</HeroPoint>
              <HeroPoint icon={<Clock className="size-4" />}>Rest for every player</HeroPoint>
            </ul>
          </div>

          <div id="desk" className="min-w-0 [perspective:2600px] lg:-mr-10">
            <div className="origin-left motion-safe:lg:[transform:rotateY(-6deg)_rotateX(2deg)]">
              <DeskPreview />
            </div>
          </div>
        </div>
      </section>

      {/* Behind the desk */}
      <section
        id="schedule"
        aria-labelledby="landing-schedule"
        className="bg-gradient-to-b from-background via-info-surface to-background py-20 sm:py-28"
      >
        <div className={cn(WRAP, "flex flex-col gap-9")}>
          <div className="flex flex-col items-center gap-4 text-center">
            <span className={cn(EYEBROW, "self-center")}>Behind the desk</span>
            <h2 id="landing-schedule" className={H2}>
              Let the schedule do the juggling.
            </h2>
            <p className="max-w-[560px] text-lg leading-relaxed text-foreground/80">
              Court 2 just ran 12 minutes over. Press play and watch what Tournova does with the rest
              of the day.
            </p>
          </div>
          <ScheduleDemo />
        </div>
      </section>

      {/* For players and spectators */}
      <section aria-labelledby="landing-players" className="py-16 sm:py-24">
        <div className={cn(WRAP, "grid items-center gap-x-16 gap-y-12 lg:grid-cols-2")}>
          <div className="flex flex-col gap-[22px]">
            <span className={EYEBROW}>For players and spectators</span>
            <h2 id="landing-players" className={H2}>
              Your court, your status — on your phone.
            </h2>
            <ul className="flex flex-col gap-[18px]">
              <PlayerPoint icon={<LayoutGrid className="size-5" />} title="Follow every court, live">
                On court, up next and just finished — open to anyone, no account needed.
              </PlayerPoint>
              <PlayerPoint icon={<UserRound className="size-5" />} title="See your next match">
                Your court, your opponent, and the draw a win leads to.
              </PlayerPoint>
              <PlayerPoint icon={<SquareCheck className="size-5" />} title="Register from the tournament page">
                Sign in, choose your events and name your partner.
              </PlayerPoint>
              <PlayerPoint icon={<UserRound className="size-5" />} title="Know where you stand">
                Awaiting decision, Approved or Not accepted — with the organisers&rsquo; note.
              </PlayerPoint>
            </ul>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 pt-1.5">
              <Link
                to="/explore"
                className={cn(
                  "inline-flex min-h-[52px] items-center gap-2.5 rounded-2xl bg-surface px-[22px] text-base font-bold text-info-foreground shadow-[inset_0_0_0_1.5px_var(--primary)] transition-colors hover:bg-info-surface",
                  FOCUS_RING,
                )}
              >
                See what&rsquo;s on
                <ArrowRight className="size-[18px]" aria-hidden="true" />
              </Link>
              <Link to="/auth" search={signInSearch(href)} className={TEXT_LINK}>
                Sign in
              </Link>
            </div>
          </div>
          <ReaderPreview />
        </div>
      </section>

      {/* Closing */}
      <section aria-labelledby="landing-close" className="pb-14 sm:pb-24">
        <div className={WRAP}>
          <div className="grid items-center gap-10 rounded-[32px] bg-info-foreground p-7 text-primary-foreground sm:p-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:p-16">
            <div className="flex min-w-0 flex-col gap-[18px]">
              <span className="text-[15px] font-semibold text-primary-foreground/80">Saturday</span>
              <span className="font-display text-[clamp(88px,15vw,196px)] leading-[0.82] font-extrabold tracking-[-0.06em] tabular-nums">
                08:00
              </span>
              <h2
                id="landing-close"
                className="mt-1.5 font-display text-[clamp(30px,3.6vw,48px)] leading-none font-extrabold tracking-[-0.04em]"
              >
                Doors open.{" "}
                <span className="text-primary-foreground/75">You&rsquo;re ready.</span>
              </h2>
              <p className="max-w-[420px] text-[17px] leading-relaxed text-primary-foreground/85">
                Set it up in the weeks before. On the day, it&rsquo;s one desk.
              </p>
            </div>
            <div className="overflow-hidden rounded-[20px] bg-surface text-foreground shadow-[0_30px_60px_-30px_rgb(0_0_0/0.5)]">
              <p className="border-b border-hairline px-5 py-3.5 font-display text-[17px] font-bold">
                Before the doors open
              </p>
              <ul className="flex flex-col px-5 py-2">
                <Ready>Registration closed, requests decided</Ready>
                <Ready>Schedule built for every playing day</Ready>
                <Ready>Editors added under Access</Ready>
                <Ready last>Court board open for anyone to follow</Ready>
              </ul>
              <div className="px-5 pb-5">
                <Link
                  to="/tournaments/new"
                  className={cn(
                    "flex min-h-14 items-center justify-center gap-2.5 rounded-2xl bg-primary text-[17px] font-bold text-primary-foreground transition-colors hover:bg-primary-hover",
                    FOCUS_RING,
                  )}
                >
                  Create a tournament
                  <ArrowRight className="size-[18px]" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </PublicShell>
  );
}

function HeroPoint({ icon, children }: { icon: ReactNode; children: string }) {
  return (
    <li className="inline-flex items-center gap-2">
      <span aria-hidden="true" className="text-primary">
        {icon}
      </span>
      {children}
    </li>
  );
}

function PlayerPoint({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3.5">
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface text-primary shadow-[0_1px_2px_rgb(23_26_29/0.06),inset_0_0_0_1px_var(--info-border)]"
      >
        {icon}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[17px] font-bold">{title}</span>
        <span className="text-[15px] leading-normal text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

function Ready({ children, last = false }: { children: string; last?: boolean }) {
  return (
    <li className={cn("flex items-center gap-3 py-3 text-base", !last && "border-b border-hairline")}>
      <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
        <Check className="size-3.5" strokeWidth={3} />
      </span>
      {children}
    </li>
  );
}

