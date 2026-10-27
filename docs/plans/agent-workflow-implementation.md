# Agent workflow implementation plan

Status: complete. Implemented and verified on 2026-10-27; client/platform validation limits are recorded in the evaluation. Approved scope: all six improvements
discussed on 2026-10-27. This document defines the work; it does not introduce new
repository instructions or change the current verification policy.

## Outcome

Make routine agent work start with a small instruction set, locate the relevant source,
rules and tests through one command, and receive concise, trustworthy verification output.
Keep the repository self-contained and usable from Cursor, Codex and a normal terminal.

Optimize discovery and repeated work without weakening tournament correctness, authorization,
hermetic browser testing, local integration safeguards or the zero-skips requirement.

## Baseline and boundaries

- Starting checkpoint: `f4057f3`. The working tree was clean when this plan was written.
- Root `AGENTS.md`: 197 lines, approximately 1,600 whitespace-delimited words.
- Mandatory domain references are expensive to read in full: migration README approximately
  27,500 words; authorization and scheduling decisions approximately 6,900 words each.
- The last completed application checkpoint passed 1,384 Vitest cases, 237 browser cases
  with zero skips/flaky results, 156 local integration cases and the production build.
  These are historical results, not tests executed for this planning document.
- Eight standalone E2E TypeScript diagnostics already exist. Do not silently treat them
  as new failures, suppress them, or widen the main typecheck without addressing that debt.
- Detailed measurements: [maintenance baseline](../maintenance-baseline.md).

Do not change application behavior, scoring/scheduling algorithms, access predicates,
applied SQL migrations, dependency versions, worker/shard counts or production targets.
Do not add dependencies or an agent orchestration framework in the first implementation.
Do not change machine-global agent settings or assume approval policies can be overridden
by a file committed to this repository. No delegation is required by this plan.

## Delivery sequence

Implement as separate, reviewable changes in this order. Later phases may adjust details
using measured evidence, but may not drop a phase or relax an invariant to meet a target.

| Phase | Work | Depends on | Completion evidence |
| --- | --- | --- | --- |
| P0 | Capture discovery baseline and define the area map | None | Reproducible measurement and rule-preservation checklist |
| P1 | Short root guidance and scoped instructions | P0 | All existing safeguards remain reachable; root budget met |
| P2 | Context lookup and environment diagnosis | P1 | Deterministic CLI behavior and meaningful command tests |
| P3 | Check planning, execution and concise reports | P2 | Correct risk selection, exit codes and full-gate equivalence |
| P4 | Separate current domain contracts from history | P2; use P3 for verification | Existing requirements preserved and links/map updated |
| P5 | Search and short handoff conventions | P2, P4 | Resume a representative task without rereading its transcript |
| P6 | Evaluate, integrate CI and finish documentation | P3, P4, P5 | Comparison on three task classes and final gates |

## P0 — Baseline and one area map

- [x] Record the current instructions, mandatory reads, entry points and test commands for
  UI, routes, registration, scoring, scheduling, authorization, migrations and test infrastructure.
- [x] Identify conflicting/duplicated instructions and distinguish current contracts from
  implementation history. Preserve a checklist of every consequential rule before editing.
- [x] Define `scripts/agent/areas.json` as the small shared map used by context and check
  selection. Store path patterns, entry points, documentation sections, tests, risk and
  integration requirements. Do not enumerate every symbol or duplicate domain rules there.
- [x] Capture discovery evidence for three representative tasks: UI copy/layout,
  registration payload/cache, and scheduling/RPC authorization. Use bounded read-only
  investigations or disposable local patches; never modify a hosted backend for measurement.

Measure files/bytes/words read, search commands, bootstrap failures, verification executions
and elapsed time. Record actual tokens only if the client provides them; do not call word
counts token measurements. Record machine/client conditions with timing results.

Acceptance: the later implementation can be compared with a documented baseline, and every
area has an explicit owner path, authoritative reference and verification requirement.

## P1 — Small root instructions, specialized guidance nearby

- [x] Reduce root `AGENTS.md` to a target of 500–700 words. Keep the product/audience split,
  non-negotiable security rules, preservation of existing work, startup commands, full-gate
  requirement, Git rules and links to applicable specialized guidance.
