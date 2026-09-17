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

It is a note about the event rather than a private scratchpad, and the UI copy says so. It is not
published anywhere either: this version has no participant-facing screens, so the note is only
reachable from the admin-only setup wizard.

The note follows the rest of the wizard for editing: **it is not editable once the tournament is
activated**, because `save_tournament_draft` refuses anything that is not a Draft and no other
path writes this column. Making it editable mid-event would mean a new RPC and a surface outside
the wizard to call it from.

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
is defined once so the two RPCs cannot drift apart.

### Verify after applying

```sql
-- the column and its limit exist
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'tournaments' AND column_name = 'notes';

SELECT conname FROM pg_constraint WHERE conname = 'tournaments_notes_length_check';

-- anon must still be locked out after the functions were replaced
SELECT has_function_privilege('anon', 'public.save_tournament_draft(uuid, jsonb)', 'EXECUTE') AS anon_can;

-- the round trip, including that an empty box clears the note
SELECT public.create_tournament_draft('{"name":"Note probe","notes":"  hello  "}'::jsonb);
SELECT notes FROM public.tournaments WHERE name = 'Note probe';          -- 'hello'
SELECT public.save_tournament_draft('<id>'::uuid, '{"name":"Note probe","notes":""}'::jsonb);
SELECT notes FROM public.tournaments WHERE name = 'Note probe';          -- NULL
```

### Rolling back

`DROP FUNCTION public.notes_trim(text); ALTER TABLE public.tournaments DROP COLUMN notes;` and
restore the previous bodies of the two draft RPCs.

## Applying `20260917000000_placement_stage.sql` and `20260917010000_placement_stage_rpcs.sql`

These two add the storage and the RPCs for the **two-round placement** format. Apply them in
order, exactly the same way as the others (Lovable sync, or paste into the SQL editor and then
`NOTIFY pgrst, 'reload schema';`).

They are **purely additive**. The legacy round-robin tables (`pools`, `pool_entries`,
`pool_matches`, `draws`, `draw_matches`) and every function that touches them are left alone, so
both formats can live in one database and an existing tournament keeps behaving as before.

### The format, in one line

Every entrant plays two placement matches; the two results sort them into one of four
single-elimination draws.

```
WW -> Draw A    WL -> Draw B    LW -> Draw C    LL -> Draw D
```

### The bye rules are opposite, on purpose

This is the single easiest thing to get wrong, so it is worth stating plainly:

- **Placement stage — no byes.** An odd entry count *holds* one entrant out of round one. That
  entrant then plays two make-up matches in round two: first the seed-nearest round-one winner,
  then the seed-nearest loser. Holding is expressed as the *absence* of a row rather than a "bye"
  row, which is what makes it neutral — there is nothing that can accidentally be counted as a
  win, a loss, or one of the entrant's two matches.
- **Knockout stage — byes allowed, and they go to the highest seed.** A knockout only needs to
  eliminate people, and standard seeding absorbs an awkward bracket size by rewarding the
  strongest entrants.

### What the first migration adds

| Table                 | Holds                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------- |
| `placement_entrants`  | One row per team per category, with the skill level, the permanent seed and the tier.   |
| `placement_matches`   | Rounds one and two, including the make-up and crossover flags and the prerequisite list. |
| `tier_draws`          | One row per tier: bracket size, entrant count, and the champion once known.             |
| `tier_draw_matches`   | The bracket rounds, with byes pre-decided and `games` for a best-of-three rule.          |

Three constraints carry most of the weight:

- **`placement_matches_pairing_unique`** — an unordered pair of entrants may appear only once
  across the whole placement stage. This is the database-level guard for the invariant that
  matters most: nobody faces the same opponent twice, including across the crossover boundary.
- **`placement_entrants_seed_unique`** — seeds are unique per category, but only once assigned, so
  every entrant can sit at `NULL` until the seed order is locked.
- **`placement_required_matches()` / `placement_decided_matches()`** — the two-match gate, with
  explicit branches for fields of one and two, which cannot produce two matches at all.

The migration also redefines `delete_tournament` to clear `desk_activity` for the new match
tables. `desk_activity` is keyed by `match_id` with no foreign key to tournaments, so without this
its rows would outlive the tournament and keep appearing on the desk for matches that no longer
exist.

### What the second migration adds

All gated on `public.has_staff_role(...)`, matching the role the equivalent round-robin RPC uses.

