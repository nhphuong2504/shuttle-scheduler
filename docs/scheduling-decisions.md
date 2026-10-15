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
- **The Schedule page** shows "N ready matches have no time yet" with **Place now** (the same pass,
  run on demand, loudly) or "Every ready match has a time". "Update schedule" is renamed **Rebuild
  schedule**. Saving timings, match settings or breaks offers **Review & apply** in the toast instead
  of telling the host to go and find the button.
- **The Desk** lists a ready match with no time at all in its "ready, unassigned" pool (after every
  timed one), so it can still be dispatched while nothing has placed it.
- **What stays manual:** the first build, a rebuild after the day windows, courts or timings change,
  clearing a held overlap, and withdrawals or walkovers, which the placement format does not support
  on the Desk.
