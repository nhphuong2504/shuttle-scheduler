---
name: Estimated tournament finish
overview: Replace the current finish time — which is only the end of the last match that has a slot — with a labelled estimate that always answers "when does this tournament end", covering matches that could not be placed and bracket rounds that do not exist yet. Shown on the Schedule tab, the Build/Rebuild preview, and the Desk.
todos:
  - id: extract-loop
    content: Extract the per-day scheduling loop out of planPlacementSchedule into an internal runSchedule(items, ...) so the estimate can reuse it with extra items instead of duplicating it. Production callers pass no extra items, so behavior is unchanged.
    status: pending
  - id: arithmetic
    content: "Add expected/synthetic round arithmetic to src/lib/tournament/finish-estimate.ts: expected = round===1 ? bracketSize/2 - byes : bracketSize/2**round; synthetic = max(0, expected - existing playable rows in that round)"
    status: pending
  - id: synthetic-items
    content: Build synthetic GraspSchedulableMatch items per missing round with fresh placeholder playerIds and explicit dependsOn on their two feeders, so feeder precedence comes from dependsOn and the round-to-round rest gap from shared placeholders
    status: pending
  - id: estimate
    content: Add estimateFinish() returning { finish, placedFinish, unplacedMatches, uncreatedMatches, deficitMinutes, basis } with basis placed|projected|overflow, mutating no slots, payloads, blocked or draw rows
    status: pending
  - id: wire
    content: Call the estimate from planPlacementSchedule, expose it on PlacementSchedulePlan, and make projectedFinishDeltaMinutes/currentProjectedFinish compare forecast against forecast
    status: pending
  - id: ui
    content: Add one shared FinishEstimate component implementing the honesty rules and use it in the Schedule summary bar, the rebuild preview, and the Desk KPI so the three surfaces cannot invent their own wording
    status: pending
  - id: desk
    content: Extend the Desk projectedFinish KPI (desk.ts, index.tsx) to count the remainder so its on-target/behind label stops comparing a floor against the target
    status: pending
  - id: tests
    content: "Tests: zero placed, all placed (basis placed), blocked/unplaced, future uncreated rounds, partially-created round, sizes 2/4/8/16/32, byes, one-entrant draw, feeder precedence, rest between synthetic rounds, overflow, placedFinish <= finish, and real+synthetic == full playable bracket"
    status: pending
  - id: verify
    content: npx tsc --noEmit, full npx vitest run, ESLint on changed files, live check on /placement-schedule and /, and a deliberately reproduced blocked/overflow case
    status: pending
isProject: false
---

# Always show an estimated tournament finish

## Scheduler behavior, verified

Requirement 2 asked for verification before assuming. Findings, all from reading the source:

**Player rest is enforced through shared player ids.** The run records `playerFreeAt.set(playerId, end + restMs)` after placing a match (`scheduler-grasp.ts:730`), and `isEligible` refuses a court while any of the match's players is still resting (`scheduler-grasp.ts:422`).

**Eligibility** requires, in order (`scheduler-grasp.ts:399`): the match is still remaining, is not `fixed`, is not `playersKnown === false`, and has `playerIds.length > 0`.

**Ordering/dependencies are an explicit mechanism — `dependsOn` — not a side effect of shared players.**

```416:419:src/lib/tournament/scheduler-grasp.ts
  for (const dependencyId of match.dependsOn ?? []) {
    const dependencyEnd = scheduledEnd.get(dependencyId);
    if (dependencyEnd == null || dependencyEnd > currentTime) return false;
  }
```

This confirms the warning in the brief: **shared placeholder `playerIds` on their own do not enforce feeder precedence.** A null `scheduledEnd` entry means the dependency is unscheduled, and the child is refused outright — the one place in the scheduler that treats "not yet scheduled" as hard-blocking rather than deferring.

**Fixed matches do seed `scheduledEnd`**, so a synthetic child may depend on an already-placed match:

```628:628:src/lib/tournament/scheduler-grasp.ts
  const scheduledEnd = new Map(indexes.fixedSlots.map((slot) => [slot.matchId, slot.end]));
```

