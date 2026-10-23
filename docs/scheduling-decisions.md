# Day 1 group-stage scheduler: implementation record

> **This is a record of shipped behaviour, not a pending task.**
>
> Despite the imperative phrasing it was originally written in, the scheduler
> described below **is implemented**. It was written as a build prompt and has been
> kept because it is the most complete written statement of the scheduling decisions
> the code embodies - decisions that are otherwise only visible by reading the
> solver.
>
> Do not treat this as work to be done. Read it to understand why the scheduler
> behaves the way it does. If the code and this document disagree, the code wins.
>
> Where it lives now:
> - [`src/lib/scheduling/solvers/grasp.ts`](../src/lib/scheduling/solvers/grasp.ts)
> - [`src/lib/scheduling/solvers/hybrid.ts`](../src/lib/scheduling/solvers/hybrid.ts) — "GRASP, seeded with greedy"
> - [`src/lib/scheduling/solvers/types.ts`](../src/lib/scheduling/solvers/types.ts)
> - [`src/lib/scheduling/domain.ts`](../src/lib/scheduling/domain.ts)
>
> The decisions below were verified against the code when this document was moved
> into `docs/`: court-driven construction, fixed-match preloading, soft round and
> category semantics, stall handling, the top-K restricted candidate list with seeded
> multi-run search, independent validation, the weighted final score, the court-idle
> metric, and default configuration values.

---

Implement Day 1 group-stage scheduler V2 by replacing the current match-driven greedy scheduler with a court-driven GRASP-style scheduler.

Keep the existing data model, fixed-match handling, and database persistence flow where possible. Focus changes on `scheduleDay()` / `scheduleMatches()` and related helper functions.

## 1. Core scheduling loop

Replace:

```text
for each match
→ find earliest court
→ assign match
```

with:

```text
find earliest feasible court/time
→ find all eligible matches for that court/time
→ rank eligible matches
→ take top-K RCL candidates
→ randomly choose one candidate
→ assign it to that same court
→ update scheduling state
→ repeat
```

The scheduler must be court-driven, not category-driven or match-list-driven.

## 2. Fixed matches

Matches that are already `reported`, `in-progress`, or `walkover` must remain fixed.

Before scheduling new matches, preload fixed matches into the run state so they affect:

- court occupancy,
- player availability,
- player rest,
- dependency state.

Never overwrite or move fixed matches.

## 3. Hard eligibility rules

A match is eligible only if:

- all required players are known,
- all involved individual players are available,
- all players have satisfied the configured rest gap,
- the selected court is available,
- applicable match dependencies are satisfied,
- there is no conflict with a fixed match,
- the match has not already been scheduled.

For doubles, check all four individual players independently.

## 4. Round semantics

Do not use whole-round synchronization as a hard scheduling barrier.

`round` remains a soft scheduling priority only.

A later-round match may become eligible once its own explicit prerequisites are complete and its players satisfy availability/rest rules.

Earlier rounds should still rank ahead of later rounds when other factors are similar.

Do not leave courts idle solely to preserve round batching.

## 5. Category semantics

`categoryOrder` is a soft preference, not a hard block.

Prefer earlier categories when practical, but if no earlier-category match is eligible, allow another category to use the court.

Do not require one category to finish before the next category starts.

## 6. Scheduler state

Each GRASP run should maintain state such as:

```text
currentTime
courtFreeAt
playerFreeAt
scheduledMatches
unscheduledMatches
dependencyState
earliestEligibleTime
```

Fixed match occupancy must also be represented in this state.

## 7. Stall handling

The scheduling loop must never hang.

If no currently available court has an eligible match, advance `currentTime` to the earliest future scheduling event strictly greater than `currentTime`.

Future events may include:

- court becomes free,
- player rest completes,
- fixed match ends,
- prerequisite match ends,
- dependency becomes satisfied.

If unscheduled matches remain and no future event can change eligibility, mark the run as deadlocked.

Use an explicit bounded loop with an iteration cap and clear failure diagnostics.

## 8. Match ranking

Rank only eligible matches.

Use lexicographic priority rather than a weighted per-match score.

