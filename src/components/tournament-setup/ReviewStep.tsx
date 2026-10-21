import type { TournamentStatus } from "@/lib/auth/authorization";
import { Button } from "@/components/ui/button";
import { PLACEMENT_TIERS, SUPPORTED_FORMAT } from "@/lib/tournament/competition-format";
import { cn } from "@/lib/utils";
import { effectiveRegistration } from "./problems";
import { SetupSection } from "./section";
import {
  countIsoDays,
  setupSteps,
  stepForCheck,
  windowLabel,
  type DraftForm,
  type SetupStep,
} from "./types";

/** One line of the checklist, whether it came from the browser or from the database. */
export interface ReviewCheck {
  id: string;
  label: string;
  ok: boolean;
  detail?: string | null | undefined;
  /** False for a check that is advice rather than a blocker. Absent means it blocks. */
  blocking?: boolean | undefined;
}

/**
 * The last step: whether the tournament can be created (or is set up, once it exists), what
 * was set up, and the one act that belongs here.
 *
 * While a tournament is being made, the checks come from the form itself - there is no row
 * to ask - and the page opens with the answer in one sentence ("ready to create", or "N
 * things to fix"), because a host arrives here to learn exactly that. Each thing to fix
 * carries the button that goes to the step that fixes it. Once it exists the checks are the
 * database's own `tournament_readiness`, the same function that decides whether registration
 * can open.
 *
 * There is no Start button. A tournament starts by itself when its first match is started on
 * the Desk, so the act that belongs on an existing tournament's last step is only the end of
 * it: Complete, while it is running.
 *
 * `onGoToStep` is absent once the configuration is frozen (the tournament has started), and
 * with it the Edit and fix buttons: a button that goes to a step that can no longer be
 * changed would be a door to a form that lies.
 */
