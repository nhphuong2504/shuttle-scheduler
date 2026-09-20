import { Panel } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TournamentReadiness } from "@/lib/tournament/data";
import { PLACEMENT_TIERS, SUPPORTED_FORMAT } from "@/lib/tournament/competition-format";
import { cn } from "@/lib/utils";
import { dateRangeLabel, type DraftForm } from "./types";

/**
 * The final summary. The checks come from `tournament_readiness`, which is the
 * same function the activation RPC re-runs, so what is shown here is what the
 * database will enforce.
 *
 * A check can be advisory (`blocking: false`), which is how the per-day court
 * assignment behaves: it is genuinely needed to build a schedule, but not to
 * activate a tournament whose courts are configured at the first build. Those
 * failures are listed, but they do not hold activation back.
 */
export function ReviewStep({
  form,
  readiness,
  readinessError,
  busy,
  canActivate,
  onActivate,
  onDiscard,
}: {
  form: DraftForm;
  readiness: TournamentReadiness | undefined;
  readinessError: string | null;
  busy: boolean;
  canActivate: boolean;
  onActivate: () => void;
  onDiscard: () => void;
}) {
  const activeEvents = form.events.filter((event) => event.active !== false);
  const checks = readiness?.checks ?? [];
  const blockers = checks.filter((check) => !check.ok && check.blocking !== false);
  const advisories = checks.filter((check) => !check.ok && check.blocking === false);
  const ready = readiness?.ready === true;

  return (
    <div className="space-y-4">
      <Panel
        title="Checks"
        right={
          checks.length ? (
            <span className="font-score text-[11px] text-muted-foreground">
              {checks.length - blockers.length - advisories.length}/{checks.length} passed
            </span>
          ) : null
        }
        bodyClassName="p-0"
      >
        {readinessError ? (
          <p className="p-4 text-sm text-danger-foreground">{readinessError}</p>
        ) : !readiness ? (
          <p className="p-4 text-sm text-muted-foreground">Running checks…</p>
        ) : (
          <>
            <div
              className={cn(
                "flex items-center gap-3 border-b border-hairline px-4 py-3",
                ready ? "bg-mint/10" : "bg-warn-surface",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full font-score text-sm font-bold",
                  ready ? "bg-mint/50 text-foreground" : "bg-warn-border/50 text-warn-foreground",
                )}
              >
                {ready ? "✓" : "!"}
              </span>
              <p className={cn("text-sm font-semibold", ready ? "" : "text-warn-foreground")}>
                {ready
                  ? advisories.length
                    ? `Ready to activate. ${advisories.length} setting${
                        advisories.length === 1 ? "" : "s"
                      } below ${advisories.length === 1 ? "is" : "are"} finished at the first build.`
                    : "All checks passed. This tournament is ready to activate."
                  : `${blockers.length} check${blockers.length === 1 ? "" : "s"} to resolve before activation.`}
              </p>
            </div>
            <ul className="divide-y divide-hairline">
              {checks.map((check) => {
                const advisory = !check.ok && check.blocking === false;
                return (
                  <li key={check.id} className="flex items-start gap-2.5 px-4 py-2.5">
                    <span
                      className={cn(
                        "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold",
                        check.ok
                          ? "bg-mint/40 text-foreground"
                          : advisory
                            ? "bg-warn-border/40 text-warn-foreground"
                            : "bg-danger-surface text-danger-foreground",
                      )}
                      aria-hidden
                    >
                      {check.ok ? "✓" : "!"}
                    </span>
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "block text-sm",
                          check.ok ? "text-muted-foreground" : "font-semibold",
                        )}
                      >
                        {check.label}
                      </span>
                      {!check.ok && check.detail ? (
                        <span
                          className={cn(
                            "block text-xs",
                            advisory ? "text-warn-foreground" : "text-danger-foreground",
                          )}
                        >
                          {check.detail}
                        </span>
                      ) : null}
                      {advisory ? (
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          Set on the Schedule page at the first build.
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Panel>

      <Panel title="Basics">
        <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <Row label="Name" value={form.basics.name.trim() || "Not set"} />
          <Row label="Timezone" value={form.basics.venueTimezone || "Not set"} />
          <Row label="Venue" value={form.basics.venueName.trim() || "Not set"} />
          <Row label="Address" value={form.basics.venueAddress.trim() || "Not set"} />
          <Row label="Organizer" value={form.basics.organizerName.trim() || "Not set"} />
          <Row
            label="Contact"
            value={
              [form.basics.organizerEmail.trim(), form.basics.organizerPhone.trim()]
                .filter(Boolean)
                .join(" · ") || "Not set"
            }
          />
          <div className="sm:col-span-2">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Note
            </dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">
              {form.basics.notes.trim() || "None"}
            </dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Dates">
        <dl className="mb-3 grid gap-x-4 gap-y-3 sm:grid-cols-3">
          <Row label="Date range" value={dateRangeLabel(form.days)} />
          <Row label="Days" value={String(form.days.length)} />
        </dl>
        <ol className="divide-y divide-hairline">
          {form.days.map((day, index) => (
            <li key={day.date || index} className="flex items-center gap-3 py-2 text-xs">
              <span className="font-semibold">Day {index + 1}</span>
              <span className="font-score">{day.date || "No date"}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-muted-foreground">
          The venue&apos;s courts, each day&apos;s hours and breaks, match lengths and scoring rules
          are set on the Schedule page at the first build, where the courts exist.
        </p>
      </Panel>

      <Panel title="Events">
        {activeEvents.length === 0 ? (
          <p className="text-sm text-danger-foreground">No events. Add at least one.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {activeEvents.map((event) => (
              <li key={event.code} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="font-score font-semibold">{event.code}</span>
                <span>{event.name}</span>
                <Badge variant="outline">
                  {event.gender === "open" ? "Open" : `${event.gender}`}
                </Badge>
                <Badge variant="outline">
                  {event.entryType === "pair" ? "Doubles" : "Singles"}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {event.maxEntries == null ? "No entry cap" : `Cap ${event.maxEntries}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          A player may enter at most{" "}
          <span className="font-semibold text-foreground">
            {form.maxCategoriesPerPlayer} event{form.maxCategoriesPerPlayer === 1 ? "" : "s"}
          </span>
          .
        </p>
      </Panel>

      <Panel title="Structure">
        <p className="text-sm font-semibold">{SUPPORTED_FORMAT.name}</p>
        <p className="mt-1 text-xs text-muted-foreground">{SUPPORTED_FORMAT.summary}</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {PLACEMENT_TIERS.map((tier) => (
            <li key={tier.tier} className="flex items-center gap-2 text-xs">
              <Badge variant="outline" className="font-score">
                {tier.record}
              </Badge>
              <span className="text-muted-foreground">→</span>
              <span className="font-semibold">{tier.label}</span>
              <span className="text-muted-foreground">{tier.title}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Finish">
        <p className="mb-3 text-xs text-muted-foreground">
          Activating moves this tournament from <span className="font-semibold">Draft</span> to{" "}
          <span className="font-semibold">In Progress</span> and makes it the active scope for the
          desk. The current active tournament is switched off. Discarding deletes the draft and
          everything it owns.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !canActivate || !ready} onClick={onActivate}>
            {busy ? "Working…" : "Activate tournament"}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onDiscard}>
            Discard draft
          </Button>
        </div>
        {!ready && readiness ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Activation is blocked until every blocking check passes. The database enforces the same
            checks.
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="break-words text-sm">{value}</dd>
    </div>
  );
}
