import type { TournamentStatus } from "@/lib/auth/authorization";
import { Button } from "@/components/ui/button";
import { PLACEMENT_TIERS, SUPPORTED_FORMAT } from "@/lib/tournament/competition-format";
import type { TournamentReadiness } from "@/lib/tournament/data";
import { cn } from "@/lib/utils";
import { SetupSection } from "./section";
import { SETUP_STEPS, dateRangeLabel, stepForCheck, type DraftForm, type SetupStep } from "./types";

/**
 * The last step: whether the tournament can start, what was set up, and the start itself.
 *
 * The checks come from `tournament_readiness`, which is the same function the start RPC
 * re-runs, so what is shown here is what the database will enforce. The page opens with the
 * answer in one sentence ("ready", or "N things to fix"), because a host arrives here to
 * learn exactly that, and each thing to fix carries the button that goes to the step that
 * fixes it.
 *
 * The checklist is information, not the gate. Start is enabled whenever the tournament
 * exists, and the RPC names its own refusal: it knows the blockers and the venue-local
 * start time, and a disabled button would only be able to say "no".
 *
 * `onGoToStep` is absent once the configuration is frozen (the tournament has started), and
 * with it the Edit and fix buttons: a button that goes to a step that can no longer be
 * changed would be a door to a form that lies.
 */