| RPC                                    | Purpose                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `sync_placement_entrants(category)`    | Materialises one entrant per active team; waives withdrawn teams. Idempotent.             |
| `set_placement_skill(category, team, level)` | The desk's skill override. Refused once seeds are locked.                            |
| `lock_placement_seeds(category, seeds)` | Writes and freezes the shuffled seed order.                                              |
| `apply_placement_generation(...)`      | Creates round one.                                                                        |
| `apply_placement_round_two(...)`       | Creates round two, refused until every round-one result exists.                           |
| `apply_tier_draws(...)`                | Writes the tier assignment and the four brackets. Re-checks the gate.                    |
| `advance_tier_draw_locked(draw)`       | Internal: pairs the adjacent slots of a finished round.                                  |
| `report_placement_result(...)`         | Reports a placement result under the **placement** scoring rule.                          |
| `report_tier_draw_result(...)`         | Reports a knockout result under the **knockout** rule, then advances the bracket.         |
| `start_placement_match` / `start_tier_draw_match` | Marks a match in progress without committing a result.                         |
| `reset_placement_result` / `reset_tier_draw_result` | Clears a result so it can be re-entered, refusing when a later round depends on it. |
| `apply_placement_day_schedule(...)`    | Persists one GRASP pass for the placement or knockout stage.                              |

### Why the pairing algorithms are not in SQL

They live in TypeScript, in `src/lib/tournament/placement.ts` and
`src/lib/tournament/tier-draw.ts`, where `placement.test.ts` exercises every field size from 3 to
16 against *every* combination of results and asserts that each entrant plays exactly twice, that
no pairing ever repeats, and that a crossover is used exactly when `N mod 4` is 1 or 2.

The SQL here **validates and persists** instead of re-deriving: it re-checks the placement gate,
that every round-one result exists before round two, and that a batch did not silently drop a
match. A client bug can therefore produce a rejected call, never a corrupt bracket. The one
exception is `advance_tier_draw_locked`, which is pure set arithmetic with no algorithm to drift.

### Verify after applying

```sql
-- the tables exist with RLS on
SELECT relname, relrowsecurity FROM pg_class
WHERE relname IN ('placement_entrants','placement_matches','tier_draws','tier_draw_matches');

-- no mutating RPC is reachable by anon: every row must read false
SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('apply_placement_generation','apply_placement_round_two','apply_tier_draws',
                    'lock_placement_seeds','report_placement_result','report_tier_draw_result',
                    'apply_placement_day_schedule','sync_placement_entrants')
ORDER BY p.proname;

-- the no-rematch guard is real: an unordered pair may appear only once
SELECT least(entrant_a_id, entrant_b_id), greatest(entrant_a_id, entrant_b_id), count(*)
FROM public.placement_matches GROUP BY 1, 2 HAVING count(*) > 1;
```

Then regenerate `src/integrations/supabase/types.ts` against the project. **`types.ts` in this
repo has already been hand-extended with the four new tables and the new functions** so that the
code compiles before the migration is applied; a regeneration should produce the same shape, and
any difference means the migration and the committed types have drifted.

Finally run `npm run typecheck && npm run test` — `placement.test.ts` covers the pairing engine
independently of the database.

### Rolling back

```sql
DROP FUNCTION IF EXISTS public.apply_placement_day_schedule(uuid, text, jsonb),
  public.reset_tier_draw_result(uuid), public.reset_placement_result(uuid),
  public.start_tier_draw_match(uuid, uuid), public.start_placement_match(uuid, uuid),
  public.report_tier_draw_result(uuid, jsonb), public.report_placement_result(uuid, jsonb),
  public.advance_tier_draw_locked(uuid),
  public.apply_tier_draws(uuid, jsonb, jsonb, boolean),
  public.apply_placement_round_two(uuid, jsonb, boolean),
  public.apply_placement_generation(uuid, jsonb, boolean),
  public.lock_placement_seeds(uuid, jsonb),
  public.set_placement_skill(uuid, uuid, text),
  public.sync_placement_entrants(uuid),
  public.placement_check_games(jsonb, int, int, int),
  public.placement_decided_matches(uuid, uuid),
  public.placement_required_matches(uuid);
DROP TABLE IF EXISTS public.tier_draw_matches, public.tier_draws,
  public.placement_matches, public.placement_entrants;
```

Then restore the previous body of `delete_tournament` without the two new `UNION ALL` branches.
Dropping is safe: nothing in the round-robin schema references these tables.

## Applying `20260917030000_placement_live_schedule_shift.sql`

Closes the gap left by the two placement migrations: **reporting a placement result now moves the
rest of that day.** Before this, `shift_live_schedule_after_match()` only accepted
`pool_matches` and `draw_matches`, so a placement round that finished 20 minutes late silently ate
the gap before the next match on that court and the desk only found out when the day ran over.

Apply it after the two placement migrations and the helper-grant one. It is **purely additive** to
a live database: no table changes, no data changes, no signature changes.

