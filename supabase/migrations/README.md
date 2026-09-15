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
