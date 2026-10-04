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

Rest gaps are checked for **every individual player**, not per team. For doubles the
scheduler checks all four players independently.

## Play days

Play days are **not fixed at setup**. They are created in the wizard as a start and
end date range, and then managed from the Schedule page:

- Days can be **added and removed after the tournament is activated**.
- `add_tournament_day` renumbers existing days; `remove_tournament_day` refuses to
  remove the last day or a day with scheduled matches on it.
- A database trigger keeps `day_number` and `date` in chronological order for every
  modification, so out-of-order dates cannot be introduced.

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
