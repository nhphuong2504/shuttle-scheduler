import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { useCompleteTournament } from "@/components/tournament-setup/use-complete-tournament";
import { Button } from "@/components/ui/button";
import { normalizeTournamentStatus } from "@/lib/auth/authorization";
import {
  usePlacementEntrants,
  usePlacementMatches,
  useTournamentContext,
  useTournamentRegistrationQueue,
  useTournamentSummary,
} from "@/lib/tournament/data";
import { organiserNextStep, type NextStepTarget } from "@/lib/tournament/next-step";
import { tournamentPhase } from "@/lib/tournament/phase";
import { normalizeRegistrationState } from "@/lib/tournament/registration-state";

const SECTION_PATHS = {
  registrations: "/tournaments/$tournamentId/registrations",
  entries: "/tournaments/$tournamentId/entries",
  placement: "/tournaments/$tournamentId/placement",
  schedule: "/tournaments/$tournamentId/schedule",
  desk: "/tournaments/$tournamentId/desk",
} as const;

/**
 * The one thing an organiser should do next, drawn above the page they are on.
 *
 * Mount it only for a caller who may edit and only on organiser pages - never on the Desk,
 * which is the moderator's surface and carries no tournament-wide guidance. It reads counts
 * that the workspace already fetches (the registration queue and the summary share the
 * shell's cache entries) and hands them to `organiserNextStep`, which owns the order.
 */
export function NextStepCard() {
  const { tournamentId, tournament } = useTournamentContext();
  const summary = useTournamentSummary(tournamentId).data;
  const queue = useTournamentRegistrationQueue(tournamentId, { enabled: true });
  const entrants = usePlacementEntrants().data;
  const matches = usePlacementMatches().data;
  const complete = useCompleteTournament(tournamentId, tournament?.name ?? "");

  const step = useMemo(() => {
    // Wait for every input: a guess made from half the counts would name the wrong step.
    if (!summary || !queue.data || !entrants || !matches) return null;
    const active = entrants.filter((entrant) => !entrant.excluded);
    return organiserNextStep({
      status: normalizeTournamentStatus(summary.status),
      phase: tournamentPhase(summary),
      registrationState: normalizeRegistrationState(summary.registration_state),
      pendingRequests: queue.data.pending.length,
      activeEntrants: active.length,
      unseededEntrants: active.filter((entrant) => entrant.seed == null).length,
      placementMatches: matches.length,
      scheduledPlacementMatches: matches.filter((match) => match.scheduled_time).length,
    });
  }, [summary, queue.data, entrants, matches]);

  if (!step || !tournamentId) return null;
  // A running tournament's next step is "keep running it", which the Desk already is; drawing
  // it above every organiser page for days is noise. It speaks again when there is a real act
  // to take (Complete, once the last day has passed).
  if (step.stage === "run" && summary && normalizeTournamentStatus(summary.status) === "in_progress") {
    return null;
  }

  const action = (target: NextStepTarget) =>
    typeof target === "string" ? (
      <Button asChild size="sm">
        <Link to={SECTION_PATHS[target]} params={{ tournamentId }}>
          {step.actionLabel}
        </Link>
      </Button>
    ) : (
      <Button size="sm" disabled={complete.busy} onClick={complete.open}>
        {step.actionLabel}
      </Button>
    );

  return (
    <section
      aria-label="Next step"
      data-testid="next-step"
      className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-info-border bg-info-surface px-3.5 py-3 text-info-foreground"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold uppercase tracking-wide">Next step</p>
        <p className="text-base font-semibold">{step.title}</p>
        <p className="text-sm">{step.detail}</p>
      </div>
      {action(step.target)}
      {complete.dialog}
    </section>
  );
}
