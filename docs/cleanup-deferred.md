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
| The `chart-*` and `sidebar-*` colour tokens | Their only consumers were `chart.tsx` and `sidebar.tsx`. Their `--color-*` keys and their declarations went with the primitives. |
| The first `createTournament` and its `CreateTournamentInput` / `TournamentCategoryInput` types in `src/lib/tournament/actions.ts` | Superseded and marked deprecated; no caller. (A different `createTournament` now exists: the wizard's atomic call to `create_tournament`, with a window and events. This entry is about the old one.) |
| `src/integrations/supabase/auth-middleware.ts` | Exported `requireSupabaseAuth` with no importer. The live path is `auth-attacher.ts`, wired in `src/start.ts`. |
| 32 packages | The eight shadcn-only runtime packages, the twenty `@radix-ui` packages whose only consumers were the deleted wrappers, and `@hookform/resolvers`, `date-fns`, `zod` and `@testing-library/jest-dom`, which had no import or test registration anywhere. 85 transitive packages left with them. |
| `supabase/.temp/cli-latest` (untracked) | Machine-local CLI scratch state. `.gitignore` already ignored `supabase/.temp/`; the file was tracked anyway. |
| `.cursor/plans/sport-agnostic_scheduling_core_3ca401f1.plan.md` | A superseded planning artifact. The scheduling core it describes is shipped under `src/lib/scheduling`, and its decisions are recorded in [`scheduling-decisions.md`](scheduling-decisions.md). |
| The landing's `desk-preview.tsx`, `reader-preview.tsx`, `schedule-demo.tsx` and `schedule-demo-data.ts` (with its test) | Unreachable since the landing became the court board: no importer in `src`, `e2e`, `integration` or `scripts`. |
| `src/lib/tournament/scheduling/badminton.ts` | No importer anywhere; the adapters in use are `policy.ts`, `composition.ts` and `formats/`. |
| The second `DrawTier` declaration in `draws.ts` | Now re-exported from `competition-format.ts`, so the union has one definition. |
| The `\n`-only split in `integration/env.ts` and `scripts/integration-target.mjs` | Both now split on `\r?\n`, so a CRLF `integration/.env` no longer reads as "not configured". |

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

### `buildFirstRound` and `buildTierBracket` are not duplicates

They look similar and are not: the pool path applies a rematch-avoidance rule keyed on pool
name, the placement path does not, because they are two formats rather than one algorithm
with two callers. Do not merge them without reading
[`tournament-format.md`](tournament-format.md).

### `info-*` tone tokens

`--info-surface`, `--info-border` and `--info-foreground` are defined and
rendered by nothing. They are design vocabulary rather than scaffolding, so retiring them is
a design decision, left for when the design settles.

### `card` / `card-foreground`

No component renders `bg-card`, but it is the third step of the surface ramp
(`--background` -> `--surface` -> `--card`), so the token is kept until the design settles.

### `@tanstack/router-plugin` is a direct dependency

It is not imported by `vite.config.ts` or any Vitest config, and it already arrives as a
dependency of `@tanstack/start-plugin-core` through `@tanstack/react-start`. The top-level
entry looks like a version pin (`1.168.23`) rather than a direct import, so it was left in
place until that intent is confirmed.

### Nothing reads `match_result_history` yet

Correcting an already-reported result now keeps the result it replaced, who sent it and when
(`20261022010000_match_result_history.sql`). The table is readable by that tournament's
editors through RLS, but no screen reads it: there is no "this result was amended" line on the
Desk, the Scores list or the bracket, and no history panel.

Recording was the gap - the previous score was being destroyed - so the table exists and the
trigger that fills it is tested. Deciding *where* an amendment should be visible is a design
question with more than one answer (a line in the match dialog, a column in Scores, a
correction badge on the tile), and picking one speculatively is how a surface ends up showing
half a story. Until then, reading it is an operator action:

```sql
select * from public.match_result_history
where table_name = 'tier_draw_matches' and match_id = '<id>'
order by changed_at;
```

### Retirement in the placement format
A player can stop mid-match — injury, a family matter, a walkover agreed on court — and the
supported format cannot record it. The only exception paths are `walkover` and `void`
(`resolve_match_exception`), and the desk hides both for the placement and bracket tables
(`isPlacement` in [`desk.tsx`](../src/routes/tournaments/$tournamentId/desk.tsx)), so
[`scheduling-decisions.md`](scheduling-decisions.md) states it as a rule: withdrawals and
walkovers are not part of the placement format. The desk is left inventing a full score or
voiding a match that was partly played.

This is deliberately deferred rather than half-built. The honest shape is a `retired` status
carrying the games played to the point of retirement, which is not a local change:

- the `status` CHECK on `placement_matches` and `tier_draw_matches` gains a value;
- `stage-progress.ts` decides played/settled from status sets, and a retirement is played but
  not a completed result;
- `court-state.ts`, `knockout-bracket.tsx`, the Scores filter and `standings.ts` each enumerate
  statuses and would silently misreport the new one;
- the placement tie-break reads two results per entrant, and a retirement is a loss with a
  partial record.

A cheaper alternative — allowing `walkover`/`void` on the two newer tables — loses the games
already played, so it is not the same feature and should not be mistaken for it. Not scheduled;
recorded so the gap is a decision rather than an oversight.

### Operator scripts and the Prettier backlog

`scripts/fake-day-one-results.mjs` and the `generate-/verify-placement-shift-migration.ps1`
pair are referenced only from documentation, not from `package.json` or CI. They are
historical operators' tools, not abandoned junk, so they stay. The repository-wide Prettier
backlog is unrelated to this work and was deliberately not addressed; `npm run lint` is not
a gate.