### What it does

Two edits, and the second exists so the first is not dead code:

1. `shift_live_schedule_after_match()` learns about `placement_matches` and `tier_draw_matches`.
   Five additions at five anchors — a wider table guard, a fourth arm on the source-row lookup, two
   `UNION ALL` branches, two player-lookup inserts, two write-backs. The ~350 lines of reflow
   algorithm between them are byte-identical to the previous version.
2. `report_placement_result()` and `report_tier_draw_result()` call it after committing the result.
   In the knockout case the bracket is advanced **first**, then the day is reflowed, because
   advancing can create a match that is now ready to play and a reflow that ran first would not
   have known about it.

### Why it is additive rather than a rewrite

The reflow function is load-bearing and working, and there is no local database in this repo to
test a rewrite against. Re-emitting it by hand to add four branches would have put the
round-robin path at risk for no functional gain.

So the function body was copied out of `20260915000000_tournament_scoping.sql` byte-for-byte and
the new branches spliced in. `scripts/verify-placement-shift-migration.ps1` proves the result is
additive: it requires every line of the original function to appear in the new one, in order, with
exactly three deliberate one-line rewrites standing in for it, and it reports the four insertion
points. Run it after any edit to the source migration.

```sh
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-placement-shift-migration.ps1
```

`scripts/generate-placement-shift-migration.ps1` is the script that produced this file from the
source migration. It reads the source, not this file, so it is deterministic: re-running it
reproduces the committed migration byte-for-byte, and it fails loudly on a missing or ambiguous
anchor rather than splicing into the wrong place. It is kept so that editing the source migration
is a regenerate-and-verify, not a hand-merge.

The safety argument does not rest on the splice being careful, though. Every branch is scoped to
`source_tournament`, and a tournament has exactly one format, so for a round-robin tournament the
two new branches match zero rows and for a placement tournament the two legacy ones do. The two
sets of tables can never both contribute to a single reflow.

### The one addition it would be easy to miss

The source-row lookup was a two-way `IF ... ELSE`. Without a fourth arm, reporting a placement
result would have looked the match up in `draw_matches`, found nothing, and returned early on
`source_court IS NULL` — the reflow would have silently done nothing at all, which is the worst
available failure mode because it looks like success.

### Verify after applying

```sql
-- the guard accepts all four tables
SELECT pg_get_functiondef('public.shift_live_schedule_after_match(text, uuid)'::regprocedure)
  LIKE '%tier_draw_matches%' AS wired_in;                                    -- must be true

-- reporting now reflows: schedule two placement matches on one court, report the
-- first late, and the second must move
SELECT id, scheduled_time, status FROM public.placement_matches
WHERE tournament_id = '<id>'::uuid AND court_id IS NOT NULL ORDER BY scheduled_time;
```

Then, from the outside, confirm the report RPCs are still closed to `anon` — redefining a function
with `CREATE OR REPLACE` keeps its OID and therefore its ACL, but this asserts it rather than
trusting it:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$SUPABASE_URL/rest/v1/rpc/report_placement_result" \
  -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
  -d '{"p_match_id":"00000000-0000-0000-0000-000000000000","p_games":[]}'      # must be 401
```

### Rolling back

Restore the previous two function bodies: drop the `placement_matches` / `tier_draw_matches`
branches from `shift_live_schedule_after_match`, and restore `report_placement_result` /
`report_tier_draw_result` without the `PERFORM public.shift_live_schedule_after_match(...)` line.
The tables themselves are untouched, so nothing else changes.

## Applying `20260917040000_placement_day_schedule_slot_fix.sql`

**The knockout half of a build could not be written at all.** A build generated the A/B/C/D draws
and then failed with `column reference "slot" is ambiguous`, leaving every knockout match
unscheduled — so the desk saw 20 brackets appear and nothing on court.

### The defect

`apply_placement_day_schedule(p_tournament_id, p_stage, p_slots)` reads its payload in a loop whose
variable was called `slot`:

```plpgsql
DECLARE
  slot jsonb;
BEGIN
  ...
  FOR slot IN SELECT * FROM jsonb_array_elements(COALESCE(p_slots, '[]'::jsonb))
