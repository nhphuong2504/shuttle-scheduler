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
| `activate_tournament(p_tournament_id)`                      | Draft -> In Progress. Delegates to `set_active_tournament`.                                                                                                 |
| `set_active_tournament(p_tournament_id)`                    | Points the active scope at a tournament that already exists. Re-runs readiness for a draft, skips it for one that has already run, then clears `is_active` on every row and sets the target `in_progress, is_active=true` under the same advisory lock `create_tournament` uses. |
| `delete_tournament_draft(p_tournament_id)`                  | Discards a draft; children cascade.                                                                                                                         |
| `add_tournament_day(p_tournament_id, p_date, p_start_time, p_end_time)` | Adds a playing day to a tournament that is already running. The date decides its position, and the days after it are renumbered to keep `day_number` in date order. |
| `remove_tournament_day(p_tournament_id, p_day_id)`          | Removes a playing day, refusing the last one and any day that still has matches attributed to it.                                                             |

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

- **Placement stage — no byes.** An odd entry count _holds_ one entrant out of round one. That
  entrant then plays two make-up matches in round two: first the seed-nearest round-one winner,
  then the seed-nearest loser. Holding is expressed as the _absence_ of a row rather than a "bye"
  row, which is what makes it neutral — there is nothing that can accidentally be counted as a
  win, a loss, or one of the entrant's two matches.
- **Knockout stage — byes allowed, and they go to the highest seed.** A knockout only needs to
  eliminate people, and standard seeding absorbs an awkward bracket size by rewarding the
  strongest entrants.

### What the first migration adds

| Table                | Holds                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `placement_entrants` | One row per team per category, with the skill level, the permanent seed and the tier.    |
| `placement_matches`  | Rounds one and two, including the make-up and crossover flags and the prerequisite list. |
| `tier_draws`         | One row per tier: bracket size, entrant count, and the champion once known.              |
| `tier_draw_matches`  | The bracket rounds, with byes pre-decided and `games` for a best-of-three rule.          |

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

| RPC                                                 | Purpose                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `sync_placement_entrants(category)`                 | Materialises one entrant per active team; waives withdrawn teams. Idempotent.       |
| `set_placement_skill(category, team, level)`        | The desk's skill override. Refused once seeds are locked.                           |
| `lock_placement_seeds(category, seeds)`             | Writes the seed order, shuffled or permuted by a drag. Refused if matches exist.    |
| `apply_placement_generation(...)`                   | Creates round one.                                                                  |
| `apply_placement_round_two(...)`                    | Creates round two, refused until every round-one result exists.                     |
| `apply_tier_draws(...)`                             | Writes the tier assignment and the four brackets. Re-checks the gate.               |
| `advance_tier_draw_locked(draw)`                    | Internal: pairs the adjacent slots of a finished round.                             |
| `report_placement_result(...)`                      | Reports a placement result under the **placement** scoring rule.                    |
| `report_tier_draw_result(...)`                      | Reports a knockout result under the **knockout** rule, then advances the bracket.   |
| `start_placement_match` / `start_tier_draw_match`   | Marks a match in progress without committing a result.                              |
| `reset_placement_result` / `reset_tier_draw_result` | Clears a result so it can be re-entered, refusing when a later round depends on it. |
| `apply_placement_day_schedule(...)`                 | Persists one GRASP pass for the placement or knockout stage.                        |

### Why the pairing algorithms are not in SQL

They live in TypeScript, in `src/lib/tournament/placement.ts` and
`src/lib/tournament/tier-draw.ts`, where `placement.test.ts` exercises every field size from 3 to
16 against _every_ combination of results and asserts that each entrant plays exactly twice, that
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

## Applying `20260917050000_placement_stage_reset.sql`

Adds `reset_placement_stage(p_tournament_id)` — the **"Delete results & schedule"** button on the
Court schedule tab. It is the way back to the start of the event without re-registering the field.

### What it does

One transaction that:

1. deletes every `tier_draw_matches` row for the tournament,
2. deletes every `tier_draws` row,
3. deletes every `placement_matches` row,
4. clears the placement state on `placement_entrants` — `seed`, `seed_locked_at`, `tier` and
   `excluded`.

It returns what it removed, as `{ placementMatches, tierDraws, tierMatches, entrants }`, so the desk
is told rather than left to guess.

