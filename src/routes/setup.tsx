import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell, EmptyState, Panel } from "@/components/app-shell";
import { DetailsStep } from "@/components/tournament-setup/DetailsStep";
import { EventsStep } from "@/components/tournament-setup/EventsStep";
import { ReviewStep } from "@/components/tournament-setup/ReviewStep";
import { hydrateForm } from "@/components/tournament-setup/hydrate";
import {
  MAX_TOURNAMENT_DAYS,
  SETUP_STEPS,
  defaultForm,
  isSetupStep,
  setupStepIndex,
  type DraftForm,
  type SetupStep,
} from "@/components/tournament-setup/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import {
  activateTournament,
  createTournamentDraft,
  deleteTournament,
  deleteTournamentDraft,
  saveTournamentDays,
  saveTournamentDraft,
  saveTournamentEvents,
  setActiveTournament,
  type TournamentDraftInput,
} from "@/lib/tournament/actions";
import {
  useAllTournaments,
  useTournamentDraftData,
  useTournamentReadiness,
  type Tournament,
} from "@/lib/tournament/data";

interface SetupSearch {
  /** A draft id, or "new" while the first step has not been saved yet. */
  draft?: string;
  /** Which step of the wizard to show. */
  step?: SetupStep;
}

export const Route = createFileRoute("/setup")({
  validateSearch: (search: Record<string, unknown>): SetupSearch => {
    const result: SetupSearch = {};
    const draft = search["draft"];
    if (typeof draft === "string" && draft.length > 0) {
      result.draft = draft;
    }
    if (isSetupStep(search["step"])) result.step = search["step"];
    return result;
  },
  head: () => ({
    meta: [
      { title: "Tournament setup | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content:
          "Create a badminton tournament: basics, dates, events and competition structure, then activate it.",
      },
      { property: "og:title", content: "Tournament setup | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content:
          "Create a badminton tournament: basics, dates, events and competition structure, then activate it.",
      },
      { property: "og:type", content: "website" },
      { property: "twitter:card", content: "summary" },
    ],
  }),
  component: SetupPage,
});