**A second, separate finding the brief did not anticipate.** The production knockout path does not use GRASP at all:

```565:565:src/lib/tournament/placement-schedule.ts
  const result = scheduleMatches(items as SchedulableMatch[], {
```

And `scheduleMatches` in `scheduler.ts` has **no `dependsOn` support whatsoever** — its loop only reads `playerIds`, `earliestStart`, `order` and `categoryOrder` (`scheduler.ts:199` onward). It cannot model bracket precedence.

### What this means for the design

- Precedence comes from **`dependsOn`** — an existing, production, verifiable mechanism. The plan uses it explicitly; nothing is assumed.
- **Shared placeholder players are used only for the between-rounds rest gap**, which `dependsOn` does not provide: `earliestEligibleTime` adds a dependency's end with no rest (`scheduler-grasp.ts:373`).
- The estimator must run on **GRASP, not `scheduleMatches`**, because only GRASP has `dependsOn`. This makes the knockout forecast an approximation of the production knockout path, which must be documented rather than hidden. It is a forecast-side choice only; production keeps using `scheduleMatches`.
- GRASP takes a single `slotMinutes`, and placement and knockout run at different durations — which is exactly why the planner fills a day in two passes. The estimate therefore runs **one GRASP pass per stage**, mirroring that structure.

## What is wrong today

The finish time is `lastFinishMs`, the maximum end over **placed slots only**.

- **It vanishes.** With nothing placed, `lastFinishMs` is `null` and the "Finishes 23:59" chip disappears entirely.
- **It lies.** A blocked match never moves it, so the chip still reads the official close while matches have nowhere to go.
- **It cannot see the future.** Rounds after the current one do not exist as rows:

```51:51:src/lib/tournament/tier-draw.ts
  /** Round one only. Later rounds are created as results come in. */
  matches: TierBracketMatch[];
```

The Desk has the same floor from a separate calculation, `projectedFinishFromRemaining` in `desk.ts:251`.

## The estimate

Two numbers, no longer conflated:

- `placedFinish` — max end over placed slots. Exact, unchanged, and the floor the estimate can never go below.
- `finish` — the projected end of the whole tournament.

### Synthetic workload, from expected minus existing

Per draw and per round, as specified — not from a count of created rounds, because a later round may be partially created:

```ts
const expected = round === 1 ? bracketSize / 2 - byes : bracketSize / 2 ** round;
const synthetic = Math.max(0, expected - existingPlayableInRound);
```

`existingPlayableInRound` counts rows that are actually played — excluding `is_bye` and `status === "void"`, matching the filter real items already use in `tierItems` (`placement-schedule.ts:416`). Counting bye rows as existing work would double-count against the `- byes` term.

Worked checks from the brief: `bracket_size 16` with R1 8/8, R2 2/4, R3 0/2, R4 0/1 gives `2 + 2 + 1 = 5`; and `bracket_size 8, 6 entrants, 2 byes` gives `2 + 2 + 1 = 5 = entrants - 1`. Guarded: `bracketSize <= 1` yields no rounds, so a champion-only draw contributes nothing.

### Synthetic items and their dependencies

Each synthetic match is a `GraspSchedulableMatch` with:

- `dependsOn: [feederA, feederB]` — the two matches of the round below that feed it. Both real and synthetic feeders are in the batch, so every dependency resolves to something the run will schedule; a dependency on something absent would block the child permanently, per the `== null` rule above.
- `playerIds` sharing one player with each feeder, so `playerFreeAt` enforces the round-to-round rest gap. Fresh placeholders for round-one synthetic matches, so parallel matches in a round do not contend with each other.
- `playersKnown` left `undefined`, and never `false`, since `false` is itself disqualifying.

## Reuse rather than duplication

Requirement 6 asks for the planner's existing items rather than a parallel rebuild. The cleanest way is to extract the per-day loop already inside `planPlacementSchedule` into an internal `runSchedule(items, …)`.

- `planPlacementSchedule` calls it with the real items only — no synthetic items, so its behavior is unchanged.
- The estimator calls it with real items plus synthetic items and reads only the finish and what remained unscheduled.
- Synthetic slots are read for timing and then discarded. They never enter `slots`, `payloads`, `blocked` or `diff`, so nothing can reach the database.

