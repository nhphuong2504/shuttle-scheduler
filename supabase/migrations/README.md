# Migrations

Files here are applied in filename order (timestamp prefix). The hosted project is
`hdmfxndanyrbxedgboev` (see `supabase/config.toml`).

## Applying `20260915000000_tournament_scoping.sql`

This is the migration that introduces the `tournaments` entity as the top-level scope.
It is **non-destructive**: it renames `tournament_settings` to `tournaments`, keeps the
existing row's `id`, backfills `tournament_id` onto every existing court, category, team,
pool, draw and match row, materialises `tournament_days` from the old `day_1` / `day_2`
columns, and only then enforces `NOT NULL` and drops the retired day columns. Existing
live results survive.

There is no local Supabase CLI wired up in this repo (`supabase/config.toml` holds only
the project ref), so pick one of these:

1. **Lovable sync (preferred).** Push the branch that contains this file. Lovable applies
   pending migrations to the connected project, and the file also becomes visible in the
   Supabase dashboard's migration history.
2. **Supabase SQL editor.** Open the project's SQL editor, paste the whole file and run it
   as a single script. Afterwards, refresh the API schema cache so PostgREST picks up the
   new `tournaments` / `tournament_days` tables and the changed function signatures:

   ```sql
   NOTIFY pgrst, 'reload schema';
   ```

### Verify after applying

```sql
-- exactly one active tournament, created from the old settings row
SELECT id, name, day_count, court_count, is_active FROM public.tournaments;
SELECT day_number, date, start_time, end_time FROM public.tournament_days ORDER BY day_number;

-- nothing left unscoped
SELECT count(*) FROM public.courts   WHERE tournament_id IS NULL
UNION ALL SELECT count(*) FROM public.categories  WHERE tournament_id IS NULL
UNION ALL SELECT count(*) FROM public.teams       WHERE tournament_id IS NULL
UNION ALL SELECT count(*) FROM public.pools       WHERE tournament_id IS NULL
UNION ALL SELECT count(*) FROM public.pool_matches WHERE tournament_id IS NULL
UNION ALL SELECT count(*) FROM public.draws        WHERE tournament_id IS NULL
UNION ALL SELECT count(*) FROM public.draw_matches WHERE tournament_id IS NULL;
```

Then regenerate `src/integrations/supabase/types.ts` against the project and run
`npm run typecheck && npm run test`.

### Rolling back

There is no down migration. The retired columns (`day_1`, `day_2`, `day_start_time`,
`day_end_time`, `planning_end_time`) can be reconstructed from `tournament_days`, and the
added `tournament_id` columns are nullable-safe to drop, but any tournament created after
this migration (i.e. a second tournament) has no equivalent in the old singleton schema.

## Applying `20260916000000_tournament_creation_flow.sql`

This is the migration behind the admin-only tournament creation wizard. Apply it after the
scoping migration, exactly the same way (Lovable sync, or paste into the SQL editor and then
`NOTIFY pgrst, 'reload schema';`).

It is **additive and safe on a live database**: every new column has a default, and existing
rows are backfilled so an already-running tournament keeps behaving exactly as it did.

### What it adds

- **Draft lifecycle.** `tournaments.status` (`draft` / `in_progress` / `completed`) and
  `tournaments.format`. Existing rows are backfilled to `status='in_progress'` where
  `is_active`, and `format='round_robin'`, so nothing that is currently live changes status.
  Only `draft` tournaments are editable through the wizard, and only `in_progress` rows can
  be activated (or discovered as the active scope).
- **Basics.** `venue_name`, `venue_address`, `organizer_name`, `organizer_email`,
  `organizer_phone`, and `max_categories_per_player` (1–5). `venue_timezone` already existed
  and is now actually read by the app.
- **Per-stage scoring.** `placement_games_to` / `placement_win_by` / `placement_best_of` and
  `knockout_games_to` / `knockout_win_by` / `knockout_best_of`. Existing rows are backfilled
  to single-game-to-21 and best-of-three-to-21, which is what the code used to hardcode.
  Scoring is stored separately from duration; the existing `group_slot_minutes`,
  `knockout_slot_minutes` and `*_rest_gap_minutes` columns are reused as the placement and
  knockout durations and rest gaps. They are deliberately **not** renamed, because that would
  break the round-robin SQL without any functional gain.
- **`categories.gender`** (`men` / `women` / `mixed` / `open`), backfilled from `code`
  (MS/MD → men, WS/WD → women, XD → mixed). `entry_type` already encoded singles vs doubles,
  so no second column was added. This is what lets a Women's Singles event work without a
  code special-case.
- **`tournament_day_courts`** and **`tournament_day_breaks`**, both with the same RLS as
  `tournament_days` (public read, staff write). A day can now pick a subset of the court pool
  and declare optional breaks.

### What it changes in existing functions

- `enforce_two_category_cap()` no longer hardcodes a cap of 2; it reads the tournament's
  `max_categories_per_player`.
- `enforce_team_shape()` reads `cat.gender` instead of inferring gender from `cat.code`.
- `report_draw_result()` reads the tournament's knockout rule instead of hardcoding
  "best of three, race to 21, win by 2". `report_pool_result` is untouched, which is why
  group-stage scoring stays on the legacy 21 rule.
- `create_tournament()` is kept and simply becomes unreferenced by the app.

### What it deliberately does not do

- **No engine.** There is no placement-match generation, record derivation or draw
  generation. Activating a tournament flips its status; matches come later.
- **No scheduling changes.** Per-day courts and breaks are stored and editable but not yet
  enforced, and the per-stage durations and rest gaps are stored and displayed but not yet
  consumed by the scheduler.
