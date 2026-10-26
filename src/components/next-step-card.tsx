import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { useCompleteTournament } from "@/components/tournament-setup/use-complete-tournament";
import { Button } from "@/components/ui/button";
import { fetchCompletionCheck } from "@/lib/tournament/actions";
import { normalizeTournamentStatus } from "@/lib/auth/authorization";
import {
  usePlacementEntrants,
  usePlacementMatches,
  useTeams,
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
 *
 * A running tournament is the one case the page cannot answer on its own: whether every
 * match has been played is a count across four match tables, so it comes from
 * `tournament_completion_check` - the same read the Complete dialog uses, which is what
 * keeps "the card offers Complete" and "the dialog is ready to complete" the same fact.
 */
export function NextStepCard() {
  const { tournamentId, tournament } = useTournamentContext();
  const summary = useTournamentSummary(tournamentId).data;
  const queue = useTournamentRegistrationQueue(tournamentId, { enabled: true });
  const teams = useTeams().data;
  const entrants = usePlacementEntrants().data;
  const matches = usePlacementMatches().data;
  const complete = useCompleteTournament(tournamentId, tournament?.name ?? "");

  const status = summary ? normalizeTournamentStatus(summary.status) : null;
  const completion = useQuery({
    queryKey: ["next-step-completion", tournamentId],
    queryFn: () => fetchCompletionCheck(tournamentId as string),
    enabled: !!tournamentId && status === "in_progress",
  });

  const step = useMemo(() => {
    // Wait for every input: a guess made from half the counts would name the wrong step.
    if (!summary || !queue.data || !teams || !entrants || !matches) return null;
    // The same for the completion counts, and only for a running tournament - every other
    // rung is answered by rows the shell has already read.
    if (status === "in_progress" && !completion.data) return null;
    const active = entrants.filter((entrant) => !entrant.excluded);
    // The Entries page's roster, which is what "has anyone entered" actually asks. A team
    // only reaches Placement once somebody syncs it, so counting entrants alone reported an
    // empty roster for a tournament with a full one.
    const entries = teams.filter((team) => !team.withdrawn).length;
    return organiserNextStep({
      status: normalizeTournamentStatus(summary.status),
      phase: tournamentPhase(summary),
      registrationState: normalizeRegistrationState(summary.registration_state),
      pendingRequests: queue.data.pending.length,
      entries,
      placementEntrants: active.length,
      unseededEntrants: active.filter((entrant) => entrant.seed == null).length,
      placementMatches: matches.length,
      scheduledPlacementMatches: matches.filter((match) => match.scheduled_time).length,
      matches: {
        total: completion.data?.total ?? 0,
        onCourt: completion.data?.onCourt ?? 0,
        unplayed: completion.data?.unplayed ?? 0,
      },
    });
  }, [summary, queue.data, teams, entrants, matches, status, completion.data]);

  if (!step || !tournamentId) return null;
  // A running tournament's next step is "keep running it", which the Desk already is; drawing
  // it above every organiser page for days is noise. It speaks again when there is a real act
  // to take (Complete, once every match is played).
  if (step.stage === "run" && status === "in_progress") {
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