```

`tier_draw_matches` has a real column named `slot` (the position inside a bracket round). Inside
the `UPDATE public.tier_draw_matches ... WHERE id = (slot->>'match_id')::uuid` that writes a
knockout slot, `slot` was therefore ambiguous between the PL/pgSQL variable and the table column,
and Postgres rejected the entire statement.

The `placement` branch never failed, because `placement_matches` has no `slot` column. That
asymmetry is the whole reason the bug survived: the placement call commits, the knockout call
raises, and the client reports a failed rebuild with the knockouts missing.

### The fix

The variable is renamed to `v_slot_json`. Renaming beats qualifying the reference (`v_slot_json`
has no column to collide with) because the payload is read identically in both branches and only
one of the two tables collides. The function is otherwise identical to the definition in
`20260917010000_placement_stage_rpcs.sql`; the `REVOKE`/`GRANT` pair and `NOTIFY pgrst` are
re-issued so the replaced function keeps its lock-down and the schema cache reloads.

Purely a function replacement: no table changes, no data changes, no signature change. Safe to
apply at any time, and it takes effect on the next rebuild.

### Verify after applying

Rebuild the schedule from `/placement-schedule`. The summary should now report knockout matches
being placed alongside the placement rounds, and the running order should show the brackets filling
in. Then check that no assigned match was left without a court and time:

```sql
-- expect 0
select count(*) from public.tier_draw_matches
where status = 'scheduled' and not is_bye
  and (scheduled_time is null or court_id is null);
```

The fix was proved against a real Postgres engine (PGlite) before it was committed: the harness
applies the **original** definition and confirms it raises `column reference "slot" is ambiguous`,
then applies this file and confirms a knockout payload writes, that the placement branch still
writes, that the completeness guard still refuses to leave an assigned match unscheduled, and that
a byes-only knockout day still clears.

## Applying `20260917020000_placement_helper_grants.sql`

A two-statement follow-up to the RPC migration above. Apply it after both placement migrations.

### What it fixes

The RPC migration states that every function it creates repeats its own
`REVOKE ALL ... FROM anon, PUBLIC`, because `CREATE FUNCTION` grants EXECUTE to PUBLIC by default
and the auth-hardening migration could only close the functions that existed when it ran. Two of
them did not: the read-only helpers `placement_required_matches` and `placement_decided_matches`.

That was confirmed against the deployed project rather than inferred. Calling each function over
PostgREST with the publishable key:

| Function                        | Result before            | Expected          |
| ------------------------------- | ------------------------ | ----------------- |
| `placement_required_matches`    | `200` (callable by anon) | `401`             |
| every other placement RPC       | `401 permission denied`  | `401`             |

**This is not a data leak**, and the reason is worth stating so it is not over-read as one:

- Both helpers are `LANGUAGE sql` and **not** `SECURITY DEFINER`, so they run with the caller's
  rights and stay bound by the RLS policies on the tables they read.
- Those policies are `USING (true)` with an explicit `GRANT SELECT ... TO anon`, because the desk
  has a read-only unauthenticated view. An anonymous caller could already read the same rows
  directly.

So what this closes is a discrepancy between the code and its own stated gating — someone
auditing the surface from that header comment would have been auditing the wrong set of functions.

### Why it cannot break anything

Neither helper is reachable from the client: the TypeScript engine recomputes both numbers in
`placement.ts`. The only real callers are the `SECURITY DEFINER` functions in the same file, which
resolve the call with the owner's rights and are unaffected by the revoke.

### Verify after applying

```sql
-- both must read false
SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('placement_required_matches', 'placement_decided_matches')
ORDER BY p.proname;
```

Then re-run the round-trip check from the previous section. It must still behave identically: a
revoked helper is only ever called from inside a `SECURITY DEFINER` function, so the desk's own
actions are unaffected.

### Rolling back

`GRANT EXECUTE ON FUNCTION ... TO anon, PUBLIC;` for both. There is no reason to: the grant only
ever exposed a function the client does not call.

## The test field: `../seed/50-test-players.sql`

Not a migration, and the directory is the point. **Nothing in `supabase/seed/` is applied by
Lovable**, so this file leaves the hosted project alone until it is pasted into the SQL editor.
Moving it into this directory would instead make it fifty fake entrants in the live tournament on
the next push.

It inserts 50 players (30 men, 20 women) and registers them in `MS`, `WS`, `MD`, `WD` and `XD`, then
creates the matching `placement_entrants` rows with skill levels spread across all three seed
blocks. It does not generate rounds, lock seeds or write results -- those stay the desk's own
buttons. The file header documents the field plan, the idempotency, and the two commented blocks at
the end: one to reset the placement stage, one to remove the test data entirely.

It refuses to run if the placement stage is already under way (any `placement_matches`, or locked
seeds), because adding entrants to a category whose round one was already generated from a smaller
field corrupts the bracket silently.

### Verify after running

Expect MS 13, MD 9, XD 8, WS 7, WD 5 entries, and 50 players carrying a `@shuttlenet.test` email.
The odd fields are deliberate: an odd field is what makes the placement engine hold one entrant out
of round one and give them two make-up matches in round two, which is the format's least obvious
path.


