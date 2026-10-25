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

## Call next (in Tournova)

Call next on a court tile opens a preview for that court's next match. Opening sends
nothing. Send writes a call and notifications atomically; players with a linked profile
receive it in their account's Notifications inbox. There is no email, SMS or browser push.
Call next is enabled by default. Apply its database migration before deploying the client.

The button is offered only to tournament editors. It is locked while disconnected or
when the sides are unknown. A green dot on the bell means all players are free (nobody
is on court, including this court, or still within their configured rest gap). It also
supports calling players directly at the venue, so linked accounts and reach loading do
not affect the cue. The cue is a static 6px success-green dot at the bell's upper-right corner,
with a 1.5px surface ring to separate it from the icon. It stays hidden while the button is locked. It can appear while unrelated players occupy the court, since calling
ahead is allowed. Busy-player warnings stay in the dialog and button description.
Calling ahead while the court is busy, or a player is on another court, is allowed. Only a Ready court proposes “come now”; all others propose
“be ready near the court”. A match that moves or starts closes its old preview.

The preview lists each player's whereabouts and either In Tournova or Not linked.
It counts reachable players; no recipients means Send is disabled. Messages are editable,
with a 500-character limit. Missing accounts need a direct call by the moderator. Identity
is never inferred from email or name. Approval remains the only profile-linking path.

While sending, Send and the message are locked. Errors stay in the preview. An uncertain
response retains its request ID for a safe retry. Send again after success creates a new
call, with a 30-second server cooldown per match. The server checks permission, live
lifecycle, court, scheduled time, players and queue before committing. “Last sent” records
an inbox write, not delivery to a device or proof the player read it. The tile always
keeps the action label Call next, with the last-sent time on a secondary line.

The inbox is in the signed-in account header in both shells, shows the latest 100 calls, has an
unread count and per-item Mark as read. It links to the read-only court board without
granting operating rights. Old calls whose match has changed or started carry a notice
to check the board. Reads and acknowledgements are scoped to the recipient profile.
Five-second polling while the app is active and focus/reconnect refresh catch up from
stored records; the app must be open to display updates. Desk call history uses the
same refresh policy so multiple moderators share the last call time.

## Day bar

The selected day is the dark one - foreground fill, surface text - rather than the accent:
purple means "act", and choosing which day to look at is navigation. The rest of the bar is the
day's pace: expected finish, closing time, and matches done.

## Ready matches with no time

A danger bar over the board, editors only, while any ready match has no court and time: "N ready
matches have no time yet", then why (the last automatic pass's problem: it failed, it was refused and
will retry, or what is left unplaced and why) and a link to review the schedule. It appears at once
when the last pass reported a problem, and otherwise once the same set has waited a minute. The
offline bar takes its place while the Desk is paused. Level: Notice. See scheduling-decisions.md
section 32.

## Court board

Five states keep their names: Playing, Overrun, Ready, Waiting, Idle.

- **Playing** is the normal state, so it is quiet: a white tile with the resting hairline, and
  the green lives in the chip alone. Only Overrun and Ready, the states that ask for a hand,
  tint the whole tile, so on a day when most courts are playing they still stand out. The tile
  gives the elapsed minutes against the slot - "7′ of 15′ on court" - so a moderator reads how
  far through the match is, and roughly when the court frees, without arithmetic; it does not
  say how the match started.

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
- **A busy court with nothing queued says "Nothing queued".** The "Ready to place" pairing - a
  ready match with no court - is offered on free courts only: a busy court cannot take it.
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

## Entering a score

The dialog collects one row per game the rule allows (`bestOf`), and reads them through
`score-entry.ts` rather than deciding anything itself. `gamesWinnerFor` still decides whether
the result is legal - the same function the report path is built on - so the button and the
server cannot disagree; this module only says a refusal in words.

Four behaviours are deliberate:

- **A blank row between games is refused, not dropped.** Only trailing blank rows are ignored,
  because those are how a best-of-three looks when the match ended in two. Filtering the array
  instead used to turn `21-19, (blank), 21-19` into a legal 2-0, which recorded a result nobody
  entered.
- **The refusal is spoken.** `role="status"` under the score box names the reason - "Game 1 is
  not a winning score. Games are to 21, win by 2.", "Game 2 is empty. Fill it in, or clear the
  games after it." - and the box at fault carries `aria-invalid`. A disabled `Report result`
  with no explanation reads as a broken app, and a score the desk believes it entered is then
  entered twice. It appears only once something has been typed, never on a fresh dialog.
- **The winner is named before saving.** "A. Nguyen / B. Tran wins 2-0." on a multi-game match,
  so the operator does not count the games themselves.
- **Only digits reach the box.** `inputMode="numeric"` shapes a phone keyboard but does not stop
  a hardware keyboard or a paste, and `Number` reads `0x15` as 21 and `1e1` as 10.

## Recording a result: when did it finish?

Placement and knockout matches only. Folded to one line ("Finished just now · Change"); Change opens the chips "Just now / 5 min ago / 10 min ago" plus "Other
time…", a clock time read on the venue's wall clock (`finish-time.ts`). The RPC still takes
minutes, so the screen converts; nothing server-side changed.

## Known gaps

- Group-stage (pool) and round-robin draw matches have no finish-time parameter, so the field
  is not shown for them. Needs a migration.
- Several toasts show the database's `error.message` unchanged.
- A partial reflow ("2 moved, 1 couldn't be moved safely") is not reported as such yet; the
  toast only states what was committed and what now needs review.

## Placement wording

Court tiles, Scores and Call next use the existing event/round labels (`MD R1`,
`MD R2`) for every pairing. A free court groups `Next 12:40` and `MD R2` with layout
spacing and wrapping. A busy court keeps its current match identity, then puts the next
time and pairing on separate lines. Details group identity, court/time and scoring rules
into separate readable lines. Internal `is_makeup` and `is_crossover` flags are not public match types.
Details explain why an entrant plays both placement matches in Round 2, or why a Round 1
winner meets a Round 1 loser, and state that these results count towards draw assignment.
The Placement table places an (i) next to the entrant who did not play in Round 1, with
the explanation available on hover, tap or keyboard activation. The row keeps its own
completed/required match count. A match is never called an extra, friendly or bye.
The landing Desk preview uses the same label helper. Pairings, dependencies, rest gaps,
scoring and tier assignment are unchanged.