This order is now one shared comparator, [`solvers/urgency.ts`](../src/lib/scheduling/solvers/urgency.ts).
Greedy reads it as its processing order and GRASP reads it to rank the candidates at each instant, so
"the solver prefers X" has a single meaning; greedy and GRASP still place matches differently, but they
rank them the same way.

The shipped priority order:

1. player bottleneck pressure — `futureConflictDegree` desc, then `fixedWindowPressure` desc,
2. stage-closing urgency — `stageRemaining` asc, then `stageUnlocks` true first,
3. raw player work volume — `remainingMatches` desc, then `remainingGroupCount` desc,
4. waiting time desc,
5. completion pressure asc,
6. `phase`, `softOrder`, `sequence`, the constrained player's id, then the match id.

Two things this retires from the original design. Completion pressure has **one polarity**, ascending:
greedy used to drain the largest unit first while GRASP drained the smallest, and that inversion is
what let the two disagree about the same problem. And raw work volume is no longer the leading key:
`remainingMatches` descending is "drain the biggest pool first", which starves a stage that has almost
finished, so it now sits below stage closure and breaks ties within a stage tier rather than outranking
one.

Greedy recomputes its order from the still-pending set on each dependency pass rather than once from
whole-problem counts, so `stageRemaining` actually falls as a stage drains.

Keep each component observable for debugging.

## 9. Constrained-player priority

For each player, track interpretable factors in two tiers:

```text
bottleneck pressure:  futureConflictDegree
                      fixedWindowPressure
raw work volume:      remainingMatches
                      remainingGroupCount
```

The split is deliberate: bottleneck pressure is what the ranking leads with, and raw volume is a
tie-break beneath stage closure (see §8). `futureConflictDegree` counts how many co-participants are
themselves still owed more than one match, and `fixedWindowPressure` is the minutes of work still owed
beyond the minutes left in the window; neither is a proxy for "this player has a lot left", which was
the mechanism that benched a straggler.

For singles, use the more constrained player.

For doubles, use the most constrained player among all four players.

Do not average player constraint values.

## 10. Waiting time

Define match waiting time as:

```text
waitingTime = currentTime - earliestEligibleTime(match)
```

Clamp at zero.

This is used only for per-match ranking.

## 11. Restricted Candidate List

After ranking eligible matches:

- take the top `K`,
- default `K = 3–5`,
- randomly choose one candidate,
- assign it to the selected court.

Do not randomize only exact ties.

Make `K` configurable.

Use deterministic seeded randomness.

## 12. Multi-run search

Run the full scheduler 50–100 times.

Each run should use a different deterministic seed.

For the same input, configuration, and seed, the run must reproduce exactly the same schedule.

Do not persist intermediate runs.

The shipped default is narrower than the original 50–100. The production strategy is the hybrid —
GRASP seeded with greedy's incumbent — at `DEFAULT_HYBRID_RUNS = 1`, and the hybrid keeps the
incumbent unless a candidate is **strictly** better, so one run can only ever help.

The run ladder (`npm run bench:scheduling`) is what keeps that decision evidence-based rather than an
assumption. On the six current shapes, `x1` already beats greedy on five of them (2/5, 5/5, 4/5, 5/5,
5/5 seeds) and matches it on `straggler`; going to `x5` adds a small median stage-progression gain for
roughly four times the runtime on the large shape (77 ms → 354 ms), and `x25` costs about twenty times
greedy's time (1.6 s) for a further modest gain. The desk is live and on imperfect wifi, so the cheap
configuration wins unless a future measurement says otherwise; the ladder is re-run whenever the
objective or the urgency order changes.

## 13. Independent validation

After each completed run, independently validate:

- no court overlap,
- no player overlap,
- minimum rest gap for every consecutive pair of that player's matches,
- dependency rules,
- fixed matches unchanged,
- every intended match appears exactly once,
- every scheduled match has a valid court/time,
- no fixed court/player conflict.

Validation logic should be separate from schedule-construction logic.

Reject invalid candidates.

## 14. Final schedule scoring