The entrant rows themselves survive. They mirror the registrations, so deleting them would mean
re-syncing a field that has not changed. Clearing their state is what returns the stage to the point
it is at right after "Sync entrants" — the next action is **Shuffle & lock seeds**.

### Why it is an RPC rather than client-side deletes

- **Ordering.** `tier_draw_matches` and `tier_draws` both reference `placement_entrants`, and
  `tier_draw_matches` references itself. Four round trips from the client can fail halfway and leave
  a tournament with draws but no matches. One function is one transaction.
- **Authorization.** `placement_entrants` is writable by `admin`/`registrar` and the match tables by
  `admin`/`scheduler`, so no single staff role can clear both paths through the table policies. The
  RPC is **admin-only**, which is the only role that should be able to discard a played event.
- **Locking.** It takes the same `live-schedule` advisory lock as `apply_placement_day_schedule()`
  and `shift_live_schedule_after_match()`, so a reset cannot interleave with a build or a reflow.

Scoped to the placement format's own tables. The legacy round-robin tables are untouched.

### Verify after applying

The button appears next to **Build the schedule** on `/placement-schedule`, and only for admins. It
asks for confirmation, then reports what it removed. After it, the Placement tab should show every
event back at **Shuffle & lock seeds** with no matches:

```sql
-- both expect 0
select count(*) from public.placement_matches where tournament_id = '<id>';
select count(*) from public.tier_draws         where tournament_id = '<id>';
-- expect 0: nothing left seeded, locked, tiered or waived
select count(*) from public.placement_entrants
where tournament_id = '<id>'
  and (seed is not null or seed_locked_at is not null or tier is not null or excluded);
```

Proved against a real Postgres engine (PGlite) before it was committed — 19 checks covering what it
deletes, what it clears, the counts it returns, that a second tournament is untouched, that a
second run is harmless, that seeds can be re-locked afterwards without tripping the partial unique
index, that a waiver is cleared, that `scorer`/`scheduler`/`registrar`/anonymous are all refused,
and that the function is `SECURITY DEFINER` with no `anon` or `PUBLIC` grant.

## Applying `20260917060000_placement_desk_move.sql`

Adds the missing **move** for the placement format, so the Control Desk can run a placement
tournament as it runs a round-robin one. `20260917010000` already covers starting, scoring and
correcting a placement match; moving one by hand was the gap.

### Why it is not a widening of `reschedule_live_match`

`reschedule_live_match()` guards a move through `assert_match_eligible()`, which resolves a match's
players straight from `team_a_id` / `team_b_id`. A placement match has no team columns: it carries
entrant ids, and an entrant is what points at a team. Teaching that shared function about the new
tables would mean editing three duplicated occupancy CTEs inside the guarantee for the live
round-robin format, and it would cut across the separation between the two formats. So the placement
format gets its own helper and its own move.

### What it adds

1. **`placement_occupied_matches(p_tournament_id)`** — every placement-format match, with its
   resolved player list and its real end time. Both guards are then a single interval test over
   this, instead of repeating a four-branch union twice. It is deliberately **not** filtered to
   matches that already have a time: a match with no `scheduled_time` has a NULL `starts_at`, so it
   clashes with nothing, and keeping it in the set is what lets the move resolve the players of a
   match it is about to place for the first time.
2. **`reschedule_placement_match(p_table, p_match_id, p_court_id, p_scheduled_time)`** — one
   function for both placement tables, because the body is identical apart from the duration and the
   bye guard.

### The guards, and why they are not ceremony

The two rounds of a placement stage are not independent. Round two is generated from the round-one
winners and losers, and for an odd field the held entrant plays two make-up matches whose opponents
were picked from those sets. A match moved on top of another player's slot, or inside their rest
gap, produces a round two that is correct on paper and impossible on court. So the move refuses:

- a **court** that is occupied during the requested time,
- a **player** who is busy or still inside their rest gap,
- a move **into the past**,
- a court belonging to **another tournament**,
- a match that has **already started** — a started match is an anchor, not a movable row,
- a match with an **unassigned side**.

Both clashes are measured with the right duration for the stage: the **group** timings for the
placement rounds and the **knockout** timings for the A/B/C/D brackets. An in-progress match is
modelled as ending no earlier than now, so an overrun match still holds its court until it is
reported, and a **bye occupies nothing**.