- [x] Create scoped instructions only where they add distinct requirements:
  `src/lib/scheduling/AGENTS.md`, `src/lib/tournament/AGENTS.md`, `e2e/AGENTS.md`,
  `integration/AGENTS.md` and `supabase/migrations/AGENTS.md`.
- [x] Move long verification/review explanations into one concise `docs/verification.md`.
  Keep the full-gate command and high-risk requirement visible at the root.
- [x] Add an explicit scope-discovery rule: when operating from root, consult the area map
  and the applicable instruction files before editing. Do not assume every client loads
  nested instructions merely because a descendant file is being edited.
- [x] Preserve the old mandatory domain reads until P4 provides reviewed replacements.
  In the transition, use the small area table directly; do not reference a CLI as available
  before P2 implements it.
- [x] Check Cursor and Codex instruction discovery separately where available. If an adapter
  is necessary, use a thin pointer to the canonical guidance, not a second copy of the rules.

Acceptance: the root is substantially shorter, all original safeguards have a canonical
home, and a root-started agent can discover the applicable guidance. No universal directive
requires reading every scoped instruction or every historical document.

## P2 — Context lookup and a read-only doctor

Implement small Node scripts under `scripts/agent/` with npm entry points:

| Command | Contract |
| --- | --- |
| `npm run agent:context -- <path> [more paths]` | Report applicable instruction sources, exact documentation sections, entry points, relevant tests, risk and integration requirements |
| `npm run agent:doctor` | Diagnose the normal development/test prerequisites without modifying the environment |
| `npm run agent:doctor -- --integration` | Also inspect Docker/local-stack readiness; distinguish unavailable prerequisites from a successful check |

- [x] Context lookup accepts multiple paths, de-duplicates shared references, and handles
  new/deleted paths by their nearest known area. For unknown areas, provide the conservative
  fallback and a useful search scope; do not invent file locations or declare them low-risk.
- [x] Default output is paths, section links and commands, not complete source/doc bodies.
  Offer JSON output and explicit verbose/expanded output for clients that need it.
- [x] Doctor checks the repository's Node/CI requirements, lockfile/dependency presence,
  installed Playwright browser and relevant port availability. Reuse Node 22 from CI rather
  than upgrading tooling as part of this work.
- [x] Inspect required configuration names without printing values. Do not install packages,
  kill a server, start Docker, rewrite environment files or make network requests by default.
- [x] Report an occupied port as occupied; do not assume that any service there is this app.
- [x] Provide distinct success, missing-prerequisite and command-usage results with useful
  next commands. Machine-local limitations are not passing verification.

Acceptance tests cover overlapping scopes, shared references, missing/unknown paths,
spaces in filenames, absent optional integration tools, and absence of secret values in output.

## P3 — Correct check selection and compact execution evidence

Expose these commands, sharing the P0 area map:

| Command | Contract |
| --- | --- |
| `npm run agent:check -- --changed` | Print the check plan for staged, unstaged and non-ignored untracked changes; default stage is explicitly iteration-only |
| `npm run agent:check -- --changed --stage=checkpoint --run` | Execute the applicable checkpoint checks and report their results |
| `npm run agent:verify` | Execute the full phase-close gate and produce a compact summary |

- [x] Support an explicit comparison ref after validating that it resolves locally. Use
  NUL-delimited Git path output and subprocess argument arrays; never interpolate paths or
  user arguments into a shell command.
- [x] High-risk scoring, scheduling, authorization, database and RPC changes retain the
  current full-bar requirement at every required checkpoint. Unknown/shared infrastructure
  changes default conservatively. A `.tsx` suffix alone never proves UI-only behavior.
- [x] Focused unit tests assist low-risk iteration. Dependency-based test discovery may add
  coverage but cannot replace explicit SQL/RPC/auth/realtime requirements in the area map.
- [x] A phase-close request always runs the full gate, even with no diff. A clean-diff
  iteration plan says "no changes detected", not "verification passed".
