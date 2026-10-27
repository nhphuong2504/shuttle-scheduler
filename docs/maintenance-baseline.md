# Maintenance baseline and registration extraction

Recorded on 2026-10-27. This is the first checkpoint of the code/test maintenance work,
not a proposal to rewrite the application. Line counts include comments and blank lines;
they locate concentrations of responsibility and are not measures of code quality.

## Before the change

| Area | Files | Lines | Notes |
| --- | ---: | ---: | --- |
| Application source | 180 | 46,789 | Excludes tests, test helpers/fixtures and dedicated type/generated files; includes benchmark tooling |
| Vitest tests in `src` | 68 | 20,104 | 1,328 executed test cases |
| Source test helpers/fixtures | 5 | 1,577 | Separate from production source |
| Dedicated type/generated files | 6 | 3,050 | Not manual cleanup targets |
| Browser suite and fixtures | 22 | 8,731 | 13 spec files; 235 executed cases in the existing report |
| Integration suite and helpers | 17 | 7,151 | 15 test files; real local backend |
| Applied SQL migrations | 73 | 32,429 | Deployment history; do not edit or delete to reduce LOC |

The first isolated Vitest measurement during the audit passed all 1,328 tests in 68 files
in about 11.2 seconds (JSON report elapsed from start to last file end). The existing
Playwright report, timestamped `2026-10-27T04:52:26.130Z`, recorded 235 passes, zero skips,
zero failures and 388,995 ms elapsed with four workers. That browser result is historical,
not a fresh before/after benchmark on an otherwise idle machine.

An additional baseline attempt overlapped Docker startup, Vitest and Chromium. Vitest
reported 1,327/1,328 passes, including a failure in the hybrid solver monotonicity test;
the browser measurement was deliberately interrupted. Those runs are not evidence of a
speed improvement or a clean baseline. Run the final gates sequentially. There was no
fresh pre-change integration timing, so an after-change integration duration has no
comparable before measurement.

The historical browser report's largest accumulated test durations were:

| Spec | Cases | Sum of case durations |
| --- | ---: | ---: |
| `staff-surfaces.spec.ts` | 32 | 349.9 s |
| `public-surfaces.spec.ts` | 57 | 337.2 s |
| `route-sweep.spec.ts` | 34 | 181.8 s |
| `states.spec.ts` | 18 | 132.0 s |
| `access.spec.ts` | 28 | 127.6 s |

These are sums across parallel workers, not wall times. The first two account for about
48% of accumulated case time; inspect setup and assertions there before changing worker
or shard counts. The route sweep already shares one page load across multiple probes.

## Responsibility and dependency map

Before extraction, `data.ts` had 1,581 lines and 39 non-test source files importing its
absolute alias. `actions.ts` had 1,590 lines and 20 such consumers. These counts omit
relative imports and measure files, not individual imported symbols.

| Module | Responsibilities before this change | Boundary after this change |
| --- | --- | --- |
| `data.ts` | Tournament context/types, query keys, discovery, roster, matches, registration, realtime | Registration reads/models/cache bases move out; existing non-registration responsibilities remain |
| `actions.ts` | Tournament configuration, lifecycle, legacy scoring/scheduling, membership, registration | Registration writes move out; existing non-registration responsibilities remain |
| `registration.ts` | Pure payload, capacity and review-queue models | Also owns the pure participant request model/fold |
| `registration/participant.ts` | Previously in both shared modules | Own-request read, submit and withdrawal |
| `registration/review.ts` | Previously in both shared modules | Operator queue, pending request counts and decision |
| `registration/window.ts` | Previously in both shared modules | Public registration-state read and operator window writer |
| `registration/keys.ts` | Previously in shared `keys` | Existing registration cache identities |

All in-repository consumers import the owning module directly; there are no compatibility
re-exports in `data.ts` or `actions.ts`. RPC names, payloads, cache key values, query enablement,
error messages and mutation invalidation breadth are unchanged. The modules do not import
runtime values from `data.ts` or `actions.ts`; the pure model's category/team dependencies
are type-only. Participant approval still grants no operating authority.

The remaining large UI modules are deliberately outside this checkpoint:
`placement-scheduler.tsx` (2,587 lines), `desk.tsx` (2,194), and `app-shell.tsx` (1,471).
Moving files alone will not reduce the complexity of those orchestration paths.

## Test inventory by responsibility