### Verify after applying

On `/`, open a placement match on the Court board. **Move / delay** should offer a court and a time,
and:

| Attempt                                   | Expected                                                      |
| ----------------------------------------- | ------------------------------------------------------------- |
| Move to a free court and time             | Accepted, and the card moves                                  |
| Move onto a court busy at that time       | `That court is occupied during the requested time`            |
| Move a match whose player is playing then | `A player is busy or has not completed the required rest gap` |
| Move a match into its own rest gap        | Same message                                                  |
| Move to a past time                       | `A scheduled match cannot be moved into the past`             |
| Move a bracket match awaiting its teams   | `Both sides must be assigned before this match can be moved`  |

### What this migration deliberately does not do

**Walkovers and voids are not available for the placement format.** `resolve_match_exception()` only
accepts `pool_matches` and `draw_matches`. Rather than offer a control that fails, the desk hides the
Walkover and Void buttons for the two placement kinds. A no-show in this format is currently handled
by correcting the result and, if needed, regenerating the stage.

### Rolling back

```sql
DROP FUNCTION IF EXISTS public.reschedule_placement_match(text, uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.placement_occupied_matches(uuid);
```

The desk's **Move / delay** control then fails with a "function not found" toast, as it did before.

---

## Applying `20260917070000_placement_reset_clears_start.sql`

One-line fix to `reset_placement_result()`: clearing a placement result now also clears `started_at`.

### The defect

`reset_tier_draw_result()` already sets `started_at = NULL`, and so does `reset_and_repair_match()`
for the round-robin tables. `reset_placement_result()` was the only one that did not, which left a
placement match **"scheduled" while still carrying a real start time**. That is not cosmetic, because
two things read `started_at` unconditionally:

- `start_placement_match()` starts from `COALESCE(started_at, statement_timestamp())`. A match that
  was started, reset and started again therefore kept the **original** start, so the desk showed it as
  enormously overrun the moment it restarted.
- `placement_occupied_matches()`, added by `20260917060000` above, measures a match from
  `COALESCE(started_at, scheduled_time)`. A stale start time makes a reset match occupy a court from
  the wrong instant, so a hand-move could be refused against a match that is no longer happening.

The whole point of a reset is to put the match back to a clean, replayable state, so the start time
goes with the result. Nothing else about the function changes.

### Verify after applying

Start a placement match on `/`, clear its result, then start it again. The elapsed timer should
restart from `0′` rather than showing the time since the **first** start.

### Rolling back

Re-apply the `reset_placement_result` definition from `20260917010000_placement_stage_rpcs.sql`,
which is the version without `started_at = NULL`.

---

## Applying `20260917080000_placement_realtime_publication.sql`

Adds the placement tables to the `supabase_realtime` publication, so the desk and the schedule page
actually receive the changes the new format writes.

### The defect

Every screen subscribes with one `postgres_changes` channel on `public` and invalidates all its
queries when anything arrives (`useRealtimeRefresh`). Realtime only delivers rows for tables that are
**members of the publication**, and the placement tables were created without being added to it,
while `pool_matches`, `draw_matches` and the rest of the round-robin schema already are.

The result is a control desk that shows a `Live` badge and never updates: a result entered on one
screen does not appear on another, and a freshly built schedule stays invisible until a manual
reload. Because the badge only reports the channel's own state, nothing looks wrong — the channel is
genuinely subscribed, it simply never receives anything for these tables. That is why the symptom
reads as a stale page rather than as a connection problem.

Six tables are added, covering the placement stage and the per-day configuration the schedule page
edits:

| Table | Why |
| --- | --- |
| `placement_entrants` | seeds, tiers and waivers change as a build runs |
| `placement_matches` | generation, scheduling, start, report, move |
| `tier_draws` | a build creates the A/B/C/D brackets |
| `tier_draw_matches` | the knockout fixtures and their times |
| `tournament_day_courts` | per-day court sets feed the next build |
| `tournament_day_breaks` | per-day breaks feed the next build |

### Why it is a `DO` block and not six statements

`ALTER PUBLICATION … ADD TABLE` raises an error if the table is already a member, so each table is
checked against `pg_publication_tables` first. The publication itself is checked too, because it is
created by the platform rather than by these migrations and may legitimately be absent. Re-running
the migration is therefore a no-op.

### Verify after applying

