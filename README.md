# Tournova

Tournament operations console for badminton events. Built to be run live at a desk
during a tournament, on imperfect wifi, by a small control team.

It handles registration, seeding, match generation, live scoring, court scheduling
and knockout draws. Two kinds of operator run it during the day, and a third
audience — participants — signs in to enter:

- The **organiser** plans the tournament. The Schedule tab is their view.
- The **moderator** runs a single court in real time. The Desk is their view.
- A **participant** registers from a tournament's public page, and may withdraw
  while the request is still pending. Approval is what creates their entry, and it
  grants no operating rights.

## Stack

| Layer | Choice |
| --- | --- |
| Framework | [TanStack Start](https://tanstack.com/start) (file-based routing, SSR) |
| UI | React + TypeScript, [Tailwind v4](https://tailwindcss.com), Radix primitives |
| Data | [Supabase](https://supabase.com) — Postgres, Row Level Security, RPCs |
| Deploy | Cloudflare Workers |
| Tests | Vitest (unit and component), Playwright (rendered) |

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
| `npm run test:integration` | Vitest against a **real** backend: auth, RLS, RPC authorization per role, realtime, the lifecycle. Targets the local stack — see [`AGENTS.md`](AGENTS.md) |
| `npm run test:e2e` | Playwright — rendered app, hermetic (no network to Supabase) |
| `npm run test:e2e:record-auth` | Optional. Records a real staff session for manual checks against a live backend |
| `npm run bench:scheduling` | Scheduler benchmark; prints its report to stdout. Compares greedy against the hybrid at 1/5/10/25 runs across six shapes — `small`, `medium`, `large`, `contended`, `multi-event` and `straggler`. The report adds stage-close times and the median change in progression and churn per run-count step, so it answers "did the change close stages earlier, and at what cost to finish time" rather than only `unscheduled` / `afterCutoff` / `makespan`. Overrides: `BENCH_ONLY`, `BENCH_REPS`, `BENCH_SEEDS`, and `BENCH_OUT` to also write the markdown to a file (e.g. `BENCH_OUT=.benchmark/hybrid-core.md`, git-ignored) |
| `npm run lint` | ESLint. **Not a gate** — see below |
| `npm run format` | Prettier write |

### The gates

```sh
npm run typecheck && npm run test && npm run test:e2e && npm run build
```

All of these run in CI on every pull request. CI also asserts that the browser run
contained zero skips: a skipped test is never a passing test.

`npm run lint` is deliberately **not** a gate. It reports a large pre-existing
Prettier backlog that predates the current design work, so it is noise rather than
signal; do not run a repo-wide format as part of an unrelated change. The other
gates are green and expected to stay green.

## Testing notes

The Playwright suite is **hermetic**: it intercepts network requests and serves
deterministic fixture data, including a synthetic staff session and role. That means
it needs no credentials, never touches the production project, and produces the same
result on any machine. See [`e2e/fixtures/`](e2e/fixtures).

## Documentation

| Document | Contents |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Working rules: design system, security, workflow, gates, review tiering |
| [`docs/design-system.md`](docs/design-system.md) | The palette, the state vocabulary, and the rule that the three audiences stay separate |
| [`docs/authorization.md`](docs/authorization.md) | Who may do what: platform role vs per-tournament access, the lifecycle guards, registration, and the column privileges |
| [`docs/information-architecture.md`](docs/information-architecture.md) | The URL scheme, the two shells, and the flows between them |
| [`docs/tournament-format.md`](docs/tournament-format.md) | Tournament rules as implemented |
| [`docs/scheduling-decisions.md`](docs/scheduling-decisions.md) | Why the scheduler works the way it does |
| [`docs/recovery-runbook.md`](docs/recovery-runbook.md) | Getting the database back after data loss: what a backup does and does not contain, and the restore procedure |
| [`docs/cleanup-deferred.md`](docs/cleanup-deferred.md) | What an earlier cleanup removed, and the candidates it deliberately left alone |
| [`supabase/migrations/README.md`](supabase/migrations/README.md) | Applying and verifying database migrations |
| [`src/routes/README.md`](src/routes/README.md) | File-based routing conventions |

## Database

Migrations live in [`supabase/migrations`](supabase/migrations) and are applied in
filename order. See
[`supabase/migrations/README.md`](supabase/migrations/README.md) for how to apply and
verify them, and for what each one changes. Never edit an applied migration — add a
new one.

Many tournaments may be `upcoming` or `in_progress` at once; there is no global active
tournament. Each signed-in user has their own working tournament
(`profiles.current_tournament_id`, written by `set_current_tournament`), and a caller with
no pointer browses `/explore`. The Phase 1 `is_active` pointer and its
`set_active_tournament` verb were retired.

The `players` table is global rather than tournament-scoped, with `players.profile_id` linking
a row to the person it belongs to — `NULL` for a walk-in and for a partner supplied by name.
Registration requests and the categories they ask for live in `tournament_registrations` and
`tournament_registration_entries`; approval is the one path that links a player, and the only
path that creates an entry from a request. The domain relationships
(`owner_profile_id`, `tournament_editors.profile_id`, `tournament_registrations.profile_id`)
key on the profile rather than the auth identity, so recreating a login loses nothing. See
[`docs/authorization.md`](docs/authorization.md).

### Operator scripts

These are run by hand, are not part of any gate, and mostly need a privileged credential.
Each refuses to act on an unknown target rather than defaulting to one.

| Script | What it does |
| --- | --- |
| `scripts/apply-migrations.mjs` | Applies `supabase/migrations/*.sql` in filename order, recording each in `supabase_migrations.schema_migrations` in the same transaction. Use `supabase db push` instead when a database password exists; this exists for a personal access token, which `db push` cannot use. Refuses the production ref without `--allow-production`. |
| `scripts/create-staff-login.mjs` | Creates the `auth.users` identity for an email the migrations already seeded into `profiles`, and verifies the role actually confers its privilege. Email is the durable key — the `on_auth_user_created_link_profile` trigger fills in `profiles.user_id`, so there is no UUID or password to migrate. |
| `scripts/compare-api-surface.mjs` | Diffs the tables, columns and RPC signatures of two backends using their keys. A narrower check than `parity-dump.sql`: function bodies and policies are not visible over HTTP. |
| `scripts/run-sql.mjs` | Runs one read-only `.sql` file against a project, either over a Postgres connection string or, with `--project-ref`, through the Management API. Refuses anything that is not a single read-only statement. |
| `scripts/verify-build-target.mjs` | Asserts a build was compiled against the backend currently in `.env`, that a production build targets the production project, and that the generated Worker is `tournova-ops`. See "Deploying the Worker" below. |
| `scripts/reset-tournament-data.mjs` | Clears tournament data while keeping `profiles`: results, entries, registration requests and the player roster. Requires `SUPABASE_URL` and a key; it has no hardcoded project. |
| `scripts/restore-backup.mjs` | Restores a `pg_dump` backup into the local stack, or into a named project with `--project-ref`. Refuses the production ref without `--allow-production`. See "Backups" below. |

The database-side counterparts — `parity-dump.sql` and `migration-drift-check.sql` — are
documented in [`supabase/migrations/README.md`](supabase/migrations/README.md).

### Backups

```sh
npm run backup:production                          # pg_dump of public/, needs SUPABASE_DB_PASSWORD
npm run restore:to-local -- backups/<dump> --yes   # rehearses a restore into the local stack
```

A dump is `public` data only: the schema is rebuilt from the migrations, and `auth` is
deliberately excluded because recreating a staff login is `scripts/create-staff-login.mjs`.
Dumps go to `backups/`, which is git-ignored.

`scripts/restore-backup.mjs` restores into the local stack by default and into a named
project with `--project-ref <ref>`, which needs `--allow-production` for the live one. It
makes load order irrelevant — the dump's tables are alphabetical, so 29 of 50 foreign keys
arrive out of order, and a trigger that derives a column needs its source rows — by dropping
the foreign keys and disabling user triggers around the load, then putting both back.

**Read [`docs/recovery-runbook.md`](docs/recovery-runbook.md) before relying on a dump.** It
records what has been verified and what has not, and the auth seam that stops staff signing
in after a restore.

### Deploying the Worker

```sh
npm run deploy:check # build, verify the target, show what would be uploaded (no upload)
npm run deploy       # build, verify the target, upload
```

`npm run deploy:dry` is an alias of `deploy:check`.

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

In production mode — the default, and what both scripts above use — the check is stricter
than that. It also requires the configured project to be the production project, gets it
wrong for neither the legacy Lovable Cloud project nor staging, and reads the generated
`.output/server/wrangler.json` to confirm the Worker is still `tournova-ops`. A
`--mode development` check keeps the weaker comparison, because a staging build is allowed
to target staging.

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


