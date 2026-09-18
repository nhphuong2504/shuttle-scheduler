---
name: Estimated tournament finish
overview: >-
  Always answer "when does this tournament finish" without changing what the real
  planner places and without creating or persisting any future bracket rounds. Keep
  placedFinish as the floor (max end over placed slots) and add a separate forecast
  that folds in unplaced/blocked matches, existing matches, and inevitable-but-uncreated
  knockout rounds, produced by one pure read-only estimator that reuses the real
  scheduling primitives and never writes.
todos:
  - id: grasp-verify
    content: >-
      Re-confirm in scheduleGroupStageGrasp how player rest, match eligibility and
      ordering/dependencies are enforced (dependsOn is precedence; shared placeholder
      playerIds are rest only), and record the finding in the estimator module docstring
      before writing synthetic items.
    status: pending
  - id: module
    content: >-
      Add src/lib/tournament/finish-estimate.ts (pure/read-only). roundWorkload():
      expected = round===1 ? bracketSize/2 - byes : bracketSize/2**round; synthetic =
      max(0, expected - existingPlayableInRound). Synthetic-item builder. estimateFinish()
      returning { finish, placedFinish, unplacedMatches, uncreatedMatches, deficitMinutes,
      basis }. Must not mutate slots, payloads, blocked, draw rows or DB state.
    status: pending
  - id: reuse
    content: >-
      Reuse the planner's own scheduling: extract the per-day loop into a shared
      runPlanDays() (or reuse scheduleGroupStageGrasp directly via the existing
      runStageForDay) so the estimator runs the same constraints with real+synthetic
      items. Production passes no synthetic items and keeps scheduleMatches for its
      knockout pass, so its behavior is unchanged. If extraction cannot be proven
      behavior-preserving, fall back to an estimator-only sweep.
    status: pending
  - id: dependencies
    content: >-
      Enforce feeder precedence with dependsOn only. Copy real knockout rows and add a
      dependsOn derived from parent_a_id/parent_b_id when the parent is in the batch; never
      mutate the originals. Round-one synthetics get fresh placeholders; a later synthetic
      shares one placeholder with each feeder so playerFreeAt gives the between-rounds rest
      gap. Never rely on shared placeholders for precedence.
    status: pending
  - id: wire
    content: >-
      Call the estimator from planPlacementSchedule, surface existing unplaced items from
      its own todo sets (not a rebuild), add an estimate field to PlacementSchedulePlan
      beside summary, and make currentProjectedFinish/projectedFinishDeltaMinutes compare
      forecast against forecast (never placedFinish against a forecast). Add FinishEstimate
      to the planner output and summary shape (legacy planDay keeps its current semantics).
    status: pending
  - id: ui
    content: >-
      Add one shared FinishEstimate component/formatter implementing the honesty rules and
      use it in the /placement-schedule summary bar, the rebuild preview, and the Desk KPI
      so the three surfaces cannot invent their own wording.
    status: pending
  - id: desk
    content: >-
      Extend the Desk projected-finish KPI (desk.ts, index.tsx) to count the remainder so
      its on-target/behind label stops comparing a floor against the target.
    status: pending
  - id: tests
    content: >-
      Tests: zero placed (estimate still exists), everything placed (basis placed, finish
      === placedFinish), existing blocked/unplaced match, future uncreated rounds,
      partially-created later round, sizes 2/4/8/16/32, byes, one-entrant draw, feeder
      precedence, rest between synthetic rounds, overflow, placedFinish <= finish,
      real+synthetic == complete playable bracket.
    status: pending
  - id: verify
    content: >-
      npx tsc --noEmit, full npx vitest run, ESLint on changed files, live check on
      /placement-schedule and /, and a deliberately reproduced blocked/overflow case.
    status: pending
  - id: report
    content: >-
      Report the exact estimation model, how synthetic feeder dependencies are enforced,
      how partially-created rounds are counted, what overflow means and how it renders,
      files changed, tests added, full test/typecheck/lint status, and whether any
      production scheduling behavior changed.
    status: pending
isProject: false
---

# Always answer "when does this tournament finish?"

## Goal and guardrails

The question the UI must always be able to answer is **"when is this tournament expected to
finish?"** Two rules frame every decision below:

- **The real planner is unchanged.** Production still places only matches that exist, and a real
  Build still creates knockout rounds only as results arrive. No synthetic round is ever created
  or persisted for the estimate.
