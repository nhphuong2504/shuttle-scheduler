# Tournament format and rules

This document describes the tournament rules **as implemented**. Where it and the
code disagree, the code is right.

Two things to know before reading:

- **The supported format is a two-round placement stage feeding A/B/C/D knockout
  draws.** The older round-robin pool format is still in the codebase and still
  reachable by direct URL, but the creation wizard no longer offers it and it is
  not the format new tournaments run. See [Legacy pool engine](#legacy-pool-engine).
- **Venue figures are examples, not platform constraints.** Court counts, player
  counts and event durations in this document describe one tournament's planning
  numbers. Nothing in the app enforces them; see
  [Worked example](#worked-example-not-a-constraint).

## The supported format

Every entrant plays **exactly two** placement matches. The two results sort them
into one of four single-elimination draws:

| Record | Draw | Name |
| --- | --- | --- |
| WW | Draw A | Cup |
| WL | Draw B | Plate |
| LW | Draw C | Bowl |
| LL | Draw D | Shield |

Each draw is single elimination and runs to a winner. Draw D absorbs any extra
entrants.

Source: [`competition-format.ts`](../src/lib/tournament/competition-format.ts)
describes the format; [`placement.ts`](../src/lib/tournament/placement.ts) generates
the matches; [`tier-draw.ts`](../src/lib/tournament/tier-draw.ts) builds the brackets;
[`placement-seed.ts`](../src/lib/tournament/placement-seed.ts) does skill-block seeding.

### Round one pairing is a half-split, not bracket seeding

Seeds are paired `i` vs `ceil(N/2) + i`. This mixes the skill blocks at their
boundary rather than pitting the strongest against the weakest. With skill-based
seeding, standard bracket pairing would make round one predictable and therefore
uninformative.

### Placement rounds can overlap for fields divisible by four

For an active field of 4, 8, 12, ... entrants, round two has fixed winner/loser
feeders. Round-one rows are ordered by their persisted `generation_key` (lexical,
including `r1-10` before `r1-2`), the same order the existing batch generator reads.
Half-splitting those sources defines the round-two pairings before any result is known.
Only a slot whose two sources have a decided winner (`reported` or `walkover`) becomes
an actual placement match. It may be scheduled while unrelated round-one matches remain.
Both source finishes and the placement rest gap constrain its earliest time.

Waiting definitions are stored separately from playable matches: placement rows still
always have two entrants. Round-two progress includes unopened slots, and the Schedule
page shows their winner/loser sources. The Desk only receives actual matches.

Correcting or clearing a source withdraws its unstarted children, including their court
and time; the operator is shown the affected matches before changing a winner or clearing
a result. A child that has started locks the source. Unrelated sources remain editable.
Knockout generation still waits for every active entrant's full placement record.

An existing batch-generated round two is left unchanged. Odd fields and fields with
crossover retain their full-round generation gate and current pairing rules.

### An odd entry count holds an entrant; it never issues a bye

The placement stage has **no concept of a bye**. An odd entry count holds one
entrant out of round one, and that entrant then plays two **make-up matches** in
round two - one against a round-one winner, one against a round-one loser. So:

- Every entrant finishes with exactly two decided matches and reaches a draw with a
  complete record.
- Holding is expressed as the **absence of a row**, not a row marked "bye". That is
  what makes it neutral: there is nothing that could be accidentally counted as a
  win or a loss.
- The two make-up matches are interleaved with other round-two matches. The default
  cap is 3 interleaved matches, scaled down at small entry counts; the time-based
  rest gap applies on top.

### Small fields are handled explicitly

| Entrants | Placement matches required | Result |
| --- | --- | --- |
| 1 | 0 | The sole entrant takes Draw A |
| 2 | 1 | One match is played. Winner takes Draw A, loser Draw D. Crossover is deliberately not applied, because the only leftover winner and loser would be the two people who just played each other |
| 3+ | 2 | Normal two-round placement |

`requiredPlacementMatches()` lowers the requirement rather than leaving small draws
blocked forever.

## Knockout draws

### Byes are assigned by seed

When a bracket size is not a power of two, the bye goes to the **best** seed, never
at random.

### The match-count invariant

**Total matches in a single-elimination draw = entrants - 1.** This holds regardless
of byes, and is unit-tested.

Source: [`draws.ts`](../src/lib/tournament/draws.ts) (`totalMatchesInDraw`,
`nextPowerOfTwo`, `seedOrder`).

### Bracket size rounds up to the next power of two.

### The whole bracket exists from the draw

The draw creates **every round and every slot** of each A/B/C/D bracket at once
(`bracket_size - 1` matches), so a viewer sees the full path to the final immediately.
Slots above round one start empty, except that a bye's winner is advanced straight away.

- **Filling.** When a match is reported, its winner is written into the slot that already
  exists in the next round: the winner of round `r` slot `s` goes to round `r+1` slot
  `(s+1)/2`, as side A when `s` is odd and side B when `s` is even. The final's winner is
  the draw's champion.
- **Ready.** A match is *ready* only when both sides are known (and it is not a bye or void).
  Only ready matches are scheduled, shown on the Desk or Scores, started, or counted by the
  schedule writer; a slot waiting on a feeder is just a place in the bracket, drawn as
  "Winner of Semifinal 2". One definition serves all of them: `isTierMatchReady`.
- **Correcting.** Resetting a result withdraws the winner from the next slot (clearing its
  court and time) unless that match has already started, in which case it is refused.
  Entering a *different* score for an already-reported match replaces the result instead, and
  the replaced one is kept in `match_result_history` with who sent it: a clear is loud and
  recoverable, a correction used to be silent. The desk also refuses a correction made against
  a stale read (see `assertMatchUnchanged`), comparing the result token captured when the match
  was opened - not the live row, which realtime may have already updated - so two people
  correcting the same result cannot overwrite each other without either noticing.

Source: [`tier-draw.ts`](../src/lib/tournament/tier-draw.ts) (`buildTierBracket`,
`childSlot`, `isTierMatchReady`, `feederLabel`) and migration
`20261016000000_full_knockout_bracket.sql`.

## Configurable rules

These are tournament settings, not constants. The defaults are noted because they
are what a new tournament starts with.

| Rule | Setting | Default | Constraint |
| --- | --- | --- | --- |
| Max categories per player | `max_categories_per_player` | 2 | `CHECK BETWEEN 1 AND 5` |
| Group rest gap | `group_rest_gap_minutes` | 10 | Minutes between two matches for the same player |
| Knockout rest gap | `knockout_rest_gap_minutes` | 30 | As above, in knockout |
| Match length | Per stage (`group_slot_minutes`, `knockout_slot_minutes`) | 20 / 25 | Planned court slot including changeover |
| Scoring | Per stage (`placement_*`, `knockout_*`) | Single game to 21 (placement), best of 3 to 21 (knockout) | Configured on the Schedule page |

The category cap is enforced **at the form level**: a third category selection is
rejected rather than warned about afterwards. Doubles pairs are a single "team" for
scheduling, but each half is tracked individually against the cap and the rest-gap
rule.

### How a game is won

A game ends the instant it is won, so a legal score is one the game could actually have
stopped on, and a match is won by `gamesNeededToWin` such games.

- At `gamesTo` the winner stopped there, which only happens when the loser is at most
  `gamesTo - winBy` behind: `21-19` and `21-0` are games, `21-20` is not.
- Past `gamesTo` the two sides are **exactly** `winBy` apart, because the game ended on the
  point that opened that lead: `22-20` and `29-27` are games, `25-10` and `24-21` are not -
  at `21-10` and `23-21` the game was already over.
- The **21-point win-by-2 game also stops at 30**: 29-29 is deuce, so the next point wins
  30-29, and no score above 30 is a game at all. That ceiling is derived from the rule
  (`gamePointCap` in [`scoring.ts`](../src/lib/tournament/scoring.ts), `game_point_cap` in the
  database) rather than stored, because only the 21-point game has one: a 15- or 11-point
  tournament has no official cap, and `winBy: 1` has no deuce to end.
- A rule with `winBy: 1` never leaves `gamesTo` at all - the first point at the target wins -
  so `22-21` is not a game. An uncapped rule has no second ceiling: what stops an absurd
  score there is the exact margin, and what stops one being typed is the two-digit field
  (`parseScoreInput` in [`score-entry.ts`](../src/lib/tournament/score-entry.ts)).

The rule is checked twice, by the same predicate on each side of the wire -
`isLegalGameScoreFor` in [`format.ts`](../src/lib/tournament/format.ts) and
`game_score_is_legal` in the database - so a score the desk accepts is a score the RPC accepts.
One shared case table ([`game-rule-cases.test-helpers.ts`](../src/lib/tournament/game-rule-cases.test-helpers.ts))
is answered by both, and the migration that wrote the rule checks itself against it.
Before the predicate was shared it was written out three times and knew only a margin floor,
which is how `31-29`, `211-19` and `25-10` were stored as results that cannot happen.

**Results already stored are not rewritten.** A migration that edited a recorded score would
change standings and every placement that reads the result, with nobody to review it. Instead
such a row is characterised: the desk still shows the score, and refuses to save it back
unchanged until it is corrected. Run `npm run db:audit-scores` against a shared database
*before* applying that rule change; it lists one row per affected match and the games to
correct, so the handling is a per-match decision rather than a surprise.

Rest gaps are checked for **every individual player**, not per team. For doubles the
scheduler checks all four players independently.

## Play days

Setup does not choose the days a tournament plays on. It chooses the **window**: a first and a
last date, which are what the public sees and have no maximum length. The days actually played
are chosen later, on the Schedule page, when the schedule is built:

- Every playing day must lie **inside the window**, and they need not be consecutive. A window
  of 20-30 October may be played on the 20th, the 22nd and the 29th. There is no limit on how
  many playing days there are.
- A tournament may have **no playing days yet**; choosing at least one is what building a
  schedule asks for, not what creating a tournament asks for.
- Days can be **added and removed after the first match**. `add_tournament_day` renumbers
  existing days; `remove_tournament_day` refuses a day with scheduled matches on it.
- The window's last date can be extended at any time before completion; its first date is
  locked once the first match has started. A window cannot be shrunk past a playing day.
- A database trigger keeps `day_number` and `date` in chronological order for every
  modification, so out-of-order dates cannot be introduced, and a second one keeps every day
  inside the window.

Registration is a separate window again. It closes at or before 00:00 of the tournament's
first date, so people register before the tournament and never during it; see
[`authorization.md`](authorization.md) section 6.

The old "day 1 is groups, day 2 is knockouts" split is no longer a structural
constraint, because the number of days is not fixed.

## Working tournament

There is no global active tournament. Each signed-in user has their own working tournament
(`profiles.current_tournament_id`), and a caller with none browses `/explore`. The `players`
table is global rather than tournament-scoped.

## Legacy pool engine

The round-robin pool format is **legacy but still present and reachable**:

- The routes `/pools` and `/schedule` render it and are reachable by direct URL.
  They are deliberately absent from the navigation, because the creation wizard
  replaced the round-robin engine with two-round placement.
- The tables, RPCs and library code behind it are untouched.
- The live surfaces (`/`, `/matches`) list its matches **only for a tournament whose
  stored `format` is `round_robin`**. A two-round placement event is never shown pools,
  because they are not a stage it runs.

It is worth knowing because it is not dead code - it is shipped and reachable - and
because it documents rules that are correct for that format:

### Pool sizing

Pool size is **4, or 5 only when needed** to make the entry count work.

> **Never a pool of 3.** A pool of 3 produces only 2 matches per entrant and breaks
> the guaranteed-3-matches rule.

### Pool standings tie-break order

1. Wins
2. Head-to-head, for a two-team tie
3. Mini-table wins / differential, for multi-team ties
4. Overall point differential
5. Validated manual override

Source: [`standings.ts`](../src/lib/tournament/standings.ts).

### Pool draws

For that format, `Draw A` takes pool winners, `B` second place, `C` third, and `D`
fourth place plus any fifth-place finishers. This is the **legacy** seeding rule and
does **not** describe the supported format, where draws come from the placement
record instead.

Source: [`draws.ts`](../src/lib/tournament/draws.ts) (`tierForRank`).

## Worked example (not a constraint)

The following is one organiser's planning scenario, recorded here because it is
useful for reasoning about scale - **not** because the app enforces any of it.

> **Example only.** Eight courts, two days from 08:00, roughly 134 unique players
> across four categories, with 17:00 as a planning benchmark rather than a hard cap.
> At 20-minute group slots that is about 100 court-hours of work against about 72
> court-hours available in an 08:00-17:00 window on eight courts, so the group day is
> expected to finish after 17:00 unless the court count or match count changes.

Nothing above is a setting. Court count, day count, player count and daily windows are
all per-tournament values, and the platform does not assume this shape.

### The "Will it fit?" estimate is advice

The Schedule page of an upcoming tournament shows a rough count of court time needed against
court time offered ([`capacity-estimate.ts`](../src/lib/tournament/capacity-estimate.ts)). Both
sides are read from the tournament, with nothing typed: the needed side from the active entries
per event, the offered side from each configured day's courts times its window less its breaks.
It counts a field of N >= 3 as N placement matches plus an even split of the knockout draws, and
prices them at the default 20 / 25 minute slots. Nothing is saved and the scheduler does not read
it. It states "needs X court-hours, has Y" and nothing about utilisation, which was removed from
the forecast on purpose. The Review step and the Entries page do not show it: before entries
and a built schedule its inputs are guesses.

## Removed from this document

The previous version of this file has been replaced rather than amended, because
roughly half of it described a format the app no longer creates. Specifically, these
claims are **no longer true** and should not be reintroduced:

- Draws seeded from pool placement as the current format.
- "Day 1 = group stage only, Day 2 = knockout draws only" as a hard constraint.
- A fixed 20 / 20-25 minute timing table.
- A 75-80% court-utilisation target. Capacity and utilisation were deliberately
  removed from the schedule forecast.
- The data-entity sketch, which is superseded by the migrations,
  [`types.ts`](../src/integrations/supabase/types.ts) and
  [`supabase/migrations/README.md`](../supabase/migrations/README.md).
