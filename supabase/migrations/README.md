# Migrations

Files here are applied in filename order (timestamp prefix).

The hosted projects are `dzilzdxzdrrbdimhbiwv` (staging) and `bwzemvaftzforfmaprif`
(production); migrations reach them with `npm run db:push`, or `scripts/apply-migrations.mjs`
where `db:push` cannot log in — see "Replaying the migrations" below. The ref in
`supabase/config.toml` is not one of them: it names the *local* stack, and the CLI keeps the
linked hosted project separately in `supabase/.temp/`.

## Applying `20260915000000_tournament_scoping.sql`

This is the migration that introduces the `tournaments` entity as the top-level scope.
It is **non-destructive**: it renames `tournament_settings` to `tournaments`, keeps the
existing row's `id`, backfills `tournament_id` onto every existing court, category, team,
pool, draw and match row, materialises `tournament_days` from the old `day_1` / `day_2`
columns, and only then enforces `NOT NULL` and drops the retired day columns. Existing
live results survive.

The Supabase CLI is wired up as a devDependency, so the migrations can also be pushed
straight from a checkout (link once per clone, then push):

```sh
SUPABASE_PROJECT_ID=<ref> npm run db:link
npm run db:push
```

`db:link` and `db:push` read the token from `SUPABASE_ACCESS_TOKEN`, and `db:push` additionally
needs a database password. With only a personal access token the CLI is refused when it asks
the project for a login role (403), so use `scripts/apply-migrations.mjs` in that case — it
replays the same files through the Management API, which needs no password. Where a change is
applied by hand instead:

