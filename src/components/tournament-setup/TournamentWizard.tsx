import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { DetailsStep } from "@/components/tournament-setup/DetailsStep";
import { EventsStep } from "@/components/tournament-setup/EventsStep";
import { ReviewStep } from "@/components/tournament-setup/ReviewStep";
import { StructureStep } from "@/components/tournament-setup/StructureStep";
import { hydrateForm } from "@/components/tournament-setup/hydrate";
import {
  MAX_TOURNAMENT_DAYS,
  SETUP_STEPS,
  defaultForm,
  setupStepIndex,
  type DraftForm,
  type SetupStep,
} from "@/components/tournament-setup/types";
import { Button } from "@/components/ui/button";
import {
  isConfigurable,
  normalizeTournamentStatus,
  tournamentStatusLabel,
  type TournamentStatus,
} from "@/lib/auth/authorization";
import {
  completeTournament,
  createTournament,
  discardTournament,
  saveTournamentConfig,
  saveTournamentDays,
  saveTournamentEvents,
  setCurrentTournament,
  startTournament,
  type TournamentDraftInput,
} from "@/lib/tournament/actions";
import {
  useTournamentDraftData,
  useTournamentReadiness,
} from "@/lib/tournament/data";
import { cn } from "@/lib/utils";

/**
 * The tournament wizard: details, events, structure, review.
 *
 * It exists as one component because there is one wizard. Creating a tournament and
 * configuring one are the same four steps asked against the same row - the only difference
 * is whether the row exists yet - and S5 splits the *address* rather than the flow:
 * `/tournaments/new` creates, `/tournaments/$id/settings` configures, and both render
 * this. Two copies of the steps would be two places for the day rules, the event rules and
 * the save order to drift apart, and a host would meet the drift as a tournament that
 * refuses to start for a reason one of the copies does not know about.
 *
 * ## It owns the step, the route owns the address
 *
 * `step` arrives as a prop and every move is reported through `onStepChange`, so the
 * caller decides whether the position lives in a search param (`/tournaments/new?step=…`)
 * or in the route's own scope (`?step=…` under an existing tournament). The wizard never
 * navigates on its own except where the destination is fixed by what just happened: a
 * discarded tournament is gone, so it leaves; a started one belongs on its Desk.
 *
 * ## Why the first save creates the row
 *
 * The tournament is written on the first "Save and continue" rather than held in memory
 * until the end, so an unfinished creation survives a refresh, a flat battery or wifi
 * dropping out. Every later step writes into the same row. `startTournament` is the only
 * thing that moves it out of `upcoming`, and the database refuses every write below from a
 * tournament that has started - so a wizard left open across a start is refused rather than
 * silently rewriting a live event.
 */
export interface TournamentWizardProps {
  /** The tournament being configured, or null while one is being created. */
  tournamentId: string | null;
  /** Which step to show. Owned by the caller so it can live in the URL. */
  step: SetupStep;
  onStepChange: (step: SetupStep) => void;
  /**
   * Called once, with the id of a tournament this wizard has just created and the step to
   * continue on, so the caller can move the address to the new tournament's own settings.
   */
  onCreated?: ((tournamentId: string, nextStep: SetupStep) => void) | undefined;
}

