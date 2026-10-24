import { useState } from "react";
import { Bell, Check, Clock, Mail, MessageSquare } from "lucide-react";

import { MatchIdentity } from "@/components/match-identity";
import type { DeskMatch } from "@/lib/tournament/desk-matches";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/info-note";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  reachableCount,
  type CallNextAvailability,
  type PlayerReach,
} from "@/lib/tournament/call-next";
import type { PlayerStatus } from "@/lib/tournament/desk";
import { timeLabel } from "@/lib/tournament/format";

/**
 * The tile's Call next button. It sits on the tile beside the control that opens the match,
 * never inside it, so there is no button within a button.
 *
 * The tile's secondary action, so it is quieter than the tile's primary one ("Open next
 * match", in the interaction colour): muted ink, no border, no fill, no shadow - it reads as a
 * labelled icon until hovered or focused. A filled or outlined chip here was the heaviest object
 * on the tile, and on an Operate screen the state pill is meant to be the loudest thing. The hit
 * area stays 44px tall. The green dot means every player is free, including having
 * completed their rest gap. It also supports calling players directly at the venue. Busy-player warnings remain in the name and dialog.
 */
export function CallNextButton({
  availability,
  playersFree,
  courtNumber,
  notifiedAt,
  paused,
  onOpen,
}: {
  availability: CallNextAvailability;
  playersFree: boolean;
  courtNumber: number | string;
  notifiedAt: number | null;
  paused: boolean;
  /** Called with the button itself, so the dialog can hand focus back to it on close. */
  onOpen: (opener: HTMLElement) => void;
}) {
  if (availability.kind === "none") return null;
  const locked = availability.kind === "locked" || paused;
  const readyToCall = playersFree && !locked;
  const readyDescription = "All players are free; ready to call";
  const text = "Call next";
  const lastSent = notifiedAt != null ? `Last sent ${timeLabel(new Date(notifiedAt))}` : null;
  const note =
    availability.kind === "locked"
      ? "the teams are not known yet"
      : paused
        ? "no connection"
        : availability.kind === "warn"
          ? "a player is on another court"
          : null;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={locked}
      onClick={(event) => onOpen(event.currentTarget)}
      // The visible words lead the name, so a voice user can say what they see.
      aria-label={`${text}, Court ${courtNumber}${note ? `, ${note}` : ""}`}
      title={note ? `${text}: ${note}` : readyToCall ? readyDescription : undefined}
      aria-description={[readyToCall ? readyDescription : null, lastSent].filter(Boolean).join(". ") || undefined}
      className="h-11 gap-1.5 px-3 text-sm font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
    >
      <span className="relative inline-flex">
        <Bell aria-hidden="true" className="size-4" />
        {readyToCall ? (
          <span
            aria-hidden="true"
            data-call-ready
            className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-success ring-[1.5px] ring-surface"
          />
        ) : null}
      </span>
      <span className="flex flex-col items-start leading-tight">
        <span>{text}</span>
        {lastSent ? <span className="mt-0.5 text-xs font-normal tabular-nums">{lastSent}</span> : null}
      </span>
    </Button>
  );
}

export interface CallNextPlayer {
  id: string;
  name: string;
  status: PlayerStatus;
}

/**
 * The Call next dialog: who the next match's players are, where each of them is right now,
 * how each can be reached, and the message to send them.
 *
 * Opening sends nothing. Recipients load as capability booleans; Send remains locked
 * until they are known. Committed calls are inbox records, not proof of reading.
 */