Open `/` in two browser windows. Report or move a match in one; the other should update within a
second or two without a refresh. The same holds for `/placement-schedule`, whose running order is
now subscribed as well.

```sql
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
ORDER BY tablename;
```

All six tables above should be listed.

### Rolling back

```sql
ALTER PUBLICATION supabase_realtime DROP TABLE public.placement_entrants;
-- …and the other five. Harmless, but every screen goes back to manual refresh.
```

---

## Applying `20260917090000_placement_seed_reorder.sql`

Lets the host change the seed order by hand after **Shuffle & lock seeds** — dragging a row on the
Placement tab, or using the up/down arrows beside it — instead of only being able to re-shuffle.

### What it changes

**No new function.** `lock_placement_seeds()` already accepts a full permutation of the field: seeds
`1..N`, every non-waived team exactly once. That is precisely what a reorder sends. The shuffle and
the drag differ only in who chose the order, so they share one RPC and one validation path rather
than growing a second writer that could drift from the first.

What changes is one guard. It previously refused only a match that had been **decided**:

```sql
WHERE category_id = p_category_id AND status <> 'scheduled'
```

That was sufficient while the shuffle was the only caller, because the UI disabled the button as
soon as any match existed. It is not sufficient once rows can be dragged. A reorder after round one
has been generated is not a no-op: it permutes the seeds round one was paired *from*, so the matches
keep their pairings while the numbers beside them change — a bracket that still plays and quietly
misreports why anyone faced anyone. The check is now for any row at all:

```sql
IF EXISTS (SELECT 1 FROM public.placement_matches WHERE category_id = p_category_id) THEN
```

So the order is editable exactly while the placement stage is empty: after locking, and before the
Court schedule tab's **Build** generates round one. That was already the rule the Placement tab
enforced by disabling its button, so the only behaviour that changes is that the RPC now refuses a
state the client was already refusing to ask for.

The way back from a stage that has matches is unchanged and explicit: `reset_placement_stage()`
clears matches, draws and seeds together, and re-locking is available immediately afterwards.

### Verify after applying

```sql
-- The order is editable while this returns 0
select count(*) from public.placement_matches where category_id = '<id>';
```

On the Placement tab, with seeds locked and no matches: drag a row and the seed numbers renumber
under the cursor, the panel header reads **saving…** and then **locked** again, and a refresh keeps
the new order. Once a placement match exists the drag handles disappear and the panel says the order
is frozen.

### What it deliberately does not do

- **It does not preserve the skill blocks.** A host can drag a beginner to seed 1. The panel says so
  once the order stops following the blocks, and **Re-shuffle seeds** restores it. Enforcing the
  blocks here would make the control refuse moves the host can plainly see are legal.
- **It does not re-generate round one.** A reorder after generation is refused rather than silently
  rebuilding, because regeneration deletes and recreates the match rows, which would take that
  stage's schedule and court assignments with it.
- **It keeps no audit trail.** `seed_locked_at` is refreshed on every write, so it reads as "when
  this order was last set". Nothing keys off its value — `set_placement_skill()` only tests it for
  null — so a reorder moving it forward re-labels it rather than changing its meaning.

### Rolling back

Re-apply the `lock_placement_seeds` definition from `20260917010000_placement_stage_rpcs.sql`. The
drag control is harmless without it, but would start failing on the looser guard's terms. To remove
the control as well, revert the `SeedingPanel` in `src/routes/placement.tsx`.

Proved against a real Postgres engine (PGlite) before it was committed — 21 checks covering a first
lock, a hand-made permutation round-tripping, a refreshed lock timestamp, short and duplicate
payloads being refused, an unknown team being refused, a `scheduled` match now blocking a reorder
(the case the old predicate let through), a reported match still blocking it, re-locking working
again after a reset, and `anon`/`PUBLIC` still holding no `EXECUTE` while `authenticated` keeps it.

---

## Known behaviour: an early report rewrites the rest of that court's day

**Not a bug fix — this documents existing behaviour that is deliberate for now.** It was observed
while testing the queue, and it is recorded here because the trigger is a normal desk action rather
than a corruption.

### What happens

`shift_live_schedule_after_match()` gives a later match on a court its start from the previous
match's **real end**:

```sql
WHEN previous.actual_end IS NOT NULL THEN previous.actual_end
```

