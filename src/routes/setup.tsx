import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { AppShell, EmptyState, Panel, StatTile } from "@/components/app-shell";
import { BasicsStep } from "@/components/tournament-setup/BasicsStep";
import { DaysStep } from "@/components/tournament-setup/DaysStep";
import { DraftHeader } from "@/components/tournament-setup/DraftHeader";
import { EventsStep } from "@/components/tournament-setup/EventsStep";
import { ReviewStep } from "@/components/tournament-setup/ReviewStep";
import { RulesStep } from "@/components/tournament-setup/RulesStep";
import { StepNav } from "@/components/tournament-setup/StepNav";
import { StructureStep } from "@/components/tournament-setup/StructureStep";
import { hydrateForm } from "@/components/tournament-setup/hydrate";
import {
  SETUP_STEPS,
  courtPoolSize,
  dateRangeLabel,
  defaultForm,
  isSetupStep,
  setupStepIndex,
  type DraftForm,
  type SetupStep,
} from "@/components/tournament-setup/types";
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
  type TournamentDraftInput,
} from "@/lib/tournament/actions";
import {
  useAllTournaments,
  useTournamentDraftData,
  useTournamentReadiness,
  type Tournament,
} from "@/lib/tournament/data";
import { isScoringRuleValid } from "@/lib/tournament/scoring";

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
          "Create a badminton tournament: basics, days and courts, events, competition structure and match rules, then activate it.",
      },
      { property: "og:title", content: "Tournament setup | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content:
          "Create a badminton tournament: basics, days and courts, events, competition structure and match rules, then activate it.",
      },
      { property: "og:type", content: "website" },
      { property: "twitter:card", content: "summary" },
    ],
  }),
  component: SetupPage,
});

