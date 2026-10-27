# Agent workflow evaluation

Recorded 2026-10-27 against starting checkpoint f4057f3.

## Required-read comparison

Run `npm run agent:evaluate` to reproduce the inputs and word counts. The original
read sets are in `scripts/agent/discovery-baseline.json`; fresh machine-readable
results are ignored under `test-results/agent/discovery.json`. Original documents
are retained in the reference/history files and Git history.

| Scenario | Before words | After words | Less required text |
| --- | ---: | ---: | ---: |
| ui | 3,670 | 2,707 | 26.2% |
| registration | 11,163 | 5,982 | 46.4% |
| scheduling-rpc | 45,516 | 8,085 | 82.2% |

Root instructions alone shrink from about 1,600 to 637 words. The combined comparison
includes the root, scoped guidance, current contracts and mapped detail sections, not
just the smaller root file. Whole-file reads and section reads are deduplicated.
The three scenarios resolve with one context command. There is no measured baseline
for discovery command count, task completion time, bootstrap failure rate or token use;
do not claim those improvements as measurements. Source exploration is not included
in the document word count. No model-quality or production performance claim is made.

Generic component edits default to full checks. A reviewed no-behavior UI iteration
can explicitly declare --ui-only; this cannot override scoring/scheduling/auth/RPC
areas or phase close. Registration and scheduling/RPC scenarios retain full checks
and local integration, including after commit. Unknown areas are conservative.

## Rule-preservation review

| Original requirement | Current canonical home |
| --- | --- |
| Organiser / moderator / participant separation | Root AGENTS product invariants |
| Participation never confers authority | Root + tournament instructions + authorization contract/details |
| Read format, scheduler, auth, routes and roster rules when relevant | Root + area map + scoped instructions |
| Flexible design with required accessibility | Root + E2E instructions + verification browser section |
| Landing reflects real wording and reflow | Root + scheduling instructions |
| No credentials, frontend service role or tracked sessions | Root safety + redacted runner + secret guard |
| Hermetic browser suite, no hosted fallback | E2E instructions + verification |
| Local-only integration and target parity | Integration instructions + local target preflight + existing setup guard |
| Applied SQL immutable and ordered | Migration instructions + operations README |
| UI iteration / checkpoint / high-risk / phase-close tiers | Root + verification + tested plan selection |
| Ordered full gate, zero skips, no duplicate E2E | Shared step factory + runner + strict browser wrapper |
| Two CI shards, bounded workers, shard planning | Verification + unchanged browser worker/shard configuration |
| Integration CI fallback, Realtime warmup, exact target restoration | Verification local integration section |
| No repo-wide formatting, lint is not a gate | Root + verification |
| Risk reasoning in review, Git history preservation | Root + verification |

No application TypeScript/React source, applied SQL, dependency versions or browser
worker/shard counts change in this implementation. README's old single-court moderator
wording is aligned with the existing every-court, one-day audience invariant. Historical docs retain all sections.
Two stale operational items were resolved explicitly: authorization details formerly
required duplicate E2E and unconditional staging restoration; these now link the current
verification protocol. The scheduling record's removed knockout design-note link is
labeled historical and points to its shipped successor section.

## Behavioral evidence and limits

- CLI contracts run with Node's built-in runner, including under CI=1: scope/risk union,
  paths with spaces/metacharacters, clean branch commits, stale/empty/skipped evidence,
  child failures/signals, redaction and source changes. Native reports retain failure
  counts while masking credential strings. Verbose/summary modes share step order.
- A real docs-only agent:check --run --json smoke run passed; both normal and integration
  doctor invocations reported ready outside the filesystem/network sandbox. No doctor
  operation installed dependencies, rewrote configuration or managed a service.
- Workflow YAML parses locally. Main CI runs agent contracts once; the dependency-free
  docs-only workflow fills the Markdown-only gap and skips its duplicate on mixed changes.
  Remote CI has not been run for this unpushed implementation.
- Cursor and Codex executables exist on this machine. The explicit context command
  discovers root/ancestor instructions and document sections without either client.
  Native client prompt-chain instrumentation/restart was not performed, so automatic
  client-specific loading is not claimed. No global settings or duplicate adapter
  instructions were installed.
- macOS execution and subprocess argument/signal contracts were exercised locally.
  Linux CI is configured; Windows-native execution remains unmeasured. Node CLI argument
  arrays avoid POSIX assignments and .cmd execution assumptions.
- Handoff uses a bounded template and the task plan; it records next action and verification
  identity. No extra agent/model was launched to pretend to validate a second session.
- Full application and real local integration results are in the fresh verification
  manifest generated by agent:verify. Historical passes are not reused as fresh evidence.

## Review and rollback

The main risks are understated scope, missing required details, swallowed failures and
credential output. Conservative defaults, validated links/map entries, real subprocess
contract tests, redaction tests and the unchanged full application checks address them.
The runner never switches integration targets or manages containers; manual preparation
must preserve/restore the original state. A missing local target is blocked, not passed.
Rollback should restore the old verify entry point together with its documentation,
not bypass a failing gate or revert applied database history.

## Artifact isolation discovered in the real gate

The first real run passed typecheck, CLI contracts, 1,384 Vitest cases and 237 browser
cases, but verification correctly failed when Playwright cleaned the parent output
folder containing the agent manifest. Browser artifacts now use `test-results/browser/`;
runner artifacts remain in the sibling `test-results/agent/`. The browser JSON report
path used by the no-skips guard/shard planner is unchanged. A regression contract
simulates child cleanup and requires a failed recoverable manifest rather than a pass.
The complete gate is repeated after this integration fix, including build and backend.

## Final verification

The shared agent:verify runner completed successfully with its source fingerprint
unchanged during execution. Results: typecheck; **20/20 CLI contracts**, **1,384/1,384
Vitest cases**, **237/237 browser cases** (zero skips/flaky/unexpected); production build;
**156/156 local integration cases**. All six logs and native reports survived. Browser
execution was about 212 seconds in this run, not a controlled speed comparison with prior
machines/runs. The compact command prints step summaries, counts and artifact paths.

The original integration environment was restored byte-for-byte and its private temporary
backup removed. Only the locally started stack was stopped, retaining its normal backup.
The plan links the manifest for the tested code snapshot; subsequent closing documentation
notes are not represented as a different code run. No report was reused to skip a check.
