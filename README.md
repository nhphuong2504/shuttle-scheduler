# Tournova

Tournament operations console for badminton events. Built to be run live at a desk
during a tournament, on imperfect wifi, by a small control team.

It handles registration, seeding, match generation, live scoring, court scheduling
and knockout draws, and it is operated by two different people during the day:

- The **organiser** plans the tournament. The Schedule tab is their view.
- The **moderator** runs a single court in real time. The Desk is their view.

## Stack

| Layer | Choice |
| --- | --- |
| Framework | [TanStack Start](https://tanstack.com/start) (file-based routing, SSR) |
| UI | React + TypeScript, [Tailwind v4](https://tailwindcss.com), Radix primitives |
| Data | [Supabase](https://supabase.com) — Postgres, Row Level Security, RPCs |
| Deploy | Cloudflare Workers |
| Tests | Vitest (unit and component), Playwright + Axe (rendered) |

## Getting started

You need Node.js with npm ([install with nvm](https://github.com/nvm-sh/nvm)).

```sh
npm install
cp .env.example .env    # then fill in the four Supabase values
npm run dev
```

`.env` is git-ignored. It needs a Supabase project URL and publishable key; see
[`.env.example`](.env.example) for the exact names and where each is used. A build
fails without them.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with HMR |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript, no emit |
| `npm run test` | Vitest — unit and component tests |
| `npm run test:e2e` | Playwright — rendered app, hermetic (no network to Supabase) |
| `npm run test:e2e:final` | The phase-close gate: fails on any skip, then asserts zero skips |
| `npm run test:e2e:record-auth` | Optional. Records a real staff session for manual checks against a live backend |
| `npm run bench:scheduling` | Scheduler benchmark; writes a report to `.benchmark/` |
| `npm run lint` | ESLint. **Not a gate** — see below |
| `npm run format` | Prettier write |

### The gates

```sh
npm run typecheck && npm run test && npm run test:e2e && npm run build
```

All of these run in CI on every pull request except `test:e2e:final`, which is a
local phase-close gate because it needs no credentials but does need a full run.

`npm run lint` is deliberately **not** a gate. It reports a large pre-existing
Prettier backlog that predates the current design work, so it is noise rather than
signal; do not run a repo-wide format as part of an unrelated change. The other
gates are green and expected to stay green.

## Testing notes

The Playwright suite is **hermetic**: it intercepts network requests and serves
deterministic fixture data, including a synthetic staff session and role. That means
it needs no credentials, never touches the production project, and produces the same
result on any machine. See [`e2e/fixtures/`](e2e/fixtures).

The accessibility sweep is a **pinned baseline**, not a zero-violation target. A rule
that was already failing may keep failing; a rule that starts failing when it was not
failing before fails the suite. Re-record with `A11Y_RECORD=1 npm run test:e2e` and
review the diff.

## Documentation

| Document | Contents |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Working rules: design system, security, workflow, gates, review tiering |
| [`docs/design-system.md`](docs/design-system.md) | Tokens, typography, states, components, do/don't |
| [`docs/tournament-format.md`](docs/tournament-format.md) | Tournament rules as implemented |
| [`docs/scheduling-decisions.md`](docs/scheduling-decisions.md) | Why the scheduler works the way it does |
| [`docs/ux-review-checklist.md`](docs/ux-review-checklist.md) | The manual checks no automated gate covers |
| [`supabase/migrations/README.md`](supabase/migrations/README.md) | Applying and verifying database migrations |
| [`src/routes/README.md`](src/routes/README.md) | File-based routing conventions |

## Database

Migrations live in [`supabase/migrations`](supabase/migrations) and are applied in
filename order. See
[`supabase/migrations/README.md`](supabase/migrations/README.md) for how to apply and
verify them, and for what each one changes. Never edit an applied migration — add a
new one.

Exactly one tournament is active at a time. The `players` table is global rather than
tournament-scoped.

### Operator scripts

These are run by hand, are not part of any gate, and mostly need a privileged credential.
Each refuses to act on an unknown target rather than defaulting to one.

| Script | What it does |
| --- | --- |
| `scripts/apply-migrations.mjs` | Applies `supabase/migrations/*.sql` in filename order, recording each in `supabase_migrations.schema_migrations` in the same transaction. Use `supabase db push` instead when a database password exists; this exists for a personal access token, which `db push` cannot use. Refuses the production ref without `--allow-production`. |
| `scripts/create-staff-login.mjs` | Creates the `auth.users` identity for an email the migrations already seeded into `staff_roles`, and verifies the role resolves. Email is the durable key — the `on_auth_user_created_link_staff` trigger fills in `staff_roles.user_id`, so there is no UUID or password to migrate. |
| `scripts/compare-api-surface.mjs` | Diffs the tables, columns and RPC signatures of two backends using their keys. A narrower check than `parity-dump.sql`: function bodies and policies are not visible over HTTP. |
| `scripts/run-sql.mjs` | Runs one read-only `.sql` file against a project, either over a Postgres connection string or, with `--project-ref`, through the Management API. Refuses anything that is not a single read-only statement. |
| `scripts/verify-build-target.mjs` | Asserts a build was compiled against the backend currently in `.env`. See "Deploying the Worker" below. |
| `scripts/reset-tournament-data.mjs` | Clears tournament data while keeping `staff_roles`. Requires `SUPABASE_URL` and a key; it has no hardcoded project. |

The database-side counterparts — `parity-dump.sql` and `migration-drift-check.sql` — are
documented in [`supabase/migrations/README.md`](supabase/migrations/README.md).

### Deploying the Worker

```sh
npm run deploy:dry   # build, verify the target, show what would be uploaded
npm run deploy       # build, verify the target, upload
```

The Worker is `tournova-ops`, named explicitly in [`vite.config.ts`](vite.config.ts).
Nitro would otherwise derive the name from the git remote, which resolves to the existing
production Worker's name.

**The backend is compiled in, not configured.** `vite.config.ts` injects every `VITE_`
variable as a literal define, so the Supabase URL and publishable key are baked into the
bundle at build time. A deployed Worker exposes no vars for them — only the `ASSETS`
binding — and therefore **cannot be repointed by changing a Cloudflare variable**. Changing
backend means rebuilding and redeploying.

That is why `npm run deploy` runs `scripts/verify-build-target.mjs` before uploading: it
fails when the bundle does not contain the project the build was configured for, which is
the difference between deploying to production and quietly deploying to staging.

Which project that is comes from the environment files, split so that a mistake has to be
deliberate:

| File | Mode | Used by | Points at |
| --- | --- | --- | --- |
| `.env` | development | `npm run dev`, `npm run build:dev` | staging |
| `.env.production` | production | `npm run build`, `npm run deploy` | production |

Both are git-ignored; `.env.example` documents every variable. The guard resolves these in
Vite's own order — `.env`, then `.env.<mode>`, then the real environment — so it compares a
build against the values that build actually used rather than against whichever file it
happened to read.


