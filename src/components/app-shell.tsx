import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { supabase } from "@/integrations/supabase/client";
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
  { to: "/placement-schedule", label: "Schedule" },
  { to: "/matches", label: "Scores" },
] as const;

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
            <span className="grid size-7 place-items-center rounded-lg bg-primary font-display text-[13px] font-bold text-primary-foreground shadow-panel">
              S
            </span>
            <span className="font-display text-sm font-bold tracking-tight text-brand">
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
            {signedIn ? (
              <>
                <span className="hidden items-center gap-1.5 rounded-full border border-hairline bg-muted/60 px-2.5 py-1 text-muted-foreground sm:inline-flex">
                  <span className="size-1.5 rounded-full bg-mint" />
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
          ? "border-hairline bg-mint/10"
          : "border-hairline bg-surface";
  return (
    <div className={cn("rounded-xl border p-3 shadow-panel", toneClass)}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-score text-2xl font-semibold leading-none tracking-tight">{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
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

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    reported: "bg-mint/20 text-foreground ring-mint/40",
    walkover: "bg-mint/15 text-foreground ring-mint/30",
    "in-progress": "bg-amber/25 text-foreground ring-amber/50",
    scheduled: "bg-muted text-muted-foreground ring-hairline",
    void: "bg-danger-surface text-danger-foreground ring-danger-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 font-score text-[10px] uppercase tracking-wider ring-1 ring-inset",
        map[status] ?? "bg-muted text-muted-foreground ring-hairline",
      )}
    >
      {status.replace("_", " ")}
    </span>
  );
}
