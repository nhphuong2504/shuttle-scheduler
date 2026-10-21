import { useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { CompleteDialog } from "@/components/tournament-setup/CompleteDialog";
import { DetailsStep } from "@/components/tournament-setup/DetailsStep";
import { DiscardDialog, UnsavedDialog } from "@/components/tournament-setup/UnsavedDialog";
import { markStepSaved, stepDirty } from "@/components/tournament-setup/dirty";
import { EventsStep } from "@/components/tournament-setup/EventsStep";
import { ReviewStep, type ReviewCheck } from "@/components/tournament-setup/ReviewStep";
import { StructureStep } from "@/components/tournament-setup/StructureStep";
import {
  hydrateForm,
  registrationOrigin,
  type RegistrationOrigin,
} from "@/components/tournament-setup/hydrate";
import {
  clearLocalDraft,
  loadLocalDraft,
  saveLocalDraft,
} from "@/components/tournament-setup/local-draft";
import {
  effectiveRegistration,
  localChecks,
  problemsForStep,
} from "@/components/tournament-setup/problems";
import {
  SETUP_STEPS,
  defaultForm,
  setupStepIndex,
  setupSteps,
  type DraftForm,
  type SetupStep,
} from "@/components/tournament-setup/types";
import { Button } from "@/components/ui/button";
import {
  isConfigurable,
  normalizeTournamentStatus,
  type TournamentStatus,
} from "@/lib/auth/authorization";
import {
  completeTournament,
  createTournament,
  discardTournament,
  fetchCompletionCheck,
  saveTournamentConfig,
  saveTournamentEvents,
  setRegistrationWindow,
  updateTournamentDetails,
  updateTournamentWindow,
  type TournamentDraftInput,
} from "@/lib/tournament/actions";
import { useTournamentDraftData, useTournamentReadiness } from "@/lib/tournament/data";
import { isValidTimeZone, zonedToInstant } from "@/lib/tournament/zoned-time";
import { cn } from "@/lib/utils";

/**
 * The tournament wizard: details, events, structure, review.
 *
 * It exists as one component because there is one wizard. Creating a tournament and
 * setting one up are the same four steps; the difference is what "continue" does.
 * `/tournaments/new` creates and `/tournaments/$id/settings` sets up, and both render this.
 * Two copies of the steps would be two places for the date rules, the event rules and the
 * registration rules to drift apart.
 *
 * ## Creating: nothing is stored until the end
 *
 * A tournament is created complete or not at all. While it is being made the answers live
 * in this component and, as insurance against a reload or a flat battery, in the browser's
 * session storage (see `local-draft.ts`). "Continue" only moves between steps. The one act
 * that touches the database is "Create tournament" on the last step, which sends everything
 * in a single call, so there is never a half-made tournament for anyone else to find.
 *
 * ## Setting up: each step saves itself
 *
 * Once the tournament exists the steps write straight to it - on "Save and continue", and on
 * any other way out of an edited step (the rail, "Back", Review's links), so "Saved as you go"
 * is true however the host moves. Leaving the page with an edit asks first (`UnsavedDialog`).
 * The database refuses every
 * write from a tournament that is no longer upcoming. A tournament that has started cannot
 * change its events, caps or format, so the wizard shows what can still change (its name,
 * venue and last day) and the end of it, and says why the rest is gone.
 *
 * ## It owns the step, the route owns the address
 *
 * `step` arrives as a prop and every move is reported through `onStepChange`, so the caller
 * decides whether the position lives in a search param. The wizard navigates on its own only
 * where the destination is fixed by what just happened: a created tournament belongs on its
 * own page, a discarded one is gone.
 */
export interface TournamentWizardProps {
  /** The tournament being set up, or null while one is being created. */
  tournamentId: string | null;
  /** Which step to show. Owned by the caller so it can live in the URL. */
  step: SetupStep;
  onStepChange: (step: SetupStep) => void;
  /**
   * Settings that are not configuration - they stay usable while the tournament plays, so
   * they are not a step. Shown on Review, and at the top of a started tournament's page.
   */
  extra?: ReactNode;
}

/**
 * Maps the wizard form onto the payload the config RPCs accept.
 *
 * Match lengths, rest gaps and scoring rules are deliberately absent: the row is created
 * with usable defaults, and the Schedule page owns them from the first build onward.
 * Leaving them out here also means the wizard cannot overwrite a tournament's timings with
 * stale form state. The registration window is absent too: it has its own writer, because
 * its rules (an opening time that cannot move once passed, a deadline that cannot be
 * extended under a schedule) belong to it alone.
 */
function toDraftInput(form: DraftForm): TournamentDraftInput {
  return {
    name: form.basics.name,
    format: "two_round_placement",
    notes: form.basics.notes,
    venueName: form.basics.venueName,
    venueAddress: form.basics.venueAddress,
    venueTimezone: form.basics.venueTimezone,
    organizerName: form.basics.organizerName,
    organizerEmail: form.basics.organizerEmail,
    organizerPhone: form.basics.organizerPhone,
    maxCategoriesPerPlayer: form.maxCategoriesPerPlayer,
  };
}

/**
 * A blank form in the zone the host is in, which is usually the venue's. Browser-only: the
 * zone is read from the browser, which is why this is not `defaultForm`, which also runs on
 * the server.
 */
function freshForm(): DraftForm {
  const form = defaultForm();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone && isValidTimeZone(zone)) form.basics.venueTimezone = zone;
  return form;
}

