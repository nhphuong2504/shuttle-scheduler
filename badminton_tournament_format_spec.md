# Badminton tournament format spec

Venue: 8 courts, 2 days, 9am-5pm (16 court-hours/day, 128 total)
Based on 2025 turnout: 134 unique players, 4 categories after dropping WS

## Categories

- MS (Men's Singles) — individual entries
- MD (Men's Doubles) — pair entries
- WD (Women's Doubles) — pair entries
- XD (Mixed Doubles) — pair entries

WS (Women's Singles) is dropped for this edition.

## Registration rules

- **Max 2 categories per player.** Enforced at registration form level (hard limit, not a request).
- A player's identity must be consistent across categories so the system can detect when the same person appears in 2 different draws (needed for rest-gap scheduling).
- Doubles pairs are treated as a single "team" entity for scheduling purposes, but each half of the pair is still tracked individually for the 2-category cap and rest-gap rules.

## Tournament structure (per category)

### Stage 1 — Group stage (round robin pools)

- Pool size is always 4, or 5 only when needed to make the numbers work. **Never a pool of 3** (only gives 2 matches, breaks the 3-match guarantee).
- Every entrant plays every other entrant in their pool once.
  - Pool of 4 → 6 matches, every entrant plays 3.
  - Pool of 5 → 10 matches, every entrant plays 4.
- **Tie-break order** (in case of equal win-loss record within a pool):
  1. Head-to-head result
  2. Point differential across pool matches
  3. Coin toss / draw

### Stage 2 — Drop-down draws (A / B / C / D)

After group stage, entrants are re-sorted by pool finish into 4 separate single-elimination brackets:

- **Draw A (Cup)** — all 1st-place pool finishers
- **Draw B (Plate)** — all 2nd-place pool finishers
- **Draw C (Bowl)** — all 3rd-place pool finishers
- **Draw D (Shield)** — all 4th-place pool finishers, **plus** any 5th-place finishers (only exists in pools of 5)

Rules:
- A draw's entrant count = number of pools in that category (plus any 5th-placers folded into Draw D).
- Bracket size rounds up to the next power of 2. **Byes are assigned by seed** (best group-stage point differential gets the bye), never randomly.
- Total matches in any single-elimination draw = entrants − 1 (this holds regardless of byes).
- Since each draw pulls exactly one entrant per pool, no two players in the same draw have already played each other in groups.

## Match format & timing

| Stage | Format | Planned court slot |
|---|---|---|
| Group stage | Single game, race to 21 | 15 min (incl. changeover) |
| Knockout (A/B/C/D) | Best of 3, race to 21 | 20-25 min |

A visible time-cap rule should trigger if a game runs long, to prevent cascading delays.

## Scheduling constraints

1. **All pools within a category run in the same time block**, across as many courts as available — a category's Draw A-D can't be built until every one of its pools has finished, so staggering pools creates a bottleneck.
2. **Minimum 30-minute rest gap** (or one full match round) between two matches for any player entered in 2 categories. Never schedule the same player on two courts in the same slot.
3. **Day 1 = group stage only. Day 2 = knockout draws only.** Treated as a hard checkpoint — if groups overflow into day 2, it compresses knockout rounds and rest gaps.
4. **Target utilization: 75-80% of theoretical court-hour capacity**, not 100%. This absorbs walkovers, disputes, and slow matches without delaying later rounds.
5. Results must be reported to the control point **within 5 minutes** of a match ending — Draw A-D can't be seeded until every pool's results are in.

## Estimated 2025-equivalent load

| Category | Entries | Pools | Group matches | Knockout matches | Total matches | Court-hours |
|---|---|---|---|---|---|---|
| MS | 55 players | 10×4 + 3×5 | 90 | 51 | 141 | ~39.5 |
| MD | 42 pairs | 8×4 + 2×5 | 68 | 38 | 106 | ~29.7 |
| WD | 16 pairs | 4×4 | 24 | 12 | 36 | ~10.0 |
| XD | 32 pairs | 8×4 | 48 | 28 | 76 | ~21.3 |
| **Total** | | | **230** | **129** | **359** | **~100.5** |

Against 128 available court-hours, this is **~78.5% utilization** — within the target buffer.

## Data entities to model (suggested starting point)

- **Player** — id, name, contact info, categories registered (max 2)
- **Team** — id, player_1_id, player_2_id (null for singles), category_id
- **Category** — id, name (MS/MD/WD/XD), entry type (individual/pair)
- **Pool** — id, category_id, size (4 or 5), list of team/player ids
- **PoolMatch** — id, pool_id, team_a_id, team_b_id, score, winner_id, timestamp reported
- **PoolStanding** — derived: pool_id, team_id, wins, losses, point_differential, rank (1-5), computed after all PoolMatches in a pool are complete
- **Draw** — id, category_id, tier (A/B/C/D), list of entrant team ids, bracket structure (byes assigned by seed)
- **DrawMatch** — id, draw_id, round, team_a_id, team_b_id, score, winner_id
- **Court** — id, current assignment (match id), status (free/in-progress/finished)
- **ScheduleSlot** — court_id, time_block, assigned match id, category, buffer flag

Key computed rules your platform needs to enforce automatically:
- Block a court assignment if it would violate the 30-minute rest-gap rule for either player in the match.
- Don't allow a Draw to be generated until all PoolStandings in that category are finalized.
- Flag any pool that hasn't reported all match results within [pool's scheduled end time + 15 min] so control desk can chase it before it delays draw generation.
