# Roster changes after the schedule exists

Who may enter, withdraw or be added once seeds are locked and a schedule is built, what the
app does now, and what is still deliberately not built. Read this before changing how a team
leaves or joins a tournament that already has matches.

Source: [`20261022040000_mid_tournament_changes.sql`](../supabase/migrations/20261022040000_mid_tournament_changes.sql)
and [`placement-actions.ts`](../src/lib/tournament/placement-actions.ts).

## What happens now

| Act | Before matches exist | After matches exist |
| --- | --- | --- |
| Withdraw a team | The Entries button flags `teams.withdrawn`; **Sync entrants** waives the placement entrant, so the team leaves the field | The same button calls `withdraw_placement_team`: the flag, the waiver, a walkover for every unplayed match, the bracket advance and the day's reflow, in one transaction. Refused while one of its matches is on court |
| Add a late team | A new team has no placement entrant and no seed, so the seed lock reads as broken until it is synced and seeded | `add_placement_entrant` adds it as the lowest seed. Refused once any placement match exists - the pairing is then a fact, and adding a team is a re-draw |
| Move the rest of the tournament | The days and the window are edited one at a time; matches do not follow | `shift_tournament_days(from, delta)` moves the window, every day from `from` on, and their unplayed matches. Refused once anything from that day on has been played |
| A court fails | The day's court set is replaced and the matches on the removed court are left behind | Not supported as its own act. Remove the court from the day on the Schedule page and review a rebuild. `reassign_court_matches` was dropped (`20261025010000_drop_reassign_court_matches.sql`): it needed a court with nothing scheduled all day, which a full venue never has, and no surface ever called it |
| Record a walkover | | The Desk's walkover action (`resolve_match_exception`), still available per match |

## What the three RPCs guarantee

Each does the whole act in one transaction, so there is no window in which a withdrawn team still
holds a court, or a moved day has matches on the old date.

- **No result is ever edited.** A match already reported keeps its score, even if the team that won
  it then withdraws - that score is a fact about a game that was played. Only `scheduled` rows are
  converted, and a walkover stores `games = '[]'`, inventing nothing.
- **A team on court is refused** rather than withdrawn, because taking a team out mid-match is a
  retirement, not a withdrawal (see [cleanup-deferred.md](cleanup-deferred.md)).
- **The lock order matches every other writer**: `live-schedule`, then the category/court/day key,
  then rows. Reversing it lets two moderators deadlock each other; the collision is demonstrated in
  the header of [`20261022030000_report_guards.sql`](../supabase/migrations/20261022030000_report_guards.sql).
- **A day shift preserves the venue's wall clock**, not the session's. `scheduled_time + interval
  'n days'` keeps the *session* timezone's clock, so a shift across a DST boundary would move every
  match an hour on the venue's clock; the function converts through `venue_timezone` instead.

## What is built beside the RPCs

- **Withdrawal warning** ([`withdrawal-impact.ts`](../src/lib/tournament/withdrawal-impact.ts)): the
  Withdraw button counts the team's unplayed, scheduled, on-court and decided matches and asks for
  confirmation, naming what the withdrawal will convert. It runs before the RPC and changes no data
  itself.

## What is still not built, and why

1. **Late add after the draw.** Refused by design: the pairing is a fact once matches exist, so
   changing the field means resetting the stage (`reset_placement_stage`) and drawing again. A
   re-draw that preserved results would have to decide what a half-played draw means, which is a
   product decision rather than a missing RPC.
2. **Retirement mid-match.** A player who stops during a game still has no representation; the only
   exception paths are `walkover` and `void`. Recorded in
   [cleanup-deferred.md](cleanup-deferred.md) with the status-set work it needs.
3. **Row-level security on `teams`.** The withdraw RPC is `SECURITY DEFINER` and checks
   `can_edit_tournament`, so it is safe by construction. The *direct* `teams` update that
   `setTeamWithdrawn` makes is still governed only by the table's policy, and what a non-editor or a
   participant can do with it has been read about, not verified. It needs a run of
   `npm run test:integration`, which needs a container runtime.

## Verification status

The migration has been applied to a real Postgres 18.4 and its four functions exercised: withdrawal
(including the on-court refusal and the bracket advance), late add (including the draw-exists
refusal), a day shift (including the DST case and the played-result refusal) and a court move
(including both refusals). That check ran on a bare cluster with stand-in tables, not through this
repository's integration suite, so **`npm run test:integration` against the local stack is still
owed** before this is trusted end to end - and it is a high-risk change under AGENTS.md.

## Reversing a withdrawal

`withdraw_placement_team` is one-way: it converts matches to walkovers, and putting a team back into
a draw that has already advanced would silently change who a later round says won. Reinstating the
entry (`setTeamWithdrawn(id, false)`) restores the flag, and the converted matches stay walkovers -
re-pairing them is the stage reset above, by design.
