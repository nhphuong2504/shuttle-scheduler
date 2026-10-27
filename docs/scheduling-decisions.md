# Scheduling: current contract and reading map

The implementation is shipped. This page is the current entry point; detailed algorithms,
parameters and the evolution of policies are in the linked record. Historical imperative
wording there is not a new task. Later decisions supersede earlier ones, especially closing.

## Current behavior

- The sport-independent core is in `src/lib/scheduling/`; tournament adapters and day planning
  are in `src/lib/tournament/scheduling/`. Greedy seeds the hybrid's incumbent; deterministic
  seeded search may improve it and must not make the objective worse.
- Court occupancy, individual players/rest, breaks, fixed history and explicit dependencies
  constrain eligibility. Category/round ordering is a preference, not a global barrier.
  Keep independent validation and the distinction between placement and legacy formats.
- Planning, placing newly ready matches and live reflow are different operations. Do not
  copy a closing rule from one into another. Initial/automatic placement respects capacity;
  live delays continue beyond closing and produce actionable warnings.
- Reflow preserves the source playing day's scope, courts, order, fixed history, rests,
  prerequisites and breaks. It never silently moves work to another day or extends hours.
- Starts are rounded up to whole minutes; the two-minute publication threshold suppresses
  insignificant moves, except where suppression would create a real published conflict.
- The organiser sees tournament-wide planning/rebuild comparisons. The moderator sees the
  selected day's board. Keep close warnings actionable on Schedule and the landing demo
  consistent with the live policy.

## Read only the details your change needs

