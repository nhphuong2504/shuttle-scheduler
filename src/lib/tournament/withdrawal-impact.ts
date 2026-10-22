import type { PlacementEntrant, PlacementMatch, TierDrawMatch } from "@/lib/tournament/data";

/**
 * What withdrawing a team does to a tournament that already has matches, for the sentence
 * the organiser reads before confirming.
 *
 * Withdrawing a team only flags the team. The placement stage follows that flag when entrants
 * are synced, which the database allows only while the tournament is upcoming, so once matches
 * exist the entrant stays in the draw and its unplayed matches stay on the schedule until
 * somebody records a walkover. This counts those matches so that is said out loud rather than
 * discovered at the Desk. It reads rows the workspace already holds and changes nothing.
 */
export interface WithdrawalImpact {
  /** The team's placement entrant, or null when the team was never synced into placement. */
  entrantId: string | null;
  /** Matches on court now. Walking the team out of these is the Desk's decision. */
  inProgress: number;
  /** Unplayed matches, scheduled or not, that would still be waiting for this team. */
  unplayed: number;
  /** Of the unplayed, those already holding a court and time. */
  scheduled: number;
  /** Matches with a recorded result, which a withdrawal does not undo. */
  decided: number;
  /** Whether the placement stage still counts the team in the field. */
  stillInField: boolean;
}

const DECIDED = new Set(["reported", "walkover"]);

export function withdrawalImpact(input: {
  teamId: string;
  entrants: readonly PlacementEntrant[];
  placementMatches: readonly PlacementMatch[];
  tierMatches: readonly TierDrawMatch[];
}): WithdrawalImpact {
  const entrant = input.entrants.find((row) => row.team_id === input.teamId) ?? null;
  const impact: WithdrawalImpact = {
    entrantId: entrant?.id ?? null,
    inProgress: 0,
    unplayed: 0,
    scheduled: 0,
    decided: 0,
    stillInField: Boolean(entrant && !entrant.excluded),
  };
  if (!entrant) return impact;

  const tally = (status: string, scheduledTime: string | null) => {
    if (DECIDED.has(status)) impact.decided++;
    else if (status === "in-progress") impact.inProgress++;
    else if (status !== "void") {
      impact.unplayed++;
      if (scheduledTime) impact.scheduled++;
    }
  };
  for (const match of input.placementMatches) {
    if (match.entrant_a_id === entrant.id || match.entrant_b_id === entrant.id) {
      tally(match.status, match.scheduled_time);
    }
  }
  for (const match of input.tierMatches) {
    if (match.is_bye) continue;
    if (match.entrant_a_id === entrant.id || match.entrant_b_id === entrant.id) {
      tally(match.status, match.scheduled_time);
    }
  }
  return impact;
}

/** The confirmation text, or null when withdrawing changes nothing the schedule holds. */
export function withdrawalWarning(name: string, impact: WithdrawalImpact): string | null {
  if (!impact.stillInField || impact.unplayed + impact.inProgress + impact.decided === 0) {
    return null;
  }
  const lines = [`Withdraw ${name}?`, ""];
  if (impact.inProgress > 0) {
    lines.push(
      `${impact.inProgress === 1 ? "A match is" : `${impact.inProgress} matches are`} being played now.`,
    );
  }
  if (impact.unplayed > 0) {
    lines.push(
      `${impact.unplayed} unplayed ${impact.unplayed === 1 ? "match stays" : "matches stay"} in the draw` +
        (impact.scheduled > 0 ? `, ${impact.scheduled} of them already on the schedule.` : "."),
    );
  }
  if (impact.decided > 0) {
    lines.push(`${impact.decided} recorded ${impact.decided === 1 ? "result is" : "results are"} kept.`);
  }
  lines.push(
    "",
    "Withdrawing flags the entry only. The draw and the schedule do not change by themselves:",
    "record a walkover on the Desk for each match this team will not play.",
  );
  return lines.join("\n");
}