1. **Supabase SQL editor.** Open the project's SQL editor, paste the whole file and run it
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
scoping migration, exactly the same way (paste into the SQL editor, then
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
order, exactly the same way as the others (paste into the SQL editor, then
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

Adds `reset_placement_stage(p_tournament_id)` — the **Reset** button in the header of the
**Placement** tab, beside *Enter results in Scores*. It is the way back to the start of the event
without re-registering the field.

> **Its scope is now half of what it was.** This function also backed the Schedule tab's reset until
> `20260926000000_placement_schedule_reset.sql` split the two apart. The Schedule tab calls
> `reset_placement_schedule` now, which leaves the seeding alone; this one is reached only from the
> Placement tab, which owns the seed order. The entrant state it clears — step 4 below — is now the
> whole difference between the two actions, so read it as "what the stage reset does that the
> schedule reset does not".
>
> **It is also gated now.** `20260926010000_placement_stage_reset_gate.sql` makes it refuse while the
> schedule still holds any match or draw, because the seeding is what round one was paired from. Read
> the section for that migration before the verify steps below: the button is only available once the
> schedule has been cleared.

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

The button is the folded **Reset** panel at the top of `/placement`, and only for admins. It is
available once the schedule has been cleared (see `20260926010000_placement_stage_reset_gate.sql`).
It asks for confirmation, then reports what it removed. After it, the Placement tab should show every
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

## Applying `20260926000000_placement_schedule_reset.sql`

Adds `reset_placement_schedule(p_tournament_id)` — the **Schedule** tab's reset, which discards the
schedule and **keeps the seed order**. It is the sibling of `reset_placement_stage`, and the two now
differ by exactly one thing: what they do to `placement_entrants`.

### Why the one action, which did both, had to be split

`reset_placement_stage` was the only way back from a bad build, and it took the seeding with it. So
on the Schedule tab, "rebuild the schedule" and "start the tournament over" were the same button.
Scheduling is a later and separate decision than seeding — the host locks seeds on the Placement
tab, then builds days on the Schedule tab — and a rebuild is routine: days change, a court is lost,
a stage is regenerated. Losing an order set by hand, or silently re-admitting a withdrawn team by
clearing its waiver, is not a cost a rebuild should carry.

### What it does

One transaction that:

1. deletes every `tier_draw_matches` row for the tournament,
2. deletes every `tier_draws` row,
3. deletes every `placement_matches` row,
4. clears `placement_entrants.tier` where it is not already null.

It returns what it removed, as `{ placementMatches, tierDraws, tierMatches }`.

**`seed`, `seed_locked_at` and `excluded` are not touched**, and that is the whole point of the
function. Step 4 is not part of "the seeding": the A/B/C/D draw is decided by the placement RECORD
(WW/WL/LW/LL), not by the seed, so once the matches holding those results are deleted a stored tier
is a label with nothing behind it — and the next `apply_tier_draws` overwrites it anyway. Clearing it
keeps the row honest in the window between the two.

### The stage it leaves is one the Schedule tab can build from

With the seeds still locked and no round-one rows, `buildCategoryView` reads the stage as `round1`,
and `generateMissingStages` regenerates round one from the seed order. That is the intended shape:
after this reset, **Build the schedule** rebuilds, and the host still has the ordering they set.
Clearing the seeds would put the stage back at `seeding`, where the build refuses to run at all —
which is exactly why the full reset belongs on the tab that also offers **Shuffle & lock seeds**.

### Authorization and locking

Admin-only, and it takes the same `live-schedule` advisory lock as `apply_placement_day_schedule()`
and `shift_live_schedule_after_match()`, so a reset cannot interleave with a build or a reflow.
`CREATE FUNCTION` grants `EXECUTE` to `PUBLIC`, so the migration repeats the `REVOKE`/`GRANT` pair
that every new RPC has to carry for itself.

### Verify after applying

The Reset panel at the foot of `/placement-schedule` (admin-only, folded behind **Show**) discards
the schedule and reports what it removed. Count the seeding before and after — it must not move:

```sql
-- run before and after the button; the two rows must be identical
select count(*) filter (where seed is not null) as seeded,
       count(*) filter (where excluded)      as waived
from public.placement_entrants where tournament_id = '<id>'::uuid;

-- expect 0: the schedule is gone
select (select count(*) from public.placement_matches where tournament_id = '<id>'::uuid) as placement,
       (select count(*) from public.tier_draws      where tournament_id = '<id>'::uuid) as draws,
       (select count(*) from public.tier_draw_matches where tournament_id = '<id>'::uuid) as knockout;
-- expect 0: the derived tier is cleared
select count(*) from public.placement_entrants
where tournament_id = '<id>'::uuid and tier is not null;
```

Proved against a real Postgres engine (PGlite) before it was committed — 11 checks covering the
counts it returns, that a played field's seeds, lock timestamps and waivers all survive while every
tier is cleared, that the matches and draws are gone, that a second tournament is untouched, that a
second run is harmless, that a non-admin and an unknown tournament are both refused, that the stage
reset still clears the seeding, and that `anon` holds no `EXECUTE` while `authenticated` does.

## Applying `20260926010000_placement_stage_reset_gate.sql`

Redefines `reset_placement_stage()` so it refuses while the schedule still holds anything paired from
the seed order. **One guard, everything else identical** — same deletes, same counts, same
admin-only check and `live-schedule` advisory lock.

### Why the order of the two resets is now enforced

`reset_placement_stage` is the one reset that discards the **seed order**, and that order is not
free-standing: round one is paired *from* it, so a bracket that still exists is a bracket whose
pairings only make sense against the seeding behind it. Clearing the seeding while those rows survive
leaves matches that still play and can no longer explain why anyone faced anyone. That is the same
hazard `20260917090000` closed for a hand reorder, one step further on: there a stale order
misreported a live bracket, here it is deleted out from under one.

So the order goes only once nothing depends on it. `reset_placement_schedule` clears the schedule and
keeps the seeding, so the sequence is **clear the schedule, then clear the seeding**. The two remain
independent actions; this only fixes their order. Raising rather than silently doing both preserves
the reason the split exists — a host who only meant to rebuild never loses an order set by hand,
because the destructive step has to be asked for on its own after the safe one.

### Why the gate is in the database and not only on the button

`reset_placement_stage` is reachable over PostgREST by any admin session, so a guard that lives only
in the React tree is a guard the next caller does not have. The Placement tab mirrors the refusal —
it reads the same three tables and disables the header button with the reason on it — so the host is
told before they press rather than after.

### What it refuses on

Any row in `placement_matches`, `tier_draws` or `tier_draw_matches` — the exact set
`reset_placement_schedule` clears. `tier_draw_matches` is redundant with `tier_draws` through the
cascade, but listing it explicitly makes the gate read as that same set, so if the set ever grows the
two functions drift together rather than one silently admitting a state the other still has work for.

The lock is taken **before** the gate, not after: the check and the deletes have to be one decision,
or a build that slipped a round-one row in between them would be deleting rows the gate had just
approved.

### Verify after applying

On `/placement` with a built schedule, the **Reset** button in the header is disabled and carries the
refusal as its description. Clear the schedule from the Schedule tab first, then it becomes
available.

From the SQL editor, with anything still paired from the order:

```sql
-- expect: ERROR: Clear the schedule first: this reset discards the seed order, ...
SELECT public.reset_placement_stage('<id>'::uuid);
```

And once the schedule is clear, the same call deletes and reports as it always did:

```sql
-- anon must still be locked out after the function was replaced
SELECT has_function_privilege('anon', 'public.reset_placement_stage(uuid)', 'EXECUTE'); -- false
SELECT has_function_privilege('authenticated', 'public.reset_placement_stage(uuid)', 'EXECUTE'); -- true
```

Proved against a real Postgres engine (PGlite) before it was committed — 21 checks. They cover the
differential first: the **base** definition does not refuse a fully built schedule and deletes the
bracket and the seeding together, which is the behaviour this migration changes. Then that each of
the three tables stops the reset **on its own**, so no branch of the gate is dead code; that a
refusal is a refusal, leaving every entrant row untouched rather than deleting some rows before
raising; that a cleared schedule is allowed and clears seed, lock, tier and waiver; that the counts
still come back; that a second run is harmless; that one tournament's schedule does not block
another's and a reset leaves the other untouched; that an unknown tournament and a non-admin are
both refused; and that the replaced function is still `SECURITY DEFINER` with `search_path` pinned
and holds no `EXECUTE` for `anon` while `authenticated` keeps it.

### Rolling back

Re-apply the `reset_placement_stage` definition from `20260917050000_placement_stage_reset.sql`. The
full reset then discards the seeding whatever is on the schedule again, which is the behaviour that
could strand a live bracket.

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

The way back from a stage that has matches is unchanged and explicit, and there are now two of them:
`reset_placement_schedule()` clears the matches and draws and keeps the seeding, and
`reset_placement_stage()` clears the seeds along with them. They are taken in that order — since
`20260926010000` the stage reset refuses until the schedule reset has run, because the order being
discarded is what the surviving bracket was paired from. Re-locking is available immediately after
either.

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

Per-day court assignments are deliberately left alone **by this function**. With no
`tournament_day_courts` rows for a day, `courtsForDay` reads that day as "every court", which
is exactly the state a fresh venue should be in: a newly added court is available everywhere
until a host says otherwise.

That shorthand is only free for a day nobody has narrowed. A day that was narrowed to an
explicit subset would keep playing on the old courts and silently ignore every court added
afterwards, which is what made "add a court" look like it worked on some days and not others.
So the *caller* closes the gap: the Schedule page re-reads the pool after a grow and extends
every narrowed day with the new courts (`courtsAddedToDays`, in
[`src/lib/tournament/scheduling/day-plan.ts`](../../src/lib/tournament/scheduling/day-plan.ts)).
Keeping it there rather than here is deliberate — this function is the shape of the pool, and
it stays independent of how a day chooses to narrow it.

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

Not a migration, and the directory is the point. **Nothing in `supabase/seed/` is applied
automatically**, so this file leaves the hosted project alone until it is pasted into the SQL editor.
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

**To re-run a test rather than remove the field**, use the **Reset** button in the header of
`/placement` instead of the reset block in that file. It clears the seed order and any waivers, so
the stage is back to "Shuffle & lock seeds" and the field itself is left in place — see
`20260917050000_placement_stage_reset.sql` above. Since
`20260926010000_placement_stage_reset_gate.sql` it is available only once the schedule is clear, so a
played stage is cleared in two steps: **first** the Schedule tab's Reset panel, which discards the
matches and draws and **keeps** the seed order, **then** this button. That first step is also the
whole answer when the test is only being replayed, and the schedule is simply rebuilt on the same
seeding. The commented reset block in the seed file remains the way to clear it from the SQL editor,
and it is ungated because it runs as the SQL editor's own role rather than through the RPC.

### Verify after running

Expect MS 13, MD 9, XD 8, WS 7, WD 5 entries, and 50 players carrying a `@tournova.test` email.
The odd fields are deliberate: an odd field is what makes the placement engine hold one entrant out
of round one and give them two make-up matches in round two, which is the format's least obvious
path.

---

## Applying `20260920000000_realtime_publication_membership.sql`

Declares the whole `supabase_realtime` publication membership in the repository, so a rebuilt
database behaves like the hosted one.

### Why `20260917080000` was not enough

That migration adds the six placement tables and returns early with a `NOTICE` if the publication
is absent. It also only ever covered the placement work. The rest of the membership —
`pool_matches`, `draw_matches`, the tournament structure, the roster — was configured in the
Supabase dashboard and exists **only** in the hosted project.

That is invisible until it is not. Every screen subscribes with one unfiltered channel:

```ts
supabase.channel("ops-live").on("postgres_changes", { event: "*", schema: "public" }, …)
```

The subscription has no table filter, so a table that is missing from the publication does not
narrow the subscription — it silently drops that table's events. The channel still reports
`SUBSCRIBED`, so the desk still shows its `Live` badge, while a result entered on one court never
appears on another until someone reloads by hand. A subscribed channel that never fires is
indistinguishable from a quiet tournament, which is what makes this worth a migration rather than
a note.

### What it does

One `DO` block that ensures the publication exists, then adds every table the application reads
that is not already a member. Membership is checked against `pg_publication_tables` before each
`ADD`, because `ALTER PUBLICATION … ADD TABLE` raises on a duplicate; a table that does not exist
in a given database is skipped with a `NOTICE` rather than failing.

Nineteen tables are listed. The list is deliberately **every table the app reads**, not only the
match tables: because the subscription is unfiltered, omitting one drops its events rather than
excluding it from a narrower subscription.

### What it deliberately does not do

It adds **no `GRANT`**. It is tempting to grant `SELECT` on all tables so the publication is
"readable", but Realtime authorizes `postgres_changes` through each table's RLS policies, and a
blanket grant here would reverse `REVOKE SELECT ON public.players FROM anon` from
`20260910000115` — which exists precisely to stop the roster, including emails and phone numbers,
being readable with the publishable key. Table grants belong with their table.

### Verify after applying

```sql
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
ORDER BY tablename;
```

Every table the app reads must be listed. Better, prove it end to end: open `/` in two browser
windows and report a match in one — the other should update without a refresh. `npm run
test:integration` also asserts delivery for the roster and for a tournament day write.

### Rolling back

```sql
ALTER PUBLICATION supabase_realtime DROP TABLE public.<table>;
```

Harmless, but the desk goes back to manual refresh.

---

## Comparing two projects: `scripts/parity-dump.sql` and `scripts/migration-drift-check.sql`

The files here are **not a complete record of the live schema**, and these two scripts exist to
measure the difference rather than assume it. They matter if this project is ever replayed onto a
new Supabase project.

### Why not to trust a replay

- `20260909233700_tournament_hardening.sql` and
  `20260910000044_d292a59b-d108-4b79-9c0e-7ed044025230.sql` are **near-duplicates** — 706 and 696
  lines defining the same 17 functions, 1 table, 13 policies and 5 triggers, differing by 58 lines
  that are almost entirely comments. Which one represents the intended state is not recoverable
  from the files.
- Six migrations carry **UUID filenames** rather than timestamps (`95225afa`, `da4b8e8e`,
  `d292a59b`, `db7cefc0`, `24b8a1fb`, `a81552e2`), which is the naming the dashboard writes when a
  change is made in the editor. `20260909220822` is a single `ALTER TABLE`.
- No migration runs `CREATE EXTENSION`, yet the schema needs `pgcrypto` for `gen_random_uuid()`.
- No migration creates the `supabase_realtime` publication.

Each of those is a change that may live only in the hosted database. Replaying the repository onto
a fresh project can therefore succeed and still produce a different database.

### `scripts/parity-dump.sql`

Run on both projects, save each result, and `diff` them:

```sh
SUPABASE_DB_URL='postgresql://...old' npm run db:parity > /tmp/old.tsv
SUPABASE_DB_URL='postgresql://...new' npm run db:parity > /tmp/new.tsv
diff /tmp/old.tsv /tmp/new.tsv
```

`SUPABASE_DB_URL` is the Postgres connection string from the dashboard's Connect panel — not the
`https://<ref>.supabase.co` API URL. It goes through `scripts/run-sql.mjs`, which refuses anything
that is not a single read-only statement, so pointing it at the live project cannot write.

It emits a definition-level dump — rows of
`kind | name | definition`, ordered deterministically — covering schemas, extensions, columns,
constraints, indexes, sequences, functions (full `pg_get_functiondef` bodies, plus
`security_definer` and `search_path`), policies (including `qual` and `with_check`), RLS flags,
triggers (including `auth`), views (including `reloptions`, so a lost `security_invoker` shows up),
table and function grants read from the ACL, default privileges, publication membership, and
database settings.

Definitions rather than counts, because a count of 17 functions matches whether or not the bodies
are identical — and a body is where the scoring and generation rules live. Likewise, a policy with
the same name and a different `qual` is a different authorization rule.

### `scripts/migration-drift-check.sql`

Run on the **old** project:

```sh
SUPABASE_DB_URL='postgresql://...old' npm run db:drift
```

It compares `supabase_migrations.schema_migrations` against the file
list and reports three things: versions applied with no local file (a change that exists only in
that database), files never applied, and an explicit `OK` line with the counts when they agree. It
prints an `OK` row rather than nothing, because zero rows is indistinguishable from a query that
did not run.

The expected list is generated from `ls supabase/migrations/*.sql`; regenerate it if migrations are
added before the check is run.

Both scripts were run against a real Postgres engine (PGlite) before they were first used against a
hosted project, and doing so caught two defects that would otherwise have surfaced on the first
real run: a missing `UNION ALL` between the extensions and columns branches of the parity dump, and
two `text || "char"` concatenations (`provolatile`, `defaclobjtype`) that Postgres refuses to
resolve. `run-sql.mjs` is also verified to refuse a non-read-only statement, a multi-statement
file, and a missing connection string.

### Running both without a database password

Neither script needs one. `run-sql.mjs` takes `--project-ref` and goes through the Management API
using `SUPABASE_ACCESS_TOKEN`:

```sh
node scripts/run-sql.mjs scripts/parity-dump.sql --project-ref <ref>
```

That transport is not a convenience. Neither replacement project has a database password anyone
holds — the connection string the API returns carries `[YOUR-PASSWORD]` where the password goes —
so without it these two scripts are unrunnable in exactly the situation they were written for. The
read-only refusal is enforced on both paths.

### Replaying the migrations: `scripts/apply-migrations.mjs`

`supabase db push` is still the canonical path, and stays the one to use once a database password
exists. It cannot be used with a personal access token alone: the CLI first calls the project's
database-config endpoint to mint a login role, and is refused with
`LegacyDbConfigLoginRoleStatusError: unexpected login role status 403`. `apply-migrations.mjs`
replays the same files through the `database/query` endpoint instead, which needs neither a
password nor a login role.

Each file is applied in one transaction **together with its history row**, so a migration that
fails leaves neither partial DDL nor a version record, and the run stops at the first failure. The
history table is created with the CLI's own DDL and rows are inserted in the CLI's own shape, both
read out of the v2.117 binary, so a later `db push` sees a history it recognises. `statements` is
left `NULL` — which is what a version of the CLI predating that column leaves. The production ref
is refused unless `--allow-production` is passed.

### What replaying onto the replacement project showed

| Check | Result |
| --- | --- |
| All 34 migrations, in order, unedited | 34/34 on the first pass |
| `migration-drift-check.sql` against the replayed project | `OK` — applied=34, expected=34, matched=34 |
| `parity-dump.sql` against the replayed project | 1,442 rows across 17 kinds |
| `supabase_realtime` publication membership | 19 tables, exactly the list the migration names |
| `types.ts` regenerated and diffed against the committed file | byte-identical — 1,607 lines, 0 differences |
| Anonymous surface, hosted vs replayed, publishable key only | same status on all 13 tables probed |
| `npm run test:integration` against the replayed project | 25 passed, 0 failed, 0 skipped |

The `types.ts` result is the strongest signal available without the hosted project's connection
string. That file was generated against the hosted project, so drift in any table, column or
function signature would have appeared as a diff.

Three qualifications, because the table above is easy to over-read:

- **The anonymous comparison is a surface check, not a definition check.** `players` and
  `desk_activity` are denied outright on both projects and the other eleven answer `200` on both.
  Row counts differ on three tables, which is data rather than schema. Worth knowing for the
  cutover: **the migration set seeds demo data** — `20260910043000_reconstruct_demo_tournament_data`
  and `20260910200000_fake_day_one_results` insert a tournament with played results — so replaying
  it onto an empty project creates that data.
- **Function bodies, policy `qual` expressions and trigger definitions are still unverified.** They
  need the hosted project's connection string. Signatures and the visible authorization surface
  agree; a body that behaves differently while keeping its signature would not show up in either.
- **`20260909233700` and `20260910000044` remain indistinguishable from the files alone**, which is
  why the replay result and not the file list is the evidence.

### The one step a replay cannot do

The migrations seed `profiles` by email, so the first admin's authorization row exists as soon as
the schema is applied. They cannot create the `auth.users` identity, because that is GoTrue's table
and seeding it would mean writing a password hash by hand.

So a replay leaves the project with a profile whose `user_id` is NULL and no way to sign in.
`scripts/create-staff-login.mjs` closes that, and it is a one-command step rather than a migration:

```sh
node scripts/create-staff-login.mjs --project-ref <ref> --email <the-seeded-admin-email>
```

There is **no identity to migrate and no backfill to write**, which is worth stating because it is
the intuitive thing to expect. Email is the durable key: `on_auth_user_created_link_profile` is an
`AFTER INSERT` trigger on `auth.users` that fills `profiles.user_id` from a matching email, so
creating the identity *is* the linking step, and `current_system_role()` matches on
`user_id = auth.uid()` OR the JWT email. Old UUIDs, password hashes and sessions are left behind
deliberately. Its delete twin, `on_auth_user_deleted_unlink_profile`, clears the link and leaves the
row, which is what lets a recreated identity re-link to the same profile — and therefore keeps
`tournaments.owner_user_id`, which points at the profile, intact.

The script verifies rather than assuming: it signs in as the account and asserts that
`current_system_role()` resolves, that `is_platform_admin()` agrees with the seeded role, and that
an anonymous caller is refused — the last so a pass cannot come from a guard that is not running.
The second check is the discriminating one: a role string that confers nothing would look correct
and be useless, so it is the predicate the RLS policies branch on that gets asserted. Re-running it
is safe: it detects an existing identity and **does not reset its password** unless passed
`--reset-password`, because silently replacing a password from a script whose job is to verify is
how an operator locks themselves out.

### The strongest comparison available without a connection string

Lovable Cloud exposes **no database dashboard and no Postgres connection string**, so
`parity-dump.sql` cannot be pointed at the old backend and the definition-level comparison it was
written for is not obtainable. That limitation is real and is not worked around below.

What is obtainable is PostgREST's own OpenAPI document, which it serves at the REST root
(`GET /rest/v1/`) to a key holder. It enumerates every exposed table and view with every column and
its Postgres type and format, and every exposed RPC with its argument names, types and required
flags. Compared between the two backends:

| Surface | Old | Replayed | Result |
| --- | --- | --- | --- |
| Tables and views | 20 | 20 | identical |
| Columns (type and format) | 207 | 207 | identical |
| RPCs (arguments and required flags) | 52 | 52 | identical |
| Table paths | 21 | 21 | identical |

The 207 columns agree with the `column` rows in `parity-dump.sql`'s own output, which is an
independent confirmation from a different source.

One credential note: the comparison is not symmetric in what it needs. The old backend still serves
the REST root to a **publishable** key, while a current Supabase project refuses it with
`401 Secret API key required`. Both documents describe the same schema, so the credential differs
rather than the thing being measured.

**This is not a substitute for a definition dump, and the gap is narrower but not closed.** RPC
*argument names and types* are compared; RPC *bodies* are not visible over PostgREST at all. Nor
are policy `qual` expressions, trigger definitions, or function volatility and `search_path`. A body
that behaves differently while keeping its signature would pass every check above. Treat the table
as "the API surface matches, the internals are unverified."

The comparison is also verified not to be a false pass: run against the empty
`tournova-production` project it reports 92 differences, so it detects divergence rather than
reporting agreement unconditionally.

### Verifying the whole backend, not just the schema

The Playwright suite is hermetic — it intercepts transport — so it cannot see the backend at all.
`npm run test:integration` runs the application against a real project instead, covering
authentication, platform-role resolution, RLS and RPC authorization for owner, editor, unrelated
user and platform admin, realtime delivery, and the tournament lifecycle from creation through a
fully reported pool. It needs a **dedicated test project** and refuses to run against production;
see `vitest.integration.config.ts`. A machine without a container runtime can run the same suite
on GitHub Actions instead: `.github/workflows/integration.yml` starts the local stack and runs it
by hand, or on a pull request that touches the migrations.

## Applying `20260927000000_tournova_role_redesign.sql`

The one migration of Phase 1, and unlike every other entry above it is **not** a targeted fix:
it replaces the authorization model, the tournament lifecycle and the registration surface in a
single transaction, so no intermediate authorization state is ever deployable. It is applied after
all 34 of the migrations above it, and Phase 2's identity canon
([below](#applying-20260929000000_identity_canonsql)) is applied after it.

The full reference for what it establishes is [`docs/authorization.md`](../../docs/authorization.md).
This section covers only what an operator applying it needs: what it renames, what it backfills,
and what to verify.

### What it renames

Two renames and four RPC renames. The table rename is a rename rather than a new table
deliberately — the email-durability auth seam the recovery runbook depends on had to survive.

| Before | After |
| --- | --- |
| `public.staff_roles` | `public.profiles` |
| `profiles.role` | `profiles.system_role` (`admin` \| `user`) |
| `create_tournament_draft(p_payload jsonb)` | `create_tournament(p_payload jsonb)` |
| `save_tournament_draft(uuid, jsonb)` | `save_tournament_config(uuid, jsonb)` |
| `delete_tournament_draft(uuid)` | `discard_tournament(uuid)` |
| `activate_tournament(uuid)` | `start_tournament(uuid)` + `complete_tournament(uuid)` |

Dropped outright: the three legacy helpers (`current_staff_role()`, `has_staff_role(text[])`,
`is_invited_email(text)`), the `reopen_tournament` RPC, the unused
`create_tournament(text, integer, integer, date, jsonb)` overload, and the `player_roster` view
(replaced by `public_players`).

`activate_tournament` had three jobs and they have been separated rather than carried over:
readiness stays a gate, the status write becomes `start_tournament`/`complete_tournament`, and
the `is_active` write moves to `set_active_tournament`, which is now platform-admin-only and
writes `is_active` alone. The consequence worth knowing before it is pressed: **Activate no
longer makes the tournament the global public default.**

### What it backfills

Three writes, and only one is load-bearing:

| Column | Backfill |
| --- | --- |
| `tournaments.owner_user_id` | Every existing tournament to the existing admin, then `NOT NULL` |
| `profiles.current_tournament_id` | The admin's, to the `is_active` tournament; `NULL` is valid and expected |
| `tournaments.status` | `'draft'` → `'upcoming'`; `in_progress` and `completed` are left exactly as they are |

The production reality this was written against is that the application has exactly one
authenticated account — the platform admin — and no other staff. So there is no editor backfill
and no role conversion beyond `admin | user`: the existing admin stays `admin`, and an admin never
gains an editor row, because the platform role and tournament membership are separate axes.
`tournament_registrations` starts empty.

### Applying it

```sh
node scripts/apply-migrations.mjs --project-ref <ref>      # or: supabase db push
```

Because the whole model lands in one transaction, a failure leaves nothing behind and the fix is to
correct the file and re-run — not to patch a half-applied state.

### Verify after applying

```sh
node scripts/run-sql.mjs scripts/migration-drift-check.sql --project-ref <ref>
node scripts/run-sql.mjs scripts/parity-dump.sql           --project-ref <ref>
```

Then confirm the four things that would otherwise fail later and quietly:

```sql
-- 1. No tournament is unattributable.
select count(*) as unattributed from public.tournaments where owner_user_id is null;

-- 2. No legacy helper survives, in a function body, policy, view, trigger or default.
select count(*) as legacy_references
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (p.prosrc like '%current_staff_role%'
    or p.prosrc like '%has_staff_role%'
    or p.prosrc like '%is_invited_email%');

-- 3. The lifecycle states are the three that exist, and nothing is still a draft.
select status, count(*) from public.tournaments group by status order by status;

-- 4. The auth triggers are the profile pair, not the staff pair.
select tgname from pg_trigger
where tgrelid = 'auth.users'::regclass and not tgisinternal order by tgname;
```

Expected: `0`, `0`, only `upcoming` / `in_progress` / `completed`,
and `on_auth_user_created_link_profile` plus `on_auth_user_deleted_unlink_profile`.

The migration closes with a `DO $verify$` block that raises if any function body, policy
expression, view, trigger or default still names one of the three legacy helpers — that block is
what gates step 9's `DROP FUNCTION`, and it is the reason the drops are at the end of the file
rather than beside the renames. `src/lib/tournament/db-invariants.test.ts` asserts the same over
the file itself, so the check survives a future edit.

### After it is applied

**Nobody can sign in until their identity is recreated against the renamed table**, because the
`auth.users` identity links to a `profiles` row by email. The rows and their roles are already
correct; only the link is missing:

```sh
node scripts/create-staff-login.mjs --project-ref <ref> --email <the-admin-email>
```

`scripts/reset-tournament-data.mjs` and its SQL twin keep `profiles` and clear everything else, so
running one of those after this migration does not disturb a login.

### Rolling back

There is no rollback script, and there deliberately is not one. The rename is not reversible without
losing the `owner_user_id` backfill and the editor rows, and a reverse migration that dropped
`profiles` would take the platform roles with it. The recovery path is a restore — see
[`docs/recovery-runbook.md`](../../docs/recovery-runbook.md) — and the migration should be rehearsed
into the local stack first:

```sh
npm run backup:production                          # a current dump, published data only
npm run restore:to-local -- backups/<dump> --yes   # rehearse into the local stack
npm run integration:target -- local
npm run test:integration                           # RLS, RPC guards and realtime, for real
```

## Applying `20260929000000_identity_canon.sql`

Phase 2's first migration, and the one that finishes what the role redesign started. Phase 1
introduced `profiles` as the durable person but left the two *domain* relationships keyed on
`auth.users.id`:

| Column | Was |
| --- | --- |
| `tournament_editors.user_id` | `auth.users(id)` |
| `tournament_editors.added_by` | `auth.users(id)` |
| `tournament_registrations.user_id` | `auth.users(id)` |
| `tournament_registrations.decided_by` | `auth.users(id)` |

That split is the last place a relationship between a person and a tournament points at an
*identity* rather than at the *person*. It is not cosmetic: an editor grant or a registration
request is lost the moment the auth identity is recreated — which is the exact failure `profiles`
exists to survive, since the recovery runbook recreates the admin identity rather than restoring
it, and ownership already survives that. Membership and requests must survive it too.

After this file every domain relationship keys on `profiles.id`. The only columns left in the
schema that name an auth user are `profiles.user_id` (the link itself) and `desk_activity.actor_id`
(an audit attribution, deliberately an identity: it records who was signed in, not who they
durably are).

It is a **rename-and-convert, never a drop-and-recreate**. The rows carry real decisions — who may
operate a tournament, who asked to take part — and they are migrated, not re-derived.

### The unmatched-identity pre-flight

Before any DDL, and the reason this migration is safe to apply unattended. The two kinds of column
behave differently, deliberately:

- **Actor columns** (`added_by`, `decided_by`) are *attribution*. A row can exist without them, so
  an unmatched value becomes `NULL`. Losing the attribution is acceptable; losing the row is not.
- **Member and requester columns** (`tournament_editors.user_id`, `tournament_registrations.user_id`)
  are *the relationship itself*. A row whose auth user has no matching profile means a person is
  about to be silently removed from a tournament or have their request erased. The migration
  `RAISE EXCEPTION`s instead, before it has changed anything.

If it fires, the fix is to link the missing profile first — the auth user exists but no `profiles`
row carries its `user_id` — and re-run. It is a `RAISE`, not a `RAISE WARNING`, on purpose: a
warning printed into a CI log is not a failure, and a partially-converted authorization model is
worse than a migration that refuses to run.

### What it renames

| Table | Before | After |
| --- | --- | --- |
| `tournaments` | `owner_user_id` | `owner_profile_id` |
| `tournament_editors` | `user_id` | `profile_id` |
| `tournament_editors` | `added_by` | `added_by_profile_id` |
| `tournament_registrations` | `user_id` | `profile_id` |
| `tournament_registrations` | `decided_by` | `decided_by_profile_id` |

`tournaments.owner_user_id` is a rename of name only: its foreign key already pointed at
`profiles`, it was simply called `..._user_id` because it was written while `auth.users` was still
the expectation everywhere else, and a column named `user_id` that holds a profile id produces a
wrong join six months later. Its index and constraint are renamed to match.

The four constraints to `auth.users` are dropped by catalogue lookup rather than by their
auto-generated names, so the file cannot silently leave one behind if a name ever differs.

### What it adds

`public.current_profile_id()` — the caller's `profiles.id`, resolved through the auth link
(`user_id = auth.uid()`) or, before the trigger has linked the row, the normalised JWT email. It
keeps both arms for the same reason `current_system_role()` does: the email arm is the durability
seam that lets a recreated identity recover its access instead of losing it. Every rewritten
predicate, policy and RPC goes through it rather than comparing `profiles.user_id` to `auth.uid()`
at each call site.

Rewritten to key on it: `is_tournament_owner`, `is_tournament_editor`, `has_any_tournament_edit`,
the `tournament_registrations` insert and update guards, `submit_tournament_registration`,
`my_tournament_registration`, `review_tournament_registrations`, `list_tournament_editors`,
`add_tournament_editor`, `remove_tournament_editor` and `create_tournament`. The three RPCs whose
signatures changed were dropped and re-created, so their `EXECUTE` grants are re-issued here.

### Verify after applying

The migration closes with a `DO $verify$` block that raises on any of seven catalogue questions —
it is what makes a rename migration honest, because a rename has exactly one silent failure mode:
it applies, and one column still points at the old key. Run the same questions by hand:

```sql
-- 1. The predicate exists.
select to_regprocedure('public.current_profile_id()');

-- 2. No foreign key on the converted tables still points at auth.users. Expect 0.
select count(*) from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where con.contype = 'f' and con.confrelid = 'auth.users'::regclass
  and n.nspname = 'public'
  and c.relname in ('tournament_editors', 'tournament_registrations');

-- 3. Every identity column references profiles(id). Expect five rows.
select c.relname, a.attname
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
where con.contype = 'f' and con.confrelid = 'public.profiles'::regclass
  and n.nspname = 'public' order by 1, 2;

-- 4. No policy on the two converted tables reads auth.uid(). Expect zero rows.
select c.relname, pol.polname from pg_policy pol
join pg_class c on c.oid = pol.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('tournament_editors', 'tournament_registrations')
  and (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~ 'auth\.uid\(\)'
    or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ 'auth\.uid\(\)');

-- 5. The owner column is still withheld from the client UPDATE grant. Expect no row.
select grantee, column_name
from information_schema.column_privileges
where table_name = 'tournaments' and privilege_type = 'UPDATE'
  and column_name = 'owner_profile_id';
```

`src/lib/tournament/db-invariants.test.ts` asserts the same properties against the file itself, so
a later edit that removes one of them fails the unit suite rather than a deployment.

Because the whole model lands in one transaction, a failure leaves nothing behind and the fix is to
correct the offending row and re-run — not to patch a half-applied state.

### Rolling back

There is no rollback script. The conversion is lossy in one direction only: once an auth uid has
become a profile id, reversing it requires a `profiles.user_id` that the pre-flight may have just
found missing. The recovery path is a restore — see
[`docs/recovery-runbook.md`](../../docs/recovery-runbook.md).

### After it is applied

`tournament_editors` and `tournament_registrations` now survive an identity being deleted and
recreated, which is the property the migration exists to establish. Rehearse it into the local
stack and prove it rather than assuming it:

```sh
npm run integration:target -- local
npm run test:integration   # includes profile-identity.test.ts, which deletes and recreates an identity
```

## Applying `20260929001000_tournament_summary.sql`

Phase 2's second new file, and a fourth rather than one of Section 4's three. S5 ships
Explore, which needs a tournament read that did not exist, and both later files are *after* it
in concern — so it is timestamped between S1's identity canon and S8/S9's registration work,
which keeps the fresh-database order the same as the incremental one (S5 → S8/S9 → S12) instead
of inverting it. It changes no table.

### What it adds

Two reads, both `SECURITY DEFINER` and `STABLE`:

- **`tournament_registration_state(p_tournament_id)`** — the registration window as one word:
  `not_offered` · `not_ready` · `opens_soon` · `open` · `closed` · `started` · `completed`. It
  mirrors `assert_registration_not_shut` and `submit_tournament_registration` in the same order,
  so the Register button and the RPC cannot disagree about whether a request would be accepted.
  It is a read: the RPC still re-checks everything.
- **`tournament_summary(p_query, p_status, p_ids, p_limit, p_offset)`** — one row per
  tournament in the shape a card draws: id, name, venue, status, the derived start and end, the
  registration state, the entry and event counts, and the caller's `access_level`
  (`admin`/`owner`/`editor`/`viewer`). It replaces the client-side full-table read and is what
  Explore, My Tournaments and the create flow's list all render, so they cannot drift apart.
  `p_status` is validated rather than ignored, `p_ids` makes My Tournaments one read, and the
  counts read `teams` and `categories` — never a placement projection, which is cleared by a
  stage reset.

It deliberately exposes no readiness detail and no editor email: Explore is public, so every
column is a fact the anonymous desk view could already see. `tournament_summary` is therefore
granted to `anon` as well as `authenticated`; `tournament_registration_state` is granted to
both for the same reason.

### Verify after applying

```sql
-- Both exist, with the right argument lists.
select to_regprocedure('public.tournament_registration_state(uuid)');
select to_regprocedure('public.tournament_summary(text, text, uuid[], int, int)');

-- Every tournament answers with a state word from the documented set.
select id, name, public.tournament_registration_state(id) as state from public.tournaments;

-- The card read, for everyone: no session, therefore viewer or admin by predicate.
select id, name, status, registration_state, entry_count, category_count, access_level
from public.tournament_summary(null, null, null, 25, 0);

-- A typo in the status filter is refused rather than silently answered as "all".
select * from public.tournament_summary(null, 'draft', null, 5, 0);  -- expect an exception

-- The public grant, and the closed default.
select has_function_privilege('anon', 'public.tournament_summary(text, text, uuid[], int, int)', 'execute');
```

### Rolling back

```sql
drop function if exists public.tournament_summary(text, text, uuid[], int, int);
drop function if exists public.tournament_registration_state(uuid);
```

Nothing else reads either, so the drop is complete. The pages that call them would fail loudly
rather than silently render an empty list.

## Applying `20260929010000_retire_is_active.sql`

Removes Phase 1's global navigation state. `is_active` was a boolean plus a partial unique
index that allowed exactly one row to hold it, deciding which event an unpointed visitor landed
on. Phase 2 replaced the meaning with the per-user pointer (`profiles.current_tournament_id`,
written by `set_current_tournament`) and with `/explore` for a caller who has not chosen — so by
the time this file lands the column has no reader left, and an unused navigation default can
only drift from what the app does.

### What it does, in order

1. **Re-scopes `current_tournament_id()` to the pointer alone**, dropping the fallback to the
   globally live tournament. An anonymous caller — which is also the server-rendering request —
   now gets `NULL` deliberately, so a server-side call can never redirect a bookmark to
   somebody's live desk.
2. **Drops `set_active_tournament(uuid)`**, the only writer left. Its predecessor
   `activate_tournament` was already dropped by the role redesign, which moved its
   Draft → In Progress meaning to `start_tournament`.
3. **Drops `tournaments_single_active`**, explicitly rather than leaving it to the column drop,
   so the intent is legible.
4. **Drops the column**, which also drops `tournaments_active_status_check` — the CHECK that
   tied the boolean to `status = 'in_progress'`, which the three-state machine had already
   replaced. Deliberately **no `CASCADE`**, so if anything unexpected still depends on the
   column this fails loudly instead of quietly taking a dependent object with it.

No grant change is needed: Phase 1 already withheld `is_active` from the `authenticated` UPDATE
list, so dropping the column withdraws nothing a client held. The `tournaments` column grant
belongs to the identity migration and is not restated here.

### Verify after applying

```sql
-- The column, its index and the global verb are gone. Expect 0, null, null.
select count(*) from information_schema.columns
where table_schema = 'public' and table_name = 'tournaments' and column_name = 'is_active';
select to_regclass('public.tournaments_single_active');
select to_regprocedure('public.set_active_tournament(uuid)');

-- The reader survived and no longer names the column. Expect one row, false.
select proname, prosrc ilike '%is_active%' as still_reads_it
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'current_tournament_id';

-- And the pointer still works for a signed-in caller.
select public.current_tournament_id();
```

The migration runs the same questions in its own `do $verify$` block before it commits.

### Rolling back

The column can be re-added, but not its meaning: there is no writer to restore (the RPC is
gone), and `current_tournament_id()` deliberately no longer falls back. Reinstating a global
default is a product decision rather than a rollback — do it as its own migration and its own
review, not as a restore of this one.

### After it is applied

Nothing to do. Every surface that used to lean on the fallback already handles `NULL` — Home
renders its empty state, and a flat path sends the caller to `/explore`.

## Applying `20260929020000_registration_entries_and_identity.sql`

Phase 2's steps 8 and 9 in one file: the registration schema and policies, then the RPCs that
use them. They are one transaction against one concern — a request that carries categories and
named partners, and the bridge that turns an approved one into `players` and `teams` rows.

Two things the file establishes, and both are about *whose* data something is:

- **`players.profile_id` gives a player row an owner, and exactly one code path may set it** —
  the approval. Before this, a player row had no identity column at all, so "the person this row
  belongs to" was answered by matching an email address. Email is a string a person types; it is
  neither unique nor normalised on this table, so a participant could be handed somebody else's
  contact data by typing their address into a form.
- **`can_manage_player` derives "may the caller read this person's contact data" from the
  entry**, never from a projection of it. The projection that exists — `placement_entrants` — is
  generated and cleared by the placement stage, so access read from it would come and go, and
  would be refused for exactly the entrants who have not been placed.

### What it adds, in the file's own order

1. `players.profile_id uuid references public.profiles(id) on delete set null`, a partial unique
   index `where profile_id is not null` (so any number of walk-ins and partners may be
   unlinked), and a column `INSERT`/`UPDATE` grant that withholds `profile_id`, `id` and
   `created_at` while re-granting `name`, `email`, `phone`, `gender`.
2. **`players_profile_link_guard`** — a trigger that decides by *state transition, not by actor*:
   a null insert is allowed, a link is set only under the transaction-local flag
   `tournova.allow_profile_link`, an unchanged update is allowed, a de-link is allowed
   unconditionally (that is what `ON DELETE SET NULL` arrives as), and a→b is refused even under
   the flag. The column grant and the trigger are deliberately redundant.
3. **`can_manage_player(p_player_id)`** — the player, an owner or editor of a tournament the
   player has entered, or a platform admin. Membership reads `teams`, never `placement_entrants`.
4. **The four `players` policies** replacing Phase 1's single `FOR ALL`: read (own or
   `can_manage_player`), insert (self-service by the caller's own JWT email with `profile_id`
   null, or a walk-in), update (own or platform admin), delete (platform admin only).
5. **`tournament_registration_entries`** — one row per category a request asks for, carrying the
   partner as a **name and an email, never a `players.id`**, uniquely keyed on
   `(registration_id, category_id)` so a resubmit replaces a set. Added to the realtime
   publication, with a policy admitting only the requester (reviewers read through the definer
   RPC).
6. **The partial unique key** on `tournament_registrations`: `(tournament_id, profile_id) where
   status <> 'rejected'`. Phase 1's unconditional key made a rejection permanent, because the
   row stayed and the key kept it.
7. **Five RPCs**: `submit_tournament_registration(uuid, jsonb)`,
   `withdraw_tournament_registration(uuid)`, `review_tournament_registrations(uuid)`,
   `my_tournament_registration(uuid)` and `decide_tournament_registration(uuid, text, text)`.
   Submission and the review read were dropped and re-created because their signatures changed,
   so their grants are re-issued.

`submit_tournament_registration` gates on a resolved profile, the lifecycle, the configured
window, readiness, at least one entry, every event this tournament's and active, the per-player
event cap, and a partner who is not the caller. It is idempotent: a retry returns the same
request and replaces its entries. `decide_tournament_registration` is editor-gated and
terminal, and runs the whole bridge in one transaction — the requester's row found by
`profile_id` and reused or created, each partner matched by normalised email among *unlinked*
rows only or created unlinked, the caps turned into a sentence, then the `teams` rows.

### Verify after applying

```sql
-- The link, the index and the guard.
select column_name, is_nullable from information_schema.columns
where table_schema = 'public' and table_name = 'players' and column_name = 'profile_id';
select indexdef from pg_indexes
where schemaname = 'public' and tablename = 'players' and indexdef ilike '%profile_id%';
select tgname from pg_trigger where tgrelid = 'public.players'::regclass and not tgisinternal;

-- The link is unreachable by a client: expect no rows for anon or authenticated.
select grantee, privilege_type from information_schema.column_privileges
where table_schema = 'public' and table_name = 'players' and column_name = 'profile_id';

-- The entries table, its key and its publication membership.
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.tournament_registration_entries'::regclass;
select tablename from pg_publication_tables
where schemaname = 'public' and tablename = 'tournament_registration_entries';

-- The five RPCs, with their argument lists.
select p.proname, pg_get_function_identity_arguments(p.oid)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in (
  'submit_tournament_registration', 'withdraw_tournament_registration',
  'review_tournament_registrations', 'my_tournament_registration',
  'decide_tournament_registration')
order by 1;

-- The plan itself is one live request per person, and a rejection leaves the index.
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'public.tournament_registrations'::regclass
  and conname like '%unique%';
```

Because this file changes RLS policies and RPC guards — the surfaces the hermetic suite
structurally cannot see — rehearse it in the local stack and prove the behaviour rather than the
shape:

```sh
npm run integration:target -- local
npm run test:integration   # authorization.test.ts, profile-identity.test.ts, realtime.test.ts
```

### Rolling back

There is no rewind. `players.profile_id` is additive and a link is a real fact once written;
the RPCs can be dropped, but the approval they perform is the only way an entry is created from
a request. A restore is the recovery path — see [`docs/recovery-runbook.md`](../../docs/recovery-runbook.md).

### After it is applied

`scripts/create-staff-login.mjs` needs no change and still matches the identity model: it
creates the `auth.users` identity for a seeded `profiles` row and verifies the platform role,
and the domain relationships now key on the profile, so recreating an identity no longer loses
an editor grant or a request. Nothing links a player on approval but the approval itself.

## Applying `20260929030000_walk_in_player_predicate.sql`

Phase 1 created one predicate whose name described the wrong thing. It answers "may this caller
add an unlinked person to the *global* player roster", and it was called
`has_any_tournament_edit()` — which reads as a capability over tournaments, and invites a writer
to reach for it where the per-tournament `can_edit_tournament(uuid)` is the right answer.

The read side of the `players` surface was narrowed in step 8 with `can_manage_player(uuid)`.
This file finishes the pair by giving the create side a name that says what it authorises:
**`can_add_walk_in_player()`**. It cannot be narrowed further — `players` has no tournament
scope, and the entry that would scope it does not exist until the player has been created — so
the change is a rename, and the body, the three arms and the admin override are identical.

### What it does, in order

1. Creates `can_add_walk_in_player()` (a platform admin, or the owner or an editor of any
   tournament), closes its implicit `PUBLIC` grant and grants `EXECUTE` to `authenticated`
   alone.
2. **Re-points `players insert` with `ALTER POLICY`**, which rewrites the stored expression and
   so releases the dependency on the old function. The self-service arm is reproduced exactly:
   `profile_id is null` **and** the caller's own normalised JWT email.
3. Drops `has_any_tournament_edit()`. Order matters — a policy is a dependent object, so
   dropping first fails.
4. Its own `do $verify$` block checks the new name exists, the old one does not, no surviving
   function body names it, the policy names the new one, `authenticated` can execute it, and
   `anon` cannot.

### Verify after applying

```sql
select to_regprocedure('public.can_add_walk_in_player()');            -- one row
select to_regprocedure('public.has_any_tournament_edit()');           -- null

select policyname, with_check from pg_policies
where schemaname = 'public' and tablename = 'players' and policyname = 'players insert';

-- No function body still names the old predicate. Expect 0.
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosrc ilike '%has_any_tournament_edit%';

select has_function_privilege('authenticated', 'public.can_add_walk_in_player()', 'execute');  -- t
select has_function_privilege('anon', 'public.can_add_walk_in_player()', 'execute');           -- f
```

### Rolling back

Recreate the old name by copying the body and reverse the two catalogue steps:

```sql
create or replace function public.has_any_tournament_edit() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin()
      or exists (select 1 from public.tournaments t where t.owner_profile_id = public.current_profile_id())
      or exists (select 1 from public.tournament_editors e where e.profile_id = public.current_profile_id());
$$;
alter policy "players insert" on public.players
with check (
  profile_id is null and (
    public.normalize_email(email) = public.normalize_email(auth.jwt() ->> 'email')
    or public.has_any_tournament_edit()
  )
);
drop function public.can_add_walk_in_player();
```

A rollback through the repository's own history is the restore path, as usual — see
[`docs/recovery-runbook.md`](../../docs/recovery-runbook.md).

## Applying `20261007000000_explore_tournaments.sql`

Adds the two reads behind the paged, filtered Explore page. It is **purely additive**: two new
functions, no table or column touched, and `tournament_summary` is left exactly as it was, so
My Tournaments and the create flow are unaffected.

**Apply this before deploying the page that calls it.** Explore reads these functions; a
build that ships first shows "Couldn't load tournaments" until the migration is on the project.

### What it adds

| Function | Purpose |
| --- | --- |
| `explore_tournaments(p_query, p_status, p_registration_open, p_range, p_sort, p_limit, p_offset)` | One page of cards, with `total_count`, the size of the whole result, taken in the same statement. |
| `explore_tournament_counts(p_query, p_registration_open, p_range)` | How many match per status, always all three, for the filter buttons. |

Both are granted to `anon` and `authenticated`, and the implicit `PUBLIC` grant is closed.
`p_status`, `p_range` (`week` | `month` | `quarter`) and `p_sort` (`soonest` | `newest` |
`entries` | `name`) are checked against that list and raise on anything else. The page size is
clamped to 50, and every ordering ends in the tournament id so a page boundary never repeats or
skips a row.

### Verify after applying

```sql
-- the grants: both callable by anon, neither by PUBLIC
SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can
FROM pg_proc p WHERE p.proname IN ('explore_tournaments', 'explore_tournament_counts');

-- a page, and the size of the whole result
SELECT name, status, total_count FROM public.explore_tournaments(p_limit => 3);

-- the counts, always three rows
SELECT * FROM public.explore_tournament_counts();

-- an unknown word is refused rather than answered
SELECT * FROM public.explore_tournaments(p_sort => 'random');  -- Unknown sort: random
```

Then regenerate `src/integrations/supabase/types.ts` (the two entries in this change were
written by hand to match) and run `npm run test:integration` against the local stack.

### Rolling back

`DROP FUNCTION public.explore_tournaments(text, text, boolean, text, text, int, int);` and
`DROP FUNCTION public.explore_tournament_counts(text, boolean, text);`. Nothing else depends on
them but the Explore page.


---

## Applying `20261008000000_tournament_window.sql`

First of four files that make one change (the window, start-on-first-match, the registration rules, the details writer); apply them in order.
Do not apply the app build that calls the new `create_tournament` before this is in place, and do
not apply this before the build that stops calling `start_tournament` and `save_tournament_days`
for a new tournament: the two sides move together.

### What it adds

- `tournaments.starts_on` and `ends_on`, the tournament **window**: the dates the tournament
  promises, chosen when it is created. Backfilled from the span of each tournament's existing days
  (a tournament with no days gets the date it was created on, in UTC), then `NOT NULL` with
  `CHECK (starts_on <= ends_on)`. They are not in the editor UPDATE grant: only `create_tournament`
  and `update_tournament_window` write them.
- `tournament_starts_at` / `tournament_ends_at` now read the window, not the earliest and latest
  playing day. The start is 00:00 of `starts_on` in the venue timezone, and the end is 00:00 of the
  day after `ends_on`.
- Playing days (`tournament_days`) are chosen later and must lie inside the window. A trigger
  enforces it for every writer, because an editor can write the table directly. They need not be
  consecutive.
- The seven-day ceiling is gone: `tournaments_day_count_check` and
  `tournament_days_day_number_check` keep only their floor of one, and `add_tournament_day` /
  `save_tournament_days` no longer count. `remove_tournament_day` no longer insists on one day left,
  because a tournament may have none until the schedule is built; it still refuses a day with a
  match on it.
- `create_tournament(p_payload)` is the single, atomic way to create a tournament: name, window,
  timezone and at least one event in one transaction, with an optional registration window. There is
  no draft row.
- `update_tournament_window(id, starts_on, ends_on)`: the last date may move later until completion;
  the first date is locked once the tournament is in progress; refused if a playing day would fall
  outside, or the first date would pass the registration deadline.
- `tournament_has_schedule(id)`, and a trigger that refuses a timezone change once any match has a
  time.
- `tournament_readiness_checks` no longer asks about days (`days`, `day_dates` are gone), and the
  `basics` check asks for a name only. A venue is optional.
- `save_tournament_days` refuses once anything is scheduled.

### Check before applying

```sql
-- tournaments that will get a window from their created date because they have no days:
SELECT id, name, status, created_at FROM public.tournaments t
WHERE NOT EXISTS (SELECT 1 FROM public.tournament_days d WHERE d.tournament_id = t.id);

-- registration windows that close between 00:00 and the first day's opening on day 1: they
-- were valid before and will be refused the next time anything rewrites them.
SELECT t.id, t.name, t.registration_closes_at, min(d.date + d.start_time) AS first_opening
FROM public.tournaments t JOIN public.tournament_days d ON d.tournament_id = t.id
WHERE t.registration_closes_at IS NOT NULL
GROUP BY t.id HAVING t.registration_closes_at::date >= min(d.date);
```

### Verify after applying

```sql
SELECT count(*) FROM public.tournaments WHERE starts_on IS NULL OR ends_on IS NULL;       -- 0
SELECT count(*) FROM public.tournament_days d JOIN public.tournaments t ON t.id = d.tournament_id
WHERE d.date NOT BETWEEN t.starts_on AND t.ends_on;                                        -- 0

-- a day outside the window is refused for the table, not just the RPC
INSERT INTO public.tournament_days (tournament_id, day_number, date, start_time, end_time)
SELECT id, 99, ends_on + 1, '09:00', '18:00' FROM public.tournaments LIMIT 1;  -- is outside the tournament window
```

### Rolling back

Not mechanical: dropping the window columns discards the dates tournaments were created with. If it
must be undone, restore `tournament_starts_at` / `tournament_ends_at` from
`20260927000000_tournova_role_redesign.sql` first, then drop the two triggers, then the columns.

---

## Applying `20261008010000_start_on_first_match.sql`

### What it changes

- `start_tournament` is dropped. A tournament becomes `in_progress` when its first match is started:
  `start_placement_match`, `start_tier_draw_match` and `start_match_safe` accept an `upcoming`
  tournament (from 00:00 of the window's first date in the venue timezone, never a `completed` one,
  admin or not) and flip it in the same transaction with `mark_tournament_started`, which only ever
  moves an `upcoming` row forward.
- Scoring, resetting and rescheduling still require `in_progress` (`assert_tournament_live` is
  unchanged), so the closed list of 13 callers is the list of 16 minus these three.
- `complete_tournament` is refused while any match is on court. A shared advisory lock
  (`lifecycle:<id>`) is taken by every match start and the exclusive lock by Complete, so a Complete
  that saw nothing on court cannot commit after a match has started. Row locks would deadlock two
  concurrent first matches, which is why it is an advisory lock.
- `tournament_completion_check(id)` returns `{on_court, unplayed, total}` to an editor for the
  Complete dialog. A read, never a gate.

### Verify after applying

```sql
SELECT to_regprocedure('public.start_tournament(uuid)');   -- NULL
SELECT has_function_privilege('authenticated', 'public.mark_tournament_started(uuid)', 'execute');  -- false
```

Then, as an editor of an upcoming tournament whose window has opened, start a scheduled match and
confirm `status` became `in_progress`; start a second and confirm nothing else changed; complete it
with that match still on court and confirm it is refused.

### Rolling back

Re-create `start_tournament` and the three start functions from
`20260927000000_tournova_role_redesign.sql`, and `complete_tournament` without the match check.

---

## Applying `20261008020000_registration_window_rules.sql`

### What it changes

- `assert_registration_window`: the deadline must be at or before 00:00 of the window's first date,
  so registering and playing never overlap. (The bound already read `tournament_starts_at`, which now
  means the window; the message is the change.)
- A trigger on the two registration columns applies to every writer, including the editor UPDATE grant
  and `save_tournament_config`: they cannot change once the tournament has started; the opening time
  cannot change once it has passed; and the deadline cannot be extended - or registration switched on -
  once a schedule exists.
- `set_registration_window(id, opens, closes)`: the one call that changes the window on its own.
  Extending, closing early (`closes = now()`) and switching it off are all this.
- `tournament_play_starts_at` / `tournament_play_ends_at`: the first and last playing day, which are what
  `tournament_starts_at` / `tournament_ends_at` used to return. `tournament_summary` and
  `explore_tournaments` gain `play_starts_at` and `play_ends_at` (NULL until playing days are chosen) so
  the app can say "not started" and "past its last day" about the plan rather than the window. Both are
  dropped and re-created because their return type changes; their grants to `anon` are restored.

### Verify after applying

```sql
SELECT name, starts_at, play_starts_at FROM public.explore_tournaments(p_limit => 3);
SELECT has_function_privilege('anon', 'public.explore_tournaments(text, text, boolean, text, text, int, int)', 'execute');  -- true
SELECT has_function_privilege('anon', 'public.set_registration_window(uuid, timestamptz, timestamptz)', 'execute');         -- false
```

Then regenerate `src/integrations/supabase/types.ts` (the entries in this change were written by hand to
match) and run `npm run test:integration` against the local stack.

### Rolling back

Drop the trigger and `set_registration_window`, restore `assert_registration_window` from
`20260927000000_tournova_role_redesign.sql`, and re-create the two reads from
`20260929001000_tournament_summary.sql` and `20261007000000_explore_tournaments.sql`.


---

## Applying `20261008030000_update_tournament_details.sql`

The fourth file of the same change, and the smallest. It belongs to the first three: they make
the tournament's configuration fixed from its first match, and this is the narrow door that stays
open.

### What it adds

`update_tournament_details(p_tournament_id, p_payload)`: name, note, venue, address and the
organiser's contact, for an owner, an editor or a platform admin, until the tournament is
completed (`assert_tournament_writable`). It reads those seven keys and nothing else. The events,
format and rules have `save_tournament_config` / `save_tournament_categories`, which are
upcoming-only; the window has `update_tournament_window`; the timezone is left to
`save_tournament_config` and its guard under a schedule.

### Verify after applying

```sql
SELECT has_function_privilege('anon', 'public.update_tournament_details(uuid, jsonb)', 'execute');           -- false
SELECT has_function_privilege('authenticated', 'public.update_tournament_details(uuid, jsonb)', 'execute'); -- true
```

Then, as an editor of an in-progress tournament, change its venue and confirm it saves; change a
completed one as the same editor and confirm it is refused.

### Rolling back

`DROP FUNCTION public.update_tournament_details(uuid, jsonb);` Only the Setup page of a started
tournament calls it.


---

## Applying `20261008040000_result_correction_guards.sql`

Reporting or correcting a result: what it may change downstream, and what the live reflow may do.

### What it changes

- **Correction guards.** Four `AFTER UPDATE` triggers, one per match table. Each fires only on a
  *correction*: an already-reported row whose winner changes to another non-null value (pools: whose
  winner or score changes). A first report and a reset (`winner_id` becomes NULL) are untouched, and the
  four `report_*_result` functions are not edited.
  - `tier_draw_matches_correction`: the next-round match is repaired in place while it is `scheduled`;
    refused once it has started.
  - `draw_matches_correction` (legacy knockout): same, through `parent_a_id` / `parent_b_id`.
    `advance_draw_locked` only looks at the newest round, so it never repaired an older one.
  - `placement_matches_correction`: a round-one winner cannot change once round two exists.
  - `pool_matches_correction`: a group result cannot change once draws exist for the category.
- **Break-aware reflow.** `shift_live_schedule_after_match` is now a wrapper. The original ~350-line
  function was renamed to `shift_live_schedule_core` (untouched), and the wrapper calls it and then
  `clear_breaks_after_reflow(tournament_id)`, which moves any still-`scheduled` match that overlaps a
  `tournament_day_breaks` row to the break's end and slides the matches behind it on that court. Every
  caller keeps the old name and signature. Known limits: the pass keeps each court's order but does not
  re-check a player's rest window for the matches it pushes, and it does not enforce the day's closing
  time.
- **Access.** `shift_live_schedule_after_match` was granted to `authenticated` by `20260916010000` with no
  tournament check, so any signed-in account could reflow any tournament by match id. It is now revoked,
  along with the core, the break pass and the four guard functions: they are called only from
  `SECURITY DEFINER` functions.

### Verify after applying

```sql
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN
  ('shift_live_schedule_core', 'clear_breaks_after_reflow', 'guard_tier_draw_correction',
   'guard_draw_correction', 'guard_placement_correction', 'guard_pool_correction');                    -- 6
SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
  ('tier_draw_matches_correction', 'draw_matches_correction',
   'placement_matches_correction', 'pool_matches_correction');                                         -- 4
SELECT has_function_privilege('authenticated', 'public.shift_live_schedule_after_match(text, uuid)', 'execute'); -- false
```

Those prove the objects exist, not that they behave. Run `npm run test:integration` against the local
stack, in particular `integration/simulation.test.ts`: its second test asserts that changing a round-one
winner after round two exists is refused, that a score-only correction is accepted, and that changing a
knockout winner after the next round was played is refused. A break overlap after a late finish is checked
at every step of its first test.

### Rolling back

```sql
DROP TRIGGER pool_matches_correction ON public.pool_matches;
DROP TRIGGER placement_matches_correction ON public.placement_matches;
DROP TRIGGER draw_matches_correction ON public.draw_matches;
DROP TRIGGER tier_draw_matches_correction ON public.tier_draw_matches;
DROP FUNCTION public.guard_pool_correction(), public.guard_placement_correction(),
  public.guard_draw_correction(), public.guard_tier_draw_correction();
DROP FUNCTION public.shift_live_schedule_after_match(text, uuid);
DROP FUNCTION public.clear_breaks_after_reflow(uuid);
ALTER FUNCTION public.shift_live_schedule_core(text, uuid) RENAME TO shift_live_schedule_after_match;
```

Rolling back the rename restores the old behaviour, including the old grant being absent: re-grant
`EXECUTE` to `authenticated` only if a caller outside the `SECURITY DEFINER` functions needs it, and
none does today.


---

## Applying `20261009000000_scoped_player_reads.sql`

The player roster stops being readable as a whole.

### What it changes

`players` is the one global table, and `public_players` (a definer view over it) was granted to `anon`
and `authenticated`. The app read all of it on every page: the Entries screen showed the platform's
roster as "Players" (384, for a tournament of fifty), and anyone could list everybody who had ever played
anywhere. Three calls replace the read, and the view's grant is withdrawn.

- `tournament_players(p_tournament_id)` - id, name and gender of everyone with a team row in the
  tournament. Granted to `anon` and `authenticated`: the entries are public and so are the names on them.
- `search_players(p_tournament_id, p_query, p_limit)` - a name search over the whole roster for the desk
  entering someone. `can_edit_tournament` of that tournament only; two characters or more; at most 50 rows;
  `%` and `_` are literal. Not callable by `anon`.
- `add_walk_in_player(name, email, phone, gender)` - creates an unlinked person and returns the id, which a
  table insert cannot (`RETURNING` is checked against the read policy). `can_add_walk_in_player()`; no
  `profile_id` parameter, so the link is still made only by approving a registration.
- `REVOKE SELECT ON public.public_players FROM anon, authenticated`. The view stays, for definer
  functions. Nothing is changed on `players` itself.

Application: `usePlayers()` now reads `tournament_players` for the current tournament (so the cache is keyed
per tournament); `searchPlayers()` feeds the new `PlayerPicker`; `createPlayer()` returns the new id. The
function entries in `src/integrations/supabase/types.ts` were written by hand to match; regenerate them.

### Verify after applying

```sql
SELECT has_table_privilege('anon', 'public.public_players', 'select');                                  -- false
SELECT has_table_privilege('authenticated', 'public.public_players', 'select');                         -- false
SELECT has_function_privilege('anon', 'public.tournament_players(uuid)', 'execute');                    -- true
SELECT has_function_privilege('anon', 'public.search_players(uuid, text, integer)', 'execute');         -- false
SELECT has_function_privilege('authenticated', 'public.add_walk_in_player(text, text, text, text)', 'execute'); -- true
```

The migration also checks these itself (`DO $verify$`) and fails if any is wrong. Then run
`npm run test:integration` against the local stack: `authorization.test.ts` covers the anonymous refusal,
the editor-only search, the wildcard and cap rules, and the walk-in id.

### Rolling back

```sql
GRANT SELECT ON public.public_players TO anon, authenticated;
DROP FUNCTION public.add_walk_in_player(text, text, text, text);
DROP FUNCTION public.search_players(uuid, text, integer);
DROP FUNCTION public.tournament_players(uuid);
```

The application reads the three functions, so roll it back with the migration; rolling back only the
grant leaves a build that works but shows the whole roster again.

## Applying `20261009010000_safe_live_schedule_reflow.sql`

### What it does

Rewrites `shift_live_schedule_core`, the algorithm that runs after a result lands and moves the
rest of the day around it. `shift_live_schedule_after_match` keeps its name and signature as a thin
wrapper, so `report_placement_result`, `report_tier_draw_result` and the walkover paths are untouched.
It also adds `tournament_day_at(uuid, timestamptz)` (the database twin of the client's
`sliceRowsByDay`) and drops `clear_breaks_after_reflow`, whose separate break pass is now part of the
loop.

Four defects the old core had, and what replaced them:

1. **It pulled matches earlier.** The next start was floored at the previous match's real end, with no
   floor at the match's own published time, so an early finish dragged the queue forward. Every start
   is now `GREATEST(its published time, the previous end, the player's rest window, its
   prerequisites' end)` — later only, never earlier.
2. **It did not know about days.** The queue is now scoped to the source's own day
   (`tournament_day_at`), so day two's first match is not dragged back toward the end of day one.
3. **It did not read `prerequisite_ids`.** The queue is seeded with the source's dependents as well as
   its own court, and a start is floored at every prerequisite's end.
4. **The break pass ran afterwards, separately,** without re-checking rest or the closing time.
   Breaks and the closing time are enforced inside the shifting loop now.

### The held match, and per-chain atomicity

The rewrite is atomic **per chain**, not per run. A match the reflow would move past the day's
close is **held**: it keeps its published time, and so does every still-movable match after it on the
same court and day, because that court's order can no longer be preserved. A match the run is *not*
moving is never held, even when its published time already crosses the close — the reflow did not
create that spill, and freezing a court over a time it did not set is not its job. A held match pushes
nothing — no shared player, no dependent on another court — so the rest of the day, and every
unrelated chain, still reflows and is written in the same transaction. This is the deliberate trade
the old code refused: it abandoned the whole cascade on a closing-time violation, which meant one
crashing tail froze every court. A held run is surfaced with `RAISE NOTICE` naming the matches and
the reason, and never with `RAISE EXCEPTION`, so the caller's saved result is never rolled back.

**The held rows and their predecessors overlap on purpose.** That is what `schedule_conflicts`
reports; it is not a bug in this migration. The four writes that publish times each carry
`AND NOT work.held`, and held rows are never marked `dirty`, so they are never written.

### Closing time, and how this differs from the planner

Closing time is enforced on **every** day, including the last. The planner treats its cutoff as a soft
objective term, so a full schedule that runs long can still win; a reflow may not *create* that spill,
so a cascade that would do so stops at the held match and warns instead. "Create" is literal: the
close is consulted only for a match the reflow is moving, so a match already published past the close
is left as it stands — `schedule_conflicts` reports it as `past_closing` instead. The two rules
disagree on purpose — see `docs/scheduling-decisions.md` for the planner's side.

### Locking, stated plainly

Three global advisory locks (`live-schedule`, `schedule:1`, `schedule:2`) are taken first, exactly as
`apply_day_schedule`, `apply_placement_day_schedule`, `start_match_safe` and the schedule resets take
them. This migration also takes `'live-schedule:' || tournament_id`, but that key is **redundant
today**: the global keys are already held, so no second tournament can reach it. It is the first half
of a move to per-tournament locking that cannot happen until those other writers also take a
per-tournament key — dropping the global keys here alone would break the mutual exclusion, not narrow
it. The global keys are deliberately kept.

### Timezone

`venue_timezone` is `NOT NULL` on `tournaments` (`20260909233700_tournament_hardening.sql`), so the
`(date + time) AT TIME ZONE tz` arithmetic here never sees a NULL and needs no fallback branch.

### Verify after applying

```sql
-- The core holds rather than aborting, floors at the published time, and warns rather than raises.
SELECT prosrc LIKE '%held = true%'                                        AS holds,
       prosrc LIKE '%GREATEST(current_match.shifted_time, previous_end)%' AS never_earlier,
       prosrc LIKE '%would run past closing time%'                        AS warns,
       prosrc LIKE '%AND next_start IS DISTINCT FROM current_match.shifted_time%'
                                                                          AS only_moved,
       prosrc LIKE '%v_violation%'                                        AS still_aborts  -- false
FROM pg_proc WHERE proname = 'shift_live_schedule_core';

-- The superseded pass is gone.
SELECT to_regprocedure('public.clear_breaks_after_reflow(uuid)');  -- NULL

-- The wrapper is not a client RPC.
SELECT has_function_privilege(
  'authenticated', 'public.shift_live_schedule_after_match(text, uuid)', 'execute');  -- false
```

The migration asserts the same things itself in `DO $verify$` and fails if any is wrong. Then run
`npm run test:integration` on a local stack: `integration/live-reflow.test.ts` reports a late head and
checks that the held tail keeps its time, that an unrelated court still reflows, and that a held match
pulls nobody.

### Rolling back

There is no data rollback: the rewrite changed no column and no stored value. Restore the previous
`shift_live_schedule_core` / `clear_breaks_after_reflow` definitions from `20260917030000` (and the
later replays of them) if you must revert, but note that the old core aborts a whole cascade on a
closing-time violation — reverting re-introduces that freeze.

## Applying `20261009020000_schedule_conflicts.sql`

### What it returns

`schedule_conflicts(p_tournament_id)` is a computed, editor-only read (`can_edit_tournament`) over the
rows that exist, not a stored flag. It returns zero or more rows of `(match_table, match_id, court_id,
scheduled_time, ended_at, conflict_kind, detail)`. The kinds are:

- `court_overlap` — two matches on one court whose windows overlap.
- `rest_shortfall` — a player back on court before the rest gap.
- `break` — a match sleeping inside a day break.
- `past_closing` — a match finishing after its day's closing time.
- `before_prerequisite` — a match before a match it waits on.

There is deliberately **no lateness kind**. A merely-late match is the desk's own overdue alert
(`desk-transitions.ts`), which is about the clock rather than about two rows contradicting each other;
the function does not repeat it. The `DO $verify$` block fails if `overdue` ever reappears in the
source.

### Only actionable rows

A conflict is a job for the desk, and the desk can only move a match that has not been played. So:

- `court_overlap` is emitted once per still-`scheduled` side of the pair — if both matches are already
  done, nothing is reported.
- `rest_shortfall`, `break` and `before_prerequisite` are emitted only for a still-`scheduled` match.
- `past_closing` is emitted for `scheduled` and `in-progress` (a match still running is still
  actionable).

The effect: a match already played is never flagged — not even when its rest was short or its span
overlapped, which the desk saw and accepted at the time.

### Verify after applying

```sql
-- The retired kind is gone; the still-scheduled gate is present on both overlap sides.
SELECT prosrc LIKE '%overdue%'      AS still_has_overdue,        -- false
       prosrc LIKE '%is_scheduled%' AS gates_on_scheduled,       -- true
       prosrc LIKE '%a_scheduled%'  AS gates_overlap_side_a,     -- true
       prosrc LIKE '%b_scheduled%'  AS gates_overlap_side_b      -- true
FROM pg_proc WHERE proname = 'schedule_conflicts';

-- Not callable by anon.
SELECT has_function_privilege('anon', 'public.schedule_conflicts(uuid)', 'execute');  -- false
```

The `DO $verify$` block asserts the same on apply. `integration/live-reflow.test.ts` also checks that a
played match with short rest or a historical overlap produces no row, and that a still-scheduled match
the clock has overtaken produces none either.

### Rolling back

```sql
DROP FUNCTION public.schedule_conflicts(uuid);
```

The read has no client callers yet — `useScheduleConflicts` in `src/lib/tournament/data.ts` is defined
but not wired to any surface — so dropping it breaks nothing.

## Applying `20261010000000_start_match_checks_and_reflow.sql`

Two hard physical checks move onto the start path, and starting a match late — or on another court
— starts reflowing the rest of the day the way a reported result already did.

### What it changes

1. **`tournaments.block_start_on_short_rest boolean NOT NULL DEFAULT false`.** Short rest stays a
   desk *warning* by default; a tournament that wants it enforced sets this to true. No RPC and no
   UI writes it yet (see "The setting" below); it is a data switch the check reads.
2. **`assert_can_start_match(p_table, p_match_id)`** — one internal function, shared by the three
   start RPCs, that raises when:
   - a player in this match is already on court in another match of the same tournament, or
   - the target court already has a match in progress, or
   - (only when the tournament has opted in) the player's previous match finished inside their
     stage's rest gap.
   It resolves players across all four match tables (`pool_matches`, `draw_matches`,
   `placement_matches`, `tier_draw_matches`), using the same entrant → team → player hop
   `shift_live_schedule_core` already uses, and reads the candidate's court back from the row. The
   two physical checks exclude the candidate by `(match_table, match_id)`, so it never sees itself.
3. **`start_placement_match`, `start_tier_draw_match` and `start_match_safe`** each take the global
   schedule keys, mark the row `in-progress`, run the shared check, and then run the reflow. This
   is the same order for the locks every schedule writer uses — lifecycle first, then
   `live-schedule`, `schedule:1`, `schedule:2` — which is what lets two concurrent starts not both
   pass the check on a stale read. `start_match_safe` keeps its own `assert_match_eligible` call for
   the published-time window and the desk's rest override; the new check owns "is the room actually
   free".
4. **`shift_live_schedule_core` now accepts an `in-progress` source.** `status IN ('reported',
   'walkover', 'in-progress')` in the four source reads, and the early return distinguishes a
   finished match with no end (nothing to reflow from) from an in-progress match, whose expected
   finish is derived in the loop.

### The in-progress source, and `source_time`

A finished source reflows from its published time and the loop reads its real span from
`started_at` / `ended_at`. An in-progress source has no end, so its expected finish is
`GREATEST(COALESCE(started_at, scheduled_time) + duration, statement_timestamp())` — the same
expectation `assert_match_eligible` uses. For that expectation to matter, every place the loop asked
"when did this match actually finish?" for an in-progress row now reads the actual start:
`COALESCE(actual_start, shifted_time) + duration` in the `previous`, `prereq` and `fixed` branches.
Without it, a match that began twenty minutes late reflowed as though it began on time.

The **queue boundary is the harder half.** The queue is seeded on `(original_time, match_table,
match_id) > (source_time, ...)`, and `original_time` is always the *published* time, so `source_time`
is set to `LEAST(scheduled_time, started_at)` — the earlier of the two, never the actual start alone.
Each half of that minimum fixes a case the other cannot:

- **Same court, late start.** A match published at 09:00 that starts at 09:15, with its successor
  published at 09:10. The successor sits after the source's published time but *before* it went on
  court; keyed on the actual start alone it falls behind the cut and is left overlapping the match in
  front of it. The published time reaches it, and the loop's own floor keeps it from being pulled
  earlier than it needs.
- **Change of court.** A match published on court one at 10:00 that actually starts on court two at
  10:20. Court two's 10:05 match is the one it now physically sits on; only the source's published
  time (10:00) reaches it, since the actual start (10:20) is after it. The court the match *left* is
  out of scope — the queue is keyed on the court it is on now.

The minimum is safe on both sides because every write is floored at the match's own published time:
a row the boundary reaches but nothing pushes keeps its time untouched, and a row the source now sits
on top of is caught by the loop's time-overlap window, which does not depend on the ordering.

The reflow is called at the end of the start RPCs and never raises on that path: a held chain is a
`RAISE NOTICE`, so a start that is otherwise valid is never rolled back by the reflow.

### The setting

`block_start_on_short_rest` is read only by `assert_can_start_match`. It is deliberately **not** in
`update_tournament_details`, whose contract is "a detail that changes nothing about a game" and whose
seven-column list is pinned by `db-invariants.test.ts`; a writer for it belongs with the rest gaps, and
`20261012000000_tournament_start_policy.sql` adds it as its own narrow RPC.

### Locking

The start RPCs now take `live-schedule`, `schedule:1` and `schedule:2` before the physical check, in
addition to the per-tournament lifecycle lock they already held. Two desks starting at once now
serialise on one global key rather than racing, which is the point. There is no new deadlock: every
writer takes the lifecycle key (shared for a start, exclusive only in `complete_tournament`) *before*
the global keys, and `complete_tournament` never takes a global key, so no cycle exists. The advisory
locks are held for the transaction, so the reflow called at the end of the same RPC re-acquires them
re-entrantly rather than waiting on itself.

### Verify after applying

```sql
-- The switch exists, is a NOT NULL boolean defaulting to false.
SELECT data_type, is_nullable, column_default FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'tournaments'
  AND column_name = 'block_start_on_short_rest';                                   -- boolean | NO | false

-- One shared check, off the client surface, scanning all four tables and both arms.
SELECT has_function_privilege('authenticated', 'public.assert_can_start_match(text, uuid)', 'execute'); -- false
SELECT prosrc LIKE '%pool_matches%'      AS pools,
       prosrc LIKE '%draw_matches%'      AS draws,
       prosrc LIKE '%placement_matches%' AS placement,
       prosrc LIKE '%tier_draw_matches%' AS tiers,
       prosrc LIKE '%already has a match in progress%'      AS court_check,
       prosrc LIKE '%is already playing in another match%'  AS player_check,
       prosrc LIKE '%block_start_on_short_rest%'            AS rest_switch
FROM pg_proc WHERE proname = 'assert_can_start_match';                             -- all true

-- Each start RPC runs the check and then the reflow.
SELECT proname FROM pg_proc
WHERE proname IN ('start_placement_match', 'start_tier_draw_match', 'start_match_safe')
  AND prosrc LIKE '%assert_can_start_match(%'
  AND prosrc LIKE '%shift_live_schedule_after_match(%';                            -- 3 rows

-- The reflow accepts an in-progress source and reads the actual start.
SELECT prosrc LIKE '%''in-progress''%'                                   AS from_in_progress,
       prosrc LIKE '%COALESCE(previous.actual_start, previous.shifted_time)%' AS previous_actual,
       prosrc LIKE '%COALESCE(prereq.actual_start, prereq.shifted_time)%'     AS prereq_actual,
       prosrc LIKE '%COALESCE(fixed.actual_start, fixed.shifted_time)%'       AS fixed_actual,
       prosrc LIKE '%source_status = ''in-progress''%'                       AS source_time_min
FROM pg_proc WHERE proname = 'shift_live_schedule_core';                           -- all true
```

The `DO $verify$` block asserts the same on apply and fails if any is wrong. Then run
`npm run test:integration` against the local stack. `integration/start-match-checks.test.ts` covers
the two physical refusals, the short-rest switch both ways, and a late start, an early start and a
court change through the reflow; `integration/live-reflow.test.ts` (cases (a)–(j)) and
`integration/simulation.test.ts` must stay green — the simulation reports each match before starting
the next, so it never presents the new check with a match already on court.

### Rolling back

There is no data rollback: no column is dropped and no match time is rewritten by the migration
itself. Restore the previous bodies from `20261008010000_start_on_first_match.sql` (the three start
RPCs) and `20261009010000_safe_live_schedule_reflow.sql` (`shift_live_schedule_core`), then:

```sql
DROP FUNCTION public.assert_can_start_match(text, uuid);
ALTER TABLE public.tournaments DROP COLUMN block_start_on_short_rest;
```

Rolling back re-introduces the client-only check: a start on a busy court, or by a player already on
court, would again be a desk-side warning rather than a server refusal, and a late start would again
leave the rest of the day where it was.

## Applying `20261011000000_report_ended_minutes_ago.sql`

The desk can say how long ago a match actually finished, so a result entered after the fact no longer
reflows the day as though the match ran long.

### What it changes

`report_placement_result` and `report_tier_draw_result` take an optional
`p_ended_minutes_ago integer DEFAULT 0`:

- **`> 0`** — the finish is `statement_timestamp() - make_interval(mins => N)`, and it **overwrites**
  whatever `ended_at` already held. This is the late-entry correction; `shift_live_schedule_after_match`
  then reads that resolved finish and reflows.
- **`= 0` (the default)** — the old `COALESCE(ended_at, statement_timestamp())` is kept exactly, so a
  caller that does not pass the parameter behaves as before and a fixture that pre-wrote a virtual
  `ended_at` is still respected rather than replaced with the wall clock.

It is a relative offset and never an absolute instant: a browser's clock drifts from the server's, but
"N minutes ago" is arithmetic on `statement_timestamp()`, so it is server-authoritative by construction.

The server validates the offset and the resolved window with `RAISE EXCEPTION`:

- `p_ended_minutes_ago >= 0` — an absolute finish is not accepted, so a negative offset is the only way
  to reach the future and is refused as such.
- `p_ended_minutes_ago <= 720` (the named `c_max_minutes_ago`) — twelve hours covers an honest late
  entry and refuses a typo like `7000`, whose resolved finish would land before the fixture's day.
- the resolved `ended_at` may not precede the match's `started_at`, when the match has one. A match
  reported without ever starting has no window and is not checked.

### The overload, and why the old signatures are dropped

Adding a defaulted parameter with `CREATE OR REPLACE` does not replace the old function — it creates a
second one, `(uuid, jsonb, integer)` beside `(uuid, jsonb)`. PostgREST resolves a two-key body against
the best candidate and refuses to choose between the two, so a request that only sends `p_match_id` and
`p_games` would fail as ambiguous. Both two-argument signatures are therefore dropped first, in the same
transaction, and the three-argument forms are created fresh. `DROP FUNCTION` takes the old grants with
it, so the `REVOKE`/`GRANT` pair is re-issued: `authenticated` only, `anon` and `PUBLIC` denied.

### Scope: what this deliberately does not change

Only the two current-format reporters. The legacy round-robin pair (`report_pool_result`,
`report_draw_result`) and the walkover/void path (`resolve_match_exception`) stamp their finish the same
`COALESCE` way and are **not** changed here — a late entry on those formats still records the entry
time. `shift_live_schedule_after_match` is untouched; it already reads whatever `ended_at` the report
wrote.

Application: `reportPlacementMatch` / `reportTierDrawMatch` gained an optional `endedMinutesAgo` and send
`p_ended_minutes_ago` only when it is greater than zero, so existing callers and mocks are unchanged. The
desk's score dialog draws a labelled "Finished (minutes ago)" field, default 0, only for the placement
and knockout tables, and mirrors the 720 ceiling as `MAX_ENDED_MINUTES_AGO` so it refuses a typo before
the round trip. The two function entries in `src/integrations/supabase/types.ts` were written by hand to
match; regenerate them.

### Verify after applying

```sql
-- The overload is gone: each name resolves to exactly one function.
SELECT proname, count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('report_placement_result', 'report_tier_draw_result')
GROUP BY proname;                                                                  -- 1 row each

-- The parameter, its default and the three behaviours are present.
SELECT proname,
       'p_ended_minutes_ago' = ANY(proargnames)                      AS has_param,
       pronargdefaults >= 1                                          AS has_default,
       prosrc LIKE '%make_interval(mins => p_ended_minutes_ago)%'    AS offset,
       prosrc LIKE '%COALESCE(ended_at, statement_timestamp())%'     AS keeps_old_default,
       prosrc LIKE '%cannot be in the future%'                       AS rejects_negative,
       prosrc LIKE '%is before the match started%'                   AS rejects_inverted
FROM pg_proc
WHERE proname IN ('report_placement_result', 'report_tier_draw_result');            -- all true

-- Access is unchanged.
SELECT has_function_privilege('authenticated', 'public.report_placement_result(uuid, jsonb, integer)', 'execute'); -- true
SELECT has_function_privilege('anon', 'public.report_placement_result(uuid, jsonb, integer)', 'execute');          -- false
```

The `DO $verify$` block asserts the same on apply and fails if any is wrong. Then run
`npm run test:integration` against the local stack: `integration/report-ended-ago.test.ts` covers the
zero default, the preserved fixture, the two refusals, the inverted window, and a backdated finish the
reflow reads. `integration/live-reflow.test.ts`, `start-match-checks.test.ts` and `simulation.test.ts`
must stay green — they pre-write a virtual `ended_at` and report with the default.

### Rolling back

There is no data rollback. Restore the two-argument bodies from
`20260927000000_tournova_role_redesign.sql`, then:

```sql
DROP FUNCTION public.report_placement_result(uuid, jsonb, integer);
DROP FUNCTION public.report_tier_draw_result(uuid, jsonb, integer);
```

Rolling back re-introduces the late-entry problem: a result entered fifteen minutes after the match
finished would again be recorded as a fifteen-minute overrun, and the reflow would push the rest of the
court with it.

## Applying `20261012000000_tournament_start_policy.sql`

The switch that makes short rest block a start gets a writer, so a host can turn it on from the Setup
page while the tournament is playing.

### What it adds

`set_tournament_start_policy(p_tournament_id, p_block_start_on_short_rest)`: writes exactly
`tournaments.block_start_on_short_rest`, for an owner, an editor or a platform admin, until the
tournament is completed (`assert_tournament_writable`). It is `SECURITY DEFINER` with a fixed
`search_path`, refuses a NULL value, and raises `'Unknown tournament'` when the id names no row — the
same shape as the other narrow writers.

It is deliberately **not** bundled into `update_tournament_details`. That RPC's contract is "a detail
that changes nothing about a game", its seven-column list is pinned by `db-invariants.test.ts`, and its
form is the setup wizard's, which is frozen from the first match. The start policy is an on-the-day
decision that changes how a match may start, so it is its own writer and its own UI block — usable
while the tournament runs, and disabled once it is completed.

Application: `setTournamentStartPolicy` in `src/lib/tournament/actions.ts` calls it, and
`StartPolicySection` on `/tournaments/$tournamentId/settings` renders the switch below the wizard for
callers with `can_edit`. The one function entry in `src/integrations/supabase/types.ts` was written by
hand to match; regenerate it.

### Verify after applying

```sql
-- Exactly one signature, guarded by both functions, off the anon surface.
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'set_tournament_start_policy';                         -- 1
SELECT prosrc LIKE '%can_edit_tournament%'         AS edits,
       prosrc LIKE '%assert_tournament_writable(%' AS writable,
       prosrc LIKE '%block_start_on_short_rest%'   AS writes_the_column,
       prosrc LIKE '%IS NULL%'                     AS refuses_a_missing_value
FROM pg_proc WHERE proname = 'set_tournament_start_policy';                                        -- all true
SELECT has_function_privilege('anon', 'public.set_tournament_start_policy(uuid, boolean)', 'execute');          -- false
SELECT has_function_privilege('authenticated', 'public.set_tournament_start_policy(uuid, boolean)', 'execute'); -- true
```

The `DO $verify$` block asserts the same on apply. Then run `npm run test:integration` against the
local stack: `integration/authorization.test.ts` covers the owner and editor flipping it, a caller with
no access and an anonymous one being refused, a NULL value, and a completed tournament being refused for
an ordinary owner but writable by a platform admin. `integration/start-match-checks.test.ts` now flips
the switch through this RPC, so its short-rest refusal case also proves the writer reaches
`assert_can_start_match`.

### Rolling back

```sql
DROP FUNCTION public.set_tournament_start_policy(uuid, boolean);
```

The switch stays set if it was turned on; only the writer is removed. The Setup page's block calls it, so
without the function the toggle's request fails — remove `StartPolicySection` and the
`setTournamentStartPolicy` action too, or the page renders a control that cannot save.




## Applying `20261016000000_full_knockout_bracket.sql`

A knockout draw now creates its whole bracket at once. Before, `apply_tier_draws` made round one and
`advance_tier_draw_locked` made each later round when the previous one finished, so a viewer saw no path to
the final until it was close. Now every round and slot exists from the draw; later slots start with no
entrants (a bye's winner is advanced immediately), a result fills the winner into the existing child slot,
and a slot with both sides known may be scheduled.

### What it changes

- `fill_tier_bracket(draw)` (new, internal): creates missing rounds, links `parent_a_id` / `parent_b_id`
  (previously never populated for tier matches), and advances decided winners. Idempotent.
- `apply_tier_draws`: same gates; after inserting the payload it calls `fill_tier_bracket`, so the payload
  may carry every round or only the first.
- `advance_tier_draw_locked`: no longer inserts rows. It writes each decided winner into its child slot (odd
  slot feeds side A, even side B; only while the child is still `scheduled`) and sets `champion_id` from
  the final.
- `reset_tier_draw_result`: refuses only when the child has started; otherwise it withdraws the winner from
  the child and clears the child's court and time. Resetting the final clears `champion_id`.
- `start_tier_draw_match`: refuses a match with an empty side.
- `apply_placement_day_schedule`: the knockout completeness check ignores slots with an undecided side.
- `seed_demo_tournaments()`: renamed to `seed_demo_tournaments_rows()` and wrapped by a function of the same name, signature and privileges that completes every demo bracket, so the one-call reset still yields full brackets.
- Backfill: every existing draw is given its full bracket.

Application: `buildTierBracket` and `isTierMatchReady` (`src/lib/tournament/tier-draw.ts`) mirror the same
rules; `tierItems`, `buildDeskMatches` and `knockoutScheduledIds` skip slots that are not ready.

### Verify after applying

```sql
SELECT d.tier, d.bracket_size, count(m.*) AS slots           -- slots = bracket_size - 1
FROM public.tier_draws d JOIN public.tier_draw_matches m ON m.draw_id = d.id
WHERE d.bracket_size > 1 GROUP BY d.id, d.tier, d.bracket_size;
SELECT count(*) FROM public.tier_draw_matches
WHERE round > 1 AND (parent_a_id IS NULL OR parent_b_id IS NULL);      -- 0
SELECT has_function_privilege('authenticated', 'public.fill_tier_bracket(uuid)', 'execute');  -- false
```

The `DO $verify$` block asserts the same on apply. Then run `npm run test:integration` on the local stack.

### Rolling back

The previous bodies of the five replaced functions are in `20260917010000_placement_stage_rpcs.sql`,
`20260927000000_tournova_role_redesign.sql` and `20261010000000_start_match_checks_and_reflow.sql`; re-run
them to restore. The extra later-round rows can stay, but the old `advance_tier_draw_locked` would then see
`max(round)` as the final and never advance, so delete rounds above one from any draw that has not been
played before restoring.

## Applying `20261017000000_place_ready_matches.sql`

An additive writer: it gives a newly ready match a court and a time without touching any other row.
`apply_placement_day_schedule` stays the full-rebuild writer (it clears every `scheduled` row of a stage and
re-sets the lot, publishing a change for each); this is its quiet counterpart for "a knockout slot just got
its second team".

### What it adds

`place_ready_matches(p_tournament_id, p_stage, p_slots)` returns `{ placed: [match ids], skipped: [{ match_id,
reason }] }`. For each slot it writes `court_id` and `scheduled_time` only on a `scheduled` row that has
**neither** and whose two sides are known, after re-checking on the server that the court is free and no player
is busy or inside the rest gap (the same `placement_occupied_matches` test `reschedule_placement_match` uses). A
slot that fails a check is skipped with a reason (`already_placed`, `not_ready`, `not_scheduled`, `bad_court`,
`in_the_past`, `court_busy`, `player_busy`, `incomplete`, `unknown_match`) instead of failing the batch, so a
plan computed from slightly stale data places fewer matches but cannot double-book. Guarded by
`can_edit_tournament` and `assert_tournament_writable`; takes the `live-schedule` advisory lock. The day window
and breaks are the planner's to honour; the server does not re-check them.

Application: `planPlacementSchedule({ mode: "place-ready" })` and `applyPlaceReadyPlan`
(`src/lib/tournament/placement-schedule.ts`). Nothing calls them from the UI yet.

### Verify after applying

```sql
SELECT count(*) FROM pg_proc WHERE proname = 'place_ready_matches';                                    -- 1
SELECT has_function_privilege('anon', 'public.place_ready_matches(uuid, text, jsonb)', 'execute');         -- false
SELECT has_function_privilege('authenticated', 'public.place_ready_matches(uuid, text, jsonb)', 'execute'); -- true
```

The `DO $verify$` block asserts the same on apply.

### Rolling back

```sql
DROP FUNCTION public.place_ready_matches(uuid, text, jsonb);
```

Rows it already placed keep their court and time.

## Applying `20261018000000_conflict_overrun_alignment.sql`

A `CREATE OR REPLACE` of `schedule_conflicts` with one behavioural change. Written as a new migration because
`20261009020000` is already applied to staging and production.

### The mismatch it fixes

Two matches back to back on one court — `m1` at 12:00, `m2` at 12:10, a ten-minute slot — are not
double-booked while `m1` is still inside its slot. `20261009020000` read a still-running match as occupying the
court until `GREATEST(planned_end, now)`, so the pair overlapped from the first instant `now` passed 12:10 and
the "Same court and time as another match" chip appeared at 12:10. The desk only calls the same match Overrun
once the whole minutes on court pass its slot (`deriveCourtState` in `src/lib/tournament/desk.ts`):
`floor((now - started_at) / 60s) > slot`, i.e. at `started_at + slot + 1 minute` — 12:11. Same event, two
clocks, one minute apart.

### What changes

`eff` gains `eff_court_end`, which the overlap pairing alone reads. It is `planned_end` until Overrun and
`GREATEST(planned_end, now)` after it, which is the old day-of value. `eff_end` is untouched, so
`rest_shortfall`, `past_closing` and `before_prerequisite` are unchanged: for those, "the match is still on
court" is the honest answer, and a different question from whether the court has been held past its slot. Two
*published* matches that overlap remain a conflict from publication, and an overlap against a `reported` match
is still measured from its `ended_at`; only the still-running side moves.

The reflow (`20261009010000`) is deliberately **not** changed. Its
`GREATEST(shifted_time + duration, statement_timestamp())` answers "when does this court physically free up",
and at 12:10 the court is still occupied, so it must keep using `now`. Applying the Overrun boundary there
would let the reflow publish a successor at a time already in the past.

### Verify after applying

```sql
SELECT has_function_privilege('anon', 'public.schedule_conflicts(uuid)', 'execute');          -- false
SELECT has_function_privilege('authenticated', 'public.schedule_conflicts(uuid)', 'execute'); -- true
SELECT prosrc LIKE '%eff_court_end%' AND prosrc LIKE '%interval ''1 minute''%'
FROM pg_proc WHERE proname = 'schedule_conflicts';                                            -- true
```

The `DO $verify$` block asserts the security-definer guard, the four conflict kinds, the retirement of the
`overdue` kind, the still-scheduled-only restriction and the new Overrun gate on apply. Then run
`npm run test:integration` on the local stack, which is where the conflict read is exercised against real rows.

### Rolling back

Re-apply `20261009020000_schedule_conflicts.sql`; it restores the previous body and its grants.
## Applying 20261021000000_incremental_placement_round_two.sql

Adds private fixed-source definitions and the editor/live-gated
`open_ready_placement_round_two(uuid)` RPC for fields divisible by four. Placement rows
retain non-null entrants; the RPC materializes only decided sources and is additive and
idempotent under the shared live-schedule/category locks. It does not backfill or replace
an existing round two. Odd fields and crossover retain the batch path.

Source correction/reset retracts only unstarted dependent matches; a started child blocks
it. Legacy/adaptive round twos retain their whole-category correction guard. Direct client
writes to placement_matches are revoked: all application writes already use guarded RPCs.
Source definitions have RLS enabled, no client grants, and need no realtime events because
the UI derives them from round-one rows. Actual match insertions/deletions still use the
existing placement_matches publication.

Apply as a new migration, before deploying the client. Do not edit older applied SQL.
There is no data rewrite and no automatic conversion of an event already in round two.
An old client cannot finish a partially materialized managed round two: it assumes any
round-two row means the whole batch already exists. Roll back the client only before
adoption, or keep a compatible resolver running until managed categories finish. Never
delete source metadata under played children. A full reset remains the existing explicit
destructive operation.

Verify on local Supabase with integration/placement-feeders.test.ts (RPC privileges,
concurrency, legacy preservation, correction/start races and completed events). Run the
full integration suite when a container runtime is available. Additional reasoning and
benchmark commands are in docs/incremental-placement.md. PostgreSQL WASM checks are useful
for SQL execution but do not replace Supabase authentication/RLS/realtime integration.

## Applying `20261023000000_prerequisite_order.sql`

Two `CREATE OR REPLACE`s; no table, column or data changes. Written as a new migration because
`20261010000000` and `20261017000000` are already applied (to staging at least), and applied migrations are not edited.

### What it changes

- `place_ready_matches` takes its slots earliest first and skips, with a reason, a placement match whose order
  against `prerequisite_ids` would be wrong: `prerequisite_unplaced`, `before_prerequisite`, `after_dependent`.
  Everything else (additive only, court and player checks, locks, privileges) is unchanged.
- `shift_live_schedule_core` no longer uses a prerequisite queued behind a match on that match's own court as a
  floor, which is what let a pair published out of order push itself later by a slot plus rest on every
  result. The in-progress handling from `20261010000000` is carried over verbatim. See
  docs/scheduling-decisions.md section 31 for the incident.

Deploy the migration before or with the client: an old client simply meets the new skip reasons as ordinary
declines. A pair that is already out of order is not repaired by this - a rebuild does that.

### Verify after applying

```sql
SELECT prosrc LIKE '%after_dependent%' AND prosrc LIKE '%prerequisite_unplaced%'
FROM pg_proc WHERE proname = 'place_ready_matches';                                      -- true
SELECT prosrc LIKE '%prereq.court_id = current_match.court_id%'
FROM pg_proc WHERE proname = 'shift_live_schedule_core';                                 -- true
SELECT has_function_privilege('authenticated', 'public.shift_live_schedule_core(text, uuid)', 'execute'); -- false
```

The `DO $verify$` block asserts the same on apply. `npm run test:integration` case (k) in
`live-reflow.test.ts` exercises the reflow against real rows.

### Rolling back

Re-apply the earlier bodies: `20261017000000_place_ready_matches.sql` (the whole function) and the
`shift_live_schedule_core` definition in `20261010000000_start_match_checks_and_reflow.sql`, followed by the
`REVOKE`/`GRANT` lines at their ends.
