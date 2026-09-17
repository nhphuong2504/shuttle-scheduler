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

## Applying `20260916020000_delete_tournament.sql`

### What it adds

`public.delete_tournament(p_tournament_id uuid)` — removes a tournament **whatever its
status**, including the active one, along with everything it owns. It backs the Delete button
on the setup page's tournament list.

### Why it is separate from `delete_tournament_draft`

`delete_tournament_draft` refuses anything that is not a Draft, and that refusal is the whole
safety story for the wizard's "Discard draft" button. It is a dead end for a host who
activated a tournament by mistake, or who wants to clear out a finished one, so this adds an
explicitly destructive sibling instead of relaxing the guard. Both are kept on purpose: one
refuses, the other does not.

### What cascades, and the two things that do not

Every tournament-owned table references `tournaments(id) ON DELETE CASCADE` — days, courts,
categories, teams, pools, pool entries, pool matches, draws, draw matches, and the per-day
court and break rows — so the cascade does the bulk of the work.

Two tables are outside that, for different reasons:

- `desk_activity` is a global audit trail keyed by `match_id`, with no `tournament_id` and no
  foreign key to tournaments. Its rows would outlive the tournament and keep appearing on the
  desk as activity for matches that no longer exist, so the function deletes this
  tournament's rows explicitly, before the matches cascade away and the link is lost.
- `players` is a **global roster**, not tournament-owned: it has no `tournament_id` and no
  cascade. Deleting a tournament deliberately leaves people intact, because the same player
  appears in the other tournaments too.

Deleting the active tournament simply leaves no tournament active — the partial unique index
that enforces a single active tournament has nothing left to enforce, and the desk falls back
to its empty state.

### Security

Admin-only, like the rest of the lifecycle RPCs, and it takes the same
`pg_advisory_xact_lock(hashtext('tournaments'))` as create/activate/discard so a delete cannot
interleave with an activation mid-flight.

`CREATE FUNCTION` grants EXECUTE to `PUBLIC` by default, so the migration revokes from `anon`
and `PUBLIC` and re-grants to `authenticated`. The hardening migration matched mutating RPCs by
name, but it could only revoke the ones that existed when it ran — a function created after it
is not covered, so every new RPC must repeat this for itself.

### Verify after applying

```sql
-- anon_can must be false and auth_can true
SELECT has_function_privilege('anon', 'public.delete_tournament(uuid)', 'EXECUTE') AS anon_can,
       has_function_privilege('authenticated', 'public.delete_tournament(uuid)', 'EXECUTE') AS auth_can;

-- the ACL must carry no entry with an empty grantee: that entry is PUBLIC
SELECT proacl FROM pg_proc WHERE proname = 'delete_tournament';
```

Then confirm the cascade is complete on a throwaway tournament:

```sql
SELECT public.create_tournament_draft('{"name":"Delete probe"}'::jsonb);
-- ...configure and activate it, or delete it as a draft...
SELECT public.delete_tournament('<id>'::uuid);

-- all of these must be zero
SELECT (SELECT count(*) FROM public.tournament_days        WHERE tournament_id = '<id>'::uuid) AS days,
       (SELECT count(*) FROM public.categories             WHERE tournament_id = '<id>'::uuid) AS categories,
       (SELECT count(*) FROM public.tournament_day_courts  WHERE tournament_id = '<id>'::uuid) AS day_courts,
       (SELECT count(*) FROM public.teams                  WHERE tournament_id = '<id>'::uuid) AS teams;
```

### Rolling back

`DROP FUNCTION public.delete_tournament(uuid)`. The wizard's Discard path is unaffected: it
still calls `delete_tournament_draft`, whose draft-only guard this migration never touched.

## Applying `20260916030000_tournament_notes.sql`

### What it adds

`tournaments.notes` — a free-text note about the event, capped at 2000 characters by a check
constraint. It is written from the wizard's Basics step alongside venue name and address, and
shown in the Review summary.

Unlike the rest of the wizard, the note stays **editable after activation**. It exists to carry
news — a court out of service, a changed warm-up time, late arrivals — and news does not wait for
a draft, so it has its own `set_tournament_notes(uuid, text)` RPC with no status guard. Everything
else about a running tournament stays frozen: `save_tournament_draft` still refuses anything that
is not a Draft, and this RPC writes one column only.

It is shared information rather than a private scratchpad. It is shown on the control desk, which
every role uses, so it should be written for anyone to read. Admin-only to write; readable
wherever the tournament is readable — `tournaments` already carries a public read policy, so no
new policy is involved.

### Why both RPCs are redefined

`create_tournament_draft` and `save_tournament_draft` both whitelist their payload keys, so
neither would have persisted a new field on its own. Both need it: the first step of the wizard
creates the draft directly and never calls the save path, so a note typed on the Basics step
would be lost if only the save RPC knew about the column.

`CREATE OR REPLACE FUNCTION` keeps the function's OID and therefore its ACL, so the hardening
revokes still hold and these redefinitions cannot reopen access to `anon`. That is asserted in
the verification below rather than assumed.

### Why there is a `notes_trim` helper

`btrim(x)` with no second argument trims **spaces only**. That is fine for the single-line
fields, but a note is multi-line, so a box containing just a newline would be stored as `"\n"`
instead of being treated as empty. `public.notes_trim(text)` trims the full whitespace set, and
is defined once so all three writers cannot drift apart.

### Verify after applying

```sql
-- the column and its limit exist
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'tournaments' AND column_name = 'notes';

SELECT conname FROM pg_constraint WHERE conname = 'tournaments_notes_length_check';

-- anon must still be locked out after the functions were replaced
SELECT has_function_privilege('anon', 'public.save_tournament_draft(uuid, jsonb)', 'EXECUTE') AS anon_can;
SELECT has_function_privilege('anon', 'public.set_tournament_notes(uuid, text)', 'EXECUTE') AS anon_can;

-- the round trip, including that an empty box clears the note
SELECT public.create_tournament_draft('{"name":"Note probe","notes":"  hello  "}'::jsonb);
SELECT notes FROM public.tournaments WHERE name = 'Note probe';          -- 'hello'
SELECT public.save_tournament_draft('<id>'::uuid, '{"name":"Note probe","notes":""}'::jsonb);
SELECT notes FROM public.tournaments WHERE name = 'Note probe';          -- NULL

-- and that it is still writable once the event is running
SELECT public.activate_tournament('<id>'::uuid);
SELECT public.set_tournament_notes('<id>'::uuid, 'Court 3 is out of action.');
SELECT status, notes FROM public.tournaments WHERE id = '<id>'::uuid;    -- in_progress, the new note
```

### Rolling back

`DROP FUNCTION public.set_tournament_notes(uuid, text); DROP FUNCTION public.notes_trim(text);
ALTER TABLE public.tournaments DROP COLUMN notes;` and restore the previous bodies of the two
draft RPCs.