- **The floor and the forecast are separate numbers.** `placedFinish` stays the exact maximum end
  over actually placed slots. A new `finish` forecasts the whole tournament and includes
  (a) placed matches, (b) existing but unplaced/blocked matches, and (c) inevitable knockout
  matches that have not been created yet.

## Scheduler behavior, verified (do this before writing synthetic items)

All findings are read from `src/lib/tournament/scheduler-grasp.ts`; they are the reason the
design below does not assume anything.

- **Player rest is `playerFreeAt`.** A placed match records
  `playerFreeAt.set(playerId, end + restMs)` (line 730) and `isEligible` refuses a court while any
  of the match's players is still resting (line 423).
- **Eligibility** requires, in order (lines 399–409): the match is still remaining, is not `fixed`,
  is not `playersKnown === false`, and has `playerIds.length > 0`.
- **Ordering/dependencies are an explicit mechanism — `dependsOn` — not a side effect of shared
  players.**

```ts
for (const dependencyId of match.dependsOn ?? []) {
  const dependencyEnd = scheduledEnd.get(dependencyId);
  if (dependencyEnd == null || dependencyEnd > currentTime) return false;
}
```

  A dependency that is absent from `scheduledEnd` blocks the child outright; it does not defer.
  `earliestEligibleTime` also uses a dependency's end but adds **no** rest gap (line 373), so
  `dependsOn` alone does not provide the between-rounds rest.

- **Shared placeholder `playerIds` on their own do NOT enforce feeder precedence.** They only
  contribute rest. A Final could still be chosen before its Semifinals if precedence rested on
  shared ids. Precedence must come from `dependsOn`; shared placeholders are used *only* for rest.
- **Fixed matches seed `scheduledEnd`** (line 628), so a synthetic child may depend on an
  already-placed real match.
- **The production knockout path does not use GRASP.** `runStageForDay` calls `scheduleMatches`
  from `scheduler.ts` for the knockout pass, and `scheduleMatches` has no `dependsOn` support. Real
  knockout rows get their only ordering from `earliestStart` computed from *finished* parents
  (`tierItems`), which is why production can never place a later round early — later rounds do not
  exist. The estimate must therefore run the **GRASP** scheduler for its knockout forecast, which
  makes the forecast an approximation of production (documented, not hidden).
- **The last day is unbounded.** `hardEnd` is suppressed for the last day that has courts
  (`placement-schedule.ts:776`), which is exactly where a tournament overrun belongs and where the
  estimator's "extend the final day" answer comes from.
- **There is no `byes` column** on `tier_draws` (`types.ts:930-940`). Derive
  `byes = bracket_size - entrant_count`.

## Deliverable: one pure/read-only module

New `src/lib/tournament/finish-estimate.ts`. It must not mutate slots, payloads, `blocked`, draw
rows, or any database state, and must make no network/RPC calls.

### Result shape

```ts
export interface FinishEstimate {
  /** Projected end of the whole tournament, or null when no finish can be named. */
  finish: string | null;
  /** Max end over actually placed slots. The floor; never below it. */
  placedFinish: string | null;
  /** Existing matches that have players but no slot (real work still to place). */
  unplacedMatches: number;
  /** Inevitable knockout matches that do not exist as rows yet. */
  uncreatedMatches: number;
  /** Wall-clock minutes past the final close, only when the work fits by extending. */
  deficitMinutes: number | null;
  basis: "placed" | "projected" | "overflow";
  /** Optional, for wording only: remaining = unplacedMatches + uncreatedMatches. */
  remainingMatches?: number;
  /** Optional, for wording only: configured day count, for "Cannot finish in N days". */
  days?: number;
}
```

`deficitMinutes` is **wall-clock extension of the final day only**. Never put total
match/court-minutes in it: when only unscheduled workload is known, report the match count
(`unplacedMatches` + `uncreatedMatches`) instead, labelled as matches.

## Round arithmetic (expected minus existing, never `playedRounds`)

Per draw and per round:

```ts
const expected = round === 1 ? bracketSize / 2 - byes : bracketSize / 2 ** round;
const synthetic = Math.max(0, expected - existingPlayableInRound);
```

`existingPlayableInRound` counts rows that are actually playable, excluding `is_bye` and
`status === "void"` — the same filter `tierItems` already uses. Counting bye rows as existing work
would double-count against the `- byes` term. Because a later round can be partially created, this
counts rows, not created rounds, and clamps at zero.

Must handle, and be tested for:

- bracket sizes **2 / 4 / 8 / 16 / 32** (round count `log2(bracketSize)`);
- **byes** (`bracket_size - entrant_count`) subtracted in round 1 only;
- **partially created later rounds** (e.g. 16: R1 8/8, R2 2/4, R3 0/2, R4 0/1 → 2 + 2 + 1 = 5);
- **a one-entrant / champion-only draw** (`bracketSize <= 1` or `championId` set → zero rounds,
  zero synthetic);
- bye sanity: 8 bracket, 6 entrants, 2 byes → R1 2 + R2 2 + R3 1 = 5 = entrants − 1.

## Synthetic items and feeder precedence

For each draw, index existing knockout rows by `(round, slot)` and walk rounds 1..R:

1. If a real row exists at `(round, slot)`, use its id as the feeder for the next round and keep
   its real `parent_a_id`/`parent_b_id` relationship.
2. Otherwise create a synthetic `GraspSchedulableMatch` (id namespaced, e.g.
   `est:<drawId>:<round>:<slot>`) whose **`dependsOn` is the two feeders for that slot**, i.e. the
   ids at `(round-1, 2*slot-1)` and `(round-1, 2*slot)`, real or synthetic. Precedence is enforced
   solely by `dependsOn`, so no child can be placed before its feeders end.
3. **Real knockout rows are copied** and given a `dependsOn` derived from
   `parent_a_id`/`parent_b_id` when the parent is in the batch. The originals are never mutated;
   without this, a real Semifinal could be placed before a real Quarterfinal because production
   ordering lives in `earliestStart`, not `dependsOn`.
4. Synthetic `playerIds`: round-one synthetics get fresh placeholder pairs so parallel matches do
   not contend; a later synthetic **shares one placeholder with each feeder**, so `playerFreeAt`
   adds the round-to-round rest gap. Shared placeholders are never the precedence mechanism.
5. `playersKnown` stays `undefined` (never `false`, which is itself disqualifying), and
   `earliestStart` is left unset so the run's own constraints decide the clock.

Synthetic placement-stage items are **not** created: the placement format's round two is
out of scope for the estimate (its size is not a bracket) and no other stage has uncreated rounds.

## Reuse rather than duplication

- The estimator consumes the planner's **own** items and todo sets (`placementAll`, `knockoutAll`,
  `placementTodo`, `knockoutTodo`, fixed set, days, courts, breaks, options). It does not rebuild
  them, and it surfaces unplaced work from the planner's leftovers rather than recomputing it.
- It runs the same real constraints — court availability, match duration, player/rest constraints,
  knockout rest, feeder dependencies, tournament-day windows, breaks — by reusing
  `scheduleGroupStageGrasp` via the existing `runStageForDay` primitive.
- Preferred wiring: extract the per-day loop out of `planPlacementSchedule` into an internal
  `runPlanDays(...)` used by both callers. Production passes only real items and keeps
  `scheduleMatches` for the knockout pass; the estimator passes real + synthetic items and selects
  GRASP for the knockout pass so `dependsOn` is honoured. The existing planner test suite is the
  guard that production behavior is unchanged.
- If that extraction cannot be shown to be behavior-preserving, do **not** force it: implement the
  smallest estimator-only day sweep that calls the same `scheduleGroupStageGrasp` primitive, and
  leave the production loop untouched.
- Synthetic slots are read for timing and then discarded. They never enter `slots`, payloads,
  `diff` or `blocked`, so nothing synthetic can reach the database.
- Use a fixed `seed` and a bounded `graspRuns` so the same state does not report a different finish
  on every render.

## Three bases and overflow, honestly

- **`"placed"`** — nothing forecast. `finish === placedFinish`. Reads `Finishes 01:30`.
- **`"projected"`** — forecast work exists and all of it fits inside the windows. Reads
  `Estimated finish ~01:45 · 7 matches still to place` (remaining = unplaced + uncreated).
- **`"overflow"`** — work exists that the configured windows cannot contain. The official close is
  never presented as the finish. Two rendered cases:
  - everything can be placed but only past the final close → report the **wall-clock extension**:
    `Needs ~40 min beyond the tournament window` and
    `Estimated finish ~02:10 if courts remain available` (`deficitMinutes` set).
  - something still cannot be placed even with the final day extended → do **not** name a finish;
    report the **match count**: `Cannot finish in 2 days · 4 matches still need capacity`
    (`finish === null`, `deficitMinutes === null`).