- **No deletions.** `pools`, `pool_entries`, `standings.ts`, `/pools` and `/draws` are all
  left in place and simply unreferenced. `/pools`, `/draws` and `/schedule` were removed from
  the navigation only; their route files are intact and still reachable by URL.

### New RPCs

All are gated on `public.has_staff_role(ARRAY['admin'])`:

| RPC                                                         | Purpose                                                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_tournament_draft(p_payload jsonb)`                  | Creates the draft row from the basics step.                                                                                                                 |
| `save_tournament_draft(p_tournament_id, p_payload)`         | Updates basics, stage rules and the category cap. Raises unless the row is still a draft.                                                                   |
| `save_tournament_days(p_tournament_id, p_days)`             | Replaces the days, their courts and their breaks, keeping `day_count` / `court_count` in sync.                                                              |
| `save_tournament_categories(p_tournament_id, p_categories)` | Replaces the categories.                                                                                                                                    |
| `tournament_readiness(p_tournament_id)`                     | The authoritative review checklist, so the wizard's checks match the activation gate.                                                                       |
| `activate_tournament(p_tournament_id)`                      | Re-runs readiness, clears `is_active` on every row, then sets `status='in_progress', is_active=true` under the same advisory lock `create_tournament` uses. |
| `delete_tournament_draft(p_tournament_id)`                  | Discards a draft; children cascade.                                                                                                                         |

### Verify after applying

```sql
-- every existing tournament was backfilled, and the active one is still in progress
SELECT name, status, format, placement_best_of, knockout_best_of, max_categories_per_player
FROM public.tournaments ORDER BY created_at;

-- no category is left without gender metadata
SELECT code, gender, entry_type FROM public.categories ORDER BY code;

-- a draft can be created, checked and activated end to end
SELECT public.create_tournament_draft('{"name":"Test","venue_timezone":"Asia/Kuala_Lumpur"}'::jsonb);
SELECT public.tournament_readiness('<draft-id>'::uuid);
SELECT public.activate_tournament('<draft-id>'::uuid);
SELECT id, status, is_active FROM public.tournaments WHERE is_active;

-- the cap is read from configuration, not hardcoded
UPDATE public.tournaments SET max_categories_per_player = 3 WHERE id = '<draft-id>';
```

Then regenerate `src/integrations/supabase/types.ts` against the project and run
`npm run typecheck && npm run test`.

### Rolling back

Drop `tournament_day_courts` and `tournament_day_breaks`, restore the previous bodies of
`enforce_two_category_cap`, `enforce_team_shape` and `report_draw_result`, and drop the added
`tournaments` and `categories` columns. Drafts are safe to delete first; activated
tournaments are not, because they are the active scope.

## Applying `20260916010000_tournament_auth_hardening.sql`

**Apply this immediately after the creation-flow migration.** It closes a hole that made
every admin-only RPC callable with the publishable (anon) key, including
`activate_tournament`.

### The two defects

1. **`has_staff_role()` returned NULL, not false, for a caller with no staff row.**
   `current_staff_role()` selects from `staff_roles` matching `auth.uid()` or the JWT email.
   With neither, the SELECT returns no row, so the function returned NULL and so did
   `has_staff_role()`.

   Every guard in the codebase is written `IF NOT public.has_staff_role(...)`. In PL/pgSQL
   `NOT NULL` is NULL and `IF NULL THEN` does not run, so the guard silently passed and
   execution continued. This affected **all 35 guards across eight migrations**, not only the
   creation-flow ones — which also meant any signed-in user without a staff role could reach
   them.

2. **`CREATE FUNCTION` grants EXECUTE to PUBLIC by default.** The creation-flow migration
   granted EXECUTE to `authenticated` but never revoked that implicit PUBLIC grant, so `anon`
   retained access through PUBLIC. Older RPCs were only safe because an earlier migration
   revoked them explicitly; `create_tournament` and the seven new draft RPCs were not.

Either defect alone would have been enough. Together they exposed the functions to
unauthenticated callers.

### What the fix does

- Redefines `has_staff_role()` as `COALESCE(current_staff_role() = ANY(needed), false)`, so
  "no staff row" is an explicit false. This repairs **every** call site at once, including
  the RLS policies, which had been denying access only incidentally because NULL is not true.
- Revokes EXECUTE from `anon` and `PUBLIC` on all seventeen mutating RPCs and re-grants to
  `authenticated`. It matches by function **name** rather than signature, because several of
  these were redefined with different argument lists across migrations
  (`apply_day_schedule` in particular), and a hardcoded signature list would silently miss an
  overload.

`current_staff_role()` and `has_staff_role()` stay callable by `anon`: the app needs the
former to render the signed-in role, and RLS policies evaluate the latter for anonymous
reads, where it now simply returns false. Neither is a write path.

### Verify after applying

```sql
-- must be false, never NULL, for a sessionless caller
SELECT public.has_staff_role(ARRAY['admin']);

-- anon must not hold EXECUTE on any mutating RPC
SELECT p.proname, array_to_string(p.proacl, ' | ') AS acl
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('create_tournament_draft','save_tournament_draft','save_tournament_days',
                    'save_tournament_categories','tournament_readiness','activate_tournament',
                    'delete_tournament_draft','create_tournament','report_draw_result')
ORDER BY p.proname;
```

Then confirm from outside the database that the anon key is refused. Both of these must come
back `401 permission denied for function`, not `200`:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$SUPABASE_URL/rest/v1/rpc/create_tournament_draft" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  -H 'Content-Type: application/json' -d '{"p_payload":{"name":"probe"}}'
```

### Rolling back

Not advisable, and there is no reason to: the fix only ever removes access that should never
have been granted. Reverting the `has_staff_role` body would restore the bypass.