/**
 * Maps the wizard form onto the payload the draft RPCs accept.
 *
 * Match lengths, rest gaps and scoring rules are deliberately absent: the row is created
 * with usable defaults, and the Schedule page owns them from the first build onward.
 * Leaving them out here also means the wizard cannot overwrite a tournament's timings with
 * stale form state.
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

export function TournamentWizard({
  tournamentId,
  step,
  onStepChange,
  onCreated,
}: TournamentWizardProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();

  /**
   * The id a fresh creation acquired.
   *
   * Held here rather than sent back through the caller because the caller may not have
   * moved the address yet, and the remaining steps of *this* save still have to name the
   * row they are writing into. `tournamentId` wins when it is set, so a wizard rendered
   * under an existing tournament never looks at this.
   */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const draftId = tournamentId ?? createdId;
  const isNew = !draftId;

  const draftData = useTournamentDraftData(draftId);
  const readinessQuery = useTournamentReadiness(draftId);

  const [form, setForm] = useState<DraftForm>(defaultForm);
  const [busy, setBusy] = useState(false);
  /**
   * Whether the host has pressed "Save and continue" on this step with something missing.
   *
   * Problems are drawn beside their fields only after that. A form that complains before
   * anybody has typed in it is telling the host they have already done something wrong; one
   * that waits until they try to move on is telling them what is missing.
   */
  const [attempted, setAttempted] = useState(false);
  const hydratedFor = useRef<string | null>(null);

  const currentIndex = setupStepIndex(step);

  // Load a persisted tournament into the form exactly once per id, so a background refetch
  // can never overwrite what the host is typing.
  useEffect(() => {
    if (!draftId) {
      hydratedFor.current = null;
      return;
    }
    if (hydratedFor.current === draftId) return;
    if (draftData.isLoading || !draftData.tournament) return;
    setForm(
      hydrateForm(
        draftData.tournament,
        draftData.days,
        draftData.courts,
        draftData.dayCourts,
        draftData.dayBreaks,
        draftData.categories,
      ),
    );
    hydratedFor.current = draftId;
  }, [draftId, draftData]);

  const patchForm = (patch: Partial<DraftForm>) => setForm((prev) => ({ ...prev, ...patch }));

  /** Moving between steps starts a clean attempt: the next step has not been tried yet. */
  const goTo = (next: SetupStep) => {
    setAttempted(false);
    onStepChange(next);
  };

  const problems = useMemo(() => problemsForStep(step, form), [step, form]);

  /**
   * Whether the configuration can still be changed, which is exactly "is it upcoming".
   *
   * The rename from `draftStillEditable` is not cosmetic: `draft` was a lifecycle state and
   * `upcoming` is the one that replaced it, so the question is about the lifecycle again
   * rather than about a wizard artifact.
   */
  const tournamentStatus: TournamentStatus = normalizeTournamentStatus(
    draftData.tournament?.status,
  );
  const configEditable = isNew || isConfigurable(tournamentStatus);

  const refresh = () => qc.invalidateQueries();

  /** Saves whatever the current step owns, then advances. */
  const saveAndContinue = async () => {
    if (problems.length) {
      setAttempted(true);
      return;
    }
    setBusy(true);
    try {
      const next = SETUP_STEPS[Math.min(currentIndex + 1, SETUP_STEPS.length - 1)];
      const nextStep: SetupStep = next ? next.id : "review";

      let id = draftId;
      let justCreated = false;
      if (!id) {
        id = await createTournament(toDraftInput(form));
        setCreatedId(id);
        hydratedFor.current = id;
        justCreated = true;
        // The first step now owns the dates too, so they are saved with the tournament.
        await saveTournamentDays(id, form.days);
      } else {
        await saveStep(step, id, form);
      }

      await refresh();

      // Advancing past the first step means the tournament now exists, so the caller must
      // move the address to carry its id or a refresh would lose the position.
      setAttempted(false);
      if (justCreated && onCreated) onCreated(id, nextStep);
      else onStepChange(nextStep);
      toast.success("Saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Upcoming -> In Progress.
   *
   * The readiness gate and the start-time floor are both enforced by the RPC, and this
   * deliberately does not pre-empt either: the refusal carries the venue-local start time,
   * and a client-side check could only replace that with a vaguer message or disagree with
   * it. The checklist above the button is information; the button is the real attempt.
   *
   * Making it the working tournament afterwards is the successor to what the old activate
   * did globally. It is per user now, so starting a tournament changes what this person
   * sees and nobody else's desk.
   */
  const start = async () => {
    if (!draftId) return;
    setBusy(true);
    try {
      await startTournament(draftId);
      await setCurrentTournament(draftId);
      await refresh();
      toast.success("Tournament started");
      void navigate({
        to: "/tournaments/$tournamentId/desk",
        params: { tournamentId: draftId },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the tournament");
    } finally {
      setBusy(false);
    }
  };

  /** In Progress -> Completed. Terminal apart from a platform admin's repair paths. */
  const complete = async () => {
    if (!draftId) return;
    setBusy(true);
    try {
      await completeTournament(draftId);
      await refresh();
      toast.success("Tournament completed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not complete the tournament");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Discards an upcoming tournament and everything it owns.
   *
   * Available only while upcoming, which is exactly what protects a start-line mistake.
   * Deleting a tournament that has already started is the explicitly destructive path, and
   * it lives on the tournament's card in My Tournaments rather than here - a button whose
   * only job is to destroy a live event does not belong in the flow that configures one.
   *
   * The page cannot stay where it is afterwards: the tournament it is about no longer
   * exists, and the workspace layout would 404 on the address. So this leaves, and the
   * successor to "the tournament you were just in" is the caller's own list.
   */
  const discard = async () => {
    if (!draftId) return;
    if (!window.confirm("Discard this tournament? Everything configured so far is deleted.")) return;
    setBusy(true);
    try {
      await discardTournament(draftId);
      await refresh();
      toast.success("Tournament discarded");
      void navigate({ to: "/me/tournaments", replace: true });
    } catch (error) {
      // An attempt to discard a tournament that has already started is refused here, and
      // the refusal is the useful message.
      toast.error(error instanceof Error ? error.message : "Could not discard the tournament");
    } finally {
      setBusy(false);
    }
  };

  /**
   * The final step's props, assembled once.
   *
   * The readiness answer is the same function the start RPC re-runs, so the checklist the
   * host reads and the refusal they might get cannot disagree. `hasTournament` is what
   * disables the lifecycle buttons while a first step has not been saved yet, and it is why
   * this is a wizard concern rather than a review-step one.
   */
  const reviewProps = {
    form,
    readiness: readinessQuery.data,
    readinessError: readinessQuery.error instanceof Error ? readinessQuery.error.message : null,
    busy,
    hasTournament: !!draftId,
    status: tournamentStatus,
    onStart: () => void start(),
    onComplete: () => void complete(),
    onDiscard: () => void discard(),
    onGoToStep: configEditable ? goTo : undefined,
  };

  return (
    <div className="wizard-flow mx-auto w-full max-w-[64rem]">
      {configEditable ? (
        <div className="grid items-start gap-6 lg:grid-cols-[16.25rem_minmax(0,1fr)] lg:gap-10">
          {/*
            Where you are, as a rail on a wide screen and a bar on a narrow one.

            The rail names each step and says what it is for in a line, marks the ones that are
            done, and marks a finished step that still needs something - so a host who skipped
            ahead sees where to go back to. It is a list of buttons because moving between
            steps is a deliberate act that saves nothing: the step's own work is saved by the
            button at the foot.
          */}
          <nav aria-label="Setup steps" className="hidden lg:sticky lg:top-24 lg:block">
            <ol className="space-y-1.5">
              {SETUP_STEPS.map((entry, index) => {
                const isCurrent = entry.id === step;
                const visited = index < currentIndex && !!draftId;
                const needs = visited && problemsForStep(entry.id, form).length > 0;
                const isDone = visited && !needs;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => goTo(entry.id)}
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
                className={cn(
                  "size-2 rounded-full",
                  draftId ? "bg-success" : "bg-border-control",
                )}
              />
              {draftId ? "Draft saved" : "Not saved yet. Saved after this step."}
            </p>
          </nav>

          <div className="lg:hidden">
            <p className="flex justify-between gap-3 text-sm text-muted-foreground">
              <strong className="text-foreground">
                Step {currentIndex + 1} of {SETUP_STEPS.length} · {SETUP_STEPS[currentIndex]?.label}
              </strong>
              <span>{draftId ? "Draft saved" : "Not saved yet"}</span>
            </p>
            <div aria-hidden="true" className="mt-2 grid grid-cols-4 gap-1.5">
              {SETUP_STEPS.map((entry, index) => (
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
              <DetailsStep form={form} onChange={patchForm} isNew={isNew} showErrors={attempted} />
            ) : null}
            {step === "events" ? (
              <EventsStep form={form} onChange={patchForm} showErrors={attempted} />
            ) : null}
            {step === "structure" ? <StructureStep /> : null}
            {step === "review" ? <ReviewStep {...reviewProps} /> : null}

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
                    if (previous) goTo(previous.id);
                  }}
                >
                  ← Back
                </Button>
              ) : null}
              <span className="hidden text-sm text-muted-foreground lg:inline">
                Step {currentIndex + 1} of {SETUP_STEPS.length}
              </span>
              {step !== "review" ? (
                <Button
                  className="ml-auto h-12 flex-1 px-7 text-base font-semibold lg:flex-none"
                  disabled={busy}
                  onClick={saveAndContinue}
                >
                  {busy ? "Saving…" : "Save and continue →"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/*
            A started tournament's configuration is fixed, and the database refuses these
            writes rather than this notice doing so. Rendering the steps as editable fields
            that could only fail would be a form that lies, so the wizard shows the one step
            that still has actions and says where the rest moved to.
          */}
          <div className="mb-4 rounded-xl border border-info-border bg-info-surface px-4 py-3 text-sm text-info-foreground">
            This tournament is {tournamentStatusLabel(tournamentStatus)}, so its name, dates and
            events can no longer be changed. Courts, timings and scoring are adjusted on the Schedule
            page. The checks below still say whether it is ready.
          </div>
          <div className="max-w-3xl">
            <ReviewStep {...reviewProps} />
          </div>
        </>
      )}
    </div>
  );
}

async function saveStep(step: SetupStep, id: string, form: DraftForm): Promise<void> {
  switch (step) {
    case "details":
      // The first step owns the name, venue, timezone and the dates.
      await saveTournamentConfig(id, toDraftInput(form));
      await saveTournamentDays(id, form.days);
      return;
    case "events":
      await saveTournamentConfig(id, toDraftInput(form));
      await saveTournamentEvents(id, form.events);
      return;
    default:
      await saveTournamentConfig(id, toDraftInput(form));
      return;
  }
}

/** Client-side checks per step. The database re-validates everything. */
function problemsForStep(step: SetupStep, form: DraftForm): string[] {
  const issues: string[] = [];

  if (step === "details") {
    if (!form.basics.name.trim()) issues.push("Give the tournament a name.");
    if (!form.basics.venueTimezone.trim()) issues.push("Choose a timezone.");
    if (form.days.length === 0) issues.push("Pick the first day.");
    if (form.days.length > MAX_TOURNAMENT_DAYS) {
      issues.push(`A tournament can span at most ${MAX_TOURNAMENT_DAYS} days.`);
    }
    const dates = new Set<string>();
    for (const day of form.days) {
      if (!day.date) {
        issues.push("Every tournament day needs a date.");
        continue;
      }
      if (dates.has(day.date)) issues.push(`Two days use ${day.date}.`);
      dates.add(day.date);
    }
    return issues;
  }

  if (step === "events") {
    if (form.events.length === 0) issues.push("Add at least one event.");
    const codes = form.events.map((event) => event.code);
    if (new Set(codes).size !== codes.length) issues.push("Two events share a code.");
    for (const event of form.events) {
      if (event.gender === "mixed" && event.entryType !== "pair") {
        issues.push(`${event.code} is mixed, so it must be a doubles event.`);
      }
      if (event.maxEntries != null && event.maxEntries < 2) {
        issues.push(`${event.code} needs an entry cap of 2 or more, or no cap.`);
      }
    }
    if (form.maxCategoriesPerPlayer < 1 || form.maxCategoriesPerPlayer > 5) {
      issues.push("The per-player event limit must be between 1 and 5.");
    }
    return issues;
  }

  return issues;
}