## One shared UI component

Add a single `<FinishEstimate estimate={…} />` (plus its formatter) that owns every wording rule
above, and use it in all three surfaces:

- `/placement-schedule` summary bar (replaces the bare `Finishes …` chip and the
  `projectedFinishDeltaMinutes` span),
- the rebuild preview's "Projected finish" block,
- the Desk / dashboard finish KPI.

The three surfaces must not independently invent wording.

## Rebuild comparison: forecast against forecast

- Add the estimate to `PlacementSchedulePlan` beside `summary`; keep `lastFinishMs` as
  `placedFinish`.
- Compute `currentProjectedFinish` and `projectedFinishDeltaMinutes` from the **same estimator and
  the same semantics** on both sides: the current DB state's forecast vs the rebuilt plan's
  forecast. Never compare a forecast on one side with `placedFinish` on the other.
- The shared `ScheduleSummary` is also used by the legacy `planDay`; add fields additively so the
  legacy path keeps its current meaning, and have the placement route read the estimate instead.

## Changes by file

- **New** `src/lib/tournament/finish-estimate.ts` — `roundWorkload`, the synthetic-item builder,
  and `estimateFinish()`; pure, read-only, no persistence.
- `src/lib/tournament/placement-schedule.ts` — reuse/extract the day loop, parameterize the
  knockout scheduler for the estimator, call the estimator with the planner's items and todo sets,
  surface the estimate on `PlacementSchedulePlan`, and make the rebuild delta forecast-vs-forecast.
- **New** shared `FinishEstimate` component (alongside the existing tournament components).
- `src/routes/placement-schedule.tsx` — render the shared component in the summary bar and rebuild
  preview.
- `src/lib/tournament/desk.ts` — count the remainder so the KPI is not a floor.
- `src/routes/index.tsx` — pass the remainder and `tierDraws` (already fetched, already carrying
  `bracket_size`/`entrant_count`) into the KPI call.
- **New** `src/lib/tournament/finish-estimate.test.ts`.

## Out of scope

- The legacy round-robin `/schedule` page and `planDay` — untouched unless compilation or shared
  types require it.
- Creating or persisting future rounds. A real Build still creates rounds only as results arrive.
- Any change to `scheduleMatches`, GRASP, or the planner's placement decisions.

## Risks

- **Optimism, disclosed in the UI.** The forecast assumes perfect flow: no overruns, no
  re-shuffles, no desk intervention. The copy must say it is an estimate.
- **The knockout forecast uses GRASP, production does not.** `scheduleMatches` is a simpler greedy
  pass with no `dependsOn`; the estimate can therefore differ from a real knockout build.
  Documented in the module.
- **Adding `dependsOn` to real knockout copies.** This is estimator-only and must never touch the
  item objects production uses.
- **Refactoring the shared day loop.** Largest risk; mitigated by the existing planner suite and by
  passing no synthetic items on the production path, with the standalone fallback above.
- **Heuristic non-determinism.** Pass a fixed seed and bounded run count.

## Tests (at least)

- zero placed matches: the estimate still exists;
- everything placed: `basis === "placed"` and `finish` equals `placedFinish`;
- an existing blocked/unplaced match is counted and forecast;
- future uncreated rounds are counted;
- a partially-created later round is counted from rows, not rounds;
- bracket sizes 2 / 4 / 8 / 16 / 32;
- byes;
- a one-entrant draw;
- feeder precedence: no synthetic child round may occur before its feeder matches end;
- rest between synthetic rounds;
- overflow;
- `placedFinish <= finish` whenever a clock-time forecast exists;
- `expected real + synthetic` equals the complete playable bracket size;
- the worked partial state (16: 8/8, 2/4, 0/2, 0/1 → synthetic 5) and the bye sanity state
  (8: 6 entrants, 2 byes → 5 = entrants − 1).

## Verification and final report

- `npx tsc --noEmit`; full `npx vitest run`; ESLint on changed files.
- Live check on `/placement-schedule` and `/`, plus a deliberately reproduced blocked/overflow
  case — the current live tournament (66 matches, 2 days, nothing blocked) exercises only the
  clean path.
- Final report: the exact estimation model implemented; how synthetic feeder dependencies are
  enforced; how partially-created rounds are counted; what overflow means and how it is displayed;
  files changed; tests added; full test/typecheck/lint status; and an explicit statement of whether
  any production scheduling behavior changed.