This touches shared code that production depends on, which is the main risk in the plan. The existing 220-test suite covers the planner heavily and is the guard; the extraction is mechanical and must not change behavior when no extra items are passed.

## Overflow, honestly

`deficitMinutes` must not conflate match-minutes with wall-clock minutes. The two cases are kept distinct:

- Work that fits nowhere at all (blocked by precedence, courts or players) — report a **match count**: `Cannot finish in 2 days · 4 matches still need capacity`.
- Work that only fits by overrunning the final day's close — report **wall-clock extension** of the final day, which the run already computes as `overrunMinutes` because `hardEnd` is suppressed for the last day: `Needs ~40 min beyond the tournament window · estimated finish ~02:10 if courts stay available`.

## The three bases

- `"placed"` — nothing forecast. `finish === placedFinish`. Reads `Finishes 01:30`.
- `"projected"` — forecast work exists but all of it fits inside the windows. Reads `Estimated finish ~01:45 · 7 matches still to place`.
- `"overflow"` — something does not fit, or fits only past the final close. `finish` is not presented as the official finish.

During a rebuild, `currentProjectedFinish` and the new estimate must both be forecasts, so `projectedFinishDeltaMinutes` never compares an estimate against a floor (requirement 9).

## Changes by file

- New `src/lib/tournament/finish-estimate.ts` — `roundWorkload` arithmetic, the synthetic-item builder, and `estimateFinish()` returning `{ finish, placedFinish, unplacedMatches, uncreatedMatches, deficitMinutes, basis }`. Pure: no writes, no persistence.
- `src/lib/tournament/placement-schedule.ts` — extract `runSchedule`; call the estimate; add the fields to `PlacementSchedulePlan` beside `summary`; keep `lastFinishMs` as `placedFinish`; fix the rebuild comparison to forecast-against-forecast.
- New shared component (alongside the existing tournament components) — one `<FinishEstimate estimate={…} />` implementing the wording rules, used by all three surfaces.
- `src/routes/placement-schedule.tsx` — summary chip (~line 778) and the rebuild preview's "Projected finish" (~line 1199) both render the shared component.
- `src/lib/tournament/desk.ts` — count the remainder so the KPI is not a floor.
- `src/routes/index.tsx` — pass the remainder and `tierDraws` (already fetched there, already carrying `bracket_size`) into the KPI call at ~line 313.
- New `src/lib/tournament/finish-estimate.test.ts`.

## Out of scope

- The legacy round-robin `/schedule` page — not in `NAV`, untouched unless compilation requires it.
- Creating or persisting future rounds. A real Build still creates rounds only as results arrive.
- Any change to `scheduleMatches`, GRASP or the planner's placement decisions.

## Risks

- **Optimism, disclosed in the UI.** The forecast assumes perfect flow: no overruns, no re-shuffles, no desk intervention. It is a forecast and the copy must say so.
- **The knockout forecast uses GRASP, production does not.** GRASP respects `dependsOn` and rest; `scheduleMatches` is a simpler greedy pass. The estimate can therefore differ from a real knockout build. Documented in the module, not silently assumed.
- **Refactoring the shared loop.** Largest risk; mitigated by the existing planner test suite and by passing no extra items on the production path.
- **Heuristic non-determinism.** GRASP is seeded and runs multiple restarts; the estimate must pass a fixed `seed` so the same schedule does not report a different finish on each render.

## Verification

- `npx tsc --noEmit`; full `npx vitest run`; ESLint on changed files.
- Tests as enumerated in the todos, including the two worked examples from the brief, feeder precedence (no synthetic child round may start before its feeders end), and rest between synthetic rounds.
- Live check on `/placement-schedule` and `/`, plus a deliberately reproduced blocked/overflow case — the current live tournament (66 matches, 2 days, nothing blocked) exercises only the clean path.
- Final report to cover: the estimation model, how synthetic precedence is enforced, how partially-created rounds are counted, what overflow means and how it renders, files changed, tests added, check status, and an explicit statement that production scheduling behavior is unchanged.
