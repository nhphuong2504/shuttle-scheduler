import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useDensity } from "@/hooks/useDensity";
import { useSession } from "@/hooks/useSession";
import { useTheme } from "@/hooks/useTheme";
import { supabase } from "@/integrations/supabase/client";
import type { Density } from "@/lib/design/density";
import type { Theme } from "@/lib/design/theme";
import { cn } from "@/lib/utils";

/**
 * The desk navigation.
 *
 * Pools and Draws are deliberately absent: the tournament creation flow replaced
 * the round-robin engine with the two-round placement format, and `/schedule` is
 * wired to the round-robin tables. Those route files and every library they depend
 * on are untouched, so the pages still exist for a direct URL; only the nav entries
 * are gone.
 *
 * `Placement` and `Schedule` are the format that *is* built, so they are the two
 * entries that lead to its own engine.
 */
const NAV = [
  { to: "/", label: "Desk" },
  { to: "/registration", label: "Registration" },
  { to: "/placement", label: "Placement" },
  { to: "/knockout", label: "Knockout" },
  { to: "/placement-schedule", label: "Schedule" },
  { to: "/matches", label: "Scores" },
] as const;

const DENSITY_OPTIONS: { value: Density; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Density switch.
 *
 * A `role="group"` of pressed buttons rather than a radiogroup: these apply
 * immediately and are not a form field awaiting submission, so `aria-pressed`
 * describes them accurately while a radio role would imply a pending value.
 *
 * The pressed button always reflects what is actually rendering, including when
 * that came from a route default - the control never misrepresents the state to
 * make the choice look deliberate. "Default" appears only once a choice exists,
 * because resetting has no meaning before then.
 */
function DensityToggle({
  density,
  isExplicit,
  onChange,
  onReset,
}: {
  density: Density;
  isExplicit: boolean;
  onChange: (next: Density) => void;
  onReset: () => void;
}) {
  return (
    <div className="hidden items-center gap-1.5 sm:flex">
      <div
        role="group"
        aria-label="Text and row density"
        className="flex items-center rounded-full border border-hairline bg-muted/60 p-0.5"
      >
        {DENSITY_OPTIONS.map((option) => {
          const active = density === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={cn(
                "rounded-full px-2.5 py-1 font-semibold transition-colors",
                "text-t4",
                active
                  ? "bg-surface text-foreground shadow-panel"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {isExplicit ? (
        <button
          type="button"
          onClick={onReset}
          title="Go back to this page's default density"
          className="text-t4 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Default
        </button>
      ) : null}
    </div>
  );
}

/**
 * Theme switch.
 *
 * A separate control from the density switch rather than one merged "appearance"
 * control, because the two answer different questions: density is about how much fits
 * on the screen, theme is about what can be seen in the room. A dense list in a
 * brightly lit hall is a completely ordinary combination, and folding the two together
 * would make choosing one imply something about the other.
 *
 * Same pressed-button group as the density switch, deliberately - the interaction is
 * already learned from the control beside it - and the same honesty rule: the pressed
 * button reflects what is actually rendering, including when that came from the
 * operating system rather than from a choice made here. "System" appears only once a
 * choice exists, because returning to the system has no meaning before then, and its
 * tooltip says which way the system currently points.
 */
function ThemeToggle({
  theme,
  systemPrefersDark,
  isExplicit,
  onChange,
  onReset,
}: {
  theme: Theme;
  systemPrefersDark: boolean;
  isExplicit: boolean;
  onChange: (next: Theme) => void;
  onReset: () => void;
}) {
  return (
    <div className="hidden items-center gap-1.5 sm:flex">
      <div
        role="group"
        aria-label="Colour theme"
        className="flex items-center rounded-full border border-hairline bg-muted/60 p-0.5"
      >
        {THEME_OPTIONS.map((option) => {
          const active = theme === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option.value)}
              className={cn(
                "rounded-full px-2.5 py-1 font-semibold transition-colors",
                "text-t4",
                active
                  ? "bg-surface text-foreground shadow-panel"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {isExplicit ? (
        <button
          type="button"
          onClick={onReset}
          title={`Follow the system, which is currently ${systemPrefersDark ? "dark" : "light"}`}
          className="text-t4 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          System
        </button>
      ) : null}
    </div>
  );
}

export function AppShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { session, signedIn, role, isAdmin } = useSession();
  const navigate = useNavigate();
  // The route decides the *default* density, and only the default - an explicit
  // choice is resolved ahead of it inside useDensity.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { density, isExplicit, setDensity, clearDensity } = useDensity(pathname);
  // The theme takes no pathname, and that is the design rather than an omission: its
  // fallback is the operating system, not the route, so there is nothing for a route
  // to contribute. See `resolveTheme`.
  const {
    theme,
    systemPrefersDark,
    isExplicit: themeIsExplicit,
    setTheme,
    clearTheme,
  } = useTheme();

  const nav = [
    ...NAV,
    // Creating a tournament is admin-only.
    ...(isAdmin ? [{ to: "/setup" as const, label: "Tournament setup" }] : []),
    ...(isAdmin ? [{ to: "/staff" as const, label: "Staff" }] : []),
  ];

  return (
    <div className="min-h-screen bg-background font-body text-foreground">
      <header className="sticky top-0 z-30 border-b border-hairline bg-surface/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <Link to="/" className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-lg bg-primary font-display text-t2 font-bold text-primary-foreground shadow-panel">
              S
            </span>
            <span className="font-display text-sm font-bold tracking-tight text-primary">
              SHUTTLENET<span className="text-muted-foreground"> / ops</span>
            </span>
          </Link>
          <nav className="flex flex-wrap items-center gap-1">
            {nav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                activeProps={{
                  className:
                    "bg-primary text-primary-foreground shadow-panel hover:bg-primary hover:text-primary-foreground",
                }}
                activeOptions={{ exact: item.to === "/" }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-xs">
            <DensityToggle
              density={density}
              isExplicit={isExplicit}
              onChange={setDensity}
              onReset={clearDensity}
            />
            <ThemeToggle
              theme={theme}
              systemPrefersDark={systemPrefersDark}
              isExplicit={themeIsExplicit}
              onChange={setTheme}
              onReset={clearTheme}
            />
            {signedIn ? (
              <>
                <span className="hidden items-center gap-1.5 rounded-full border border-hairline bg-muted/60 px-2.5 py-1 text-muted-foreground sm:inline-flex">
                  <span className="size-1.5 rounded-full bg-primary" />
                  {session?.userEmail}
                  {role ? ` · ${role}` : ""}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await supabase.auth.signOut();
                    navigate({ to: "/auth", replace: true });
                  }}
                >
                  Sign out
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => navigate({ to: "/auth" })}>
                Desk sign in
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto min-h-[calc(100vh-3.5rem)] max-w-[1400px] px-4 py-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
            {subtitle ? (
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </div>
        {!signedIn ? (
          <div className="mb-5 rounded-lg border border-warn-border bg-warn-surface px-3 py-2 text-xs font-medium text-warn-foreground">
            Read-only view. Sign in at the desk to enter scores or generate pools, draws and
            schedules.
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}

export function Panel({
  title,
  right,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-hairline bg-surface shadow-panel transition-shadow hover:shadow-raise",
        className,
      )}
    >
      {title || right ? (
        <header className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-2.5">
          <h2 className="font-display text-xs font-bold uppercase tracking-widest text-muted-foreground">
            {title}
          </h2>
          {right}
        </header>
      ) : null}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "normal",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "normal" | "good" | "warn" | "danger";
}) {
  const toneClass =
    tone === "danger"
      ? "border-danger-border bg-danger-surface"
      : tone === "warn"
        ? "border-warn-border bg-warn-surface"
        : tone === "good"
          ? "border-hairline bg-success/10"
          : "border-hairline bg-surface";
  return (
    <div className={cn("rounded-xl border p-3 shadow-panel", toneClass)}>
      <p className="text-t4 font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-score text-t1 font-semibold leading-none tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-t4 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-hairline bg-muted/30 px-4 py-8 text-center">
      <p className="font-display text-sm font-semibold">{title}</p>
      {hint ? <p className="max-w-md text-xs text-muted-foreground">{hint}</p> : null}
      {action}
    </div>
  );
}

/**
 * The nine operating states, in four tiers.
 *
 * Tier is the structural idea. Tiers 1-3 render as a chip; tier 4 renders as
 * bare inline text. That is the whole reason archive states recede.
 *
 *   tier 1  saturated chip   live, disputed          may animate
 *   tier 2  shared amber     paused, called
 *   tier 3  gray chip        warm-up, scheduled
 *   tier 4  NO chip          walkover, retired, completed
 *
 * Colour is never the only channel: every state also carries a distinct glyph
 * and a text label, so the pill survives grayscale, colour blindness, and a
 * wall display read from ten metres away.
 */
const STATE_ALIAS: Record<string, string> = {
  "in-progress": "live",
  reported: "completed",
};

const STATE_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  live: "Live",
  walkover: "Walkover",
  completed: "Completed",
};

const STATE_TIER: Record<string, 1 | 2 | 3 | 4> = {
  live: 1,
  scheduled: 3,
  walkover: 4,
  completed: 4,
};

/**
 * Chip classes for tiers 1 to 3 only. Tier 4 has no chip token to reference.
 *
 * The four phantom states - called, warm-up, paused, disputed - are absent
 * because their tokens are absent. A state is added here only alongside the
 * migration that makes it producible.
 */
const STATE_CLASS: Record<string, string> = {
  live: "bg-state-live-chip text-state-live-ink ring-state-live-ink/25",
  scheduled: "bg-state-scheduled-chip text-state-scheduled-ink ring-state-scheduled-ink/25",
};

/**
 * Tier 4 is ink-only: no fill, no border, no radius.
 *
 * Archive states recede by LOSING their container, not by lightening their ink.
 * Lightening was the original plan and it fails measurement - the lightest grey
 * that still clears 4.5:1 on a surface is about L 0.55, so an archive ink at
 * L 0.64 would be illegal. Dropping the chip removes far more visual weight than
 * a lightness step could, while raising legibility instead of lowering it.
 */
const STATE_TIER4_CLASS = "text-state-completed-ink";

/** Strokes use `currentColor`, so the glyph inherits the state ink. */
function glyph(children: ReactNode) {
  return (
    <svg
      viewBox="0 0 18 18"
      className="size-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const STATE_GLYPH: Record<string, ReactNode> = {
  // Clock — nothing has started yet.
  scheduled: glyph(
    <>
      <circle cx="9" cy="9" r="6.25" />
      <path d="M9 5.75V9l2.25 1.5" />
    </>,
  ),
  // Filled target — the match is running now.
  live: glyph(
    <>
      <circle cx="9" cy="9" r="6.25" />
      <circle cx="9" cy="9" r="2.6" fill="currentColor" stroke="none" />
    </>,
  ),
  // Skip — the tie was passed over, not played.
  walkover: glyph(
    <>
      <path d="M5.6 6.1 9.4 9l-3.8 2.9z" fill="currentColor" stroke="none" />
      <path d="M11.9 6.1v5.8" />
    </>,
  ),
  // Check.
  completed: glyph(<path d="M5 9.4l2.7 2.7L13 6.4" />),
};

const STATE_FALLBACK_GLYPH = glyph(
  <circle cx="9" cy="9" r="1.8" fill="currentColor" stroke="none" />,
);

export function StatusPill({ status }: { status: string }) {
  const key = STATE_ALIAS[status] ?? status;
  const known = key in STATE_LABEL;
  const tier = known ? STATE_TIER[key] : null;
  const glyphNode = known ? STATE_GLYPH[key] : STATE_FALLBACK_GLYPH;
  const label = known ? STATE_LABEL[key] : status.replace(/_/g, " ");

  if (tier === 4) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 font-score text-t2 uppercase tracking-wider",
          STATE_TIER4_CLASS,
        )}
      >
        {glyphNode}
        {label}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-score text-t2 uppercase tracking-wider ring-1 ring-inset",
        known ? STATE_CLASS[key] : "bg-muted text-muted-foreground ring-hairline",
      )}
    >
      {glyphNode}
      {label}
    </span>
  );
}