| Layer | Existing groups | Owns | Does not prove |
| --- | --- | --- | --- |
| Pure Vitest | Scheduling/core/placement/scoring, registration models, format and presentation helpers | Input/output rules, deterministic invariants and serialization | Postgres execution, actual privileges or browser layout |
| Component Vitest | Setup steps, pickers, rebuild preview, call-next, decision pills | Rendered controls, accessible names, local interactions | Browser contrast/reflow, RLS |
| Static guards | `security/secrets.test.ts`, scheduling import guards in `boundary.test.ts` | Secret exclusion and dependency boundaries | Runtime correctness |
| Source/SQL assertions | `routes/-surfaces.test.ts`, `db-invariants.test.ts`; portions of day-scope/stage-progress tests | Implementation structure and migration text | Executed current schema or all rendered branches |
| Browser journeys | `public-surfaces`, `staff-surfaces`, `access`, `routing`, `call-next`, `score-entry`, `schedule-formats`, `schedule-conflicts` | Reachable screens, user acts, rendered state with mocked transport | Server authorization or transaction atomicity |
| Browser probes | `route-sweep`, `a11y`, `criteria`, `states`, `hydration` | Real layout, keyboard/focus, contrast, responsive and hydration behavior | Real backend writes/realtime |
| Local integration | Authorization, registration, lifecycle, realtime, scheduling/reflow, conflicts and simulation test files under `integration/` | Real Postgres/Auth/RLS/RPC transactions and Realtime | Complete rendered browser journeys |
| Benchmark/replay | Separate benchmark and strategy runner configs | Quality/performance comparisons | Ordinary regression gate correctness |

Source-reading tests were found in six Vitest files before this change. That does not mean
all tests in those files are static or redundant. Keep security/import guards. Convert
source assertions in bounded groups only after mapping every removed property to behavior.
Do not remove the accessibility probes or substitute mocked browser tests for backend tests.

## First conversion: registration submission behavior

Three tests in the registration section of `db-invariants.test.ts` previously pinned SQL
implementation details. They are replaced by the following local integration coverage.
Other schema, privilege, identity-link, migration verification and grant assertions remain.

| Removed source test | Runtime evidence in `integration/registration.test.ts` |
| --- | --- |
| `makes a rejection re-appliable, and moves the arbiter with the index` | `makes a rejection re-appliable, and shows the participant what was decided`: new id after rejection, own read prefers live request, reviewer sees both |
| `files the entries, and replaces them rather than accumulating on a retry` | Empty/non-array refusal; submission/retry test checks same id, replacement rather than accumulation, supplied partner data, singles strips partner fields, no competition data created, and rejected replacement rolls back; approved replacement refusal preserves entries |
| `refuses each entry mistake with the sentence that names it` | Unknown/repeated event, foreign/inactive event, per-player cap, missing/self partner tests; singles partner stripping is exercised in the submission/retry test |

The registration action tests move with their implementation instead of remaining in the
shared action suite. New hook tests exercise disabled reads, tournament cache separation,
public state normalization, participant-only reads, queue/badge request coalescing and
refresh through the existing invalidation prefix. Pure participant-model tests cover absent
requests, empty entry lists, entry order, decision notes and unknown decision fallback.

## Gates and risk

`npm run verify` is the phase-close command:

1. Typecheck.
2. Full Vitest suite.
3. One `test:e2e:final` run, including the no-skips guard.
4. Production build.

The ordinary `test:e2e` command remains for focused iteration. Removing its duplicate full
run from phase close saves one complete browser execution by construction; elapsed-time
savings depend on the machine. No test suite, accessibility assertion, retry limit or
worker/shard count is relaxed. CI uses the same strict wrapper once per shard.

The integration workflow now also watches application RPC callers, registration modules
and auth/realtime plumbing. A successful real-backend run is required by repository policy
for those changes; GitHub branch-protection settings are not changed by this checkout.
The integration environment must point at the local stack and must be restored afterwards.

What could break in this extraction: a missed consumer import, a changed cache prefix,
a read accidentally enabled for the wrong surface, a lost RPC payload field or error,
or a duplicate fetch for the queue badge. Typecheck, action/model/hook tests, browser
journeys and the local integration run address different parts of those risks. No SQL,
RLS policy, authorization predicate, scoring or scheduling algorithm is modified.

## Next checkpoint

Use the registration extraction as the pattern for later modules, then split Desk and
Schedule orchestration in separate PRs. Legacy round-robin support remains a product
decision. Existing applied migrations and generated files remain intact. Re-measure each
suite separately on the same machine before making further speed claims.