export function ReviewStep({
  form,
  readiness,
  readinessError,
  busy,
  hasTournament,
  status,
  onStart,
  onComplete,
  onDiscard,
  onGoToStep,
}: {
  form: DraftForm;
  readiness: TournamentReadiness | undefined;
  readinessError: string | null;
  busy: boolean;
  /** Whether the tournament exists yet. The first step creates it. */
  hasTournament: boolean;
  status: TournamentStatus;
  onStart: () => void;
  onComplete: () => void;
  onDiscard: () => void;
  onGoToStep?: ((step: SetupStep) => void) | undefined;
}) {
  const activeEvents = form.events.filter((event) => event.active !== false);
  const checks = readiness?.checks ?? [];
  const blockers = checks.filter((check) => !check.ok && check.blocking !== false);
  const advisories = checks.filter((check) => !check.ok && check.blocking === false);
  const ready = readiness?.ready === true;

  return (
    <div className="space-y-5">
      <Verdict
        loading={!readiness && !readinessError}
        error={readinessError}
        ready={ready}
        blockers={blockers.length}
        advisories={advisories.length}
      />

      {checks.length ? (
        <section aria-label="Checks" className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-panel">
          <ul className="divide-y divide-hairline">
            {checks.map((check) => {
              const advisory = !check.ok && check.blocking === false;
              const fixIn = !check.ok && !advisory ? stepForCheck(check.id) : null;
              return (
                <li key={check.id} className="flex flex-wrap items-center gap-x-3.5 gap-y-2 px-5 py-3.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-full font-score text-sm font-extrabold",
                      check.ok
                        ? "bg-success/15 text-foreground"
                        : advisory
                          ? "bg-secondary text-muted-foreground"
                          : "bg-danger-surface text-danger-foreground",
                    )}
                  >
                    {check.ok ? "✓" : advisory ? "i" : "!"}
                  </span>
                  <span className="min-w-[14rem] flex-1">
                    <span className={cn("block text-base", check.ok ? "" : "font-semibold")}>
                      {check.label}
                    </span>
                    {!check.ok && check.detail ? (
                      <span className="block text-sm text-muted-foreground">{check.detail}</span>
                    ) : null}
                    {advisory ? (
                      <span className="block text-sm text-muted-foreground">
                        Set on the Schedule page at the first build. It does not hold up starting.
                      </span>
                    ) : null}
                  </span>
                  {fixIn && onGoToStep ? (
                    <Button variant="outline" onClick={() => onGoToStep(fixIn)}>
                      Go to {SETUP_STEPS.find((entry) => entry.id === fixIn)?.label}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <SetupSection headingId="review-summary" title="What you set up">
        <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          <Row
            label="Name"
            value={form.basics.name.trim() || "Not set"}
            editStep="details"
            onGoToStep={onGoToStep}
          />
          <Row
            label="Dates"
            value={`${dateRangeLabel(form.days)} · ${form.days.length} day${form.days.length === 1 ? "" : "s"} · ${
              form.basics.venueTimezone || "no timezone"
            }`}
          />
          <Row
            label="Venue"
            value={
              [form.basics.venueName.trim(), form.basics.venueAddress.trim()]
                .filter(Boolean)
                .join(", ") || "Not set"
            }
          />
          <Row
            label="Organiser"
            value={
              [
                form.basics.organizerName.trim(),
                form.basics.organizerEmail.trim(),
                form.basics.organizerPhone.trim(),
              ]
                .filter(Boolean)
                .join(" · ") || "Not set"
            }
          />
          <div className="min-w-0">
            <dt className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Events</span>
              <EditLink step="events" onGoToStep={onGoToStep} />
            </dt>
            <dd className="mt-0.5 break-words text-base font-semibold">
              {activeEvents.length === 0 ? (
                <span className="text-danger-foreground">None yet</span>
              ) : (
                activeEvents.map((event) => event.code).join(", ")
              )}
            </dd>
          </div>
          <Row
            label="Entries per player"
            value={`Up to ${form.maxCategoriesPerPlayer}`}
          />
          {form.basics.notes.trim() ? (
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-sm text-muted-foreground">Note</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-base">{form.basics.notes.trim()}</dd>
            </div>
          ) : null}
          <div className="min-w-0 border-t border-hairline pt-5 sm:col-span-2">
            <dt className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Format</span>
              <EditLink step="structure" onGoToStep={onGoToStep} />
            </dt>
            <dd className="mt-0.5 text-base font-semibold">{SUPPORTED_FORMAT.name}</dd>
            <dd className="mt-2 flex flex-wrap gap-2 text-sm">
              {PLACEMENT_TIERS.map((tier) => (
                <span key={tier.tier} className="rounded-full bg-secondary px-3 py-0.5">
                  <span className="font-score">{tier.record}</span> → {tier.label} · {tier.title}
                </span>
              ))}
            </dd>
          </div>
        </dl>
        <p className="mt-5 text-sm text-muted-foreground">
          The venue&apos;s courts, each day&apos;s hours and breaks, match lengths and scoring rules
          are set on the Schedule page at the first build, where the courts exist.
        </p>
      </SetupSection>

      <SetupSection
        headingId="review-finish"
        title={status === "in_progress" ? "Finish the tournament" : "Start the tournament"}
      >
        {status === "upcoming" ? (
          <>
            <p className="mb-4 text-base text-muted-foreground">
              Starting moves this tournament from <strong className="text-foreground">Upcoming</strong>{" "}
              to <strong className="text-foreground">In progress</strong> and makes it the tournament
              you are working in. It will not start before every check passes and its own start time
              has arrived.
            </p>
            {/*
              Enabled whenever the tournament exists, even with failing checks. The RPC
              re-runs the checklist and refuses with the blockers named - and it is the only
              thing that knows the venue-local start time, so pre-empting it in the browser
              would replace a precise refusal with a vague one.
            */}
            <Button className="h-12 px-7 text-base" disabled={busy || !hasTournament} onClick={onStart}>
              {busy ? "Working…" : "Start tournament"}
            </Button>
            {ready ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Every check passes. If the start time has not arrived yet, starting will say when
                it does.
              </p>
            ) : readiness ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Starting is refused until every check above passes, and it will name what is
                missing.
              </p>
            ) : null}
          </>
        ) : status === "in_progress" ? (
          <>
            <p className="mb-4 text-base text-muted-foreground">
              This tournament is running. Its configuration is now frozen, so what is above is
              read-only. Completing it closes the event.
            </p>
            <Button className="h-12 px-7 text-base" disabled={busy || !hasTournament} onClick={onComplete}>
              {busy ? "Working…" : "Complete tournament"}
            </Button>
          </>
        ) : (
          <p className="text-base text-muted-foreground">
            This tournament is completed. Nothing can be started or changed here; a platform admin
            can repair individual results from the desk.
          </p>
        )}
      </SetupSection>

      {status === "upcoming" ? (
        <div className="flex justify-end border-t border-hairline pt-3">
          {/* A link-sized act, set apart from the one above: discarding is rare and final. */}
          <button
            type="button"
            disabled={busy || !hasTournament}
            onClick={onDiscard}
            className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-semibold text-danger-foreground underline underline-offset-2 hover:bg-danger-surface disabled:opacity-50"
          >
            Discard this draft
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The one-sentence answer the page opens with. */
function Verdict({
  loading,
  error,
  ready,
  blockers,
  advisories,
}: {
  loading: boolean;
  error: string | null;
  ready: boolean;
  blockers: number;
  advisories: number;
}) {
  let tone: "ok" | "warn" | "plain" = "plain";
  let mark = "…";
  let title = "Running checks…";
  let detail: string | null = null;

  if (error) {
    tone = "warn";
    mark = "!";
    title = "The checks could not run";
    detail = error;
  } else if (!loading && ready) {
    tone = "ok";
    mark = "✓";
    title = "Ready to start";
    detail = advisories
      ? `${advisories} setting${advisories === 1 ? "" : "s"} below ${
          advisories === 1 ? "is" : "are"
        } finished at the first build.`
      : "Every check passes.";
  } else if (!loading) {
    tone = "warn";
    mark = "!";
    title =
      blockers === 1
        ? "1 thing to fix before you can start"
        : `${blockers} things to fix before you can start`;
    detail = "The rest is ready.";
  }

  return (
    <section
      aria-live="polite"
      className={cn(
        "flex flex-wrap items-center gap-4 rounded-2xl border bg-surface p-5 shadow-panel sm:px-6",
        tone === "warn" ? "border-warn-border" : "border-hairline",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-11 shrink-0 place-items-center rounded-xl font-display text-xl font-extrabold",
          tone === "ok"
            ? "bg-success/15 text-foreground"
            : tone === "warn"
              ? "bg-warn-surface text-warn-foreground"
              : "bg-secondary text-muted-foreground",
        )}
      >
        {mark}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="font-display text-xl font-bold">{title}</h2>
        {detail ? <p className="mt-0.5 text-base text-muted-foreground">{detail}</p> : null}
      </div>
    </section>
  );
}

function EditLink({
  step,
  onGoToStep,
}: {
  step: SetupStep;
  onGoToStep?: ((step: SetupStep) => void) | undefined;
}) {
  if (!onGoToStep) return null;
  return (
    <button
      type="button"
      onClick={() => onGoToStep(step)}
      className="inline-flex min-h-11 items-center rounded-md px-1 text-sm font-semibold text-primary-ink hover:underline"
    >
      Edit
    </button>
  );
}

function Row({
  label,
  value,
  editStep,
  onGoToStep,
}: {
  label: string;
  value: string;
  editStep?: SetupStep;
  onGoToStep?: ((step: SetupStep) => void) | undefined;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{label}</span>
        {editStep ? <EditLink step={editStep} onGoToStep={onGoToStep} /> : null}
      </dt>
      <dd className="mt-0.5 break-words text-base font-semibold">{value}</dd>
    </div>
  );
}