export function ReviewStep({
  mode,
  form,
  checks,
  loading,
  error,
  busy,
  status,
  onCreate,
  onComplete,
  onDiscard,
  onGoToStep,
}: {
  mode: "create" | "existing";
  form: DraftForm;
  checks: ReviewCheck[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  status: TournamentStatus;
  onCreate: () => void;
  onComplete: () => void;
  onDiscard: () => void;
  onGoToStep?: ((step: SetupStep) => void) | undefined;
}) {
  const activeEvents = form.events.filter((event) => event.active !== false);
  const blockers = checks.filter((check) => !check.ok && check.blocking !== false);
  const advisories = checks.filter((check) => !check.ok && check.blocking === false);
  const ready = !loading && !error && blockers.length === 0;
  const registration = effectiveRegistration(form);
  const days = form.startsOn ? countIsoDays(form.startsOn, form.endsOn || form.startsOn) : 0;
  const steps = setupSteps(mode === "existing");

  return (
    <div className="space-y-5">
      <Verdict
        mode={mode}
        loading={loading}
        error={error}
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
                        Finished on the Schedule page. It does not hold anything up.
                      </span>
                    ) : null}
                  </span>
                  {fixIn && onGoToStep ? (
                    <Button variant="outline" onClick={() => onGoToStep(fixIn)}>
                      Go to {steps.find((entry) => entry.id === fixIn)?.label}
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
            label="Tournament dates"
            value={`${windowLabel(form.startsOn, form.endsOn)}${
              days ? `, ${days} day${days === 1 ? "" : "s"}` : ""
            }, ${form.basics.venueTimezone || "no timezone"}`}
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
                .join(", ") || "Not set"
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
            value={`Up to ${
              activeEvents.length
                ? Math.min(form.maxCategoriesPerPlayer, activeEvents.length)
                : form.maxCategoriesPerPlayer
            }`}
          />
          <div className="min-w-0">
            <dt className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Registration</span>
              <EditLink step="details" onGoToStep={onGoToStep} />
            </dt>
            <dd className="mt-0.5 break-words text-base font-semibold">
              {form.registration.enabled
                ? `${registration.opensAt.replace("T", " ")} to ${registration.closesAt.replace("T", " ")}`
                : "Off"}
            </dd>
          </div>
          {form.basics.notes.trim() ? (
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-sm text-muted-foreground">Note</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-base">{form.basics.notes.trim()}</dd>
            </div>
          ) : null}
          <div className="min-w-0 border-t border-hairline pt-5 sm:col-span-2">
            <dt className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Format</span>
              {/* There is one format, so nothing to edit: the link explains it. */}
              <EditLink step="structure" label="See how it runs" onGoToStep={onGoToStep} />
            </dt>
            <dd className="mt-0.5 text-base font-semibold">{SUPPORTED_FORMAT.name}</dd>
            <dd className="mt-2 flex flex-wrap gap-2 text-sm">
              {PLACEMENT_TIERS.map((tier) => (
                <span key={tier.tier} className="rounded-full bg-secondary px-3 py-0.5">
                  <span className="font-score">{tier.record}</span> → {tier.label}, {tier.title}
                </span>
              ))}
            </dd>
          </div>
        </dl>
        <p className="mt-5 text-sm text-muted-foreground">
          Which days are played, the venue&apos;s courts, each day&apos;s hours and breaks, match
          lengths and scoring rules are set on the Schedule page when the schedule is built,
          where the courts exist.
        </p>
      </SetupSection>

      <SetupSection
        headingId="review-finish"
        title={
          mode === "create"
            ? "Create the tournament"
            : status === "in_progress"
              ? "Finish the tournament"
              : status === "completed"
                ? "Completed"
                : "Starting"
        }
      >
        {mode === "create" ? (
          <>
            <p className="mb-4 text-base text-muted-foreground">
              Creating saves it as <strong className="text-foreground">Upcoming</strong>. It is
              listed in Explore, and people can register while registration is open. It becomes{" "}
              <strong className="text-foreground">In progress</strong> by itself when the first
              match is started on the Desk, from the first day at 00:00.
            </p>
            <Button
              className="h-12 px-7 text-base"
              disabled={busy || !ready}
              onClick={onCreate}
            >
              {busy ? "Creating…" : "Create tournament"}
            </Button>
            {!ready && !loading ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Fix the {blockers.length === 1 ? "check" : "checks"} above to create it.
              </p>
            ) : null}
          </>
        ) : status === "upcoming" ? (
          <p className="text-base text-muted-foreground">
            Nobody presses Start. This tournament becomes{" "}
            <strong className="text-foreground">In progress</strong> by itself when the first match is
            started on the Desk, from {form.startsOn || "the first day"} at 00:00. Until then
            everything on the previous steps can still change.
          </p>
        ) : status === "in_progress" ? (
          <>
            <p className="mb-4 text-base text-muted-foreground">
              This tournament is running. Its events, caps and format are now fixed; its name,
              venue and last day can still change. Completing it closes the event.
            </p>
            <Button className="h-12 px-7 text-base" disabled={busy} onClick={onComplete}>
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

      {mode === "create" || status === "upcoming" ? (
        <div className="flex justify-end border-t border-hairline pt-3">
          {/* A link-sized act, set apart from the one above: discarding is rare and final. */}
          <button
            type="button"
            disabled={busy}
            onClick={onDiscard}
            className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-semibold text-danger-foreground underline underline-offset-2 hover:bg-danger-surface disabled:opacity-50"
          >
            {mode === "create" ? "Discard these answers" : "Discard this tournament"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The one-sentence answer the page opens with. */
function Verdict({
  mode,
  loading,
  error,
  ready,
  blockers,
  advisories,
}: {
  mode: "create" | "existing";
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
    title = mode === "create" ? "Ready to create" : "Set up";
    detail = advisories
      ? `${advisories} setting${advisories === 1 ? "" : "s"} below ${
          advisories === 1 ? "is" : "are"
        } finished on the Schedule page.`
      : "Every check passes.";
  } else if (!loading) {
    tone = "warn";
    mark = "!";
    const things = blockers === 1 ? "1 thing" : `${blockers} things`;
    title =
      mode === "create"
        ? `${things} to fix before you can create it`
        : `${things} to fix`;
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
  label = "Edit",
  onGoToStep,
}: {
  step: SetupStep;
  label?: string;
  onGoToStep?: ((step: SetupStep) => void) | undefined;
}) {
  if (!onGoToStep) return null;
  return (
    <button
      type="button"
      onClick={() => onGoToStep(step)}
      className="inline-flex min-h-11 items-center rounded-md px-1 text-sm font-semibold text-primary-ink hover:underline"
    >
      {label}
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
