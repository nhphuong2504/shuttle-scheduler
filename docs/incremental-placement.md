# Incremental placement round two

Scope: the existing two-round placement / A-B-C-D format, active fields divisible by
four only. No new format, pairing reseed, optimizer objective or automatic rebuild.
Odd fields and crossover keep their current full-round gate. Existing batch round twos
retain their IDs, results and published times.

## Implementation

- Persist logical slots privately; materialize a placement row only after both source
  winners are decided. Pairing uses the same lexical generation-key order as the old
  database-backed batch path. Exhaustive tests through 24 entrants compare every outcome.
- Shared live-schedule/category locks, unique keys and insert-only resolution make
  duplicate/concurrent requests idempotent. Retries also detect missing generations.
- Source correction/reset retracts unplayed children and times, with operator confirmation;
  started children and knockout generation protect their history. Unrelated sources remain
  editable. Direct placement-table writes are closed; supported operations use RPCs.
- Once the event has been drawn, a placement record is final and the refusal names the
  knockout draws rather than round two: retracting a feeder child would not undo a
  seeding that already used the record. The draw check therefore runs first.
- Completed source dependencies become end-plus-rest floors so they survive day slicing.
- Schedule progress counts unopened slots and shows their sources. Both placement rounds
  may be active together. The Desk only receives actual matches.

## Benchmark

Reproduce (PowerShell):

```powershell
$env:REPLAY_SEEDS = '20'
npx vitest run --config vitest.strategy.config.ts src/lib/tournament/scheduling/placement-feeders.runner.ts
```

Twenty paired seeds per scenario. Every pair is checked to have the same match IDs,
participants and durations; outcomes are attached to match IDs, independent of play order.
The real planner and format builders are used; live SQL reflow is approximated by the
existing replay. The replay checks court/player overlaps. All matches finished in these
runs. Absolute finish includes overnight gaps; wait here is the replay's player gap metric,
not a claim about real attendance or a causal estimate from an observed tournament.

| Scenario | Release | Finish mean, min | Court idle mean, min | Total wait mean, min | Wait p95 mean, min |
| --- | --- | ---: | ---: | ---: | ---: |
| 2 events of 8, 3 courts | Whole round | 269.4 | 57.2 | 1086.1 | 71.9 |
| Same | Fixed feeders | 264.2 | 47.9 | 1058.0 | 72.9 |
| Viet Nam Open field, 4 courts | Whole round | 2219.7 | 559.4 | 43148.7 | 357.2 |
| Same | Fixed feeders | 2205.2 | 592.2 | 43118.9 | 373.0 |
| Viet Nam Open field, 8 courts | Whole round | 1750.1 | 823.7 | 25524.3 | 219.3 |
| Same | Fixed feeders | 1778.8 | 983.1 | 25531.5 | 221.5 |

Early release is an eligibility improvement, not a guarantee that the current placement
heuristic finds a better overall day. It finished about 5 and 15 minutes earlier in the
first two scenarios and about 29 minutes later in the 8-court scenario. The automatic
placement strategy itself never postponed published matches in either mode; that metric
excludes the replay's live reflow. No claim of universally improved waiting or finish is
justified, and no scheduler ranking was changed to manufacture a benchmark win.

## Verification and deployment limits

Run typecheck, the unit/component suite, hermetic Playwright, final Playwright (zero skips)
and build, in repository gate order. `integration/placement-feeders.test.ts` additionally
covers actual RPC authorization, concurrent resolution, legacy preservation, odd/crossover,
void sources, source correction and a start-versus-correction race on local Supabase.

This Windows host has neither Docker nor Podman: `npx supabase start` fails before starting
any database, so the suite runs on CI instead. The integration workflow's first run of this
branch passed all nine `placement-feeders` tests and failed only a stale expectation in
`simulation.test.ts`, which assumed the adaptive round-two wording for a field that now
refuses with the knockout-draw guard once the event has been drawn; that assertion accepts
either message, chooses neither, and now also checks that the refused correction left the
row's winner and status alone. A separate PostgreSQL WASM harness executed the migration
and exercised RPC/trigger/privilege checks with stubbed lifecycle/auth/reflow helpers. It
confirms SQL execution and core transitions but does not replace the real Supabase
integration gate.
The integration CI workflow runs on pull requests touching migrations/integration tests, so
it is the gate this branch relies on; treat a red run there as a real failure, not a flake.

Apply the new migration before the client. No remote migration or deployment is performed
by this implementation. Run full local/CI Supabase integration before releasing it.
Once a category has opened a partial round two, retain a compatible resolver until that
category finishes; an older client assumes round two was created in a single batch.

Verification completed on this branch: typecheck; 1,119 unit/component tests; 211 hermetic
Playwright tests; the final Playwright gate with 211 tests and zero skips; production build.
Independent core review was performed and its findings on direct writes, lock order and
published-time withdrawal confirmation were addressed. Supabase integration runs on CI's
local stack rather than on this host, for the container-runtime reason above. The Windows
shard-plan invocation needs an npx-to-Node CLI mapping; no repository script was changed for
that host-specific issue.
