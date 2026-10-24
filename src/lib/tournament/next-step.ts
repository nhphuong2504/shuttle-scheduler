import type { TournamentStatus } from "@/lib/auth/authorization";
import type { TournamentPhase } from "@/lib/tournament/phase";
import type { RegistrationState } from "@/lib/tournament/registration-state";

/**
 * What the organiser should do next, read from where the tournament stands.
 *
 * The workspace has nine sections side by side, but the work has an order: decide
 * registrations, settle the roster, seed it, build the schedule, run it, complete it. This
 * names the one step the order says is next, so the organiser is not left to remember it.
 * Pure on purpose: it takes counts, not queries, so every rung is pinned by a unit test.
 *
 * It is for the organiser. The Desk is the moderator's surface and never draws it, and nothing
 * here moves a tournament - it only points.
 */
export type NextStepStage =
  | "review_requests"
  | "registration_open"
  | "add_entries"
  | "seed"
  | "schedule"
  | "run"
  | "complete";

/** Where a step's button goes: a section of the workspace, or the Complete dialog. */
export type NextStepTarget =
  | "registrations"
  | "entries"
  | "placement"
  | "schedule"
  | "desk"
  | { kind: "complete" };

export interface NextStepInput {
  status: TournamentStatus;
  phase: TournamentPhase;
  registrationState: RegistrationState;
  /** Requests waiting for a decision. */
  pendingRequests: number;
  /** Entrants the tournament is actually running (not withdrawn). */
  activeEntrants: number;
  /** Of those, how many have no seed yet. */
  unseededEntrants: number;
  /** Placement matches that exist, and how many of them have a court and a time. */
  placementMatches: number;
  scheduledPlacementMatches: number;
  /**
   * Every match the tournament has, across all its stages, and what is left of them.
   *
   * `total` counts the ones that were ever going to be played - voids and byes are out -
   * so `onCourt === 0 && unplayed === 0 && total > 0` means the last match has been
   * finished. That, and not the calendar, is what says a tournament is over: one that
   * finishes early is done, and one whose last day has gone with matches still unplayed
   * is not.
   */
  matches: { total: number; onCourt: number; unplayed: number };
}

export interface NextStep {
  stage: NextStepStage;
  title: string;
  detail: string;
  actionLabel: string;
  target: NextStepTarget;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The next step, or null when there is nothing left to ask (a completed tournament). */
export function organiserNextStep(input: NextStepInput): NextStep | null {
  if (input.status === "completed") return null;

  if (input.status === "in_progress") {
    // The last match has been settled. Completion is offered on what has been played, not
    // on what the clock says: a tournament can finish early, and its last day passing is
    // no evidence that anything is left to close.
    if (input.matches.total > 0 && input.matches.onCourt === 0 && input.matches.unplayed === 0) {
      return {
        stage: "complete",
        title: "Every match has been played",
        detail: "Complete the tournament to close it and lock every result.",
        actionLabel: "Complete tournament",
        target: { kind: "complete" },
      };
    }
    return {
      stage: "run",
      title: "The tournament is running",
      detail:
        "Call and score matches from the Desk. Complete it once the last match is played.",
      actionLabel: "Open the Desk",
      target: "desk",
    };
  }

  if (input.pendingRequests > 0) {
    return {
      stage: "review_requests",
      title: `${plural(input.pendingRequests, "registration request is", "registration requests are")} waiting`,
      detail: "Approve or reject them so the roster you seed from is the real one.",
      actionLabel: "Review requests",
      target: "registrations",
    };
  }

  if (input.registrationState === "open" || input.registrationState === "opens_soon") {
    return {
      stage: "registration_open",
      title:
        input.registrationState === "open" ? "Registration is open" : "Registration opens soon",
      detail:
        "Seed and schedule once entries are final. Late entries after seeding mean seeding again.",
      actionLabel: "Open registrations",
      target: "registrations",
    };
  }

  if (input.activeEntrants === 0) {
    return {
      stage: "add_entries",
      title: "No one is entered yet",
      detail: "Add the players or teams who are playing.",
      actionLabel: "Add entries",
      target: "entries",
    };
  }

  if (input.unseededEntrants > 0) {
    return {
      stage: "seed",
      title: "Seed the draw",
      detail: `${plural(input.unseededEntrants, "entrant has", "entrants have")} no seed. Shuffle and lock seeds before building the schedule.`,
      actionLabel: "Go to Placement",
      target: "placement",
    };
  }

  if (input.placementMatches === 0 || input.scheduledPlacementMatches < input.placementMatches) {
    return {
      stage: "schedule",
      title: "Build the schedule",
      detail:
        "Choose the playing days, courts and hours, then build. Seeds are locked, so the field is fixed.",
      actionLabel: "Go to Schedule",
      target: "schedule",
    };
  }

  return {
    stage: "run",
    title: "Ready to play",
    detail:
      input.phase === "not_started"
        ? "The first day has begun. Start the first match on the Desk to begin the tournament."
        : "The tournament begins when the first match is started on the Desk.",
    actionLabel: "Open the Desk",
    target: "desk",
  };
}
