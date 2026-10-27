# Working in Tournova

Tournova is a badminton tournament operations console: TanStack Start, React,
TypeScript, Tailwind v4, Supabase and Cloudflare Workers. It must remain usable
at a live tournament desk on imperfect wifi. The repository builds independently
of an editor or hosted development platform; Cursor and Codex share these rules.

## Start with the relevant context

Check `git status --short` and preserve existing work. Run
`npm run agent:context -- <path> [more paths]` before editing a new area; read the
listed instructions and current document sections. This also works for new or
deleted paths. Do not assume a client automatically loads descendant instructions
when it starts at root. Unknown areas require conservative full checks.

`npm run agent:doctor` diagnoses prerequisites without installing, starting or
stopping anything. Add `-- --integration` when backend verification is needed.
Use Node 22 (`.nvmrc`), npm and the committed lockfile. See
[agent workflow](docs/agent-workflow.md) for discovery, commands and short handoffs.

Search the relevant area with `rg` before widening scope. Read matching sections
instead of dumping entire large files. Generated output, reports, lockfiles and
historical migration narratives are explicit-read material, not startup context.
They remain accessible when the task needs them. Follow scoped `AGENTS.md` files;
do not copy their instructions into a second client-specific rule set.

## Product invariants

- The organiser plans the whole tournament on Schedule. The moderator runs every
  court for one day on Desk. Keep tournament forecasts off Desk and operational
  noise off the organiser's view.
- A participant registers and reads their own request. Approval grants no operating
  rights. Browser controls mirror authorization; database guards remain authoritative.
- Before changing rules, read [tournament format](docs/tournament-format.md).
  For scheduling, authorization, addresses or roster changes, follow the context
  command's current contract and linked detail sections. Read
  [information architecture](docs/information-architecture.md) before adding,
  moving or redirecting a web address, and [roster freeze](docs/roster-freeze.md)
  before changing joins/withdrawals after matches exist.
- The design is flexible; [design principles](docs/design-principles.md) are guidance.
  Accessibility checks remain required. Landing (`src/components/landing/`) shows
  the real product: update its Desk wording and scheduling demo when those change.

## Safety and persistence

Never commit credentials, tokens, recorded sessions or backups. Keep `.env*` and
`e2e/.auth/` ignored. Service-role credentials belong on the server only; never
give them a `VITE_` prefix or expose them in frontend source or logs. Tests must
never target production or staging. Browser tests intercept transport; backend
integration runs against the local stack and fails closed on an unsafe target.

Migrations are append-only. Read [migration operations](supabase/migrations/README.md)
before adding/applying one, then the relevant historical details. Never rewrite
an applied SQL migration. Retain the database/RPC guards and recovery safeguards.

## Verification and delivery

`npm run agent:check -- --changed` prints an iteration plan; add
`--stage=checkpoint --run` to execute checkpoint checks. A plan or clean diff is
not verification. UI-only iteration needs typecheck; completed features need
typecheck and relevant tests. Scheduling, scoring, authorization, database and RPC
changes require the full bar at every required checkpoint, regardless of size.

Before pushing, opening a PR or closing an implementation phase, run
`npm run agent:verify` (compact) or `npm run verify` (verbose). They share the
same ordered gate: typecheck, agent contracts, full Vitest, one strict hermetic
Playwright run with zero skips, then build; required local integration is additional.
Do not run ordinary E2E again immediately before the strict run. Do not reuse a
passing result after source/config changes. Run heavy suites sequentially.

See [verification](docs/verification.md) for integration recovery, review tiers,
CI's two browser shards and shard planning. `npm run lint` is not a gate: do not
reformat the existing repository-wide backlog. All applicable CI checks must pass
before merge. Explain risks and evidence for high-risk changes.

Use short-lived branches and PRs, one concern per commit, imperative subjects.
Preserve meaningful independent commits; squash is optional. Never force-push or
rewrite published history. Keep `main` buildable and passing. Commit, push and
deployment follow the user's requested scope and the environment's approval rules.
