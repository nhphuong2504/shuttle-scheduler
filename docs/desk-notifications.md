# Control Desk — attention and notification inventory

Where the Desk (and the Schedule page's conflict block) tells someone something, how loud it
is, and what they can do about it. Wording lives in code; this lists where, so a change to one
message can be checked against its neighbours.

## Severity

| Level | Meaning | Treatment |
| --- | --- | --- |
| Block | The server will refuse. Nothing the desk can override. | Danger surface, action disabled, says when it clears |
| Warning | Allowed, but someone should know. Needs an acknowledgement to proceed. | Warn surface, confirm dialog with "Start anyway" |
| Notice | Worth seeing, nothing to decide. | Warn or neutral text, no dialog |
| Info | State of the system. | Neutral |

Colour is never the only channel: every row carries words, and chips carry a glyph.

## Start-match decision

| Condition | Source | Level | Desk behaviour |
| --- | --- | --- | --- |
| A player is on another court | `checkStartConstraints` and `assert_can_start_match` | Block | Start disabled. "{name} is playing on Court N right now. This match can start once they finish." |
| Short rest, tournament refuses it (`block_start_on_short_rest`) | server ignores `p_ignore_rest` | Block | Start disabled. Row says the tournament doesn't allow starting before the full rest. |
| Short rest, tournament allows it | `startCheck.warnings` | Warning | Dialog "Players haven't had full rest", "Start anyway" / "Don't start" |
| Schedule conflict on this match | `schedule_conflicts` | Warning | Dialog "Schedule conflict"; the match stays flagged until the schedule is fixed |
| Both of the last two | | Warning | One dialog, "Start this match anyway?" |

"Start anyway" is offered only when the server will accept the start.

## Schedule conflict reasons

One list, grouped in the Schedule block (organiser). The desk no longer draws a chip on the
court tile; a moderator only meets a conflict in the start confirmation dialog. Defined in
`src/lib/tournament/schedule-conflicts.ts`.

| Kind | Reads as |
| --- | --- |
| `court_overlap` | Same court and time as another match |
| `rest_shortfall` | A player won't have had full rest |
| `break` | Scheduled during a break |
| `past_closing` | Ends after the courts close |
| `before_prerequisite` | Scheduled before a match it depends on |

These are planning conflicts. They do not mean the match is physically impossible; that is
the Block rows above. Organiser headline: "N matches need schedule review".

## Removed: Needs action and Up next

The Desk used to carry a work column beside the board: **Needs action** (once "Act now"), the
ranked list of late starts, ready courts, overruns and pools with overdue results, and **Up
next**, the call queue of each court's next match. Both were removed, together with the order
hold and "New" cue that kept them still under the pointer and the `(N) Control desk` tab count.
The board is now the whole Desk: a tile's state and readiness line say what a court needs, and
the tile opens the match to start or score it. The tab reads "Control desk" while the Desk is
open.

## Day bar

The selected day is the dark one - foreground fill, surface text - rather than the accent:
purple means "act", and choosing which day to look at is navigation. The rest of the bar is the
day's pace: expected finish, closing time, and matches done.

## Court board

Five states keep their names: Playing, Overrun, Ready, Waiting, Idle.

- **Overrun** is amber with a ring, and the tile says how long the match has been on: "52′ on
  court". The state is the whole statement that it is running long, so the elapsed line carries
  no `+N over slot` and no `started N min late/early` arithmetic beside it.
- **Waiting** is neutral. It asks nothing of the moderator; the line beneath it gives the
  specific reason ("A. Nguyen, ready in 4 min", "A. Nguyen, on Court 2", "Teams not assigned").
  Its chip is a deeper grey than Idle so the two stay distinct fills. A player busy elsewhere
  is amber, not red: a delay is not a danger.
- **Idle** is dimmed by colour, not opacity: a muted wash on the tile, so "nothing here" reads
  at a glance while the court name and the pill keep full contrast.
- **Every tile gives its next match's published time**: "Next 14:50: A vs B", on a busy court
  as on a free one. On a busy court that time may already have passed; the match waits for the
  court to clear.
- **Playing and Overrun name the next match and stop there** — no "Ready now", no reason it
  is not ready. That line answers "can the queued match start now", which a court that still
  has a match on it cannot honestly answer; it is drawn on Ready and Waiting only.

## Toasts after a result

"Result recorded." then, only if true: "N later matches delayed by up to M min." then
"N matches need schedule review." The numbers come from the committed reflow and a re-read of
`schedule_conflicts`, never from a prediction. Being delayed is not a conflict.

## Connection badge

The chip says whether live updates are arriving: Live, Connecting, Offline, live updates
paused, Connection problem, live updates paused. The age of the last change is a separate
muted note, shown only while connected, and never changes the chip.

On the console the page header scrolls away, so the clock, the badge and Refresh move into the
console's own bar beside the day picker; the header's copy is `display: none` there, so the
badge's live region is never announced twice.

**While updates are paused** (Offline or Connection problem - not Connecting, which is the first
moments of a reconnect), the Desk holds its numbers at the moment the connection dropped
(`desk-paused.ts`): lateness, overruns and when a court frees are computed at that instant, since
the data is that old, while the clock keeps running. A bar under the day bar says "No updates since
14:37", the board carries "as of 14:37", and those minutes and times go grey. In the match dialog
every control that writes - start, score, walkover, void, move, clear - is locked, with the reason
at the top; Cancel stays usable. Opening a match is still allowed: it is a read.

## Recording a result: when did it finish?

Placement and knockout matches only. Chips "Just now / 5 min ago / 10 min ago" plus "Other
time…", a clock time read on the venue's wall clock (`finish-time.ts`). The RPC still takes
minutes, so the screen converts; nothing server-side changed.

## Known gaps

- Group-stage (pool) and round-robin draw matches have no finish-time parameter, so the field
  is not shown for them. Needs a migration.
- Several toasts show the database's `error.message` unchanged.
- A partial reflow ("2 moved, 1 couldn't be moved safely") is not reported as such yet; the
  toast only states what was committed and what now needs review.
