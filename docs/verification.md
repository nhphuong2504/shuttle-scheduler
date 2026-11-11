# Verification

## Gates and review

The root instructions define the required stages. `npm run verify` and
`npm run agent:verify` use the same implementation and definitions in
`scripts/agent/core.mjs`: typecheck → agent contracts → full Vitest → strict
Playwright/no-skips → production build. Summary mode changes output, not coverage.
High-risk paths require this full bar at every required checkpoint. Unknown paths
default to full checks and local integration. No automatic retries or cached passes.

UI-only iteration may use `npm run typecheck` or an explicit `agent:check --ui-only`
declaration after reviewing that no behavior changes. Feature checkpoints also run relevant
tests. `agent:check` labels its default plan iteration-only; `--stage=checkpoint --run`
executes the checkpoint plan. A phase close uses the full gate even on a clean tree.
Docs/copy/styling need lightweight review. Scheduling, scoring, authorization, SQL and
RPC changes need stronger review explaining what could break and what was checked.
Tests are the floor, not the argument. Every applicable CI check must pass before merge.
`npm run lint` is not a gate yet: formatting is no longer linted, but its remaining findings are unresolved.

## Browser checks

Use the shared hermetic fixture in `e2e/fixtures/app.ts`. A real browser is required
for layout, keyboard/focus, contrast, reflow and hydration. Mocked transport cannot
establish RLS, RPC or transaction correctness. Retain mock escape detection, zero skips,
the deterministic clock, accessibility baseline and anti-vacuity assertions. Do not
re-record an accessibility baseline merely to make a failing check pass.

`test:e2e:final` runs Playwright once with `E2E_REQUIRE_STAFF=1`, then rejects skipped,
empty or result-less reports. Global setup prepares heavy dev routes before parallel
workers; retain the dev build because production omits hydration diagnostics. There are
four local workers and two workers per CI shard, across two runners. After collection
changes run `npm run ci:shard-plan` against a fresh complete report or union of shard
reports. Its fixed setup budget needs CI recalibration for route preparation.

## Local integration

Required for RLS policies, RPC guards/callers and realtime publication membership.
It exercises real Auth, Postgres and Realtime. The guard refuses projects named by
root environment files, including staging. Never work around that guard.

1. Check Docker/Colima and preserve the exact original `integration/.env` privately.
2. Start `npx supabase start`; the tested lean form is
   `npx supabase start -x storage-api,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor`.
   Keep Postgres, Auth, REST, Realtime and mail; never ignore health failures.
3. `npm run integration:target -- local` points suite/app values at the same stack.
4. Run `npm run test:integration` with process timezone `America/Chicago` (the agent
   runner sets this through the child environment on all platforms).
5. Restore the exact original file, or remove it if originally absent. Restoring a
   snapshot named staging is correct only if that was the original target. Stop only
   a stack you started, using its default backup behavior.

The agent runner executes integration only when already configured for loopback.
It never rewrites environment files or starts/stops services. An unsafe/unconfigured
target returns **blocked**, not success. Existing suite guards also compare suite/app
targets; the suite warms cold Realtime before delivery assertions.

The integration CI workflow starts its own local stack, uses demo keys and holds no
credentials. Use it if Docker is unavailable; report missing local evidence explicitly.
Branch protection is managed separately from these files.

## Evidence and interruptions

Browser traces live in `test-results/browser/`, which Playwright may clean on startup.
Its JSON report stays at `test-results/e2e-report.json`. The sibling agent directory
is outside that cleanup. Ignored `test-results/agent/<run-id>/` holds per-step redacted logs and a JSON manifest:
revision, dirty source/config fingerprint, command, timestamps, duration, exit/signal and
artifact paths. Only a completed fresh run is evidence for its recorded snapshot. Results
are never used to skip checks, and the runner keeps only the ten newest run directories. Main typecheck excludes the separate E2E TypeScript backlog;
the maintenance baseline records its eight pre-existing diagnostics.

The runner bounds excerpts, fails fast and forwards catchable interruptions to the child
process tree. SIGKILL/power loss cannot run cleanup: inspect the interrupted manifest and
local services/configuration before resuming. Partial or interrupted checks never pass.

Phase-close scope includes committed branch changes: the runner uses the local merge base
with `origin/main` (or `main`) plus staged/unstaged/untracked changes, without fetching.
Use `--base <existing-ref>` to choose an explicit comparison. If no local main baseline
exists, integration is required conservatively. Committing a change does not remove it
from phase-close risk selection. The manifest records the comparison commit.