/** Maps the wizard form onto the payload the draft RPCs accept. */
function toDraftInput(form: DraftForm): TournamentDraftInput {
  return {
    name: form.basics.name,
    format: "two_round_placement",
    venueName: form.basics.venueName,
    venueAddress: form.basics.venueAddress,
    venueTimezone: form.basics.venueTimezone,
    organizerName: form.basics.organizerName,
    organizerEmail: form.basics.organizerEmail,
    organizerPhone: form.basics.organizerPhone,
    maxCategoriesPerPlayer: form.maxCategoriesPerPlayer,
    placementGamesTo: form.rules.placementRule.gamesTo,
    placementWinBy: form.rules.placementRule.winBy,
    placementBestOf: form.rules.placementRule.bestOf,
    knockoutGamesTo: form.rules.knockoutRule.gamesTo,
    knockoutWinBy: form.rules.knockoutRule.winBy,
    knockoutBestOf: form.rules.knockoutRule.bestOf,
    groupSlotMinutes: form.rules.placementSlotMinutes,
    knockoutSlotMinutes: form.rules.knockoutSlotMinutes,
    groupRestGapMinutes: form.rules.placementRestGapMinutes,
    knockoutRestGapMinutes: form.rules.knockoutRestGapMinutes,
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

  const step: SetupStep = stepParam ?? "basics";
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
          <Button size="sm" onClick={() => goto("basics", "new")}>
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
                      {tournament.day_count} day(s) · {tournament.court_count} court(s)
                    </p>
                  </div>
                  {tournament.status === "draft" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => goto("basics", tournament.id)}
                    >
                      Resume
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

  const activeEvents = form.events.filter((event) => event.active !== false);
  const courts = courtPoolSize(form.days);
  const draftStillEditable = isNew || draftData.tournament?.status === "draft";

  return (
    <AppShell
      title={isNew ? "New tournament" : (draftData.tournament?.name ?? "Tournament setup")}
      subtitle={`Step ${currentIndex + 1} of ${SETUP_STEPS.length} · ${SETUP_STEPS[currentIndex]?.label ?? ""}`}
      actions={
        <Button size="sm" variant="ghost" onClick={() => goto("basics", null)}>
          {isNew ? "Cancel" : "All drafts"}
        </Button>
      }
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Days" value={form.days.length} hint={dateRangeLabel(form.days)} />
        <StatTile label="Courts" value={courts} hint="Union of the days' courts" />
        <StatTile label="Events" value={activeEvents.length} hint="Switched on" />
        <StatTile
          label="Status"
          value={draftStillEditable ? "Draft" : "In progress"}
          tone={draftStillEditable ? "normal" : "good"}
          hint={problems.length ? `${problems.length} to fix` : "No open issues"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_320px]">
        <div className="lg:sticky lg:top-4 lg:self-start">
          <Panel title="Steps">
            <StepNav current={step} draftId={draftId} onSelect={(next) => goto(next)} />
          </Panel>
        </div>

        <div className="min-w-0">
          {step === "basics" ? (
            <BasicsStep
              value={form.basics}
              onChange={(patch) => patchForm({ basics: { ...form.basics, ...patch } })}
              isNew={isNew}
            />
          ) : null}
          {step === "days" ? <DaysStep form={form} onChange={patchForm} /> : null}
          {step === "events" ? <EventsStep form={form} onChange={patchForm} /> : null}
          {step === "structure" ? <StructureStep /> : null}
          {step === "rules" ? <RulesStep form={form} onChange={patchForm} /> : null}
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
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-warn-foreground">
                {problems.length} thing{problems.length === 1 ? "" : "s"} to fix on this step
              </p>
              <ul className="mt-1.5 space-y-1">
                {problems.map((problem) => (
                  <li
                    key={problem}
                    className="flex items-start gap-2 text-xs text-warn-foreground"
                  >
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
                  {busy ? "Saving…" : isNew ? "Create draft and continue" : "Save and continue →"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <DraftHeader form={form} isDraft={draftStillEditable} />
        </div>
      </div>
    </AppShell>
  );
}

async function saveStep(step: SetupStep, id: string, form: DraftForm): Promise<void> {
  switch (step) {
    case "days":
      await saveTournamentDays(id, form.days);
      return;
    case "events":
      await saveTournamentDraft(id, toDraftInput(form));
      await saveTournamentEvents(id, form.events);
      return;
    case "structure":
      return;
    default:
      // Basics, rules and review all persist through the same draft payload.
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
  return tournament.is_active ? "In progress · active" : "In progress";
}

/** Client-side checks per step. The database re-validates everything. */
function problemsForStep(step: SetupStep, form: DraftForm): string[] {
  const issues: string[] = [];

  if (step === "basics") {
    if (!form.basics.name.trim()) issues.push("Give the tournament a name.");
    if (!form.basics.venueTimezone.trim()) issues.push("Choose a timezone.");
    return issues;
  }

  if (step === "days") {
    if (form.days.length === 0) issues.push("Add at least one day.");
    form.days.forEach((day, index) => {
      if (!day.date) issues.push(`Day ${index + 1} needs a date.`);
      if (day.startTime >= day.endTime) {
        issues.push(`Day ${index + 1} must close after it opens.`);
      }
      day.breaks.forEach((br) => {
        if (br.endTime <= br.startTime) {
          issues.push(`A break on day ${index + 1} must end after it starts.`);
        }
      });
    });
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

  if (step === "rules") {
    if (!isScoringRuleValid(form.rules.placementRule)) {
      issues.push("Check the placement scoring rule.");
    }
    if (!isScoringRuleValid(form.rules.knockoutRule)) {
      issues.push("Check the knockout scoring rule.");
    }
    if (form.rules.placementSlotMinutes < 5) {
      issues.push("Placement matches need at least 5 minutes.");
    }
    if (form.rules.knockoutSlotMinutes < 5) {
      issues.push("Knockout matches need at least 5 minutes.");
    }
    return issues;
  }

  return issues;
}