For a finished match that value is the raw `ended_at`, with no floor. The arm above it, for an
in-progress match, is written as `GREATEST(previous.shifted_time + previous.duration,
statement_timestamp())`, so it can never schedule into the past — but the finished arm has neither
that floor nor a bound of "not earlier than the planned start".

The result: **reporting a match meaningfully before its slot pulls every later match on that court
forward to the moment it was reported.** The pull is per court, unbounded, and cascades as each
next match is reported.

### How it shows up

Measured on the seeded field, 8 courts and 31 round-one matches, all reported about 18 hours ahead
of their 09:00 slot:

- 23 of the 31 rows had `scheduled_time` rewritten to a timestamp within ~1.1 seconds of the
  report calls.
- On **every one of the 8 courts** exactly the first match in the sequence kept its planned time —
  the reflow's own source, which is immovable — and every match behind it was rewritten.
- The matches that were rewritten were mostly **unplayed**. They were moved to a time that had
  already passed, so the running order showed them as overdue before anyone had been on court.

Ordinary use is not affected: report a match at or after its slot and the shift is minutes, which is
the intended "the day is running late / running ahead" adjustment.

### If it happens

A rebuild replans the _movable_ matches from the current time, so those recover on their own.
Reported matches are immovable anchors and keep the rewritten time, so a rebuild will not restore
the plan for those rows — correct `scheduled_time` on them directly if the displayed time matters.
Note that the rewritten value is usually when the match was genuinely played, so it is often right
in its own terms and only wrong as a _plan_.

### The change, if it is ever wanted

Two candidate one-line bounds, in increasing severity:

1. Floor the derived start at `statement_timestamp()`, so an unplayed match can never be moved into
   the past. This mirrors the guard the in-progress arm already has.
2. Take `GREATEST(previous.actual_end, current_match.shifted_time)` so a match is never moved
   earlier than it was planned at all, and only overruns push the rest of the day back.

Both are behavioural changes to a function shared with the round-robin format, which is why they are
recorded rather than applied.

---

## Fixed: a played match could stop the whole build

**This one was a bug, not a known behaviour, and it is fixed.** It is written down because its
symptom was "the schedule didn't update", which reads like a stale page rather than a hard failure.

### What happened

Reporting a match **ahead of its slot** is normal on the desk — the reflow section above shows it
leaves deliberate traces — and the scheduler models a reported match as occupying its whole planned
slot (see `fixedRange` in `placement-schedule.ts`). Two matches that were both played early can
therefore be modelled as overlapping.

At the same time, the GRASP validator checked every match, **anchors included**, against its
prerequisites:

```ts
for (const dependencyId of match.dependsOn ?? []) {
  if (slot.start.getTime() < dependency.end.getTime()) errors.push(…);
}
```

For an anchor that check is about history, and history can look violated for the reason above. Every
GRASP run then produced the same "invalid" verdict, `scheduleGroupStageGrasp` threw
`Day 1 scheduler produced no valid candidates`, and the build wrote **nothing at all** — not even the
matches that had nothing to do with the pair involved. The page reported the failure as a toast and
kept its old running order.

It surfaced on a heavily played field: 63 of 64 placement matches reported, 19 knockout fixtures
generated, and exactly **0** of them holding a court or a time.

### The fix

`runValidation` now skips the dependency check for fixed matches. A fixed match's time is given
rather than chosen, so it cannot be a placement the scheduler got wrong; only placements the
scheduler actually chose are judged. Ordering for movable matches is unchanged, and `dependsOn` is
still enforced during scheduling (`earliestStart`/`isEligible`), so the guarantee that a round-two
match follows the round-one match that feeds it is unaffected — it is now simply not re-litigated
against a match that has already been played.

Regression test: `planPlacementSchedule — a played match never fails the batch` in
`placement-schedule.test.ts`. It reproduces the exact production error when the guard is removed.

---

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

| Function                     | Result before            | Expected |
| ---------------------------- | ------------------------ | -------- |
| `placement_required_matches` | `200` (callable by anon) | `401`    |
| every other placement RPC    | `401 permission denied`  | `401`    |

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

---

## Applying `20260919010000_defer_day_courts_readiness.sql`

Stops the per-day court check from blocking activation, and redefines
`tournament_readiness()` so `ready` is computed from the blocking checks alone.

