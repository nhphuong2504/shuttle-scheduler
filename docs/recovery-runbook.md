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
  migrations was compared against production with `scripts/parity-dump.sql`, which emits
  `pg_get_functiondef`, `pg_get_constraintdef` and policy `qual` text rather than names.
  61 function bodies, 38 policy expressions, 207 columns, 119 constraints, 68 indexes, 643
  table grants and 211 routine grants were **identical**. The only differences were
  platform infrastructure: the local stack's `_realtime` / `supabase_functions` schemas,
  Supabase's internal `supabase_realtime_messages_publication`, and `statement_timeout`.
- **A production dump restores into that rebuilt schema**, with values matching production
  field for field — not just row counts.
- **The restore procedure handles a populated bracket.** A dump containing rows in
  `draws`, `draw_matches`, `tier_draws` and `tier_draw_matches`, with a child row
  physically preceding its parent, loads in a single pass. All 54 foreign keys are re-added
  and the trigger-derived columns come out correct.

**Not verified — treat as untested:**

- **No restore has been run against the hosted project.** Every drill so far has used the
  local stack. Procedure B uses a code path that is verified locally and permitted by
  production's privileges, but that is an argument, not a rehearsal.

## Prerequisites

- **`pg_dump` / `pg_restore` / `psql`** — these ship with the Postgres client tools, *not*
  with the Supabase CLI:
  ```sh
  brew install libpq
  export PATH=/opt/homebrew/opt/libpq/bin:$PATH
  ```
- **`SUPABASE_DB_PASSWORD`** — the database password from Project Settings → Database. Lives
  in `.env.local` (git-ignored). A publishable key will not work: both `pg_dump` and
  `pg_restore` authenticate as the database role.
- **`SUPABASE_ACCESS_TOKEN`** — in `.env`. Used to look up the pooler host, and by
  `scripts/run-sql.mjs` to run read-only catalogue queries.

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

```sh
npm run restore:to-local -- backups/<dump> --yes
```

This empties every table in `public`, makes the load order-independent, loads the dump in a
single pass, puts the constraints and triggers back, and then compares every table against
the counts **derived from the dump itself** — so the numbers it checks against are a
property of the file being restored, not of anything left lying around.

**Why the emptying matters:** `20260910043000_reconstruct_demo_tournament_data.sql` bakes in
a demo tournament with *the same row counts* as a fresh production dump. Without emptying
first, a restore that did nothing at all would still report matching counts.

The drill and a real recovery run the same code path, so the rehearsal exercises what an
incident would actually run. That is deliberate — an earlier version of this script worked
one way locally and could not work at all on a hosted project.

## Procedure B — restore into a hosted project

```sh
node scripts/restore-backup.mjs backups/<dump> \
  --project-ref bwzemvaftzforfmaprif --allow-production --yes
```

The target has to be named explicitly, and the production ref needs `--allow-production` on
top of `--yes`, so a mistyped invocation cannot quietly overwrite the live database.

Before running it, the schema has to exist — the script loads data, it does not apply
migrations, because "rebuild the schema" and "overwrite the data" are separate decisions:

```sh
node scripts/apply-migrations.mjs bwzemvaftzforfmaprif --allow-production
```

Then, in summary:

1. **Stop writes.** Take the app down or put it in maintenance. A restore replaces data; any
   write that lands during it is lost.
2. **Rebuild the schema** — `scripts/apply-migrations.mjs`.
3. **Load the data** — `scripts/restore-backup.mjs` with `--allow-production`.
4. **Recreate the staff logins** — see [The auth seam](#the-auth-seam).
5. **Verify** — the script does this itself and fails if a table does not match.

The connection string must use the pooler's **session** port (5432), not the transaction
port (6543). Transaction mode may run each statement on a different backend connection, and
a restore needs a consistent session. The script forces the session port rather than
trusting it, because the failure is an obscure mid-restore error rather than a clear one.

### Why loading order is the hard part

A data-only restore lands rows into a schema that already has its constraints and triggers.
Two separate mechanisms make the dump's own order unusable, and only fixing the first is a
trap.

**Foreign keys.** The dump's tables are ordered alphabetically, so `categories` is restored
before the `tournaments` row it references. Against a full production dump, **29 of 50
foreign key relationships are out of order**, and a plain `pg_restore --data-only` fails
partway through.

**Triggers that derive columns.** `pool_entries_membership` is a BEFORE INSERT trigger that
reads `tournament_id` from `pools` and writes it onto the new row:

```sql
SELECT category_id, tournament_id INTO pool_cat, pool_tournament
FROM public.pools WHERE id = NEW.pool_id;
...
NEW.tournament_id := pool_tournament;
```

If `pools` has not been loaded yet, it writes **NULL**, and a NOT NULL constraint rejects the
row. Dropping the foreign keys does nothing about this: with all 54 dropped, `pool_entries`
still loaded **0 of 145 rows**. Only disabling the trigger fixes it.

### What the script does instead of ordering

It makes the order stop mattering:

- **Drops the 54 foreign keys**, then re-adds them. `ADD CONSTRAINT` validates every existing
  row as it is added, so re-adding is itself an integrity check rather than a formality.
- **Disables user triggers** for the duration, then re-enables them.

`ALTER TABLE ... DISABLE TRIGGER USER` is permitted to the **table owner**, not a superuser,
and that is the whole reason this works on a hosted project — `postgres` owns all 19 tables
there. The two obvious alternatives do not:

```
pg_restore --disable-triggers   →  needs superuser
SET session_replication_role    →  ERROR: 42501: permission denied to set parameter
```

Both were checked against production; `postgres` is not a superuser there. Verified locally
that the approach works as a non-superuser (`rolsuper=false`).

If the script is interrupted after the constraints are dropped, it has written
`<dump>.repair.sql` containing the statements to put them back. That file is the record of
how to repair the schema, so do not delete it mid-incident.

### Two traps if you hand-roll any of this

- **`pg_restore` exits 0 when a COPY fails.** The exit code is not a success signal; the
  output has to be read. A script that only checks `$?` will report a clean restore over a
  half-empty database.
- **`--table` must be unqualified.** `--table=public.players` matches no entry in the
  archive and exits **0** having restored nothing. This is how the first version of this
  drill was fooled into reporting success. Always check row counts afterwards.

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