export function CallNextDialog({
  open,
  onOpenChange,
  matchId,
  courtNumber,
  courtId,
  context,
  players,
  courtNumberFor,
  reach,
  notifiedAt,
  initialMessage,
  paused,
  onSend,
  returnFocusTo,
  sending = false,
  sendError = null,
  explanation = null,
  identity = null,
  scheduledLabel = null,
  courtContext = null,
}: {
  sending?: boolean;
  sendError?: string | null;
  explanation?: string | null;
  identity?: Pick<DeskMatch, "tag" | "roundTag"> | null;
  scheduledLabel?: string | null;
  courtContext?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The match being notified; a different match starts from its own proposed message. */
  matchId: string | null;
  courtNumber: number | string;
  /** The court the match is queued on, so a player still on it reads as "on this court". */
  courtId: string | null;
  context: string;
  players: readonly CallNextPlayer[];
  courtNumberFor: (courtId: string | null) => number | string;
  reach: ReadonlyMap<string, PlayerReach> | null;
  notifiedAt: number | null;
  initialMessage: string;
  paused: boolean;
  onSend: (message: string) => void;
  /**
   * The Call next button that opened it. The dialog is opened from state rather than a
   * trigger, so focus is handed back explicitly; a keyboard user lands where they left.
   */
  returnFocusTo: HTMLElement | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          if (!returnFocusTo?.isConnected) return;
          event.preventDefault();
          returnFocusTo.focus();
        }}
      >
        {/* Keyed on the match, so each one starts from its own proposed message. */}
        {open ? (
          <CallNextBody
            key={matchId ?? ""}
            courtNumber={courtNumber}
            courtId={courtId}
            context={context}
            players={players}
            courtNumberFor={courtNumberFor}
            reach={reach}
            notifiedAt={notifiedAt}
            initialMessage={initialMessage}
            paused={paused}
            onCancel={() => onOpenChange(false)}
            onSend={onSend}
            sending={sending}
            sendError={sendError}
            explanation={explanation}
            identity={identity}
            scheduledLabel={scheduledLabel}
            courtContext={courtContext}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CallNextBody({
  courtNumber,
  courtId,
  context,
  players,
  courtNumberFor,
  reach,
  notifiedAt,
  initialMessage,
  paused,
  onCancel,
  onSend,
  sending,
  sendError,
  explanation,
  identity,
  scheduledLabel,
  courtContext,
}: {
  sending: boolean;
  sendError: string | null;
  explanation: string | null;
  identity: Pick<DeskMatch, "tag" | "roundTag"> | null;
  scheduledLabel: string | null;
  courtContext: string | null;
  courtNumber: number | string;
  courtId: string | null;
  context: string;
  players: readonly CallNextPlayer[];
  courtNumberFor: (courtId: string | null) => number | string;
  reach: ReadonlyMap<string, PlayerReach> | null;
  notifiedAt: number | null;
  initialMessage: string;
  paused: boolean;
  onCancel: () => void;
  onSend: (message: string) => void;
}) {
  const [message, setMessage] = useState(initialMessage);
  const elsewhere = players.filter(
    (player) => player.status.kind === "on-court" && player.status.courtId !== courtId,
  );
  const elsewhereByCourt: { courtId: string | null; names: string[] }[] = [];
  for (const player of elsewhere) {
    const busyCourtId = player.status.kind === "on-court" ? player.status.courtId : null;
    const group = elsewhereByCourt.find((entry) => entry.courtId === busyCourtId);
    if (group) group.names.push(player.name);
    else elsewhereByCourt.push({ courtId: busyCourtId, names: [player.name] });
  }
  const reachable = reach
    ? reachableCount(
        players.map((player) => player.id),
        reach,
      )
    : 0;
  const canSend =
    reach != null &&
    reachable > 0 &&
    !paused &&
    !sending &&
    message.trim().length > 0 &&
    message.trim().length <= 500;

  return (
    <>
      <DialogHeader className="text-left">
        <DialogTitle className="pr-5 font-display text-xl">
          Call next on Court {courtNumber}
        </DialogTitle>
        <DialogDescription asChild>
          <div className="space-y-1 text-left text-sm text-muted-foreground">
            {identity ? (
              <>
                <div className="flex items-center gap-2">
                  <MatchIdentity match={identity} />
                  {explanation ? <InfoNote label="About this pairing">{explanation}</InfoNote> : null}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>{scheduledLabel ? `Scheduled ${scheduledLabel}` : "Time not assigned"}</span>
                  {courtContext ? <span>{courtContext}</span> : null}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <span>{context}</span>
                {explanation ? <InfoNote label="About this pairing">{explanation}</InfoNote> : null}
              </div>
            )}
          </div>
        </DialogDescription>
      </DialogHeader>

      {paused ? (
        <p className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-foreground">
          No connection, so sending is paused.
        </p>
      ) : null}

      {elsewhereByCourt.length ? (
        <ul className="space-y-1 rounded-lg border border-warn-border bg-warn-surface px-3 py-2 text-sm text-warn-foreground">
          {elsewhereByCourt.map(({ courtId: busyCourtId, names }) => (
            <li key={busyCourtId ?? "?"}>
              <span className="font-semibold">{joinNames(names)}</span>{" "}
              {names.length === 1 ? "is" : "are"} on Court {courtNumberFor(busyCourtId)}.
            </li>
          ))}
        </ul>
      ) : null}

      <table className="w-full text-left text-sm">
        <caption className="sr-only">The players of the next match on Court {courtNumber}</caption>
        <thead>
          <tr className="border-b border-hairline text-sm text-muted-foreground">
            <th scope="col" className="py-1.5 pr-3 font-medium">Player</th>
            {reach ? <th scope="col" className="py-1.5 pr-3 font-medium">Contact</th> : null}
            <th scope="col" className="py-1.5 text-right font-medium">Availability</th>
          </tr>
        </thead>
        <tbody>
          {players.map((player) => (
            <tr key={player.id} className="border-b border-hairline last:border-b-0">
              <th scope="row" className="py-2 pr-3 text-base font-semibold">{player.name}</th>
              {reach ? <td className="py-2 pr-3"><ReachCell channels={reach.get(player.id)} /></td> : null}
              <td className="py-2 text-right">
                <StatusCell status={player.status} courtId={courtId} courtNumberFor={courtNumberFor} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <Label htmlFor="call-next-message">Message</Label>
            <InfoNote label="Delivery details">
              Players receive this in Tournova when signed in. This does not confirm they have read it.
              {notifiedAt != null ? <p className="mt-2">Sending again notifies everyone again.</p> : null}
            </InfoNote>
          </div>
          {notifiedAt != null ? (
            <p className="text-sm tabular-nums text-muted-foreground">
              Last sent {timeLabel(new Date(notifiedAt))}.
            </p>
          ) : null}
        </div>
        <Textarea
          id="call-next-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={3}
          maxLength={500}
          disabled={sending}
          className="text-base md:text-base"
        />
      </div>

      {sendError ? <p role="alert" className="text-sm text-danger-foreground">{sendError}</p> : null}
      <DialogFooter className="flex-col items-center gap-3 border-t border-hairline pt-4 sm:justify-between sm:space-x-0">
        <div className="w-full text-sm text-muted-foreground sm:w-auto">
          <p>{reach ? `Sends to ${reachable} of ${players.length} player${players.length === 1 ? "" : "s"}` : "Loading recipients…"}</p>
          {reach && reachable < players.length ? <p className="mt-1">Call {players.length - reachable} player{players.length - reachable === 1 ? "" : "s"} at the venue.</p> : null}
        </div>
        <span className="flex w-full gap-2 sm:w-auto">
          <Button type="button" variant="outline" className="h-12 flex-1 px-4 sm:h-11 sm:flex-none" disabled={sending} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" className="h-12 flex-1 px-4 sm:h-11 sm:flex-none" disabled={!canSend} onClick={() => onSend(message.trim())}>
            {sending ? "Sending…" : reachable > 0 ? `${notifiedAt != null ? "Send again" : "Send"} to ${reachable} player${reachable === 1 ? "" : "s"}` : "Send"}
          </Button>
        </span>
      </DialogFooter>
    </>
  );
}

/** Account reach is explicit; contacts never enter this component. */
function ReachCell({ channels }: { channels: PlayerReach | undefined }) {
  if (!channels || (!channels.inApp && !channels.sms && !channels.email)) {
    return <span className="text-sm text-muted-foreground">Not linked</span>;
  }
  return (
    <span className="inline-flex items-center gap-2 text-muted-foreground">
      {channels.inApp ? <span>In Tournova</span> : null}
      {channels.sms ? (
        <span title="SMS">
          <MessageSquare aria-hidden="true" className="size-4" />
          <span className="sr-only">SMS</span>
        </span>
      ) : null}
      {channels.email ? (
        <span title="Email">
          <Mail aria-hidden="true" className="size-4" />
          <span className="sr-only">Email</span>
        </span>
      ) : null}
    </span>
  );
}

/** Where a player is, in the tile's own words: free, resting until, or on a court. */
function StatusCell({
  status,
  courtId,
  courtNumberFor,
}: {
  status: PlayerStatus;
  courtId: string | null;
  courtNumberFor: (courtId: string | null) => number | string;
}) {
  switch (status.kind) {
    case "free":
      return (
        <span className="inline-flex items-center gap-1 text-play-foreground">
          <Check aria-hidden="true" className="size-4" />
          Free
        </span>
      );
    case "resting":
      return (
        <span className="inline-flex items-center gap-1 text-warn-foreground">
          <Clock aria-hidden="true" className="size-4" />
          Resting until {timeLabel(new Date(status.readyAt))}
        </span>
      );
    case "on-court":
      return (
        <span className="whitespace-nowrap font-semibold text-warn-foreground">
          {status.courtId === courtId
            ? "On this court"
            : `On Court ${courtNumberFor(status.courtId)}`}
        </span>
      );
  }
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