> **Superseded by `20260919030000_trim_readiness_to_setup_scope.sql`.** The court check is no longer
> advisory but gone, along with the other checks the wizard cannot act on. The `blocking` mechanism
> described below did survive, so read on for how it works — nothing uses it today.

### Why

Setup used to ask for the days, each day's hours **and** the courts in one step, because
`save_tournament_days` is what materialises the venue's `courts` rows. That is the only reason
the readiness gate contains "every day has at least one court": the gate and the court-creation
step were the same step, so the check could never fail for a wizard-created draft.

Courts moved to the first build on the Schedule page, where `set_tournament_courts` creates them.
Activation now happens **before** the venue's courts exist, so a blocking court check would make
the whole flow unreachable. It becomes advisory instead: still reported, because a schedule
genuinely cannot be built without it, but no longer holding Draft -> In Progress back.

Every other check stays blocking. All of them hold with the defaults a new draft is created with,
so a fresh tournament activates with an empty court list and a warning, which is the intended flow.

### How `blocking` works

Each check object gains an optional `blocking` field, and `ready` skips only checks that
explicitly carry `'blocking', false`:

```sql
'ready', NOT EXISTS (
  SELECT 1 FROM jsonb_array_elements(checks) c
  WHERE (c->>'ok')::boolean = false
    AND COALESCE((c->>'blocking')::boolean, true)
)
```

`blocking` **defaults to true**, so a check that predates this field — or one added later without
thinking about it — cannot silently become optional. `day_courts` is the only advisory.

The client mirrors this: `ReadinessCheck.blocking` is optional, `ReviewStep` counts a failing
advisory separately from a blocker, and only blockers disable the Activate button. `activate_tournament`
and `set_active_tournament` both keep reading `ready`, so the gate relaxes without touching either.

### Security

`CREATE OR REPLACE FUNCTION` restores the implicit `EXECUTE` grant to `PUBLIC`, and
`tournament_readiness` had been revoked by the auth-hardening migration. The revoke and grant are
therefore re-issued here — this is the failure mode `db-invariants.test.ts` exists to catch.

### Verify after applying

```sql
-- a draft with no courts must now be ready, with the court check failing but advisory
SELECT public.tournament_readiness('<draft-id>'::uuid);

-- anon must still be locked out after the function was replaced
SELECT has_function_privilege('anon', 'public.tournament_readiness(uuid)', 'EXECUTE'); -- false
```

### Rolling back

Re-apply the `tournament_readiness` definition from `20260916000000_tournament_creation_flow.sql`
(the version without `blocking`). Activation then demands per-day courts again, which the simplified
wizard cannot supply.

---

## Applying `20260919020000_set_tournament_courts.sql`

Adds `set_tournament_courts(p_tournament_id, p_count)` — sets how many courts the venue has,
backing the **Courts at the venue** field in the Schedule page's Settings panel.

### Why it is its own RPC

`save_tournament_days` cannot serve this: it refuses anything that is not a draft, and it rewrites
every day row as a side effect. This touches only the `courts` rows and the `court_count` summary,
so it can be called at any point in a tournament's life.

Per-day court assignments are deliberately left alone. With no `tournament_day_courts` rows for a
day, `courtsForDay` reads that day as "every court", which is exactly the state a fresh venue
should be in: a newly added court is available everywhere until a host says otherwise.

### The guard that matters

A court is `ON DELETE SET NULL` from every match, so removing one that is still in use would
**unassign a live match rather than fail**: the desk would lose the court a match is on, and the
schedule would quietly grow a hole. The function therefore refuses the shrink and names how many
courts are affected. All four match tables are checked — `placement_matches`, `tier_draw_matches`,
`pool_matches` and `draw_matches` — because a tournament has one format but the function is not
scoped to one.

The pool is then deleted above `p_count` and refilled from `generate_series(1, p_count)`, so it is
always numbered contiguously without ever colliding on the per-tournament unique number.

### Verify after applying

```sql
-- anon must be locked out
SELECT has_function_privilege('anon', 'public.set_tournament_courts(uuid, int)', 'EXECUTE'); -- false

SELECT public.set_tournament_courts('<id>'::uuid, 4);
-- expect 4 contiguous rows and a matching summary
SELECT number FROM public.courts WHERE tournament_id = '<id>'::uuid ORDER BY number;
SELECT court_count FROM public.tournaments WHERE id = '<id>'::uuid;
```

