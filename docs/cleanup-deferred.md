# Cleanup: what was removed, and what was deliberately not

This records the repository cleanup that deleted the unused shadcn scaffold, and the
candidates that were found but left alone. It exists so a later reader does not re-derive
the same audit, and so nothing here is mistaken for an oversight.

The cleanup itself changed no behaviour: no schema, RPC, policy, scheduling algorithm,
tournament format or scoring rule was touched, and no rendered surface was removed.

## Removed

| Removed | Evidence |
| --- | --- |
| 36 of the 46 `src/components/ui/*` primitives | No import from outside `src/components/ui` in `src`, `e2e`, `scripts` or `docs`, and no barrel, dynamic import or Storybook consumer. Five of them (`separator`, `sheet`, `skeleton`, `toggle`, `tooltip`) were reachable only through `sidebar.tsx`, which was itself unused. |
| `src/hooks/use-mobile.tsx` | Only consumer was the deleted `sidebar.tsx`. |
| The `chart-*` and `sidebar-*` colour tokens | Their only consumers were `chart.tsx` and `sidebar.tsx`. Their `--color-*` keys and both theme declarations went with the primitives. |
| `createTournament` and its `CreateTournamentInput` / `TournamentCategoryInput` types in `src/lib/tournament/actions.ts` | Superseded and marked deprecated; no caller. The wizard writes a draft with `createTournamentDraft` and activates it with `activateTournament`. The `create_tournament` RPC is untouched. |
| `src/integrations/supabase/auth-middleware.ts` | Exported `requireSupabaseAuth` with no importer. The live path is `auth-attacher.ts`, wired in `src/start.ts`. |
| 32 packages | The eight shadcn-only runtime packages, the twenty `@radix-ui` packages whose only consumers were the deleted wrappers, and `@hookform/resolvers`, `date-fns`, `zod` and `@testing-library/jest-dom`, which had no import or test registration anywhere. 85 transitive packages left with them. |
| `supabase/.temp/cli-latest` (untracked) | Machine-local CLI scratch state. `.gitignore` already ignored `supabase/.temp/`; the file was tracked anyway. |
| `.cursor/plans/sport-agnostic_scheduling_core_3ca401f1.plan.md` | A superseded planning artifact. The scheduling core it describes is shipped under `src/lib/scheduling`, and its decisions are recorded in [`scheduling-decisions.md`](scheduling-decisions.md). |

`tokens.test.ts` used to pin a `KNOWN_DEAD` list of tokens that no component renders; it
shrank from 11 to 6 tokens with the same change. That test has since been removed along with
the other rendered-UI sweeps, so the tokens described below are kept as design vocabulary and
recorded here rather than guarded by a test.

## Deferred, with the evidence

### Legacy pool engine

`/pools`, `/draws` and `/schedule` plus `src/lib/tournament/pools.ts`,
`standings.ts` and the pool actions in `actions.ts`.

It is **not dead code**: the routes are reachable by direct URL, and the live surfaces
(`/`, `/matches`) still load the legacy rows — but only for a tournament whose stored
`format` is `round_robin`. `buildDeskMatches` takes the tournament's format and lists the
pools and pooled draws for that format alone (`isSupportedFormat` in
[`competition-format.ts`](../src/lib/tournament/competition-format.ts)), so a two-round
placement event is not shown finished matches from a stage it does not run. They are
deliberately absent from the navigation because the creation wizard replaced round-robin
with two-round placement ([`tournament-format.md`](tournament-format.md),
"Legacy pool engine"). Removing it is a product decision about whether the format is still
supported, not a cleanup, and it would touch scoring and standings paths that need the
stronger review tier.

### `DrawTier` is declared twice

The same `"A" | "B" | "C" | "D"` union exists in
[`competition-format.ts`](../src/lib/tournament/competition-format.ts) and
[`draws.ts`](../src/lib/tournament/draws.ts). Consolidating it is a one-line change and
behaviour-neutral, but it edits the `src/lib/tournament/**` review tier for no functional
gain, so it is left as a separate, deliberate change rather than folded into a cleanup.

### `buildFirstRound` and `buildTierBracket` are not duplicates

They look similar and are not: the pool path applies a rematch-avoidance rule keyed on pool
name, the placement path does not, because they are two formats rather than one algorithm
with two callers. Do not merge them without reading
[`tournament-format.md`](tournament-format.md).

### `info-*` tone tokens

`--info-surface`, `--info-border` and `--info-foreground` are defined in both themes and
rendered by nothing. They are design vocabulary rather than scaffolding, so retiring them is
a design-system decision. They stay in the palette, recorded here.

### `card` / `card-foreground`

No component renders `bg-card`, but they are the third step of the chassis ramp
(`--background` -> `--surface` -> `--card`) named in
[`design-system.md`](design-system.md), so the token is kept and this note records why rather
than deleting a documented surface.

### `@tanstack/router-plugin` is a direct dependency

It is not imported by `vite.config.ts` or any Vitest config, and it already arrives as a
dependency of `@tanstack/start-plugin-core` through `@tanstack/react-start`. The top-level
entry looks like a version pin (`1.168.23`) rather than a direct import, so it was left in
place until that intent is confirmed.

### CRLF fragility in the other environment parsers

`scripts/verify-build-target.mjs` split environment files on `\n` only. On a CRLF checkout
every value kept a trailing `\r` and could never match the end-anchored capture, so the
production guard reported a missing `VITE_SUPABASE_URL` instead of checking the build. That
is fixed. The same construct survives in
[`integration/env.ts`](../integration/env.ts) and `scripts/integration-target.mjs`:

- [`integration/env.ts`](../integration/env.ts) uses the same anchored pattern, so
  `integration/.env` values would be dropped on a CRLF checkout and the suite would report
  itself as "not configured".
- `scripts/integration-target.mjs` rewrites that file line by line and does not normalise
  line endings.

Both are outside the hermetic gates and were not exercised here, so they are recorded rather
than changed. The integration suite needs its own run to prove a fix.

### Operator scripts and the Prettier backlog

`scripts/fake-day-one-results.mjs` and the `generate-/verify-placement-shift-migration.ps1`
pair are referenced only from documentation, not from `package.json` or CI. They are
historical operators' tools, not abandoned junk, so they stay. The repository-wide Prettier
backlog is unrelated to this work and was deliberately not addressed; `npm run lint` is not
a gate.
