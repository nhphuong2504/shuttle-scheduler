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

Recommended priority order:

1. constrained-player pressure,
2. waiting time,
3. earlier round,
4. pool/category completion pressure,
5. preferred category order.

Keep each component observable for debugging.

## 9. Constrained-player priority

For each player, track interpretable factors:

```text
remainingMatches
remainingCategoryCount
futureConflictDegree
fixedWindowPressure
```

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

Compare complete valid schedules using a weighted final score.

Use normalized minute-based values.

Strongly prioritize:

1. zero unscheduled matches,
2. minimal after-cutoff time,
3. earlier projected finish,
4. lower court idle time,
5. lower excessive player waiting,
6. lower category fragmentation,
7. lower category-order deviation.

A complete schedule slightly after the cutoff must beat an incomplete schedule that finishes before the cutoff.

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