On `/placement-schedule`, open Settings, set the count and the header's court total updates. With a
match already on a court above the new count, the save is refused with a message naming the courts
still in use.

### Rolling back

```sql
DROP FUNCTION IF EXISTS public.set_tournament_courts(uuid, int);
```

The Settings field then fails with a "function not found" toast. The `courts` rows it created are
ordinary rows and are unaffected.

---

## Applying `20260919030000_trim_readiness_to_setup_scope.sql`

Redefines `tournament_readiness()` to check only what the setup wizard collects. The per-day court
check is removed rather than made advisory, along with three others: `day_windows`, `day_breaks` and
`rules`. Every check that remains is blocking, so the checklist is all-or-nothing again.

### Why the four checks could not do their job

The wizard was reduced to four inputs — the basics, a date range, the events and the fixed format.
Courts, each day's hours and breaks, match lengths and scoring rules all moved to the Schedule page.
Readiness was still checking those moved fields, which produced two kinds of noise on a screen whose
only job is to say what still has to be fixed:

| Check | Why it could not mean anything |
| --- | --- |
| `day_courts` | Cannot pass before activation by design, so it was a permanent advisory |
| `day_windows` | `buildDayRange` emits the 09:00–18:30 default for every day, so always green |
| `day_breaks` | The wizard creates no breaks at all, so always green |
| `rules` | Only ever read the column defaults; rules are edited after activation |

The deciding point is **when** the function runs. It is consulted as a draft is activated, and at
that moment every Schedule-owned field still holds its default — so none of these checks could catch
anything real. The `day_breaks` case is the clearest: it is the only guard against a break that falls
outside its day or overlaps another, but it runs before any break can exist, and nothing re-runs it
afterwards. Removing it costs no protection that was ever delivered.

The rule applied here: **a check has to validate something this wizard collects, or something derived
from what it collects.** A check over a field the organizer sets later is either always green or always
red at this point, and neither is a verdict on the draft. Six checks satisfy the rule and remain.

What actually protects the removed fields is the write path, which is where it belongs:

- `save_tournament_draft` rejects an unknown timezone and an even best-of.
- `save_tournament_days` rejects a day whose end is not after its start, in the same transaction.
- `updateTournamentMatchSettings` re-validates every scoring bound.
- `updateTournamentTimings` keeps slots positive and rest gaps non-negative.

`20260919010000` is superseded: it kept `day_courts` as an advisory, which this migration removes.
The `blocking` field and the `ready` expression are carried forward unchanged, so a check added later
can still be advisory without re-touching the gate.

### Verify after applying

```sql
-- a draft with no courts is ready, and the court check is gone from the list
SELECT jsonb_path_query_array(
  public.tournament_readiness('<draft-id>'::uuid) -> 'checks',
  '$[*].id'
);
-- expect exactly: basics, timezone, days, day_dates, categories, category_caps

-- anon must still be locked out after the function was replaced
SELECT has_function_privilege('anon', 'public.tournament_readiness(uuid)', 'EXECUTE'); -- false
```

On `/setup`, the Review step for a fresh draft lists six checks and reads *"All checks passed. This
tournament is ready to activate."* — no row about courts, day hours, breaks or match rules.

### Rolling back

Re-apply the `tournament_readiness` definition from `20260919010000_defer_day_courts_readiness.sql`.
The court and day-window rows come back; the court row returns as an advisory, so activation still
succeeds without courts.

---

## Applying `20260919040000_tournament_day_management.sql`

Lets a tournament that is already running gain or lose a playing day, and enforces that the days'
dates stay in order with their `day_number`.

### Why it was needed

`save_tournament_days` raises unless the row is still a draft, and the Schedule page only ever
updated a day that already existed. So the day count was frozen the moment a draft was activated,
and the case that actually comes up — the event overruns and needs one more day on the end — meant
rebuilding the tournament.

Two things had to be fixed first.

**The dates were not ordered.** `sliceRowsByDay` attributes a match to "the last day that had already
opened". It finds that by scanning the day windows in `day_number` order and taking the last start at
or before the match, which is only correct while the starts ascend. That held while setup was the
only writer, because `buildDayRange` emits one row per date in order. It stopped holding as soon as
the date could be typed by hand on the Schedule page, and nothing checked it. Dating day 2 before
day 1 made the scan read descending starts and file *every* match under a later day — the whole of
day 1 disappeared from the running order.