## Verification at this checkpoint

- Local integration: **156/156 passed**, zero pending, 15 files, about **58.3 s** elapsed.
  Registration contributes 21 passing cases, including the new approved-replacement case.
- First sequential Vitest checkpoint: **1,337/1,337 passed**, 70 files, **11.62 s** runner duration.
  The count grows because behavioral coverage was added; reducing test count is not the goal.
- The extracted function bodies also match the original TypeScript tokens, allowing only
  formatting and the registration cache helper names to differ.
- The first sequential browser run completed 235 cases in **512.2 s**: 233 passed,
  two Schedule cases timed out, zero skips. The build correctly did not run after that failure.
- Those failures exposed an existing unstable empty-day fallback in `useTournamentScope`:
  while data is pending, each render returned a different empty array. Schedule effects
  reset derived state on that reference change and could enter a render loop. The fallback
  is now memoized per hook. A new hook regression test fails against the old implementation
  and passes after the fix; another checks that real days replace the fallback on arrival.
  No scheduling rule or solver is changed.
- The next browser attempt exposed a separate 60-second aggregate timeout in the viewer
  test that navigated Entries, Schedule and Scores. It was interrupted after the failure.
  The three page assertions now run as separate cases with their own failure locations;
  every original assertion, network wait and timeout setting is retained. This adds two
  cases (237 total) without adding navigations or reducing permission coverage.
- A cold single-page Schedule attempt still timed out after the split. Its trace records
  **42.9 s for the initial HTML response**, before mocked backend reads began. Listening
  on the dev port was not sufficient readiness for parallel cold route transforms.
  `e2e/global-setup.ts` now prepares Schedule, Desk and Settings sequentially in a disposable
  hermetic browser before workers start. Both SSR and client modules are compiled there;
  every test still uses its own fresh page/fixtures. Preparation failures and unmocked
  requests fail the run. Test timeouts, retry count and shard/worker settings are unchanged.
- Three hybrid-solver aggregate sweeps also exceeded their shared 5-second case budget
  under contention. They now use `it.each` per fixture/shape. All seeds, run counts and
  metric comparisons are retained; no timeout is raised. This exposes 45 additional named
  cases without adding solver work.

Final `npm run verify` completed successfully on the resulting application and test code:

| Gate | Result |
| --- | --- |
| Main TypeScript check | Passed |
| Vitest | **1,384 passed**, 71 files, **10.43 s** runner duration |
| Strict Playwright | **237 passed**, **0 skipped**, **0 flaky**, **0 unexpected**, **505.9 s** including run preparation |
| No-skips report guard | Passed for all 237 cases |
| Production build | Passed |

The final browser log contains no `Maximum update depth` warning. The browser elapsed time
is not a controlled speed comparison with the historical 389-second report; machine load,
preparation and case granularity differ. The phase-close saving is one eliminated duplicate
full browser execution, rather than a claimed percentage improvement in the suite itself.

Shared-module sizes are now `data.ts`: **1,581 → 1,381 lines**, and `actions.ts`:
**1,590 → 1,487 lines**. This reduces their responsibilities, not total application LOC by
that amount: the extracted behavior lives in the smaller registration modules.

The shard plan was refreshed against all 237 recorded cases, with no unmatched durations.
Its two-shard work split is about 18.0/14.6 accumulated minutes (81% evenness). Keep two
shards: the estimate's old 54-second setup allowance needs CI recalibration for the new
route preparation. The script warns about that limitation; its wall/billed projections
are not new CI measurements.

An additional, non-gate check, `npx tsc --noEmit -p e2e/tsconfig.json`, reports **eight
pre-existing diagnostics** in `fixtures/app-mock.ts`, `public-surfaces.spec.ts` and
`schedule-formats.spec.ts`. A compiler run using HEAD versions of changed tracked sources
and the original tracked root files reports the same eight file/code diagnostics. No new
diagnostic is introduced; this backlog remains separate from the passing main typecheck.

The first full local-stack startup timed out on auxiliary service health checks while
competing with Chromium. The successful run excluded Studio, metadata, storage/image,
Edge Runtime, analytics/vector and pooler containers, which the suite does not use;
Postgres, Auth, REST, Realtime and mail remained enabled. No health check was bypassed.
After the run, the exact original integration environment was restored and the local stack
was stopped with its default backup behavior.