Compare complete valid schedules with a lexicographic objective tuple, lower is better for every term.
The order lives in [`src/lib/scheduling/metrics.ts`](../src/lib/scheduling/metrics.ts) as
`DEFAULT_OBJECTIVE_ORDER`:

```text
unscheduled, afterCutoff, stageProgression, makespan, resourceIdle,
excessWait, fragmentation, softOrderDeviation, disruption
```

`unscheduled` and `afterCutoff` are still the two that must never regress: a complete schedule slightly
after the cutoff beats an incomplete schedule that finishes before it.

`stageProgression` sits above `makespan`. It is the weighted sum of each stage's close time — the last
end among that stage's assignments minus the horizon — with stages that release a later stage counted
twice, and it is what makes closing a nearly finished stage worth moving the finish line for. Because
it outranks `makespan`, a single GRASP construction has a real reason to beat greedy and win the fold.

`disruption` is ordered **last**, below `softOrderDeviation`, so the tail still moves whenever that
materially improves stage progression or the overall schedule. It measures churn against a caller-supplied
baseline: the absolute start shift in minutes plus a penalty for a court change. A first build has no
baseline and scores zero.

Use normalized minute-based values.

The older weighted-score phrasing is superseded: the implementation is lexicographic, and each term is
observable in the diagnostics.

## 15. Court idle metric

Calculate court idle time only between:

```text
dayStart → projectedFinish
```

Do not count idle time after the final match.

## 16. Player waiting metric

For each player, sort matches chronologically.

For each consecutive pair:

```text
rawWait = next.start - previous.end
excessWait = max(0, rawWait - requiredRestGap)
```

Use excessive wait, not required rest, in final schedule scoring.

## 17. Category fragmentation

Use:

```text
categoryFragmentationGapMinutes = 30
```

as the default configurable threshold.

A category starts a new block only if it disappears for more than this threshold and later resumes.

Score fragmentation as the number of extra blocks across categories.

## 18. Category-order deviation

Count a deviation only when:

- a later-preference category is selected,
- while an earlier-preference category had an eligible match at the same decision point.

Do not count it as a deviation if the earlier category had no eligible match.

Track both deviation count and deviation magnitude.

## 19. Tie-breaking

If two complete schedules have exactly the same final score, keep the one generated first / with the lower seed.

## 20. Diagnostics

Return diagnostics for the winning schedule:

```text
projectedFinish
makespanMinutes
courtUtilization
courtIdleMinutes
matchesAfterCutoff
afterCutoffMinutes
unscheduledMatches
minimumObservedPlayerRest
maximumPlayerExcessWait
averagePlayerExcessWait
categoryFragmentation
categoryOrderDeviationCount
categoryOrderDeviationMagnitude
validCandidateCount
invalidCandidateCount
deadlockedRunCount
winningScore
winningSeed
totalRuntime
averageRuntimePerRun
```

## 21. Debug trace

Support optional trace/debug output for each assignment:

```text
decisionTime
selectedCourt
eligibleCandidateCount
rankedCandidates
RCLCandidates
selectedMatch
selectedMatchPriorityTuple
randomSeed
```

Expose why the selected match ranked highly.

## 22. Performance target

For approximately 230 matches, 8 courts, and 50–100 GRASP runs, target total runtime under 10 seconds on typical hardware.

If performance is poor, optimize indexes/caches before reducing the number of runs.

## 23. Persistence

Persist only the winning validated schedule.

Preserve the current RPC/database flow where possible.

Never rewrite fixed matches.

## 24. Non-goals

Do not introduce:

- CP-SAT,
- OR-Tools,
- external optimization solvers,
- Day 2 scheduling changes,
- automatic full rebuild after every completed match.

The goal is a fast, explainable, reproducible Day 1 group-stage scheduler that uses courts efficiently while preserving all hard player, rest, court, and dependency constraints.

## 25. Stage progression and update stability

