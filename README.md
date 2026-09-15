# Shuttle Scheduler

# Build prompt: Badminton tournament tracking platform




Copy everything below into your coding tool of choice (e.g. Claude Code) to kick off the build.




---




## Project overview




Build a web platform to manage a 2-day, 4-category badminton tournament (Men's Singles,

Men's Doubles, Women's Doubles, Mixed Doubles) running on 8 courts. The platform must handle

registration, generate group-stage pools, track live match results, automatically build

knockout draws once pools finish, and produce a court schedule that respects player rest-gap

and category-conflict rules.




Target scale: ~130-140 players, ~230 group matches, ~130 knockout matches, ~360 total matches

across the weekend.




## Core entities




- **Player**: id, name, contact info, categories registered (max 2)

- **Team**: id, player_1_id, player_2_id (null for singles), category_id

- **Category**: id, name (MS/MD/WD/XD), entry_type (individual/pair)

- **Pool**: id, category_id, size (4 or 5), list of team/player ids

- **PoolMatch**: id, pool_id, team_a_id, team_b_id, score, winner_id, court_id,

  scheduled_time, reported_time

- **PoolStanding** (derived): pool_id, team_id, wins, losses, point_differential, rank (1-5),

  computed only once every match in that pool is reported

- **Draw**: id, category_id, tier (A/B/C/D), entrant team ids, bracket structure incl. byes

- **DrawMatch**: id, draw_id, round, team_a_id, team_b_id, score, winner_id, court_id,

  scheduled_time

- **Court**: id, current match assignment, status (free / in-progress / finished)

- **ScheduleSlot**: court_id, start_time, end_time, assigned match id, category, buffer flag




## Business rules to implement




### Registration

- Every player registers for a maximum of **2 categories**. Enforce at the form level;

  reject a 3rd category selection outright rather than warning after the fact.

- Doubles pairs are single "team" entities for match scheduling, but each half of the pair

  is tracked individually against the 2-category cap and the rest-gap rule.




### Pool generation

- Pool size is always 4, or 5 only when needed to make the entry count work. **Never generate

  a pool of 3** — it only produces 2 matches per entrant and breaks the guaranteed-3-matches

  rule.

- Use the standard round-robin "circle method" to generate each pool's round-by-round pairings

  so that within a single pool, no team is scheduled into two matches in the same round.

- Tie-break order for final pool standings: (1) head-to-head result, (2) point differential

  across pool matches, (3) coin toss / manual override flag for the desk.




### Draw generation (the A/B/C/D drop-down mechanic)

- Only build a category's Draw A/B/C/D once **every pool in that category has all match

  results recorded**. Block generation and surface a clear "waiting on Pool X" status

  otherwise.

- Draw A = all pool 1st-place finishers, B = all 2nd-place, C = all 3rd-place,

  D = all 4th-place finishers **plus** any 5th-place finishers (only exists when a pool has

  5 entrants). Fold 5th-place into Draw D rather than creating a 5th bracket.

- Bracket size rounds up to the next power of 2. Assign byes by seed (best point

  differential from group stage gets the bye), never randomly.

- Total matches in any single-elimination draw = entrants minus 1. This should hold as an

  invariant you can unit test.

- Round 2+ pairings depend on round 1 results — don't pre-generate beyond one round ahead.




### Match format & timing

- Group stage: single game, race to 21, 20-minute planned court slot (incl. changeover).

- Knockout (Draw A/B/C/D): best of 3, race to 21, 20-25 minute planned court slot.

- Support a visible match clock / time-cap flag so slow matches don't silently blow the

  schedule without the desk noticing.




### Scheduling constraints

- A category's pools should be scheduled to run in parallel across a dedicated block of

  courts, so all pools in that category finish around the same time (this is what unblocks

  Draw A/B/C/D generation for that category — staggering pools creates a bottleneck).

- **Minimum 10-minute group rest gap and 30-minute knockout rest gap** between two matches for any player who appears in both.

  This applies whether it's two group matches, two knockout matches, or one of each, across

  either of their two categories. The scheduler must actively check both members of a

  doubles team, not just the team as a unit.

- Day 1 = group stage only. Day 2 = knockout draws only. Treat this as a hard constraint

  the scheduler should not violate even if a pool overruns — surface overruns as an alert

  requiring manual desk intervention rather than silently pushing groups into day 2.

- Target 75-80% utilization of total court-minutes as a planning buffer; flag (don't block)

  if a generated schedule exceeds ~90% utilization on a given day.




### Live operations

- Score entry should update pool standings and draw eligibility in near real time — the

  10-15 minute delay of a manual process is exactly what this platform exists to remove.

- Flag any pool that hasn't reported all results within [pool's scheduled end time + 15 min]

  so the desk can chase it before it delays downstream draw generation.

- Court status view: at a glance, show what's currently playing on each of the 8 courts and

  what's queued next.




## Suggested build order




1. Data model + category/pool/team CRUD

2. Round-robin pool generator (circle method) with pool-size validation (no pools of 3)

3. Match result entry + auto-computed pool standings with tie-break logic

4. Draw A/B/C/D generator, gated on pool completion, with seeded bye assignment

5. Court/time scheduling layer with the 10-minute rest-gap check across a player's up to

   2 categories

6. Live dashboard: court status board, pool standings, draw brackets, alerts for

   late-reporting pools or overrun risk




## Non-functional notes




- This will be operated live on tournament day by a small control desk team on

  laptops/tablets, likely with imperfect wifi — favor simple, resilient UI over

  feature richness, and make manual override / correction of any auto-generated

  match or draw easy, since real-world edge cases (injury withdrawal, no-show,

  disputed score) will happen and someone needs to fix them fast without breaking

  the rest of the schedule.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/a18d0f0e-6332-4eb4-a868-3343c691b112).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Database migrations

Migrations live in `supabase/migrations` and are applied in filename order. The hosted
project is `hdmfxndanyrbxedgboev`. See [supabase/migrations/README.md](supabase/migrations/README.md)
for how to apply the tournament-scoping migration and how to verify it afterwards.