/** The registration window as instants, or null when it is switched off or unreadable. */
function registrationInstants(
  form: DraftForm,
  origin: RegistrationOrigin | null,
): { opens: string; closes: string } | null {
  if (!form.registration.enabled) return null;
  const zone = form.basics.venueTimezone;
  const { opensAt, closesAt } = effectiveRegistration(form);
  // An untouched field keeps the stored instant: the form holds minutes, the database
  // microseconds, and rounding an opening time that has already passed would look like a
  // change to it.
  const opens =
    origin?.opensAt && opensAt === origin.opensLocal ? origin.opensAt : zonedToInstant(opensAt, zone);
  const closes =
    origin?.closesAt && closesAt === origin.closesLocal
      ? origin.closesAt
      : zonedToInstant(closesAt, zone);
  return opens && closes ? { opens, closes } : null;
}

export function TournamentWizard({
  tournamentId,
  step,
  onStepChange,
  extra,
}: TournamentWizardProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const isNew = !tournamentId;

  const draftData = useTournamentDraftData(tournamentId);
  const readinessQuery = useTournamentReadiness(tournamentId);

  const [form, setForm] = useState<DraftForm>(defaultForm);
  const [busy, setBusy] = useState(false);
  /** The Complete dialog, which counts what is left to play each time it opens. */
  const [completing, setCompleting] = useState(false);
  /** The Discard confirmation, which says what discarding destroys before it does. */
  const [discarding, setDiscarding] = useState(false);
  const completion = useQuery({
    queryKey: ["completion-check", tournamentId],
    queryFn: () => fetchCompletionCheck(tournamentId as string),
    enabled: completing && !!tournamentId,
    // Counted fresh every time: a match may have gone on court since the page loaded.
    staleTime: 0,
    gcTime: 0,
  });
  /**
   * Whether the host has pressed "continue" on this step with something missing.
   *
   * Problems are drawn beside their fields only after that. A form that complains before
   * anybody has typed in it is telling the host they have already done something wrong; one
   * that waits until they try to move on is telling them what is missing.
   */
  const [attempted, setAttempted] = useState(false);
  /** True once the saved answers (if any) have been read back, so they are not overwritten. */
  const [draftRead, setDraftRead] = useState(false);
  const hydratedFor = useRef<string | null>(null);
  const origin = useRef<RegistrationOrigin | null>(null);
  /**
   * The answers as the database last held them, so an edited step can be told from an
   * untouched one. Null while creating: nothing is stored, so nothing is unsaved.
   */
  const [savedForm, setSavedForm] = useState<DraftForm | null>(null);
  /** Set just before the wizard navigates away on purpose, so its own exits are not blocked. */
  const leaving = useRef(false);

  const currentIndex = setupStepIndex(step);
  const steps = setupSteps(!isNew);

  // Creating: read back what was typed before a reload, once, after the page has mounted
  // (storage does not exist on the server), then keep it up to date.
  useEffect(() => {
    if (!isNew) return;
    const saved = loadLocalDraft();
    setForm(saved ?? freshForm());
    setDraftRead(true);
  }, [isNew]);

  useEffect(() => {
    if (isNew && draftRead) saveLocalDraft(form);
  }, [form, isNew, draftRead]);

  // Setting up: load the stored tournament into the form exactly once per id, so a
  // background refetch can never overwrite what the host is typing.
  useEffect(() => {
    if (!tournamentId) {
      hydratedFor.current = null;
      return;
    }
    if (hydratedFor.current === tournamentId) return;
    if (draftData.isLoading || !draftData.tournament) return;
    const hydrated = hydrateForm(draftData.tournament, draftData.categories);
    setForm(hydrated);
    setSavedForm(hydrated);
    origin.current = registrationOrigin(draftData.tournament);
    hydratedFor.current = tournamentId;
  }, [tournamentId, draftData]);

  const patchForm = (patch: Partial<DraftForm>) => setForm((prev) => ({ ...prev, ...patch }));

  /** Moving between steps starts a clean attempt: the next step has not been tried yet. */
  const goTo = (next: SetupStep) => {
    setAttempted(false);
    onStepChange(next);
  };

  const problems = useMemo(() => problemsForStep(step, form), [step, form]);

  const tournamentStatus: TournamentStatus = normalizeTournamentStatus(
    draftData.tournament?.status,
  );
  /** Whether the events, caps and format can still change: the tournament is upcoming. */
  const configEditable = isNew || isConfigurable(tournamentStatus);

  const refresh = () => qc.invalidateQueries();

  /**
   * The step whose answers are on screen. Once the configuration is frozen only the details
   * form is shown, whatever the address says.
   */
  const editingStep: SetupStep = configEditable ? step : "details";
  const dirty = !isNew && stepDirty(editingStep, form, savedForm);

  /**
   * Saves the step on screen if it was edited. False when it could not be saved - a problem
   * on the step, which is then drawn beside its field, or a refusal from the database - and
   * the caller keeps the host where they are.
   */
  const saveCurrent = async (): Promise<boolean> => {
    if (!tournamentId || !savedForm || !dirty) return true;
    // Once the configuration is frozen the registration window is shown locked, so its checks
    // cannot be answered here and must not hold up the name, venue or last day.
    const checked = configEditable
      ? form
      : { ...form, registration: { ...form.registration, enabled: false } };
    if (problemsForStep(editingStep, checked).length) {
      setAttempted(true);
      return false;
    }
    setBusy(true);
    try {
      if (configEditable) {
        await saveStep(editingStep, tournamentId, form, origin.current);
      } else {
        await saveLive(tournamentId, form, String(draftData.tournament?.ends_on).slice(0, 10));
      }
      setSavedForm(markStepSaved(editingStep, form, savedForm));
      await refresh();
      toast.success("Saved");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** Every move between steps: the rail, "Back", Review's links. An edited step is saved first. */
  const leaveTo = async (next: SetupStep) => {
    if (next === step) return;
    if (await saveCurrent()) goTo(next);
  };

  /** Continues. While creating that only moves on; once it exists it saves the step first. */
  const saveAndContinue = async () => {
    if (problems.length) {
      setAttempted(true);
      return;
    }
    const next = SETUP_STEPS[Math.min(currentIndex + 1, SETUP_STEPS.length - 1)];
    await leaveTo(next ? next.id : "review");
  };

  /**
   * Leaving the page - not the step - with an edit asks first. The step moves themselves only
   * change the search string, so they pass; so do the wizard's own exits (`leaving`).
   */
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      !leaving.current && dirtyRef.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => !leaving.current && dirtyRef.current,
    withResolver: true,
  });

  /**
   * Creates the tournament: everything at once, or nothing.
   *
   * Every step is checked here, not only the one on screen, because the host can reach
   * Review without visiting a step. The database checks again and its refusal names what is
   * missing; the point of the client checks is to say so before the round trip.
   */
  const create = async () => {
    const all = [
      ...problemsForStep("details", form),
      ...problemsForStep("events", form),
    ];
    if (all.length) {
      setAttempted(true);
      toast.error(all[0] ?? "Check the steps first");
      return;
    }
    const registration = registrationInstants(form, null);
    if (form.registration.enabled && !registration) {
      toast.error("Check the registration times.");
      return;
    }
    setBusy(true);
    try {
      const id = await createTournament({
        ...toDraftInput(form),
        startsOn: form.startsOn,
        endsOn: form.endsOn,
        events: form.events,
        registrationOpensAt: registration?.opens ?? null,
        registrationClosesAt: registration?.closes ?? null,
      });
      clearLocalDraft();
      await refresh();
      toast.success("Tournament created");
      void navigate({
        to: "/tournaments/$tournamentId",
        params: { tournamentId: id },
        replace: true,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the tournament");
    } finally {
      setBusy(false);
    }
  };

  /** In Progress -> Completed. Terminal apart from a platform admin's repair paths. */
  const complete = async () => {
    if (!tournamentId) return;
    setBusy(true);
    try {
      await completeTournament(tournamentId);
      setCompleting(false);
      await refresh();
      toast.success("Tournament completed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not complete the tournament");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Throws the answers away (while creating) or deletes the tournament (once it exists and
   * is still upcoming).
   *
   * Deleting a tournament that has already started is the explicitly destructive path, and it
   * lives on the tournament's card in My Tournaments rather than here - a button whose only
   * job is to destroy a live event does not belong in the flow that sets one up.
   */
  const discard = async () => {
    setDiscarding(false);
    if (!tournamentId) {
      clearLocalDraft();
      setForm(freshForm());
      goTo("details");
      toast.success("Answers discarded");
      return;
    }
    setBusy(true);
    try {
      await discardTournament(tournamentId);
      await refresh();
      toast.success("Tournament discarded");
      leaving.current = true;
      void navigate({ to: "/me/tournaments", replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not discard the tournament");
    } finally {
      setBusy(false);
    }
  };


  /**
   * The review step's checks: the form's own while the tournament does not exist, the
   * database's once it does. The database's are the same function that decides whether
   * registration can open, so the list and the behaviour cannot disagree.
   */
  const checks: ReviewCheck[] = isNew
    ? localChecks(form)
    : (readinessQuery.data?.checks ?? []).map((check) => ({
        id: check.id,
        label: check.label,
        ok: check.ok,
        detail: check.detail ?? null,
        blocking: check.blocking,
      }));

  const reviewProps = {
    mode: isNew ? ("create" as const) : ("existing" as const),
    form,
    checks,
    loading: isNew ? false : !readinessQuery.data && !readinessQuery.error,
    error: readinessQuery.error instanceof Error ? readinessQuery.error.message : null,
    busy,
    status: tournamentStatus,
    onCreate: () => void create(),
    onComplete: () => setCompleting(true),
    onDiscard: () => setDiscarding(true),
    onGoToStep: configEditable ? (next: SetupStep) => void leaveTo(next) : undefined,
  };

  const registrationOpened = Boolean(
    origin.current?.opensAt && Date.parse(origin.current.opensAt) <= Date.now(),
  );

  return (
    <div className="wizard-flow mx-auto w-full max-w-[64rem]">
      <CompleteDialog
        open={completing}
        onOpenChange={setCompleting}
        name={draftData.tournament?.name ?? form.basics.name}
        check={completion.data}
        loading={completing && completion.isPending}
        error={completion.error instanceof Error ? completion.error.message : null}
        busy={busy}
        onConfirm={() => void complete()}
      />
      <DiscardDialog
        open={discarding}
        existing={!isNew}
        busy={busy}
        onCancel={() => setDiscarding(false)}
        onConfirm={() => void discard()}
      />
      <UnsavedDialog
        open={blocker.status === "blocked"}
        busy={busy}
        onStay={() => blocker.reset?.()}
        onDiscard={() => blocker.proceed?.()}
        onSave={() =>
          void saveCurrent().then((saved) => (saved ? blocker.proceed?.() : blocker.reset?.()))
        }
      />
      {configEditable ? (
        <div className="grid items-start gap-6 lg:grid-cols-[16.25rem_minmax(0,1fr)] lg:gap-10">
          {/*
            Where you are, as a rail on a wide screen and a bar on a narrow one.

            The rail names each step and says what it is for in a line, marks the ones that are
            done, and marks a finished step that still needs something - so a host who skipped
            ahead sees where to go back to. It is a list of buttons because moving between
            steps is a deliberate act.
          */}
          <nav aria-label="Setup steps" className="hidden lg:sticky lg:top-24 lg:block">
            <ol className="space-y-1.5">
              {steps.map((entry, index) => {
                const isCurrent = entry.id === step;
                const visited = index < currentIndex;
                const needs = visited && problemsForStep(entry.id, form).length > 0;
                const isDone = visited && !needs;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void leaveTo(entry.id)}
                      aria-current={isCurrent ? "step" : undefined}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors",
                        isCurrent
                          ? "border-border-selected bg-surface"
                          : "border-transparent hover:bg-muted/60",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "grid size-7 shrink-0 place-items-center rounded-full font-score text-sm font-bold",
                          isCurrent
                            ? "bg-primary text-primary-foreground"
                            : needs
                              ? "bg-warn-surface text-warn-foreground"
                              : isDone
                                ? "bg-success/15 text-foreground"
                                : "bg-secondary text-muted-foreground",
                        )}
                      >
                        {isCurrent ? index + 1 : needs ? "!" : isDone ? "✓" : index + 1}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={cn(
                            "block text-base font-semibold",
                            isCurrent || isDone || needs ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {entry.label}
                        </span>
                        <span
                          className={cn(
                            "mt-0.5 block text-sm",
                            needs ? "font-semibold text-warn-foreground" : "text-muted-foreground",
                          )}
                        >
                          {needs ? "Needs one more thing" : entry.hint}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="mt-4 flex items-center gap-2 px-3.5 text-sm text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn("size-2 rounded-full", isNew ? "bg-border-control" : "bg-success")}
              />
              {isNew ? "Kept if you reload this tab. Created at the end." : "Saved as you go."}
            </p>
          </nav>

          <div className="lg:hidden">
            <p className="flex justify-between gap-3 text-sm text-muted-foreground">
              <strong className="text-foreground">
                Step {currentIndex + 1} of {steps.length} — {steps[currentIndex]?.label}
              </strong>
              <span>{isNew ? "Kept if you reload" : "Saved as you go"}</span>
            </p>
            <div aria-hidden="true" className="mt-2 grid grid-cols-4 gap-1.5">
              {steps.map((entry, index) => (
                <span
                  key={entry.id}
                  className={cn(
                    "h-1.5 rounded-full",
                    index <= currentIndex ? "bg-primary" : "bg-hairline",
                  )}
                />
              ))}
            </div>
          </div>

          <div className="min-w-0 max-w-3xl">
            {step === "details" ? (
              <DetailsStep
                form={form}
                onChange={patchForm}
                isNew={isNew}
                showErrors={attempted}
                registrationOpened={registrationOpened}
              />
            ) : null}
            {step === "events" ? (
              <EventsStep form={form} onChange={patchForm} showErrors={attempted} />
            ) : null}
            {step === "structure" ? <StructureStep /> : null}
            {step === "review" ? <ReviewStep {...reviewProps} extra={extra} /> : null}

            {step !== "review" && attempted && problems.length ? (
              <div
                role="alert"
                className="mt-5 rounded-xl border border-danger-border bg-danger-surface px-4 py-3"
              >
                <p className="text-base font-semibold text-danger-foreground">
                  {problems.length === 1 ? "One thing to fix to continue" : "Things to fix to continue"}
                </p>
                <ul className="mt-1 space-y-1">
                  {problems.map((problem) => (
                    <li key={problem} className="text-sm text-foreground">
                      {problem}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/*
              The step's buttons, kept at the foot of the window. A step can be taller than the
              screen, and "continue" should not be a long scroll away from the field a host has
              just finished. The bar is flat - a rule and a surface, no shadow - so it reads as
              the edge of the form rather than as something floating over it, and the wizard's
              scroll margin (`--action-bar-clearance`) keeps a focused field clear of it.
            */}
            <div className="sticky bottom-0 z-20 -mx-4 mt-6 flex items-center gap-3 border-t border-hairline bg-surface px-4 py-3 lg:mx-0 lg:rounded-2xl lg:border lg:px-5">
              {currentIndex > 0 ? (
                <Button
                  variant="outline"
                  className="h-12 px-5"
                  disabled={busy}
                  onClick={() => {
                    const previous = SETUP_STEPS[currentIndex - 1];
                    if (previous) void leaveTo(previous.id);
                  }}
                >
                  ← Back
                </Button>
              ) : null}
              <span className="hidden text-sm text-muted-foreground lg:inline">
                Step {currentIndex + 1} of {steps.length}
              </span>
              {step !== "review" ? (
                <Button
                  className="ml-auto h-12 flex-1 px-7 text-base font-semibold lg:flex-none"
                  disabled={busy}
                  onClick={saveAndContinue}
                >
                  {busy ? "Saving…" : isNew || step === "structure" ? "Continue →" : "Save and continue →"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="max-w-3xl space-y-5">
          {/*
            A started tournament's events, caps and format are fixed, and the database
            refuses those writes rather than this notice doing so. Rendering them as editable
            fields that could only fail would be a form that lies, so what can still change is
            shown as a form, and the rest is said once, here.
          */}
          <div className="rounded-xl border border-info-border bg-info-surface px-4 py-3 text-sm text-info-foreground">
            {tournamentStatus === "completed"
              ? "This tournament is completed, so nothing here can change."
              : "This tournament has started, so its events, entry caps and format are fixed, and so are its first day and timezone. Its name, venue and last day can still change. Playing days, courts and timings are adjusted on the Schedule page."}
          </div>
          {extra}
          <DetailsStep
            form={form}
            onChange={patchForm}
            isNew={false}
            showErrors={attempted}
            registrationOpened={registrationOpened}
            lock={{
              all: tournamentStatus === "completed",
              start: true,
              timezone: true,
            }}
          />
          {tournamentStatus === "completed" ? null : (
            <div className="flex justify-end">
              <Button className="h-12 px-7 text-base" disabled={busy}
                onClick={() => (dirty ? void saveCurrent() : toast("No changes to save"))}
              >
                {busy ? "Saving…" : "Save details"}
              </Button>
            </div>
          )}
          <ReviewStep {...reviewProps} />
        </div>
      )}
    </div>
  );
}

/** Saves what one step of an existing tournament owns. */
async function saveStep(
  step: SetupStep,
  id: string,
  form: DraftForm,
  origin: RegistrationOrigin | null,
): Promise<void> {
  switch (step) {
    case "details":
      // The window first: it is the write the database is most likely to refuse (a playing
      // day would fall outside it), and its message names the day.
      await updateTournamentWindow(id, form.startsOn, form.endsOn);
      await saveTournamentConfig(id, toDraftInput(form));
      // After the window: the deadline is checked against the first date just written.
      await saveRegistration(id, form, origin);
      return;
    case "events": {
      await saveTournamentConfig(id, toDraftInput(form));
      await saveTournamentEvents(id, form.events);
      return;
    }
    default:
      await saveTournamentConfig(id, toDraftInput(form));
      return;
  }
}

/** After the tournament has started: what can still change, saved on its own. */
async function saveLive(id: string, form: DraftForm, storedEndsOn: string): Promise<void> {
  // The last date first: it is the one the database may refuse, and it names why.
  if (form.endsOn !== storedEndsOn) {
    await updateTournamentWindow(id, form.startsOn, form.endsOn);
  }
  await updateTournamentDetails(id, toDraftInput(form));
}

/** Writes the registration window if the host changed it, and only then. */
async function saveRegistration(
  id: string,
  form: DraftForm,
  origin: RegistrationOrigin | null,
): Promise<void> {
  const next = registrationInstants(form, origin);
  if (!form.registration.enabled) {
    if (origin?.opensAt || origin?.closesAt) await setRegistrationWindow(id, null, null);
    return;
  }
  if (!next) throw new Error("Check the registration times.");
  if (next.opens === origin?.opensAt && next.closes === origin?.closesAt) return;
  await setRegistrationWindow(id, next.opens, next.closes);
}