A **stage** is one milestone of one event: `MD:round1`, `MD:round2`, a tier draw's `r2`, a pool's own
round. `stageKey` is set by the single producer of solver input
([`stage-items.ts`](../src/lib/tournament/scheduling/stage-items.ts)) and mirrored onto `ScheduleMatch`
and `ComposedMatch`. `stageUnlocks` is true when finishing that stage is what releases the next one,
read from the format's own pipeline knowledge — `MIN_ENTRANTS_FOR_ROUND_TWO` and `bracketRoundCount` —
rather than from a numeric future-match estimate.

**The bug this exists to fix.** In the round-one moment, one event can be down to its last match or two
while four others still have a full round to play. The old ranking led with a participant's raw
`remainingMatches` and treated completion pressure as "drain the largest unit first", so the straggler —
fewest matches left, smallest unit — was scheduled last and its round two could not be generated until
every other event had played out its opening round. Nothing in the objective punished that: swapping
the straggler's court to an equal-duration match left `makespan` unchanged and could improve
`resourceIdle`.

The fix has three parts, all ranking-only:

- the shared urgency order in §8 puts stage closure directly beneath player bottleneck pressure and
  moves raw work volume below it;
- `stageProgression` (§14) ranks the schedule that closes stages earlier above a marginally shorter one;
- the benchmark's `straggler` shape measures the effect on real numbers rather than on argument.

On that shape, the straggler's stage closes at 60 minutes against the pre-change 240, while
`unscheduled` and `afterCutoff` are unchanged. The trade is real and accepted: the straggler's own
matches take courts earlier, so a serial participant elsewhere can finish later. `unscheduled` and
`afterCutoff` still outrank everything, so that trade can never cost a match.

**Update Schedule stability.** A rebuild used to re-solve everything, so the match a moderator was
about to call could move. `planPlacementSchedule` now pins the earliest still-`scheduled` match on each
court at its current court and time. `freezeHorizonMinutes` is an option defaulting to **0** — one match
per court, no time window — to be raised only if a churn measurement says a longer window is needed.

**A pin is only taken while its time is still legal.** The solver cannot move a pinned match, and the
validator exempts fixed matches from the floor, break, closing-time and rest checks, so a pin on a bad
time would be kept silently instead of repaired. A committed match is therefore pinned only if it is not
before the rebuild's floor (`nextWholeMinute`), does not overlap a break, does not finish after the close
of a day that is not the last day with courts (the last day may overrun), does not collide with a decided
match on its court or inside a shared player's rest window, and does not do the same to a pin already
taken. When two pins conflict the earlier one (then the lower id) is kept and the other is left to the
solver. The rest check is the solver's own gate (`relateToDecided`), so a pin and the solver cannot
disagree. A match whose time has already passed but that has not started is released and moves to the
floor, which the preview shows as a move; the desk's overdue alert is unaffected.

**Frozen is not fixed, and the distinction is load-bearing.** A frozen match is `fixed: true` in the
*problem* so the solver cannot move it, but it remains a `scheduled` row for the *writer* and the
*preview*. `payloadFor` excludes `fixedSet`, so treating a frozen row as decided history would clear it
without re-setting it and `uncoveredScheduledMatches` would throw; `diffPlan` computes `placedCount`
from the non-fixed rows, so a frozen row would vanish from the preview and under-count it. The plan
therefore tracks `frozenMatchIds` separately from `fixedMatchIds`: frozen matches are pinned for the
solver, still written by the payload at their existing slot, and still appear in the diff as
`unchanged`.

`disruption` (§14) is built from a caller-supplied `problem.baseline` — the current rows — and sums the
absolute start shift plus a court-change penalty. It is ordered last so the tail still moves whenever
that materially improves stage progression; a first build has no baseline and scores zero.

**Where it is measured.** `npm run bench:scheduling` reports per-stage close times and the median change
in progression and churn per run-count step, over `small`, `medium`, `large`, `contended`, `multi-event`
and `straggler`. `shapes.test.ts` pins that the straggler stage closes before every other stage and no
later than the pre-change baseline; `fixtures.test-helpers.ts`'s `F16` pins the same semantics at
fixture scale with a closed-form assertion; `core-contract.test.ts` pins the metric hierarchy, the
disruption arithmetic and re-solve idempotence; `placement-schedule.test.ts` pins the freeze.
## 26. The full knockout bracket and what is schedulable

