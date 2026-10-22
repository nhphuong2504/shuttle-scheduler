# Roster changes after the schedule exists

Who may enter, withdraw or be added once seeds are locked and a schedule is built, what the
app does today, and what is deliberately not built yet. Read this before changing how a team
leaves or joins a tournament that already has matches.

## What happens today (read from the code, not exercised against a database)

| Act | Before matches exist | After matches exist |
| --- | --- | --- |
| Withdraw a team | Flags `teams.withdrawn`. **Sync entrants** on Placement waives the placement entrant (`excluded`), so the team leaves the field | Flags the team only. `sync_placement_entrants` asserts the tournament is configurable (upcoming), so it is refused; the entrant stays in the draw and its unplayed matches stay on the schedule |
| Add a late team | A new team has no placement entrant and no seed, so the seed lock reads as broken (`seedsLocked` goes false) until it is synced and seeded | Cannot be synced (same assertion) |
| Record a walkover | | The Desk's walkover action (`resolve_match_exception`) |

## What is built

- **Withdrawal warning** ([`withdrawal-impact.ts`](../src/lib/tournament/withdrawal-impact.ts)): the
  Withdraw button on Entries counts the team's unplayed, scheduled, on-court and decided matches
  and asks for confirmation, saying the draw and schedule do not change by themselves and that a
  walkover on the Desk is what removes the team from each match. It changes no data.

## What is not built, and why

These need new SQL (RPCs and migrations) that has to be run against Postgres before it can be
trusted; the repository's integration suite needs a local Supabase stack (a container runtime),
and the integration CI workflow was unavailable when this was written. They are listed so the
decision is not lost, not because they are small.

1. **Withdraw that applies itself.** An RPC that, in one transaction, flags the team, waives its
   entrant, turns each unplayed match into a walkover for the opponent and runs the live reflow,
   refusing while any of its matches is on court. Replaces the manual walkovers above.
2. **Late add.** A guarded RPC that creates the entrant with the last seed while the tournament is
   upcoming and refuses it once matches exist, with a plain reason.
3. **Shift the schedule.** `shift_tournament_days(from_day, delta_days)` honouring the day-order and
   window triggers, reflowing unstarted matches. Today a day can be edited
   (`updateTournamentDay`) but its matches do not move with it; the organiser rebuilds.
4. **Court outage.** Reassigning a switched-off court's unstarted matches. Today
   `setTournamentDayCourts` replaces the day's court set and the matches on a removed court are not
   reassigned (the live reflow only pushes matches later within their day).
5. Check the row-level security on `teams`: the withdraw is a direct table update, and what a
   non-editor or a participant can do with it has been read about, not verified.

When these are built they are high-risk changes under AGENTS.md: full gate at every stage,
`npm run test:integration` against the local stack, and a second reviewer.
