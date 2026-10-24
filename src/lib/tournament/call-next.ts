import { playerOnCourt, playerStatus, type DeskMatchModel } from "@/lib/tournament/desk";

/**
 * The Desk's "Call next": notify the players of a court's next match.
 *
 * Pure preview rules: button availability, context, proposed message and reach counts.
 * Durable in-app calls are made through the server RPC by useMatchCalls.
 */

const MINUTE = 60_000;

/** How a channel can reach one player. Unknown until the server answers it. */
export interface PlayerReach {
  inApp?: boolean;
  sms: boolean;
  email: boolean;
}

/**
 * What a tile's Call next button is, for a court's next match.
 *
 * `none` draws no button: nothing is queued. `locked`: a side is not known yet, so there is
 * nobody to notify. `warn`: allowed, but a player is on court elsewhere right now - they will
 * get the message mid-match, which the dialog says. `ready`: nothing in the way.
 */
export type CallNextAvailability =
  | { kind: "none" }
  | { kind: "locked" }
  | { kind: "warn"; busyPlayerIds: string[] }
  | { kind: "ready" };

export function callNextAvailability<TMatch extends DeskMatchModel & { teams: (string | null)[] }>(
  next: TMatch | null,
  allMatches: readonly TMatch[],
): CallNextAvailability {
  if (!next) return { kind: "none" };
  if (next.teams[0] == null || next.teams[1] == null || !next.playerIds.length) {
    return { kind: "locked" };
  }
  // On *another* court: a player still in the match on this court is the court being busy,
  // which calling ahead allows, not a player being somewhere else.
  const busyPlayerIds = next.playerIds.filter((playerId) => {
    const onCourt = playerOnCourt(playerId, next.id, allMatches);
    return onCourt != null && onCourt.courtId !== next.courtId;
  });
  return busyPlayerIds.length ? { kind: "warn", busyPlayerIds } : { kind: "ready" };
}

/** The bell cue concerns player availability, even when the court is still occupied. */
export function callNextPlayersFree<TMatch extends DeskMatchModel & { teams: (string | null)[] }>(
  next: TMatch | null,
  allMatches: readonly TMatch[],
  restGapMinutes: number,
  now: number,
): boolean {
  return next != null && next.teams[0] != null && next.teams[1] != null
    && next.playerIds.length > 0
    && next.playerIds.every(id => playerStatus(id, next, allMatches, restGapMinutes, now).kind === "free");
}

/** What the court the match is queued on is doing, as the dialog describes it. */
export type CallNextCourt =
  | { kind: "busy"; elapsedMinutes: number | null }
  | { kind: "free" };

/**
 * The dialog's context line, worded as the match dialog words its own: comma-separated facts,
 * no other separator. "MD R2, scheduled 14:25, Court 2 still playing, 37′ on court".
 */
export function callNextContext({
  tag,
  courtNumber,
  scheduledMs,
  scheduledLabel,
  court,
  now,
}: {
  tag: string;
  courtNumber: number | string;
  scheduledMs: number | null;
  scheduledLabel: string | null;
  court: CallNextCourt;
  now: number;
}): string {
  const parts: string[] = [];
  if (tag) parts.push(tag);
  if (scheduledLabel) {
    const late =
      scheduledMs != null && court.kind === "free" ? Math.floor((now - scheduledMs) / MINUTE) : 0;
    parts.push(late >= 1 ? `scheduled ${scheduledLabel} (${late} min ago)` : `scheduled ${scheduledLabel}`);
  }
  if (court.kind === "busy") {
    parts.push(`Court ${courtNumber} still playing`);
    if (court.elapsedMinutes != null) parts.push(`${court.elapsedMinutes} min on court`);
  } else {
    parts.push(`Court ${courtNumber} free now`);
  }
  return parts.join(", ");
}

/**
 * The message the dialog proposes, which the moderator may edit before sending. Only a Ready
 * court - free, with its match able to start - asks the players to come to it. A busy court,
 * or a free one still waiting on a player, asks them to be ready, so a call never pulls four
 * players onto a court whose match cannot start yet.
 */
export function callNextMessage({
  tag,
  courtNumber,
  scheduledLabel,
  courtReady,
}: {
  tag: string;
  courtNumber: number | string;
  scheduledLabel: string | null;
  courtReady: boolean;
}): string {
  // The event goes in brackets: a tag can be a whole phrase ("MD - Draw A, Round of 16"), which
  // reads badly inside "your ... match".
  const event = tag ? ` (${tag})` : "";
  if (courtReady) {
    return `Tournova: your match is ready on Court ${courtNumber}${event}. Please come to the court now.`;
  }
  const at = scheduledLabel ? ` at ${scheduledLabel}` : "";
  return `Tournova: your match is next on Court ${courtNumber}${at}${event}. Please be ready near the court.`;
}

/** How many of the players at least one channel reaches. */
export function reachableCount(
  playerIds: readonly string[],
  reach: ReadonlyMap<string, PlayerReach>,
): number {
  return playerIds.filter((id) => {
    const channels = reach.get(id);
    return channels != null && (channels.inApp || channels.sms || channels.email);
  }).length;
}