A knockout draw creates its whole bracket at once (see
[`tournament-format.md`](tournament-format.md#the-whole-bracket-exists-from-the-draw)), so the
planner no longer relies on "a later round does not exist yet" to keep unknown matches out.

- **Only ready matches are scheduled.** `tierItems` keeps a non-fixed match only when both sides
  resolve to players (`participantsKnown`). A half-known semifinal is dropped there, not handed to
  the solver, exactly as a match with no players always was.
- **Parents are now real.** `parent_a_id` / `parent_b_id` are filled at the draw, so `eligibleFrom`
  and the reflow dependencies bind a child to its feeders' `ended_at` plus the knockout rest gap.
  A feeder decided by a bye has no `ended_at` and constrains nothing.
- **The writer ignores undecided slots.** The knockout completeness check
  (`knockoutScheduledIds`, and `apply_placement_day_schedule` in SQL) counts only matches with both
  entrants, because a slot waiting on a feeder has no court or time to lose.
- **A freshly ready match is placed by the next rebuild.** A result fills the child slot but does
  not place it; the live reflow shifts only rows that already hold a court and time. Placing newly
  ready matches without a manual rebuild ("Place ready") remains the open design in
  [`knockout-bracket-ideas.md`](knockout-bracket-ideas.md).

## 27. Placing a newly ready match without a rebuild

A rebuild (§25) re-solves every unplayed match and rewrites the whole queue. That is the wrong tool for
"a knockout slot just became ready". `planPlacementSchedule({ mode: "place-ready" })` is the other mode:

- **Held means held.** Every `scheduled` match that already has a court and a time is an immovable anchor,
  including one whose time has passed, sits in a break or crosses a day's close. The rebuild-mode legality
  filter is deliberately not applied, because releasing such a pin is exactly a move. A held match that
  collides with decided history or another held match is taken out of the problem (neither moved nor
  planned) rather than fixed.
- **Only unplaced ready matches get slots**, around the anchors. Whatever does not fit is `blocked`.
- **The additive writer.** `placementNewPayload` / `knockoutNewPayload` go to `place_ready_matches`, which
  fills only empty slots and re-checks court and player conflicts on the server, so a stale plan can place
  fewer matches but cannot double-book.

Wired in §28.

## 28. Scheduling that follows the results

Pressing "Rebuild schedule" after every round is not a workflow. Once a schedule exists, the work it
used to be pressed for happens on its own, and the button is left for deliberate re-optimisation.

- **After a result** (`useAutoSchedule`, called from `MatchOperationsDialog`, which both the Desk and
  the Scores page use): an editor's client generates the stage the result unlocked - round two, the
  knockout draws - **only for events that already have placement matches** (the first build stays the
  operator's decision), then plans in `place-ready` mode (§27) and writes through `place_ready_matches`.
  Overlapping results coalesce (`singleFlight`: one run plus one queued). It is best-effort and silent
  on failure: the result is already saved, and the Schedule page's status line is where anything left
  over stays visible. A toast names what happened ("Round 2 drawn, 2 matches scheduled").
- **Nothing is rebuilt.** No time that was already on a match changes; a rebuild still previews and
  needs confirmation (§24 still lists an automatic full rebuild as a non-goal).
- **There is no "Place now" button.** A lost race, a dropped request or a result that moved under the
  plan heals on its own: `useAutoScheduleReconciler` (mounted on the Desk and the Schedule page) looks
  again while any ready match has no time, after a short settle and then with backoff, three tries at
  most (`planRetry`). A persistent answer is tried once per situation, where a situation is the set of
  unplaced matches plus the days, courts and breaks they could go on; changing any of those is a new
  situation. With no editor looking at either page nothing retries, which is acceptable because a
  tournament in progress always has a desk.
- **Automatic placement never runs past the close.** The last day that has courts may overrun in a
  rebuild, because its preview forecasts the overrun for the host to accept or fix. A pass nobody
  reviews must not take that decision, so `place-ready` plans with `strictClose`: a match that would
  finish after the last day closes stays unplaced.
- **What is left is said as a cause.** `classifyUnplaced` sorts the leftovers into `no_courts`,
  `past_closing`, `held_behind_placement` (a knockout waiting on a placement match with no slot) and
  `data` (a missing prerequisite or a team that no longer exists); server declines that are a race
  (`court_busy`, `player_busy`, `already_placed`, `not_ready`, `not_scheduled`, `in_the_past`) are
  retried and never shown. The Schedule page works the reasons out itself from the rows on screen (a
  dry run of the same planner), so every organiser sees the same, and words one notice with one action
  (`describeUnplaced`): review a rebuild, or open settings when there are no courts. When there is
  nothing to say it says nothing.
- **"Update schedule" is now "Rebuild schedule"**, and is a quiet outline button unless something needs
  a decision (a notice, or schedule conflicts). Saving timings, match settings or breaks offers
  **Review & apply** in the toast instead of telling the host to go and find the button.
- **A rebuild is suggested only when it is worth it.** The Schedule page runs a dry-run rebuild and, when it
  would finish at least 30 minutes sooner, place every match and move at least one, says so with the cost
  stated (`buildRebuildSuggestion`) and opens the usual rebuild preview. It never applies anything, and it
  stays quiet when the unplaced-matches notice is showing.
- **The Desk** lists a ready match with no time at all in its "ready, unassigned" pool (after every
  timed one), so it can still be dispatched while nothing has placed it.
- **The settings panel is the first build's page.** On a tournament that has never been built it opens
  itself, because the days, the per-day courts, the hours, the breaks and the match settings in it are
  the whole job on a first pass. It closes itself when that build succeeds: everything in it has been
  read and written by then, and the running order the build just produced is what the host needs next.
  A refused build leaves it open, because it is also the only place to fix what refused it. A rebuild
  never closes it — that path has its own preview to dismiss.
- **What stays manual:** the first build, a rebuild after the day windows, courts or timings change,
  clearing a held overlap, and withdrawals or walkovers, which the placement format does not support
  on the Desk.

## 29. Modelling a match that is on court

The planner has to say when a running match ends, because it holds its court and its players until then.
`inProgressEnd` (`src/lib/tournament/in-progress.ts`) is the one answer: `max(start + slot, now)`, in whole
milliseconds. A match inside its slot ends when the slot is up; one that has overrun is taken as ending now,
since nothing says when. It is the model the live reflow (`shift_live_schedule_core`),
`placement_occupied_matches` and `schedule_conflicts` already used, and it is now also the Desk's finish
forecast and the Schedule page's projected finish.

- **What it replaced.** The planner used to model every running match as `now + slot`: a full slot from the
  moment of planning however long it had been playing. That reserved court and player time that had already
  been used, which left courts idle and made every rebuild push published times later. Measured against the
  planner's own belief about when courts free up, a rebuild was as tight as gap-filling; the whole gap was
  that reservation (`docs/scheduling-strategy-evaluation.md`).
- **It is a planning estimate, not a lock.** Whether another match may START on a court is decided by status
  alone (`assert_can_start_match`): a court with a match in progress is busy until it is reported, whatever
  the estimate says. An overrun therefore never lets two matches share a court. At worst the next match is
  published for a moment when the court is still busy; the reflow pushes it later and the conflict report
  flags it, exactly as they did before.
- **Pins.** A pinned next match is kept when it starts at or after the running match's modelled end, and
  released when it would overlap it. With the shorter end more pins qualify than before.
- **No margin on purpose.** A cushion for overruns (for example +5 minutes) was measured and gives back idle
  court time for fewer premature publications; it would also be a second model beside the SQL one.
- **Whole milliseconds.** The problem rejects two fixed matches on one court that overlap at all, so a
  fractional end followed by a truncated start can overlap by under a millisecond.
## 30. Incremental placement round two

Fields divisible by four now have fixed winner/loser sources in persisted generation-key
order. This supersedes the whole-round generation assumption in sections 25 and 28 for
those fields only. The slot planner and PostgreSQL resolver use the same ordering;
exhaustive outcome tests through 24 entrants compare the final pairings with the batch engine.

`open_ready_placement_round_two` stores source definitions privately and appends only
slots whose two sources are decided. It is live/editor-gated and serializes with the live
writers. Repeated or concurrent calls preserve existing IDs, court assignments and times.
Existing batch-generated round twos are not adopted; odd/crossover generation is unchanged.

A source correction withdraws only its unstarted children. Started children lock their
sources; unrelated sources remain editable. Operator confirmation names the affected
matches and times. Once the event has been drawn the record is final and the refusal names
the knockout draws rather than round two, because a seeding that already used the record
cannot be undone by retracting a feeder child. The automatic reconciler also watches missing
generations, so a lost request after a saved result can heal without a reload or an
unrelated future result.

The scheduling adapter converts decided round-one dependencies into end-plus-rest time
floors. This keeps the dependency when the source is on a previous day and no longer part
of the day's solver problem. Make-up dependencies remain explicit.

Stage progress allows both placement rounds to be current, includes unopened fixed slots
in the round-two total, and shows their winner/loser sources on the Schedule page. The Desk
receives only materialized matches. Knockout seeding and the placement completeness gate
are unchanged. Benchmark and rollout notes: `docs/incremental-placement.md`.

## 31. Order between a match and the one it waits on

`prerequisite_ids` is an ordering rule ("the held entrant's second make-up waits for the first", a
round-two child waits for its sources). Three places can break it, and each is closed.

**What happened (Viet Nam Open 2026, Men's Doubles; `desk_activity`).** The second make-up was
published at 11:35 on court 1; twenty minutes later the first was placed on the same court at 11:50. Every
result after that ran the live reflow, which holds two rules at once - a match may not start before the one
ahead of it on its court ends, and may not start before its prerequisites end - and for this pair they
cannot both be true. Each run pushed the second behind the first, then the first behind the second: a slot
plus the entrant's rest (10 + 5 + 10 = +25 minutes) per result, seven results, 11:50 -> 14:45, until a
rebuild at 11:30 re-ordered the pair. Matches sharing a player with the pair moved in lockstep.

- **Automatic placement (`place-ready`).** A published match is an anchor, and the solver gives a movable
  prerequisite no deadline, so a prerequisite with room only *after* its published dependent was placed
  behind it. The plan now drops any new slot that ends after a published dependent starts, and anything
  waiting on a dropped one, and reports them as `out_of_order` (the Schedule page asks for a rebuild). With
  room before the dependent, the prerequisite is placed there as before.
- **A rebuild** no longer pins a match that still waits on an unplayed one (the near-term freeze kept the
  second make-up at its published time and left the first only the room after it). Unpinned, the pair is
  placed in order.
- **The server (`place_ready_matches`)** re-checks the order in both directions and skips with a reason:
  `prerequisite_unplaced` (a prerequisite holds no time and is not reported; transient, the same pass may
  be placing it), `before_prerequisite` (a prerequisite would end after the start) and `after_dependent`
  (a match already published to wait for this one starts before it ends). Slots are taken earliest first, so
  a prerequisite sent with its dependent is checked in playing order. Void prerequisites do not block, and a
  reported or walkover prerequisite counts as over. Knockouts are ordered by their bracket and not checked.
- **The reflow (`shift_live_schedule_core`)** stops using a prerequisite that is queued *behind* the match
  on the match's own court as a floor. The court keeps its published order, so a pair already out of order
  is left where it is - it no longer amplifies - and `schedule_conflicts` reports it as
  `before_prerequisite` for a rebuild to reorder. A dependent published ahead of its prerequisite on
  *another* court is still pushed behind it. A cycle that runs through three or more matches on different
  courts is not detected.

Verified: the unit cases in `placement-schedule.test.ts` ("place-ready never puts a match after one that
waits on it"), the pins in `db-invariants.test.ts`, and `integration/live-reflow.test.ts` case (k). The two
functions were also run on an embedded Postgres with a minimal schema: the old reflow reproduces the log
above exactly (12:15, 12:40, ... 14:45); the new one leaves the pair at 11:35/11:50 across seven runs.
