# Migration operations

Read this before adding or applying SQL. Migrations run in filename order and are
append-only once applied. The complete per-migration narrative, checks, rollback notes
and historical behavior remain in [history](history.md); read the relevant entries only.

## Create and validate

1. Inspect Git state and the latest migrations defining the affected function/table.
   Read the current authorization contract and exact guard/grant details when relevant.
2. Add a new timestamped SQL file. Preserve existing data and explicit privileges,
   SECURITY DEFINER search paths, locking and transactional checks. Never edit applied SQL.
3. Validate SQL against the local Supabase stack, not a hosted project. A replay from
   empty and an upgrade with existing data are distinct checks; use owned fixtures for
   upgrade behavior, and do not reset a developer's database without explicit scope.
4. Run the full application gate plus local integration for RLS/RPC/realtime changes.
   Browser mocks and regex assertions cannot prove Postgres execution.

## Apply and verify

Hosted staging and production are separate from the local stack. Automation must never
use a hosted project as its test target. Do not print credentials or dump status output.
For an explicitly authorized deployment, choose the intended project before applying:

```sh
npm run db:link
npm run db:push
```

`db:link` uses `SUPABASE_PROJECT_ID`; the CLI keeps the linked target in ignored local
scratch state. Do not treat `supabase/config.toml`'s local id as the hosted link. `db:push`
needs the database password. Where only a management token is available, the documented
`scripts/apply-migrations.mjs` path records each migration transactionally and refuses
production without its explicit flag. Read [replay details](history.md#replaying-the-migrations-scriptsapply-migrationsmjs)
before choosing it. No apply/deploy command is part of agent context lookup or doctor.

After applying, verify migration history in both directions (`npm run db:drift` with the
explicit target), changed RPC signatures/grants, catalog policies and realtime membership.
Use the relevant historical verification SQL and actual role-scoped integration probes.
Regenerate Supabase types only against the intended schema (`npm run db:types` uses the
linked project), then review the generated diff and rerun affected checks.

## Recovery and comparison

There is no universal down migration. Read the relevant rollback notes and
`docs/recovery-runbook.md` before relying on a backup or attempting a repair. Backups are
private/ignored; auth identities and profile relationships need their own recovery steps.

Migration ledger parity alone does not prove schema/function/policy equivalence. The
read-only comparison tools and their limitations are documented in
[backend comparison](history.md#comparing-two-projects-scriptsparity-dumpsql-scriptsmigration-statusmjs-and-scriptsmigration-drift-checksql).
Never remove drift or a permission refusal by rewriting migration history.

## Historical entry links

These anchors keep previous links usable. Each leads to the full original entry; old
roles, active-tournament pointers and lifecycle vocabulary are historical, not new rules.

<a id="applying-20260915000000_tournament_scopingsql"></a> [Applying `20260915000000_tournament_scoping.sql`](history.md#applying-20260915000000_tournament_scopingsql)

<a id="applying-20260916000000_tournament_creation_flowsql"></a> [Applying `20260916000000_tournament_creation_flow.sql`](history.md#applying-20260916000000_tournament_creation_flowsql)

<a id="applying-20260916010000_tournament_auth_hardeningsql"></a> [Applying `20260916010000_tournament_auth_hardening.sql`](history.md#applying-20260916010000_tournament_auth_hardeningsql)

<a id="applying-20260916020000_delete_tournamentsql"></a> [Applying `20260916020000_delete_tournament.sql`](history.md#applying-20260916020000_delete_tournamentsql)

<a id="applying-20260916030000_tournament_notessql"></a> [Applying `20260916030000_tournament_notes.sql`](history.md#applying-20260916030000_tournament_notessql)

<a id="applying-20260917000000_placement_stagesql-and-20260917010000_placement_stage_rpcssql"></a> [Applying `20260917000000_placement_stage.sql` and `20260917010000_placement_stage_rpcs.sql`](history.md#applying-20260917000000_placement_stagesql-and-20260917010000_placement_stage_rpcssql)

<a id="applying-20260917030000_placement_live_schedule_shiftsql"></a> [Applying `20260917030000_placement_live_schedule_shift.sql`](history.md#applying-20260917030000_placement_live_schedule_shiftsql)

<a id="applying-20260917050000_placement_stage_resetsql"></a> [Applying `20260917050000_placement_stage_reset.sql`](history.md#applying-20260917050000_placement_stage_resetsql)

<a id="applying-20260926000000_placement_schedule_resetsql"></a> [Applying `20260926000000_placement_schedule_reset.sql`](history.md#applying-20260926000000_placement_schedule_resetsql)

<a id="applying-20260926010000_placement_stage_reset_gatesql"></a> [Applying `20260926010000_placement_stage_reset_gate.sql`](history.md#applying-20260926010000_placement_stage_reset_gatesql)

<a id="applying-20260917060000_placement_desk_movesql"></a> [Applying `20260917060000_placement_desk_move.sql`](history.md#applying-20260917060000_placement_desk_movesql)

<a id="applying-20260917070000_placement_reset_clears_startsql"></a> [Applying `20260917070000_placement_reset_clears_start.sql`](history.md#applying-20260917070000_placement_reset_clears_startsql)

<a id="applying-20260917080000_placement_realtime_publicationsql"></a> [Applying `20260917080000_placement_realtime_publication.sql`](history.md#applying-20260917080000_placement_realtime_publicationsql)

<a id="applying-20260917090000_placement_seed_reordersql"></a> [Applying `20260917090000_placement_seed_reorder.sql`](history.md#applying-20260917090000_placement_seed_reordersql)

<a id="known-behaviour-an-early-report-rewrites-the-rest-of-that-courts-day"></a> [Known behaviour: an early report rewrites the rest of that court's day](history.md#known-behaviour-an-early-report-rewrites-the-rest-of-that-courts-day)

<a id="fixed-a-played-match-could-stop-the-whole-build"></a> [Fixed: a played match could stop the whole build](history.md#fixed-a-played-match-could-stop-the-whole-build)

<a id="applying-20260917040000_placement_day_schedule_slot_fixsql"></a> [Applying `20260917040000_placement_day_schedule_slot_fix.sql`](history.md#applying-20260917040000_placement_day_schedule_slot_fixsql)

<a id="applying-20260917020000_placement_helper_grantssql"></a> [Applying `20260917020000_placement_helper_grants.sql`](history.md#applying-20260917020000_placement_helper_grantssql)

<a id="applying-20260919010000_defer_day_courts_readinesssql"></a> [Applying `20260919010000_defer_day_courts_readiness.sql`](history.md#applying-20260919010000_defer_day_courts_readinesssql)

<a id="applying-20260919020000_set_tournament_courtssql"></a> [Applying `20260919020000_set_tournament_courts.sql`](history.md#applying-20260919020000_set_tournament_courtssql)

<a id="applying-20260919030000_trim_readiness_to_setup_scopesql"></a> [Applying `20260919030000_trim_readiness_to_setup_scope.sql`](history.md#applying-20260919030000_trim_readiness_to_setup_scopesql)

<a id="applying-20260919040000_tournament_day_managementsql"></a> [Applying `20260919040000_tournament_day_management.sql`](history.md#applying-20260919040000_tournament_day_managementsql)

<a id="the-test-field-seed50-test-playerssql"></a> [The test field: `../seed/50-test-players.sql`](history.md#the-test-field-seed50-test-playerssql)

<a id="applying-20260920000000_realtime_publication_membershipsql"></a> [Applying `20260920000000_realtime_publication_membership.sql`](history.md#applying-20260920000000_realtime_publication_membershipsql)

<a id="comparing-two-projects-scriptsparity-dumpsql-scriptsmigration-statusmjs-and-scriptsmigration-drift-checksql"></a> [Comparing two projects: `scripts/parity-dump.sql`, `scripts/migration-status.mjs` and `scripts/migration-drift-check.sql`](history.md#comparing-two-projects-scriptsparity-dumpsql-scriptsmigration-statusmjs-and-scriptsmigration-drift-checksql)

<a id="applying-20260927000000_tournova_role_redesignsql"></a> [Applying `20260927000000_tournova_role_redesign.sql`](history.md#applying-20260927000000_tournova_role_redesignsql)

<a id="applying-20260929000000_identity_canonsql"></a> [Applying `20260929000000_identity_canon.sql`](history.md#applying-20260929000000_identity_canonsql)

<a id="applying-20260929001000_tournament_summarysql"></a> [Applying `20260929001000_tournament_summary.sql`](history.md#applying-20260929001000_tournament_summarysql)

<a id="applying-20260929010000_retire_is_activesql"></a> [Applying `20260929010000_retire_is_active.sql`](history.md#applying-20260929010000_retire_is_activesql)

<a id="applying-20260929020000_registration_entries_and_identitysql"></a> [Applying `20260929020000_registration_entries_and_identity.sql`](history.md#applying-20260929020000_registration_entries_and_identitysql)

<a id="applying-20260929030000_walk_in_player_predicatesql"></a> [Applying `20260929030000_walk_in_player_predicate.sql`](history.md#applying-20260929030000_walk_in_player_predicatesql)

<a id="applying-20261007000000_explore_tournamentssql"></a> [Applying `20261007000000_explore_tournaments.sql`](history.md#applying-20261007000000_explore_tournamentssql)

<a id="applying-20261008000000_tournament_windowsql"></a> [Applying `20261008000000_tournament_window.sql`](history.md#applying-20261008000000_tournament_windowsql)

<a id="applying-20261008010000_start_on_first_matchsql"></a> [Applying `20261008010000_start_on_first_match.sql`](history.md#applying-20261008010000_start_on_first_matchsql)

<a id="applying-20261008020000_registration_window_rulessql"></a> [Applying `20261008020000_registration_window_rules.sql`](history.md#applying-20261008020000_registration_window_rulessql)

<a id="applying-20261008030000_update_tournament_detailssql"></a> [Applying `20261008030000_update_tournament_details.sql`](history.md#applying-20261008030000_update_tournament_detailssql)

<a id="applying-20261008040000_result_correction_guardssql"></a> [Applying `20261008040000_result_correction_guards.sql`](history.md#applying-20261008040000_result_correction_guardssql)

<a id="applying-20261009000000_scoped_player_readssql"></a> [Applying `20261009000000_scoped_player_reads.sql`](history.md#applying-20261009000000_scoped_player_readssql)

<a id="applying-20261009010000_safe_live_schedule_reflowsql"></a> [Applying `20261009010000_safe_live_schedule_reflow.sql`](history.md#applying-20261009010000_safe_live_schedule_reflowsql)

<a id="applying-20261009020000_schedule_conflictssql"></a> [Applying `20261009020000_schedule_conflicts.sql`](history.md#applying-20261009020000_schedule_conflictssql)

<a id="applying-20261010000000_start_match_checks_and_reflowsql"></a> [Applying `20261010000000_start_match_checks_and_reflow.sql`](history.md#applying-20261010000000_start_match_checks_and_reflowsql)

<a id="applying-20261011000000_report_ended_minutes_agosql"></a> [Applying `20261011000000_report_ended_minutes_ago.sql`](history.md#applying-20261011000000_report_ended_minutes_agosql)

<a id="applying-20261012000000_tournament_start_policysql"></a> [Applying `20261012000000_tournament_start_policy.sql`](history.md#applying-20261012000000_tournament_start_policysql)

<a id="applying-20261016000000_full_knockout_bracketsql"></a> [Applying `20261016000000_full_knockout_bracket.sql`](history.md#applying-20261016000000_full_knockout_bracketsql)

<a id="applying-20261017000000_place_ready_matchessql"></a> [Applying `20261017000000_place_ready_matches.sql`](history.md#applying-20261017000000_place_ready_matchessql)

<a id="applying-20261018000000_conflict_overrun_alignmentsql"></a> [Applying `20261018000000_conflict_overrun_alignment.sql`](history.md#applying-20261018000000_conflict_overrun_alignmentsql)

<a id="applying-20261021000000_incremental_placement_round_twosql"></a> [Applying 20261021000000_incremental_placement_round_two.sql](history.md#applying-20261021000000_incremental_placement_round_twosql)

<a id="applying-20261023000000_prerequisite_ordersql"></a> [Applying `20261023000000_prerequisite_order.sql`](history.md#applying-20261023000000_prerequisite_ordersql)

<a id="applying-20261023010000_whole_millisecond_match_timessql"></a> [Applying `20261023010000_whole_millisecond_match_times.sql`](history.md#applying-20261023010000_whole_millisecond_match_timessql)

<a id="applying-20261024000000_in_app_call_nextsql"></a> [Applying `20261024000000_in_app_call_next.sql`](history.md#applying-20261024000000_in_app_call_nextsql)

<a id="applying-20261027000000_reflow_past_closingsql"></a> [Applying `20261027000000_reflow_past_closing.sql`](history.md#applying-20261027000000_reflow_past_closingsql)