**A day could be deleted out from under its matches.** Matches carry an absolute `scheduled_time`
and no day foreign key, so deleting a day does not fail; it silently re-attributes the matches, and
the tournament's official close moves with them.

### What it does

- **`tournament_days_guard_order`** — a `BEFORE INSERT OR UPDATE` trigger that rejects two days
  sharing a date, and rejects a day whose number and date disagree with a neighbour. A trigger
  rather than validation inside the RPCs because the date is also editable by a plain table update
  from the Schedule page, so one guard covers every writer.
- **`add_tournament_day`** — inserts a day whose position is decided by its date. Rows at or after
  the target are stepped up **one at a time in descending order**, so each moves into a slot the
  previous move freed. A single multi-row `UPDATE` would give no ordering guarantee and trip the
  unique index on `(tournament_id, day_number)`. Refuses past the seven-day cap. A new day has no
  `tournament_day_courts` rows, which is stored state for "every court", so it can use the whole
  venue until it is narrowed.
- **`remove_tournament_day`** — refuses the last remaining day, and refuses any day that still has a
  match. A day's territory is the half-open span from its own opening to the next day's opening,
  which is the same rule `sliceRowsByDay` attributes by; the final day runs to infinity, because it
  is the one allowed to overrun. Checking the closing time instead would miss a match legitimately
  placed after its own day's end.

### The timezone detail

`date + start_time` is a wall clock. Compared against a `timestamptz` directly it would be cast using
the *session* timezone — UTC on Supabase — which is five or six hours off for a US venue and would
put every match on the wrong side of a boundary. The guard reads the window with
`AT TIME ZONE venue_timezone`. This is the first place in the repo a day window is compared against
`scheduled_time` at all; every other comparison is against `statement_timestamp()` or another
match's own time.

### Verify after applying

```sql
-- the trigger rejects a date that disagrees with the day number
UPDATE public.tournament_days SET date = date - 1 WHERE day_number = 2;
-- expect: ERROR: Day 2 has to fall in date order...

-- adding a day keeps the numbers in date order
SELECT public.add_tournament_day('<id>'::uuid, '<a date after the last day>'::date);
SELECT day_number, date FROM public.tournament_days ORDER BY day_number;  -- dates ascend

-- removing a day that has matches is refused
SELECT public.remove_tournament_day('<id>'::uuid, '<day-with-matches>'::uuid);
-- expect: ERROR: Day N still has M match(es) on it...

-- anon must still be locked out
SELECT has_function_privilege('anon', 'public.add_tournament_day(uuid, date, time, time)', 'EXECUTE'); -- false
SELECT has_function_privilege('anon', 'public.remove_tournament_day(uuid, uuid)', 'EXECUTE'); -- false
```

On `/placement-schedule`, **Settings → Playing days** shows an *Add day* date field and a *Remove*
button on each day card. *Remove* is disabled on the only remaining day and on any day with matches,
with the reason in its tooltip.

### Rolling back

```sql
DROP TRIGGER IF EXISTS tournament_days_guard_order ON public.tournament_days;
DROP FUNCTION IF EXISTS public.tournament_days_guard_order();
DROP FUNCTION IF EXISTS public.add_tournament_day(uuid, date, time, time);
DROP FUNCTION IF EXISTS public.remove_tournament_day(uuid, uuid);
```

The day rows are left as they are: the RPCs only ever renumbered them into date order, which is the
state the removed `sliceRowsByDay` behaviour also preferred.

---

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

**To re-run a test rather than remove the field**, use the **Delete results & schedule** button on
`/placement-schedule` instead of the reset block in that file. It clears the matches, draws, results
and schedule, and also the seed order and waivers, so the stage is back to "Shuffle & lock seeds" and
the field itself is left in place — see `20260917050000_placement_stage_reset.sql` above. The
commented reset block in the seed file remains the way to clear it from the SQL editor.

### Verify after running

Expect MS 13, MD 9, XD 8, WS 7, WD 5 entries, and 50 players carrying a `@tournova.test` email.
The odd fields are deliberate: an odd field is what makes the placement engine hold one entrant out
of round one and give them two make-up matches in round two, which is the format's least obvious
path.