/**
 * Maps the wizard form onto the payload the draft RPCs accept.
 *
 * Match lengths, rest gaps and scoring rules are deliberately absent: the row is
 * created with usable defaults, and the Schedule page owns them from the first
 * build onward. Leaving them out here also means the wizard cannot overwrite a
 * tournament's timings with stale form state.
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

function SetupPage() {
  const qc = useQueryClient();
  const { isAdmin, signedIn } = useSession();
  const { draft: draftParam, step: stepParam } = Route.useSearch();
  const navigate = useNavigate();

  const isNew = draftParam === "new";
  const draftId = draftParam && !isNew ? draftParam : null;

  const draftData = useTournamentDraftData(draftId);
  const readinessQuery = useTournamentReadiness(draftId);
  const tournamentsQuery = useAllTournaments();

  const [form, setForm] = useState<DraftForm>(defaultForm);
  const [busy, setBusy] = useState(false);
  const hydratedFor = useRef<string | null>(null);

  const step: SetupStep = stepParam ?? "details";
  const currentIndex = setupStepIndex(step);

  // Load a persisted draft into the form exactly once per draft, so a background
  // refetch can never overwrite what the host is typing.
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

  const problems = useMemo(() => problemsForStep(step, form), [step, form]);

  const goto = (nextStep: SetupStep, nextDraft?: string | null) => {
    void navigate({
      to: "/setup",
      search: (prev) => {
        const search: SetupSearch = { ...prev, step: nextStep };
        if (nextDraft !== undefined) {
          if (nextDraft) search.draft = nextDraft;
          else delete search.draft;
        }
        return search;
      },
      replace: true,
    });
  };

  const refresh = () => qc.invalidateQueries();

  /** Saves whatever the current step owns, then advances. */
  const saveAndContinue = async () => {
    if (problems.length) {
      toast.error(problems[0] ?? "Check this step.");
      return;
    }
    setBusy(true);
    try {
      let id = draftId;
      if (isNew) {
        id = await createTournamentDraft(toDraftInput(form));
        hydratedFor.current = id;
        // The first step now owns the dates too, so they are saved with the draft.
        await saveTournamentDays(id, form.days);
      } else if (id) {
        await saveStep(step, id, form);
      }

      await refresh();

      // Advancing past the first step means the draft now exists, so the URL
      // must carry its id or a refresh would lose the work.
      const next = SETUP_STEPS[Math.min(currentIndex + 1, SETUP_STEPS.length - 1)];
      const nextStep: SetupStep = next ? next.id : "review";
      goto(nextStep, id ?? undefined);
      toast.success("Saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!draftId) return;
    setBusy(true);
    try {
      await activateTournament(draftId);
      await refresh();
      toast.success("Tournament activated and set as the active scope");
      void navigate({ to: "/" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not activate");
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!draftId) return;
    if (!window.confirm("Discard this draft? Everything configured so far is deleted.")) return;
    setBusy(true);
    try {
      await deleteTournamentDraft(draftId);
      await refresh();
      toast.success("Draft discarded");
      void navigate({ to: "/setup", search: {}, replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not discard the draft");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Deletes a tournament whatever its status, including the active one.
   *
   * The database cascades every day, court, event, player, entry, match and
   * result, so the confirmation spells that out rather than asking a bare
   * yes/no. Invalidate everything afterwards: the desk reads the active
   * tournament from a cached query, and deleting it must clear that too.
   */
  const removeTournament = async (tournament: Tournament) => {
    const confirmed = window.confirm(
      `Delete "${tournament.name}"?\n\n` +
        "This permanently removes the tournament and everything it owns — days, " +
        "courts, events, players, entries, matches and results. It cannot be undone.",
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await deleteTournament(tournament.id);
      await refresh();
      toast.success(`Deleted ${tournament.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the tournament");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Makes an already-existing tournament the active scope again.
   *
   * Switching moves every page — the desk, registration, placement, knockout and the
   * schedule all read the active tournament from a cached query — so the confirmation
   * says what changes and everything is invalidated afterwards.
   */
  const makeActive = async (tournament: Tournament) => {
    const confirmed = window.confirm(
      `Make "${tournament.name}" the active tournament?\n\n` +
        "Every page switches to this tournament. The tournament that is active now " +
        "stays exactly as it is, but is no longer the one being shown.",
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await setActiveTournament(tournament.id);
      await refresh();
      toast.success(`${tournament.name} is now the active tournament`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not activate the tournament");
    } finally {
      setBusy(false);
    }
  };

  if (!isAdmin) {
    return (
      <AppShell title="Tournament setup" subtitle="Only admins can create a tournament.">
        <Panel title="Not permitted">
          <p className="text-sm text-muted-foreground">
            {signedIn ? "Your account does not hold the admin role." : "Sign in at the desk first."}{" "}
            Creating a tournament, and adding players and entries, is admin-only.
          </p>
        </Panel>
      </AppShell>
    );
  }

  if (!draftParam) {
    const tournaments = tournamentsQuery.data ?? [];
    return (
      <AppShell
        title="Tournament setup"
        subtitle="A tournament owns its days, courts and events. Everything else in the desk is scoped to it."
        actions={
          <Button size="sm" onClick={() => goto("details", "new")}>
            New tournament
          </Button>
        }
      >
        <Panel title="Tournaments">
          {tournamentsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading tournaments…</p>
          ) : tournamentsQuery.isError ? (
            <EmptyState
              title="Could not read tournaments"
              hint={
                tournamentsQuery.error instanceof Error
                  ? tournamentsQuery.error.message
                  : "The tournament schema may not be up to date. Apply the latest migration and reload."
              }
            />
          ) : tournaments.length === 0 ? (
            <EmptyState
              title="No tournaments"
              hint="Start a new tournament to configure it step by step."
            />
          ) : (
            <ul className="divide-y divide-hairline">
              {tournaments.map((tournament) => (
                <li key={tournament.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-display text-sm font-semibold">
                        {tournament.name}
                      </span>
                      <Badge variant={tournament.status === "draft" ? "secondary" : "outline"}>
                        {tournamentStatusLabel(tournament)}
                      </Badge>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Started {new Date(tournament.created_at).toLocaleString()} ·{" "}
                      {tournament.day_count} day(s)
                    </p>
                  </div>
                  {tournament.status === "draft" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => goto("details", tournament.id)}
                    >
                      Resume
                    </Button>
                  ) : null}
                  {tournament.status !== "draft" && !tournament.is_active ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void makeActive(tournament)}
                    >
                      Make active
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger-foreground"
                    disabled={busy}
                    onClick={() => void removeTournament(tournament)}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <div className="mt-4">
          <Panel title="How this works">
            <ul className="space-y-2 text-xs text-muted-foreground">
              <li>Each step saves into the same draft, so you can stop and come back.</li>
              <li>
                Setup covers the name, the dates and the events. Courts, day hours and match
                settings are configured on the Schedule page, at the first build.
              </li>
              <li>Nothing reaches the desk until the review step activates the tournament.</li>
              <li>The active tournament stays in charge until a draft takes over.</li>
              <li>
                Delete removes a tournament whatever its status, along with everything it owns. It
                cannot be undone.
              </li>
            </ul>
          </Panel>
        </div>
      </AppShell>
    );
  }

  if (draftId && !draftData.isLoading && !draftData.tournament) {
    return (
      <AppShell title="Tournament setup" subtitle="Draft not found.">
        <Panel title="Not found">
          <p className="mb-3 text-sm text-muted-foreground">
            That draft no longer exists. It may have been discarded or activated.
          </p>
          <Button size="sm" variant="outline" asChild>
            <Link to="/setup" search={{}}>
              Back to drafts
            </Link>
          </Button>
        </Panel>
      </AppShell>
    );
  }

  const draftStillEditable = isNew || draftData.tournament?.status === "draft";

  return (
    <AppShell
      title={isNew ? "New tournament" : (draftData.tournament?.name ?? "Tournament setup")}
      subtitle={SETUP_STEPS[currentIndex]?.hint ?? ""}
      actions={
        <Button size="sm" variant="ghost" onClick={() => goto("details", null)}>
          {isNew ? "Cancel" : "All tournaments"}
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-3xl">
        <ol className="mb-5 flex items-center gap-2">
          {SETUP_STEPS.map((entry, index) => {
            const isCurrent = entry.id === step;
            const isDone = index < currentIndex && !!draftId;
            return (
              <li key={entry.id} className="flex flex-1 items-center gap-2">
                <button
                  type="button"
                  onClick={() => goto(entry.id)}
                  aria-current={isCurrent ? "step" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
                    isCurrent
                      ? "border-primary/40 bg-primary/10"
                      : "border-hairline bg-surface hover:bg-muted/60",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-full font-score text-[10px] font-bold",
                      isCurrent
                        ? "bg-primary text-primary-foreground"
                        : isDone
                          ? "bg-mint/50 text-foreground"
                          : "bg-muted text-muted-foreground",
                    )}
                  >
                    {isDone ? "✓" : index + 1}
                  </span>
                  <span
                    className={cn(
                      "truncate text-sm font-semibold",
                      isCurrent ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {entry.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        {step === "details" ? (
          <DetailsStep form={form} onChange={patchForm} isNew={isNew} />
        ) : null}
        {step === "events" ? <EventsStep form={form} onChange={patchForm} /> : null}
        {step === "review" ? (
          <ReviewStep
            form={form}
            readiness={readinessQuery.data}
            readinessError={
              readinessQuery.error instanceof Error ? readinessQuery.error.message : null
            }
            busy={busy}
            canActivate={!!draftId && draftStillEditable}
            onActivate={activate}
            onDiscard={discard}
          />
        ) : null}

        {step !== "review" && problems.length ? (
          <div className="mt-4 rounded-xl border border-warn-border bg-warn-surface px-4 py-3">
            <ul className="space-y-1">
              {problems.map((problem) => (
                <li key={problem} className="flex items-start gap-2 text-xs text-warn-foreground">
                  <span aria-hidden className="mt-1 size-1.5 shrink-0 rounded-full bg-current" />
                  {problem}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="sticky bottom-0 z-20 mt-4 -mx-1 flex flex-wrap items-center gap-3 rounded-xl border border-hairline bg-surface/90 px-4 py-3 shadow-raise backdrop-blur-md">
          {currentIndex > 0 ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                const previous = SETUP_STEPS[currentIndex - 1];
                if (previous) goto(previous.id);
              }}
            >
              ← Back
            </Button>
          ) : null}
          <span className="font-score text-[11px] text-muted-foreground">
            Step {currentIndex + 1} / {SETUP_STEPS.length}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {step !== "review" ? (
              <Button disabled={busy} onClick={saveAndContinue}>
                {busy ? "Saving…" : isNew ? "Create and continue" : "Save and continue →"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

async function saveStep(step: SetupStep, id: string, form: DraftForm): Promise<void> {
  switch (step) {
    case "details":
      // The first step owns the name, venue, timezone and the dates.
      await saveTournamentDraft(id, toDraftInput(form));
      await saveTournamentDays(id, form.days);
      return;
    case "events":
      await saveTournamentDraft(id, toDraftInput(form));
      await saveTournamentEvents(id, form.events);
      return;
    default:
      await saveTournamentDraft(id, toDraftInput(form));
      return;
  }
}

/**
 * One badge per row. An activated tournament that the desk is currently scoped to
 * says so, because deleting that one changes what every other page shows.
 */
function tournamentStatusLabel(tournament: Tournament): string {
  if (tournament.status === "draft") return "Draft";
  if (tournament.status === "completed") {
    return tournament.is_active ? "Completed · active" : "Completed";
  }
  return tournament.is_active ? "In progress · active" : "In progress";
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
