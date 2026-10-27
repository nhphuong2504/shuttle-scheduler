# Agent workflow

## Start and find context

Use Node from `.nvmrc`, the npm lockfile and `git status --short`. Preserve existing work.

```sh
npm run agent:context -- src/lib/tournament/registration/participant.ts
npm run agent:doctor
npm run agent:check -- --changed
```

Context returns instructions, exact document sections, entry points and tests without
loading their bodies. Pass several paths to combine/deduplicate areas; new/deleted paths
inherit ancestor guidance. `--json` is machine-readable (use `npm run --silent` to omit npm banners); `--expand` explicitly reads the
listed instructions/sections. Use `rg -n <symbol> <area>` and bounded source reads next.
Unknown paths fail conservatively to full checks and local integration. The map is
`scripts/agent/areas.json`; update it when moving entry points or changing risk boundaries.

Root-started clients must explicitly consult the instructions returned by context.
Do not assume editing a child file loads every nested AGENTS.md. The workflow is usable
from a plain terminal and does not require a client plugin. No machine-global settings
are modified. An unavailable client is not evidence that its automatic discovery works.

Doctor only diagnoses Node, installed dependencies/browser, configuration name presence
and the browser port. `--integration` also checks Docker, a loopback integration target
and local API reachability. A reachable API does not establish healthy migrations/RPCs.
It does not install anything, start/stop services, rewrite files, print keys or call a
hosted backend. Missing prerequisites exit 1; invalid usage exits 2.

## Edit and verify

`agent:check --changed` includes staged, unstaged and non-ignored untracked files.
Use `--base <existing-ref>` for comparison or pass explicit paths instead of `--changed`.
Default stage is **iterate**, never phase-close evidence. Add
`--stage=checkpoint --run` to execute the plan. High-risk/unknown areas take the full
bar; mixed changes keep the strongest requirements. A file extension does not establish
UI-only semantics. Component changes default to the full bar. For a reviewed copy/style
iteration with no behavior change, `--ui-only` explicitly declares that scope and selects
typecheck; it is rejected outside UI-only areas or outside iteration. A clean-diff plan says no changes, not that checks passed.

```sh
npm run agent:check -- --changed --stage=checkpoint --run
npm run agent:verify
```

`agent:verify` and `verify` share one runner/step list; the former summarizes output,
the latter streams redacted logs. Both always run typecheck, agent contracts, full Vitest,
strict browser/no-skips and build. Integration is appended when the changed areas require
it; `--integration` explicitly adds it even for a clean tree. Required integration with
an unsafe/unconfigured target is blocked, with no hosted fallback. Prepare and restore the
local target using [verification](verification.md#local-integration). The runner itself
never changes environment files or manages containers.

Logs/manifests are ignored under `test-results/agent/<run-id>/`. Success summaries target
10–20 lines; failures show the failed step and bounded excerpt. Inspect the named full log
or browser trace for detail, not the whole report by default. Credentials are redacted
before both logging and display. A report includes source identity and never skips a
future run. If source changes during a run, its status is source-changed, not passed.
Catchable interruptions stop the child process tree; inspect services/state after an
uncatchable termination. Never continue a partial run as though the full gate passed.

## Search and handoff

Search the relevant area first, then expand based on findings. Default broad discovery
should exclude generated artifacts (`.output`, `.tanstack`, generated type/router files),
lockfiles, runtime reports and historical narrative. Read them explicitly when relevant;
never hide application source or migration SQL with a security/ignore workaround.
No editor-specific ignore adapter is needed without measured evidence that it helps.

For multi-session work, use [the handoff template](templates/agent-handoff.md) in a task's
`docs/plans/<task>.md`. Keep goal/scope, material decisions, entry points, next action,
unresolved risks and verification identity in about 30 lines. Small edits need no separate
handoff. On completion, move durable decisions into their authoritative document, remove
obsolete active state, and retain only useful implementation evidence. Do not save chat
transcripts or build a universal growing memory file.

## Maintain this workflow

Keep one map and one gate implementation. New script behavior is tested with Node's
built-in runner (`npm run test:agent`) independently of the application's Vitest suite.
CI runs it once in its checks job; a lightweight docs-only workflow covers instruction/map
links when the main application workflow intentionally skips Markdown-only changes.
Do not raise budgets or weaken requirements to make a measurement look better.

Phase-close scope includes committed branch changes: the runner uses the local merge base
with `origin/main` (or `main`) plus staged/unstaged/untracked changes, without fetching.
Use `--base <existing-ref>` to choose an explicit comparison. If no local main baseline
exists, integration is required conservatively. Committing a change does not remove it
from phase-close risk selection. The manifest records the comparison commit.
