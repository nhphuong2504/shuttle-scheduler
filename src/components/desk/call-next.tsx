import { useState } from "react";
import { Bell, Check, Clock, Mail, MessageSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
 * How each player of a match can be reached. `null` until the sending feature exists: the
 * players read the Desk has today carries no contact details, and none are fetched just to
 * draw icons. The real feature replaces this one seam, with booleans from the server - never
 * an address or a number sent to the browser.
 */
export function usePlayerReach(): ReadonlyMap<string, PlayerReach> | null {
  return null;
}

/** When a match's players were last notified. Nothing is recorded until sending exists. */
export function useCallNextRecords(): (matchId: string) => number | null {
  return () => null;
}

/**
 * The tile's Call next button. It sits on the tile beside the control that opens the match,
 * never inside it, so there is no button within a button.
 *
 * Neutral rather than accent: a board of fourteen tiles with fourteen coloured buttons would
 * shout over the state pills, which are what a moderator scans. A player on another court
 * adds an amber dot - allowed, but worth a look - and the dialog says why.
 */
export function CallNextButton({
  availability,
  courtNumber,
  notifiedAt,
  paused,
  onOpen,
}: {
  availability: CallNextAvailability;
  courtNumber: number | string;
  notifiedAt: number | null;
  paused: boolean;
  /** Called with the button itself, so the dialog can hand focus back to it on close. */
  onOpen: (opener: HTMLElement) => void;
}) {
  if (availability.kind === "none") return null;
  const locked = availability.kind === "locked" || paused;
  const text = notifiedAt != null ? `Notified ${timeLabel(new Date(notifiedAt))}` : "Call next";
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
      variant="outline"
      disabled={locked}
      onClick={(event) => onOpen(event.currentTarget)}
      // The visible words lead the name, so a voice user can say what they see.
      aria-label={`${text}, Court ${courtNumber}${note ? `, ${note}` : ""}`}
      title={note ? `${text}: ${note}` : undefined}
      className="relative h-11 gap-1.5 bg-surface px-3 text-sm"
    >
      <Bell aria-hidden="true" className="size-4" />
      {text}
      {availability.kind === "warn" && !locked ? (
        <span
          aria-hidden="true"
          className="absolute -right-1 -top-1 size-3 rounded-full border-2 border-surface bg-warn-foreground"
        />
      ) : null}
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
 * Opening it sends nothing; Send does. Until sending exists `reach` is null, so the reach
 * column is left out, the footer says sending is not connected, and Send stays disabled -
 * the dialog never claims to have notified anyone.
 */
export function CallNextDialog({
  open,
  onOpenChange,
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
        className="sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          if (!returnFocusTo?.isConnected) return;
          event.preventDefault();
          returnFocusTo.focus();
        }}
      >
        {/* Keyed on the opening, so each one starts from the proposed message. */}
        {open ? (
          <CallNextBody
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
}: {
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
  const reachable = reach ? reachableCount(players.map((player) => player.id), reach) : 0;
  const canSend = reach != null && reachable > 0 && !paused && message.trim().length > 0;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-display text-xl">
          Notify the next match on Court {courtNumber}
        </DialogTitle>
        <DialogDescription className="text-sm">{context}</DialogDescription>
      </DialogHeader>

      {paused ? (
        <p className="rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-sm text-danger-foreground">
          No connection, so sending is paused.
        </p>
      ) : null}

      {/* Allowed, but they will get it mid-match: said once here rather than asked twice. */}
      {elsewhere.length ? (
        <ul className="space-y-1 rounded-lg border border-warn-border bg-warn-surface px-3 py-2 text-sm text-warn-foreground">
          {elsewhere.map((player) => (
            <li key={player.id}>
              <span className="font-semibold">{player.name}</span> is playing on Court{" "}
              {player.status.kind === "on-court" ? courtNumberFor(player.status.courtId) : "?"}{" "}
              right now and will get this on court.
            </li>
          ))}
        </ul>
      ) : null}

      {notifiedAt != null ? (
        <p className="flex items-center gap-1.5 text-sm text-play-foreground">
          <Check aria-hidden="true" className="size-4" />
          Notified {timeLabel(new Date(notifiedAt))}. Sending again notifies everyone again.
        </p>
      ) : null}

      <table className="w-full text-left text-sm">
        <caption className="sr-only">The players of the next match on Court {courtNumber}</caption>
        <thead>
          <tr className="border-b border-hairline text-xs text-muted-foreground">
            <th scope="col" className="py-1.5 font-medium">
              Player
            </th>
            {reach ? (
              <th scope="col" className="py-1.5 font-medium">
                Reach by
              </th>
            ) : null}
            <th scope="col" className="py-1.5 text-right font-medium">
              Right now
            </th>
          </tr>
        </thead>
        <tbody>
          {players.map((player) => (
            <tr key={player.id} className="border-b border-hairline last:border-b-0">
              <th scope="row" className="py-2 text-base font-semibold">
                {player.name}
              </th>
              {reach ? (
                <td className="py-2">
                  <ReachCell channels={reach.get(player.id)} />
                </td>
              ) : null}
              <td className="py-2 text-right">
                <StatusCell
                  status={player.status}
                  courtId={courtId}
                  courtNumberFor={courtNumberFor}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="space-y-1.5">
        <Label htmlFor="call-next-message">Message</Label>
        <Textarea
          id="call-next-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={3}
          className="text-base md:text-base"
        />
      </div>

      <DialogFooter className="items-center gap-2 sm:justify-between sm:space-x-0">
        <p className="text-sm text-muted-foreground">
          {reach
            ? `Sends to ${reachable} of ${players.length} player${players.length === 1 ? "" : "s"}`
            : "Sending is not connected yet."}
        </p>
        <span className="flex gap-2">
          <Button type="button" variant="outline" className="h-11 px-4" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            className="h-11 px-4"
            disabled={!canSend}
            onClick={() => onSend(message.trim())}
          >
            {notifiedAt != null ? "Send again" : "Send"}
          </Button>
        </span>
      </DialogFooter>
    </>
  );
}

/** A player's channels: an icon each, named for a screen reader, or "No contact". */
function ReachCell({ channels }: { channels: PlayerReach | undefined }) {
  if (!channels || (!channels.sms && !channels.email)) {
    return <span className="text-sm font-semibold text-danger-foreground">No contact</span>;
  }
  return (
    <span className="inline-flex items-center gap-2 text-muted-foreground">
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
        <span className="font-semibold text-warn-foreground">
          {status.courtId === courtId ? "On this court" : `On Court ${courtNumberFor(status.courtId)}`}
        </span>
      );
  }
}
