import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { supabase } from "@/integrations/supabase/client";

const NAV = [
  { to: "/", label: "Desk" },
  { to: "/registration", label: "Registration" },
  { to: "/pools", label: "Pools" },
  { to: "/matches", label: "Scores" },
  { to: "/draws", label: "Draws" },
  { to: "/schedule", label: "Schedule" },
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

  return (
    <div className="min-h-screen bg-background font-body text-foreground">
      <header className="sticky top-0 z-30 border-b border-hairline bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <Link to="/" className="font-display text-sm font-bold tracking-tight text-brand">
            SHUTTLENET<span className="text-muted-foreground"> / ops</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-1">
            {[...NAV, ...(isAdmin ? [{ to: "/staff" as const, label: "Staff" }] : [])].map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="rounded-md px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                activeProps={{ className: "bg-primary/10 text-primary" }}
                activeOptions={{ exact: item.to === "/" }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-xs">
            {signedIn ? (
              <>
                <span className="hidden text-muted-foreground sm:inline">
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

      <main className="mx-auto max-w-[1400px] px-4 py-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </div>
        {!signedIn ? (
          <div className="mb-5 rounded-lg border border-warn-border bg-warn-surface px-3 py-2 text-xs font-medium text-warn-foreground">
            Read-only view. Sign in at the desk to enter scores or generate pools, draws and schedules.
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
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-hairline bg-surface ${className}`}>
      {title || right ? (
        <header className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-2.5">
          <h2 className="font-display text-xs font-bold uppercase tracking-widest text-muted-foreground">{title}</h2>
          {right}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    reported: "bg-mint/15 text-foreground",
    walkover: "bg-mint/15 text-foreground",
    "in-progress": "bg-amber/25 text-foreground",
    scheduled: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 font-score text-[10px] uppercase tracking-wider ${map[status] ?? "bg-muted text-muted-foreground"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