- [x] Keep a single full-gate implementation shared by `npm run verify` and
  `npm run agent:verify`; verbose and summary modes must run the same commands in the same
  order. Preserve typecheck, full Vitest, strict Playwright/no-skips and build. Add tests for
  the new CLI behavior to both the local gate and CI without executing them twice per gate.
- [x] Use Node's built-in test runner for script contract tests unless an existing suitable
  mechanism is simpler. Do not add tests that merely compare command-source strings.
- [x] Run CPU-heavy suites sequentially. Retain existing browser route preparation.
  Do not add automatic retries or silently change timeouts/worker counts.
- [x] Required integration checks use the local stack only. Reuse existing guards/helpers;
  refuse staging/production and never fall back to a hosted target. When a runner changes
  integration configuration, preserve and restore the exact original state in cleanup,
  including failures and catchable interruptions (SIGINT/SIGTERM). Provide recovery
  instructions for an uncatchable termination. Stop only services it started.
- [x] If integration prerequisites are missing, report the required check as blocked and
  return non-success; retain the existing CI fallback workflow. Never label a partial run
  as a completed full gate.

Execution output and artifacts:

- [x] Save per-step logs plus a small JSON manifest under ignored `test-results/agent/`.
  Track run id, command, stage, relevant source/config/lockfile fingerprint, Git revision,
  dirty state, start/end times, duration, exit/signal and artifact paths. Do not record
  credentials or dump the environment.
- [x] Target 10–20 summary lines on success. On failure, show the failed step, a bounded
  useful excerpt and the full-log/trace path; expand only when needed.
- [x] Propagate errors and interruptions correctly. An empty/missing/malformed report,
  skipped test, failed child or failed required cleanup must not become success.
- [x] Keep old results labeled with their run/source identity. Do not reuse them to skip
  checks, and do not cache a green result across a source/config/environment change.
- [x] Validate behavior on macOS/Linux and Windows-compatible subprocess handling. No
  POSIX-only environment assignment or dependence on a `.cmd` executable without handling it.

Acceptance tests exercise mixed-risk diffs, changed/untracked paths, empty diffs, unknown
paths, fail-fast execution, signals, stale/missing reports, required integration being
unavailable, cleanup after failure and redaction. Use deterministic fake child processes
for orchestration tests; the real full gate proves the production command path.

## P4 — Current contracts first, history on demand

- [x] Restructure `supabase/migrations/README.md` around current create/apply/verify/recovery
  procedures. Move per-migration narrative to a linked historical document. Keep every SQL
  migration unchanged and preserve historical content and useful section links/redirecting
  anchors when moving it.
- [x] Restructure `docs/scheduling-decisions.md` so current scheduler/reflow constraints and
  source/test entry points are clear. Move old implementation-prompt material into history
  and label it explicitly as shipped/historical rather than pending work.
- [x] Restructure `docs/authorization.md` around the current access matrix, lifecycle guard
  classification and invariants. Keep registration/player/repair/recovery details linked
  from the actions they constrain; do not omit exceptions to make the overview shorter.
- [x] Retain the canonical existing entry addresses where practical. Any extracted detail
  is linked rather than duplicated as a second normative summary.
- [x] Update the area map and scoped instructions together. Required reading becomes the
  short current contract plus the relevant detail sections, not an unconditional historical
  dump. Preserve route, roster-freeze and landing consistency requirements.
- [x] Validate current contracts against implementation/tests, checking the P0 preservation
  checklist. Where code/docs disagree, record and resolve the discrepancy explicitly;
  a summary must not silently introduce a new tournament rule or access policy.
- [x] Check moved internal links and anchors. Clearly distinguish normative documents,
  historical evidence and measurements that can become stale.

Acceptance: the three large references remain complete and discoverable, while an agent
can identify its required current sections without loading all history. No applied SQL or
application behavior changes are bundled into this phase.

## P5 — Bounded search and short handoffs

- [x] Document a common sequence: inspect Git state → get relevant context → diagnose
  required prerequisites → make the change → focused checks where allowed → required gate.
- [x] Search the relevant area first with `rg`; expand the scope if evidence requires it.
  Keep generated artifacts, lockfiles, reports and migration history out of default broad
  discovery, while allowing explicit access. Do not modify `.gitignore` to hide real source
  or rely on a client ignore file as a security boundary.
