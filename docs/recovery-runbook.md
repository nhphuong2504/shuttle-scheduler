# Database recovery runbook

> **Read this before you need it.** Everything here is about getting the database back
> after data loss — an accidental truncate, a bad migration, a dropped project.
>
> The one thing to know up front: **the backup does not contain logins.** A recovery
> restores the tournament data and the staff *roles*, but every staff member's `auth.users`
> identity has to be recreated separately. See [The auth seam](#the-auth-seam).

The recovery model is two-part, and the two parts come from different places:

| Part | Source | Why |
| --- | --- | --- |
| Schema — tables, functions, policies, triggers, grants | `supabase/migrations` (35 files) | The migrations are the source of truth for behaviour, so they are what rebuild it |
| Data — every row in `public` | A `pg_dump` backup | Operators type this during an event and none of it is regenerable |
| Logins — `auth.users` | `scripts/create-staff-login.mjs` | Recreated on purpose; see the auth seam |

## What is verified, and what is not

Verified on 2026-09-22 against production (`bwzemvaftzforfmaprif`):

- **The migrations reproduce production's schema exactly.** A database rebuilt from the 35
  migrations was compared against production using `scripts/parity-dump.sql`, which emits
  `pg_get_functiondef`, `pg_get_constraintdef` and policy `qual` text rather than names.
  61 function bodies, 38 policy expressions, 207 columns, 119 constraints, 68 indexes, 643
  table grants and 211 routine grants were **identical**. The only differences were
  platform infrastructure: the local stack's `_realtime` / `supabase_functions` schemas,
  Supabase's internal `supabase_realtime_messages_publication`, and `statement_timeout`.
- **A production dump restores into that rebuilt schema**, and the restored values match
  production field for field — not just row counts.

**Not verified — treat as untested:**

- **No restore has been run against the hosted project.** Every drill so far has used the
  local stack. The procedure in [Procedure B](#procedure-b--restore-into-a-hosted-project)
  is the one that *would* be used, and its two approaches are reasoned rather than
  exercised.
- **No backup has been restored that contains a populated bracket.** Every dump so far has
  `draw_matches` and `tier_draw_matches` empty, which is what makes the ordered approach
  work. See [Foreign keys are the hard part](#foreign-keys-are-the-hard-part).

## Prerequisites

- **`pg_dump` / `pg_restore` / `psql`** — these ship with the Postgres client tools, *not*
  with the Supabase CLI:
  ```sh
  brew install libpq
  export PATH=/opt/homebrew/opt/libpq/bin:$PATH
  ```
- **`SUPABASE_DB_PASSWORD`** — the database password from Project Settings → Database. Lives
  in `.env.local` (git-ignored). A publishable key will not work: `pg_dump` authenticates as
  the database role.
- **`SUPABASE_ACCESS_TOKEN`** — in `.env`. Used to look up the pooler host and, via
  `scripts/run-sql.mjs`, to run read-only catalogue queries.

## Taking a backup

```sh
npm run backup:production
```

It resolves the target from `.env.production`, prints it before reading anything, records
per-table row counts beside the dump, and reads the dump's table of contents back with
`pg_restore --list` as the cheapest proof the file is usable. Dumps land in `backups/`,
which is git-ignored — they contain player emails.

**A backup is only as good as the moment it was taken.** There is no PITR on this project,
so the loss window is however long it has been since the last dump. Take one before every
event.

## Procedure A — rehearse into the local stack

This is the drill, and it is scripted:

```sh
npm run restore:to-local -- backups/<dump> --yes
```

It calls `supabase db reset` first, so the schema is rebuilt from the migrations exactly as
it would be in a real recovery, then truncates the migration baseline and loads the dump's
data. It finishes by comparing every table against the counts recorded in the dump, and
fails loudly on any mismatch.

**Why the truncate matters:** `20260910043000_reconstruct_demo_tournament_data.sql` bakes in
a demo tournament with *the same row counts* as a fresh production dump. Without truncating
first, a restore that did nothing at all would still report matching counts.

It connects as `supabase_admin` for the load so it can pass `--disable-triggers`. That role
is local-only, and is why this exact invocation does not carry over to production.

## Procedure B — restore into a hosted project

> **Untested.** No hosted restore has been rehearsed. Read
> [Foreign keys are the hard part](#foreign-keys-are-the-hard-part) before relying on this.

There is deliberately no script for this. The local script refuses any target it cannot
prove is the local stack, because it deletes everything it touches, and a script that can be
pointed at production is a script that eventually will be.

The shape of it:

1. **Stop writes.** Take the app down or put it in maintenance. A restore replaces data; any
   write that lands during it is lost.
2. **Rebuild the schema** by applying every migration. `scripts/apply-migrations.mjs` does
   this with a personal access token, recording each file in
   `supabase_migrations.schema_migrations` in the same transaction.
3. **Load the data** — see below.
4. **Recreate the staff logins** — see [The auth seam](#the-auth-seam).
5. **Verify** against the dump's `.counts.json`.

The connection string must use the pooler's **session** port (5432), not the transaction
port (6543). Transaction mode may run each statement on a different backend connection, and
a restore needs a consistent session; the failure is an obscure mid-restore error rather
than a clear one.

```sh
# session mode, as the postgres role
export PGURL="postgresql://postgres:<password>@aws-0-us-west-2.pooler.supabase.com:5432/postgres"
```

### Foreign keys are the hard part

Restoring only data means the foreign keys already exist, and this is where a naive restore
fails. Two facts about this schema:

- **The dump's table order is alphabetical, not dependency-ordered** — `categories` is
  restored before `tournaments` that it references. Against this dump, **29 of 50 foreign
  key relationships are out of order**, so a plain `pg_restore --data-only` will fail
  partway.
- **The usual two escapes are both unavailable on hosted.** `--disable-triggers` and
  `SET session_replication_role = replica` both require superuser, and the `postgres` role
  is not one on a hosted project:
  ```
  ERROR: 42501: permission denied to set parameter "session_replication_role"
  ```

That leaves two workable approaches.

**1. Ordered restore — load one table at a time, parents first.** No superuser, no schema
changes. This is verified locally: with the tables emptied first, `pg_restore --data-only
--table=<name>` for each table in topological order restored all 935 rows with no trigger
suppression at all.

```sh
# Dependency order, computed from the foreign-key graph. RECOMPUTE THIS when a migration
# adds a table or a foreign key - a stale list restores silently and incompletely.
for t in desk_activity players staff_roles tournaments categories courts \
         tournament_days draws pools teams tournament_day_breaks \
         tournament_day_courts draw_matches placement_entrants pool_entries \
         pool_matches placement_matches tier_draws tier_draw_matches; do
  pg_restore --data-only --no-owner --no-privileges --table="$t" --dbname "$PGURL" <dump>
done
```

Two traps:

- **`--table` must be unqualified.** `--table=public.players` matches no entry in the
  archive and exits **0** having restored nothing — a silent no-op that looks exactly like
  success. This is how the first version of this drill was fooled. Always check row counts
  afterwards.
- **It cannot handle self-referencing foreign keys.** `draw_matches.parent_a_id` /
  `parent_b_id` reference `draw_matches` itself, as do the same columns on
  `tier_draw_matches`. Within a single table's load the rows arrive in dump order, and a row
  referencing a later row in the same table fails. **Both tables are empty today, which is
  the only reason this works.** The first dump containing a real bracket will break it.

**2. Drop the foreign keys, load, re-add them — the approach that survives a populated
bracket.** The `postgres` role owns all 19 `public` tables, so it can drop and re-add its own
constraints without superuser. Load order then stops mattering entirely:

1. Record every constraint definition first (`parity-dump.sql`'s `constraint` and
   `trigger` sections already emit them, and the migrations can recreate them).
2. `ALTER TABLE ... DROP CONSTRAINT ...` for all 54 foreign keys.
3. Restore the data in any order.
4. Re-add the constraints and verify with a parity diff against a database rebuilt from
   migrations.

This is the recommended production procedure, and it is the one thing here that has **not**
been exercised. Verify it against a real dump with a populated bracket before trusting it.

## The auth seam

`auth.users` is excluded from the backup on purpose — a partial `auth` restore is not
something to attempt during an incident. So after restoring data:

```sh
node scripts/create-staff-login.mjs <email>
```

Email is the durable key: the migrations seed `staff_roles` with the email, and the
`on_auth_user_created_link_staff` trigger fills in `staff_roles.user_id` when the account is
created. There is no UUID or password to migrate.

**What this means in practice:** after a recovery, **staff cannot sign in until their login
is recreated.** Their role, and therefore their authorization, is already correct — the
restored `staff_roles` row carries it — but there is no account to authenticate as. Plan for
this: it is the step that turns a completed restore into a usable application.

## Limits

- **No PITR, and no retained backups on the project.** The only recovery points are the
  dumps in `backups/`.
- **A dump is a point in time.** Anything written after it is gone; that is the whole reason
  to take one before an event rather than after.
- **`statement_timeout` is 120s in production and unlimited locally.** Supabase's platform
  default. A slow query that succeeds locally can be killed in production, so the local
  stack will never reproduce that failure.
- **The dumps live on one machine.** A backup beside the repository it backs up does not
  survive a lost laptop. Nothing here is a substitute for an offsite copy.
