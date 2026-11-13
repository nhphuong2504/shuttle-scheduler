import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PublicShell } from "@/components/app-shell";
import { PILOT_TERMS_VERSION, POLICY_UPDATED } from "@/lib/legal/policy";

export function PolicyPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PublicShell title={title} subtitle={`Pilot draft · Updated ${POLICY_UPDATED}`}>
      <div className="mx-auto max-w-[70ch] space-y-8 pb-8 text-base leading-7">
        <nav
          aria-label="Policies and help"
          className="flex flex-wrap gap-x-6 gap-y-2 border-b border-hairline pb-4 text-sm font-semibold"
        >
          <Link
            to="/privacy"
            className="inline-flex min-h-11 items-center underline underline-offset-4"
          >
            Privacy
          </Link>
          <Link
            to="/terms"
            className="inline-flex min-h-11 items-center underline underline-offset-4"
          >
            Terms
          </Link>
          <Link
            to="/contact"
            className="inline-flex min-h-11 items-center underline underline-offset-4"
          >
            Contact
          </Link>
        </nav>
        <p className="text-muted-foreground">
          Version {PILOT_TERMS_VERSION}. These pilot policies are drafts and may change before
          general release.
        </p>
        {children}
      </div>
    </PublicShell>
  );
}

export function PolicySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-2xl font-bold text-foreground">{title}</h2>
      {children}
    </section>
  );
}