- [x] Keep runtime logs/results ignored. Add an editor-specific discovery filter only if
  it demonstrably helps that client and does not hide source, required tests or current rules.
- [x] Provide a short handoff template for genuinely multi-session work: goal/scope,
  material decisions, touched entry points, next action, unresolved risks and verification
  run identity. Target about 30 lines, with expansion only for material complexity.
- [x] Use `docs/plans/<task>.md` for durable approved work plans and bounded active handoff
  information. Do not require a handoff file for every small edit or persist transcripts.
  On completion, promote only durable decisions to existing authoritative docs and remove
  obsolete active state. Do not build an ever-growing universal memory file.

Acceptance: another session can resume a representative task from its handoff and current
source without rereading the chat or treating an old successful report as current evidence.

## P6 — Evaluation, CI and rollout

- [x] Repeat the three P0 task investigations under the new workflow using comparable
  entry conditions. Keep the same task boundaries and verification requirements.
- [x] Confirm root instructions meet the 500–700-word target and that a known area can be
  resolved with one context command. Measure the combined root + scoped + required-doc
  input, not merely the smaller root file.
- [x] Compare read volume, discovery commands, bootstrap failures, repeated suite runs,
  output size and time. Report token savings only when actual token accounting exists.
  Do not claim a fixed percentage of total cost reduction from a word-count reduction.
- [x] Confirm UI, registration and scheduling/RPC paths select the expected checks; unsafe
  or unknown classifications must not silently receive a cheaper gate.
- [x] Exercise the CLI in CI with deterministic cases, keeping existing required checks
  and hermetic/no-secrets behavior. Validate instruction/map references automatically with
  small contract tests rather than reintroducing broad source-text assertions.
- [x] Test instruction discovery in available clients. If one is unavailable, record that
  limitation instead of claiming compatibility was demonstrated.
- [x] Run the full final verification and applicable local integration checks. Run the
  shard plan if browser case/file changes affect it. Keep the standalone E2E typecheck
  backlog explicit unless a separately scoped change fixes it.
- [x] Update README with the short startup path and commands. Replace transitional P1
  instructions and mark this plan complete only when every required deliverable is done.

Release criteria: all six improvements are present, new CLI contract tests pass, existing
application gates remain green, relevant integration evidence exists, and measurement
shows less unnecessary discovery/output without missing required context or checks.

## Review, rollback and maintenance

Each phase should have its own concern-focused commit/PR, explaining what could break and
what was checked. Apply the repository's current gates until an equivalent shared runner
has been validated; this plan does not grant a phase-close exemption.

The public `npm run verify` command must remain available throughout. Do not replace it
with the new runner until its equivalence is proven. On rollout failure, restore the prior
entry point and repair the helper; do not bypass failed checks. Preserve Git history.

Keep the area map small and validate paths when they change. Add instructions only for
consequential, non-obvious project constraints. Avoid accumulating postmortems, duplicate
rules, stale result inventories or model-specific prompting rituals in startup context.

Implementation completion is separate from committing, pushing or changing remote branch
protection. Those actions follow the user's request and the existing Git workflow.


## Completion evidence

- All P0–P6 deliverables are implemented; scope and validation limits are in
  `docs/agent-workflow-evaluation.md`.
- Fresh full gate: `test-results/agent/2026-10-27T15-57-03-453Z-84bcd2de/manifest.json`.
- Code snapshot fingerprint: `d5b28678e406e742acb41f5d6435498cc2ce72199593dc03cb82764e7f0ec70c`.
- Results: typecheck, 20 CLI contracts, 1,384 Vitest, 237 browser, build and 156 local
  integration cases passed; all six step logs/native reports retained. No app source,
  applied SQL, dependency versions or browser worker/shard counts changed.
- Original integration configuration restored exactly; the owned local stack is stopped
  after verification. These closing notes are documentation updates after the recorded run.
- No obsolete active handoff, transcript or credentials are retained here. Remote CI,
  native client prompt-chain instrumentation and Windows execution are not claimed.