| Change | Required record sections |
| --- | --- |
| Core eligibility, ranking, search or metrics | [Algorithm](reference/scheduling-decisions.md#1-core-scheduling-loop) through [non-goals](reference/scheduling-decisions.md#24-non-goals); inspect the specific sections affected |
| Stage order, stability, knockout readiness | [Progression](reference/scheduling-decisions.md#25-stage-progression-and-update-stability), [bracket](reference/scheduling-decisions.md#26-the-full-knockout-bracket-and-what-is-schedulable) |
| Automatic placement / retries | [Newly ready placement](reference/scheduling-decisions.md#27-placing-a-newly-ready-match-without-a-rebuild), [retry/problem reporting](reference/scheduling-decisions.md#32-automatic-placement-that-fails-is-fixed-and-says-so-when-it-cannot-be) |
| Results, on-court modeling or closing | [Result reflow](reference/scheduling-decisions.md#28-scheduling-that-follows-the-results), [on court](reference/scheduling-decisions.md#29-modelling-a-match-that-is-on-court), [current closing policy](reference/scheduling-decisions.md#35-live-delays-continue-past-closing-closing-is-an-actionable-warning) |
| Incremental placement round two | [Round two](reference/scheduling-decisions.md#30-incremental-placement-round-two), plus `incremental-placement.md` and `tournament-format.md` |
| Prerequisite order and time precision | [Order](reference/scheduling-decisions.md#31-order-between-a-match-and-the-one-it-waits-on), [published minutes](reference/scheduling-decisions.md#33-published-times-are-whole-minutes-and-only-a-move-worth-announcing-is-written) |
| Rebuild preview / near-term moves | [Preview contract](reference/scheduling-decisions.md#34-a-rebuild-preview-is-a-comparison-and-it-is-priced-in-matches-the-desk-is-about-to-call) |

Read `tournament-format.md` before changing rules. SQL/RPC changes also require the
current authorization contract and migration operations. Full verification is required;
real local integration covers reflow/guards/publication changes. Core invariant tests,
placement-schedule tests, the landing demo test and benchmark runners have different roles.

## Existing section links

The complete record is preserved. Earlier policy descriptions are historical where a
later section supersedes them; do not reinstate held-at-closing behavior from old prose.

<a id="day-1-group-stage-scheduler-implementation-record"></a> [Day 1 group-stage scheduler: implementation record](reference/scheduling-decisions.md#day-1-group-stage-scheduler-implementation-record)

<a id="1-core-scheduling-loop"></a> [1. Core scheduling loop](reference/scheduling-decisions.md#1-core-scheduling-loop)

<a id="2-fixed-matches"></a> [2. Fixed matches](reference/scheduling-decisions.md#2-fixed-matches)

<a id="3-hard-eligibility-rules"></a> [3. Hard eligibility rules](reference/scheduling-decisions.md#3-hard-eligibility-rules)

<a id="4-round-semantics"></a> [4. Round semantics](reference/scheduling-decisions.md#4-round-semantics)

<a id="5-category-semantics"></a> [5. Category semantics](reference/scheduling-decisions.md#5-category-semantics)

<a id="6-scheduler-state"></a> [6. Scheduler state](reference/scheduling-decisions.md#6-scheduler-state)

<a id="7-stall-handling"></a> [7. Stall handling](reference/scheduling-decisions.md#7-stall-handling)

<a id="8-match-ranking"></a> [8. Match ranking](reference/scheduling-decisions.md#8-match-ranking)

<a id="9-constrained-player-priority"></a> [9. Constrained-player priority](reference/scheduling-decisions.md#9-constrained-player-priority)

<a id="10-waiting-time"></a> [10. Waiting time](reference/scheduling-decisions.md#10-waiting-time)

<a id="11-restricted-candidate-list"></a> [11. Restricted Candidate List](reference/scheduling-decisions.md#11-restricted-candidate-list)

<a id="12-multi-run-search"></a> [12. Multi-run search](reference/scheduling-decisions.md#12-multi-run-search)

<a id="13-independent-validation"></a> [13. Independent validation](reference/scheduling-decisions.md#13-independent-validation)

<a id="14-final-schedule-scoring"></a> [14. Final schedule scoring](reference/scheduling-decisions.md#14-final-schedule-scoring)

<a id="15-court-idle-metric"></a> [15. Court idle metric](reference/scheduling-decisions.md#15-court-idle-metric)

<a id="16-player-waiting-metric"></a> [16. Player waiting metric](reference/scheduling-decisions.md#16-player-waiting-metric)

<a id="17-category-fragmentation"></a> [17. Category fragmentation](reference/scheduling-decisions.md#17-category-fragmentation)

<a id="18-category-order-deviation"></a> [18. Category-order deviation](reference/scheduling-decisions.md#18-category-order-deviation)

<a id="19-tie-breaking"></a> [19. Tie-breaking](reference/scheduling-decisions.md#19-tie-breaking)

<a id="20-diagnostics"></a> [20. Diagnostics](reference/scheduling-decisions.md#20-diagnostics)

<a id="21-debug-trace"></a> [21. Debug trace](reference/scheduling-decisions.md#21-debug-trace)

<a id="22-performance-target"></a> [22. Performance target](reference/scheduling-decisions.md#22-performance-target)

<a id="23-persistence"></a> [23. Persistence](reference/scheduling-decisions.md#23-persistence)

<a id="24-non-goals"></a> [24. Non-goals](reference/scheduling-decisions.md#24-non-goals)

<a id="25-stage-progression-and-update-stability"></a> [25. Stage progression and update stability](reference/scheduling-decisions.md#25-stage-progression-and-update-stability)

<a id="26-the-full-knockout-bracket-and-what-is-schedulable"></a> [26. The full knockout bracket and what is schedulable](reference/scheduling-decisions.md#26-the-full-knockout-bracket-and-what-is-schedulable)

<a id="27-placing-a-newly-ready-match-without-a-rebuild"></a> [27. Placing a newly ready match without a rebuild](reference/scheduling-decisions.md#27-placing-a-newly-ready-match-without-a-rebuild)

<a id="28-scheduling-that-follows-the-results"></a> [28. Scheduling that follows the results](reference/scheduling-decisions.md#28-scheduling-that-follows-the-results)

<a id="29-modelling-a-match-that-is-on-court"></a> [29. Modelling a match that is on court](reference/scheduling-decisions.md#29-modelling-a-match-that-is-on-court)

<a id="30-incremental-placement-round-two"></a> [30. Incremental placement round two](reference/scheduling-decisions.md#30-incremental-placement-round-two)

<a id="31-order-between-a-match-and-the-one-it-waits-on"></a> [31. Order between a match and the one it waits on](reference/scheduling-decisions.md#31-order-between-a-match-and-the-one-it-waits-on)

<a id="311-times-are-stored-in-whole-milliseconds"></a> [31.1 Times are stored in whole milliseconds](reference/scheduling-decisions.md#311-times-are-stored-in-whole-milliseconds)

<a id="32-automatic-placement-that-fails-is-fixed-and-says-so-when-it-cannot-be"></a> [32. Automatic placement that fails is fixed, and says so when it cannot be](reference/scheduling-decisions.md#32-automatic-placement-that-fails-is-fixed-and-says-so-when-it-cannot-be)

<a id="33-published-times-are-whole-minutes-and-only-a-move-worth-announcing-is-written"></a> [33. Published times are whole minutes, and only a move worth announcing is written](reference/scheduling-decisions.md#33-published-times-are-whole-minutes-and-only-a-move-worth-announcing-is-written)

<a id="34-a-rebuild-preview-is-a-comparison-and-it-is-priced-in-matches-the-desk-is-about-to-call"></a> [34. A rebuild preview is a comparison, and it is priced in matches the desk is about to call](reference/scheduling-decisions.md#34-a-rebuild-preview-is-a-comparison-and-it-is-priced-in-matches-the-desk-is-about-to-call)

<a id="35-live-delays-continue-past-closing-closing-is-an-actionable-warning"></a> [35. Live delays continue past closing; closing is an actionable warning](reference/scheduling-decisions.md#35-live-delays-continue-past-closing-closing-is-an-actionable-warning)
