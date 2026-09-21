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
