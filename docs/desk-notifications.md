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

## Needs action (top of the work column)

Each row leads with the court, then names the match, the one number that put it there, what is
in the way when something is, and the single button that clears it. Rows are ranked by how
late they are, whatever their kind; ready courts that are not late come last, soonest first.
The first five are drawn and the rest fold behind "Show N more" - three, each on one line,
on a short console (a laptop viewport under 760px tall), so Up next keeps room for its queue. Derived in
`src/lib/tournament/desk-actions.ts`.

| Row | When | Level | Action |
| --- | --- | --- | --- |
| Court N, M min late; A vs B, ready to start | A free court's next match is past its start and can start | Do this now (accent) | Start |
| Court N, M min late; A vs B. Waiting: (the tile's readiness words) | The same, but a player is busy, resting or not known | Warning | Open match |
| Court N, M min on court; A vs B, K min past the expected finish | K ≥ max(5, ⅓ of the slot), or the match behind it is already late | Warning | Enter result |
| CODE — Pool X, results incomplete; M min past scheduled finish | More than 15 min past the pool's finish | Warning | Enter results |
| Court N is ready; A vs B | A free court with a ready match, free for 3 min or more | Do this now (accent) | Start |
| All clear. Nothing needs action right now. | Nothing above | — | — |

The tile turns amber the moment a match passes its slot; the row waits, because a long match
is not yet worth walking over for, and a court that freed a minute ago is a moment between
matches.

### The thresholds are assumptions

No tournament has run on the app yet, so none of these numbers is measured. Each is chosen from
the shape of the sport and from which mistake is cheaper: a spare row costs the moderator a
glance, a missed one costs court time. Where unsure, they lean towards raising the row early.

| Threshold | Value | Why |
| --- | --- | --- |
| Late start | 1 min | Past the published time is late, and the row always carries an action |
| Ready court | 3 min free (`READY_ALERT_AFTER_MINUTES`) | Roughly the time players take to walk on; a late match never waits for it |
| Overrun | max(5 min, ⅓ of the slot) (`overrunAlertAfterMinutes`), or at once when the next match is late | A third game adds about a third of a best-of-three; past that, a finished match with no result entered is the likelier story |

**Check them at the first real tournament.** The app already stores every match's scheduled,
start and end times, and `deskActions` is a pure function of them, so the day can be replayed
afterwards with no extra tracking: how often each row fired, and how that changes under other
thresholds. Look at the spread of actual length minus slot - an overrun row raised for much more
than one match in five is noise - and ask the moderators which rows they ignored and what they
noticed before the panel did. Do not tune these against fixtures or simulated schedules: those
are built from the same assumptions and can only agree with them.

An overdue result is an omission, not a danger, so it is amber.

There is no row for a ready match without a court. It is either about to be placed
automatically, or it is waiting on an organiser's decision (no slot before the close, no
courts, a first build or a rebuild), and the Schedule page names that cause. What a moderator
can do - put it on a court that is free now - is the idle tile's "Ready to place".

## Up next (under Needs action)

The call queue: for each court, the match to call next, when its court frees and whether its
players will be free by then. Derived in `src/lib/tournament/desk-up-next.ts`.

- **No match twice.** A match Needs action names is left out, and so is one past its scheduled
  start (Needs action's, from the same one-minute line).
- **One time per row, and it says which.** "~14:45" is when the court frees: the playing match's
  start plus its slot. "Now" for a free court, "Overrun" for one past its expected end - never a
  time in the past. The published time sits under it ("sched. 14:50") only when it differs. A busy
  court's tile names its next pairing without a time, so the two never disagree.
- **Players are judged when the court frees, not now.** A player is free at the end of their rest,
  or at the end of their match elsewhere plus the rest gap. The row warns when that is at least
  `UP_NEXT_RISK_MARGIN_MINUTES` (3) after the court frees, naming the player: "resting until
  14:58", "on Court 2, free ~14:52", or "still on Court 2, running over" when that match is past
  its own expected end. Under the margin it reads "✓ Players free". "Players not known yet" when
  a side is still TBC.
- **The row is the button** that opens the match. The bell beside it is **Notify players**, drawn
  now and inactive until player notifications exist: `aria-disabled`, out of the Tab order, and
  explained once in the panel header ("Notify players: coming soon").
- Not a live region: it re-ranks every 30 seconds, and reading each change aloud would bury the
  alerts above it.

## Court board

Five states keep their names: Playing, Overrun, Ready, Waiting, Idle.

- **Overrun** is amber with a ring, and the tile says how long the match has been on: "52′ on
  court". The state is the whole statement that it is running long, so the elapsed line carries
  no `+N over slot` and no `started N min late/early` arithmetic beside it.
- **Waiting** is neutral. It asks nothing of the moderator; the line beneath it gives the
  specific reason ("A. Nguyen, ready in 4 min", "A. Nguyen, on Court 2", "Teams not assigned").
  Its chip is a deeper grey than Idle so the two stay distinct fills.
- **Playing and Overrun name the next pairing and stop there** — no "Ready now", no reason it
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
14:37", each panel carries "as of 14:37", and those minutes and times go grey. In the match dialog
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
