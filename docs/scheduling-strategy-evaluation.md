# Keeping the schedule current: place new matches, or rebuild?

When a result makes new matches ready, the schedule has to give them a time. There are two ways to do it
automatically, and the question this document settles is which one to build on.

- **`place-ready`**: every match that already has a court and time stays exactly where it is; the new
  matches are slotted into the gaps. It never moves a published time, and it never sees the whole picture.
- **`rebuild`**: re-solve the whole unplayed queue. It sees everything, and may move any time that was
  already published (only the next match on each court is pinned).

The worry about `place-ready` is that gap-filling drifts: each new match goes in wherever it fits, and the
schedule gets steadily worse. The worry about `rebuild` is that it changes times players have already been
told. Rather than argue it, `src/lib/tournament/scheduling/strategy-replay.ts` plays the same tournaments
under each strategy and measures both.

## What was measured

A synthetic tournament, seeded so every strategy sees identical dice: five events (8, 8, 12, 12, 8
entrants), two days 09:00–18:00, round one, round two paired by record, and A/B/C/D brackets built with
`buildTierBracket`. Outcomes are coin flips and match lengths jitter from 10 minutes faster to 25 slower
than the slot, so the day drifts the way a real one does. The real `planPlacementSchedule` does all the
planning. A minimal "push later matches on the same court" cascade stands in for the live reflow, for every
strategy alike. Eight seeds per scenario, at 6, 4 and 3 courts (the last two are tight on purpose).

Strategies compared:

| Name | What it does |
| --- | --- |
| `place-ready` | After each result, place new ready matches into gaps; never move anything. |
| `rebuild` | After each result that leaves a ready match untimed, re-solve everything and apply it. |
| `gated-rebuild` | As `rebuild`, but refuse a plan that postpones anything starting within 2 h by more than 30 min, or that runs past the close. A refused match stays untimed until the next try. |
| `manual-rounds` | Today's workflow: a person presses Update schedule when a round finishes. |
| `place-then-compact` | `place-ready`, then try a rebuild with everything starting within 3 h pinned, and keep it only if it passes the gate and finishes the queue at least 15 min sooner. |
| `rebuild-leftshift` | `rebuild`, then one left-compaction pass: move each waiting match to the earliest time at which a court, its players (with rest) and its feeders are free. |
| `place-ready-pull` | `place-ready`, then pull later matches earlier into gaps, but never anything starting within 2 h and never to less than an hour's notice. |
| `gated-leftshift` | `rebuild-leftshift`, kept only if it passes the same gate as `gated-rebuild`; otherwise undone. |
| `rolling-horizon` | `place-ready`, then a rebuild with everything starting within 3 h pinned plus a compaction of what is further out, kept only if it does not finish the queue later. |
| `future-days` | As `rolling-horizon`, but everything left of today is pinned and only later days are re-solved. |

Reproduce with `npm run bench:strategies` (`REPLAY_COURTS`, `REPLAY_SEEDS`, `REPLAY_DAY_END`, `REPLAY_OUT`
scope it). The full tables are written to `.benchmark/` (git-ignored), so they are regenerated rather
stored; the numbers below are the means from the run this document was written from.

## Results (means over 8 seeds)

Four courts, the middle scenario:

| Measure | place-ready | rebuild | gated-rebuild | manual-rounds | place-then-compact |
| --- | ---: | ---: | ---: | ---: | ---: |
| Last match ends (min after 09:00 day 1) | **1771** | 1908 | 1794 | 1975 | **1771** |
| Court idle (min) | **189** | 609 | 284 | 880 | **189** |
| Player wait, total (min) | 9304 | **8209** | 9958 | 8427 | 9304 |
| Player wait, p95 gap (min) | **235** | 246 | 241 | 256 | **235** |
| Published times pushed later | **0** | 158 | 12 | 230 | **0** |
| ...largest push (min) | **0** | 1032 | 42 | 1032 | **0** |
| Any change inside the last 30 min | **0** | 50 | 5 | 59 | **0** |
| Ready match with no time, p95 (min) | **0** | **0** | 629 | **0** | **0** |
| Organiser had to step in | **0** | **0** | 1.6 | **0** | **0** |

The same ordering holds at 6 and at 3 courts: `place-ready` finishes first and idles the fewest court
minutes in every scenario; `rebuild` and `manual-rounds` push 100–250 published times later per
tournament, often by a whole night, and 40–60 of those changes land within 30 minutes of the start.

## The rule, applied

The decision rule was written down before running anything.

1. *Choose `rebuild` if* the 95th-percentile postponement is within 30 minutes, nothing changes inside the
   last 30 minutes, and it clearly beats `place-ready` on finish or waiting. **It fails all three**: pushes
   of about 1000 minutes, 40–53 changes inside the last 30 minutes, and a later finish than `place-ready`
   at every court count.
2. *Choose `gated-rebuild` if* `rebuild` fails but the gate refuses under 10 % of attempts and the result
   still beats `place-ready`. **It fails**: the gate refuses roughly 85–90 % of attempts (44–55 of 51–61
   plan runs), the longest a ready match waits for a time has a 95th percentile of 350–630 minutes, the
   organiser has to step in about twice per tournament, and it finishes 23–181 minutes after `place-ready`.
3. *Keep `place-ready` if* its finish and waiting are within 5 % of `rebuild`. Its finish is 7–13 % **better**,
   its court idle is two to three times lower, and its 95th-percentile waiting gap is no worse than
   `rebuild` at any court count. Its one clear cost is total player waiting, 3–13 % higher than `rebuild`.
   **Keep `place-ready`.**

`place-then-compact` came out identical to `place-ready`: with the 3-hour pin and the gate, no compaction
was both safe and worth 15 minutes in any of the 24 tournaments. That is a result, not a bug: it says
that on this workload the tail has nothing safe left to win.

## Pros and cons

**`place-ready`**
- Pro: published times never change, so no player is ever told "later". Zero changes inside the last hour.
- Pro: best finish and least court idle in every scenario here, with the lowest p95 waiting gap at 3 courts.
- Pro: cheap (a few milliseconds a run) and safe to run unattended: the server re-checks every slot.
- Pro: already built and unit-tested; its SQL is applied on staging (the app code is not deployed there, and
  the SQL has not been exercised end to end).
- Con: 3–13 % more total player waiting than `rebuild`; it never improves a bad gap it created earlier.
- Con: quality depends on the first build. Nothing here measures a very long tournament or a bad first build.
- Con: nothing re-optimises the future, so a human still needs "Rebuild schedule" when the days, courts or
  timings change.

**`rebuild` (automatic)**
- Pro: lowest total player waiting (3–13 % below `place-ready`).
- Con: finishes later and idles courts two to three times as much, in this simulation, and the solver's
  stated objective order (finish before idle before waiting) says it should not. See the open question below.
- Con: moves hundreds of published times per tournament, many inside the last half hour, many by a night.
  The solver has no term for "later than the time already told" (its churn term is symmetric and ranked
  last), so nothing in it protects players.
- Con: unattended apply is unsafe today: `apply_placement_day_schedule` has no version or conflict check,
  so two desks, or a match that starts mid-plan, can overwrite each other.

**`gated-rebuild`**
- Pro: genuinely protects the near term: no postponement beyond the gate, changes inside 30 minutes drop
  from about 50 to about 5.
- Con: leaves ready matches without a time for a long while (mean 56–142 minutes, p95 5–10 hours), and the
  organiser has to intervene about twice. That is a worse experience than a late-but-fixed time.
- Caution: its good "started after the time first published" score is partly an artefact. A match that has
  no published time cannot be late against one.

**`manual-rounds`** (today)
- It is the worst or second worst on finish, court idle and published changes in every scenario, because it
  is a full rebuild at every round boundary. Its virtue is that a person decides, with a preview.

## Caveats

- The tournaments are synthetic: no real ranking rules, availability or withdrawals, and an idealised reflow.
  The comparison between strategies on identical input is the point; the absolute numbers are indicative.
- **Open question.** Why a full rebuild idles courts and spills matches into the next day more than gap-filling
  does is not root-caused. Hypotheses: the objective ranks stage progression above packing; the hard
  closing time on the first day pushes whatever does not fit; the planner's single hybrid run is a poor
  optimiser. Because `manual-rounds` is today's Update button, this deserves its own investigation even if
  `place-ready` stays the automatic path.
- The "started after the first published time" measure favours any strategy that publishes late.

## Follow-up: why a rebuild idles courts, and what changes with tournament length

The first run left one result unexplained: a full rebuild idles courts two to three times as much as
gap-filling, although the solver's stated order puts finish and idle ahead of waiting.

### Root cause: the planner assumes a running match has a full slot left

This subsection replaces an earlier explanation ("the solver builds in urgency order and leaves holes"), which
was wrong. Reading the solver showed that greedy places each match at the earliest feasible start on any court,
backfilling holes, and the GRASP run advances a clock and only idles a court when nothing is eligible. Neither
holds a court back on purpose. The earlier "every gap had a match that could fill it" count was not rigorous
either: it ignored the filler's own rest before a later match of the same player.

The cause is in how the planner describes a match that is on court now. `fixedRange`
(`src/lib/tournament/scheduling/stage-items.ts`) models it as ending at
`max(start + slot, floor + slot, now + slot)`, which is `now + slot`: one full slot from the moment of planning,
however long it has already been playing. The comment says why: ending it at its planned time could let the
next match start on that court before the running one has finished. It is a deliberate, safe choice, and it
costs the time a running match has already used.

Evidence, from computing the rebuild plan and the place-ready plan from the same state (4 courts, 72 triggers;
8 courts, 194 triggers):

| First planned match on a court starts later than the court is free, court-minutes per plan | rebuild plan | place-ready plan |
| --- | ---: | ---: |
| Measured from when the court is **really** free (4 courts / 8 courts) | 66 / 149 | 23 / 84 |
| Measured from when the **planner believes** it is free, now + a slot (4 courts / 8 courts) | **18 / 49** | 16 / 45 |
| Reserved but unused because of the model (elapsed minutes of the matches on court) | 52 / 113 | |

Measured against its own beliefs the rebuild plan is as tight as the gap-filling one (18 against 16, 49 against
45), so the solver is not the problem. The whole difference appears only when measured against the real world,
and the reservation (52 and 113 minutes) is the same size as the excess (43 and 65). This also explains the
churn: every rebuild re-times the next match on each running court to "now + a slot", and a place-ready plan
keeps the earlier, tighter times it published, so a rebuild pushes published times later while a gap-filling
plan does not.

The validation error seen when the estimate was first shortened was a replay artefact: the replay clock was
fractional milliseconds, and a start truncated to whole milliseconds then overlapped the end of the running
match it followed by under a millisecond. With the clock rounded to whole milliseconds, no variant below threw
(0 errors in every run). Production passes `Date.now()`, an integer, but the new estimate must round to whole
milliseconds as well.

`rebuild-leftshift` applies the rebuild and then walks the queue once, moving each match to the earliest time
at which a court, both sides' players (with rest) and its feeders are free:

| 4 courts, 8 seeds | place-ready | rebuild | rebuild-leftshift |
| --- | ---: | ---: | ---: |
| Last match ends (min after 09:00 day 1) | 1771 | 1908 | 1785 |
| Court idle (min) | 189 | 609 | **117** |
| Player wait, total (min) | 9304 | 8209 | **6472** |
| Player wait, p95 gap (min) | 235 | 246 | **202** |
| Published times pushed later | **0** | 158 | 154 |

So most of what looked like "rebuild is worse" comes from a conservative input, not from the solver. It also
means today's **Update schedule** button leaves court time on the table whenever matches are on court.
The compaction pass, audited at 414 passes for court overlaps, rest gaps (the stricter of the planner's and the
reflow's rule) and feeder order, introduced no violations; it does not model placement prerequisites, breaks,
per-day court sets or the planner's pins.

### Fixing the estimate: what the sweep shows

The estimate was swapped through a temporary, uncommitted hook in `fixedRange` (reverted; the production code
is unchanged) and the strategies re-run. `A` is today's `now + slot`. `B` is the reflow's own model,
`max(start + slot, now)`. `C m` is `max(start + slot, now + m minutes)`. `D x` is `max(start + slot, now + x of a
slot)`. `E` ramps the margin with how far the match has overrun.

`rebuild`, medium field (5 events, 4 courts, 2 days, 4 seeds):

| Estimate | Court idle | Last end | Player wait | Pushed later | Changes in last 30 min | Plans that put the next match before the running one really ends | Pushes made afterwards by the reflow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A: now + slot (today) | 644 | 1931 | 7803 | 170 | 55 | 10 (81 min) | 92 (1027 min) |
| B: max(start + slot, now) | **105** | 1788 | 7646 | 105 | 35 | 38 (433 min) | 161 (1741 min) |
| C 3 min | 118 | 1796 | 7524 | 107 | 39 | 35 (380 min) | 149 (1550 min) |
| **C 5 min** | 130 | **1787** | 7568 | 110 | 40 | 32 (356 min) | 140 (1475 min) |
| C 10 min | 153 | 1805 | 8034 | 120 | 44 | 29 (308 min) | 133 (1360 min) |
| D 25 % | 162 | 1793 | 7954 | 115 | 40 | 26 (268 min) | 134 (1386 min) |
| D 50 % | 275 | 1826 | **6896** | 133 | 46 | 21 (210 min) | 118 (1345 min) |
| E ramp | 118 | 1790 | 7749 | 104 | 35 | 34 (376 min) | 147 (1516 min) |

Every shorter estimate removes most of the idle court time (644 down to 105-160) and finishes about 140
minutes sooner. The price is the right-hand columns: a shorter estimate makes the plan optimistic more often, so
the match that follows a running one is sometimes published to start before the running match really ends, and
the live reflow then pushes it later (about 11 minutes each). `m` trades one against the other, and the curve is
gentle: 5 minutes keeps nearly all of the gain, 10 minutes gives back some idle for about 15 % fewer such events.

Across strategies, with the estimate set to `C 5` against today's (5 seeds):

| | place-ready | rebuild, today | **rebuild, C 5** | rebuild-leftshift, C 5 | manual-rounds, C 5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| *medium, 4 courts* idle / last end / wait | 170 / 1761 / 9057 | 655 / 1921 / 7897 | **146 / 1785 / 7590** | 113 / 1780 / 7614 | 170 / 1799 / 7798 |
| *large, 8 courts* idle / last end / wait | 276 / 2064 / 30532 | 2456 / 2368 / 32643 | **403 / 2068 / 22043** | 283 / 2074 / 21195 | 424 / 2077 / 22418 |
| *medium, overrun-heavy* idle / last end / wait | 79 / 1917 / 10565 | 520 / 2115 / 10073 | **69 / 1976 / 9098** | 39 / 1985 / 9202 | 88 / 1988 / 8889 |

Over tournament length, `C 5` (3 seeds), total player wait:

| | tiny | small | medium | large | xlarge (3 days) |
| --- | ---: | ---: | ---: | ---: | ---: |
| place-ready | 1471 | 3710 | 9057 | 30532 | 54673 |
| rebuild, today | 1725 | 4874 | 7897 | 32643 | 26125 |
| **rebuild, C 5** | 1479 | 3830 | 7590 | 22043 | 28408 |
| rebuild-leftshift, C 5 | 1224 | 3613 | 7614 | 21195 | 29304 |

**Does `leftshift` still help?** The pre-registered rule: keep it only if it cuts court idle by at least 10 %
or waiting by at least 5 % against `rebuild` with the new estimate, without raising changes in the last 30
minutes. It still cuts idle (about 20-40 %) but its waiting advantage is gone: the 21-30 % it showed before was
the phantom reservation, not packing. It also makes the last-30-minute changes much worse (medium 59 against 38,
large 248 against 151, xlarge 443 against 260). **It fails the rule and should be dropped.**

**What the fix does not change.** Re-solving still moves published times: at the largest size `rebuild` with
the fixed estimate still pushes about 1 600 times later and changes 260 within the last half hour, and the largest
single push is still about 19 hours (a match spilling into the next day at the first day's close). The estimate
removes the waste, not the churn. And at tiny and small sizes `place-ready` and the fixed `rebuild` are
equivalent, so nothing is gained there.

### After the change (production code, 6 seeds)

With `inProgressEnd` in the planner and the replay run as it ships (no hook), rebuild against gap-filling:

| 4 courts unless stated | place-ready | rebuild | manual-rounds | rebuild-leftshift |
| --- | ---: | ---: | ---: | ---: |
| Medium: court idle / last end (min) / player wait | 158 / 1758 / 9310 | 105 / 1788 / **7646** | 113 / 1794 / 7523 | 94 / 1800 / 7720 |
| Large, 8 courts: idle / last end (h) / wait | 254 / 34.8 / 30828 | 327 / 34.9 / **21934** | 337 / 34.8 / 21962 | 261 / 34.4 / 20332 |
| Three days, 10 courts: idle / last end (h) / wait | 338 / 51.0 / 55599 | 391 / 54.2 / **27659** | 412 / 54.6 / 28109 | 347 / 54.4 / 28339 |
| Medium: published times pushed later / inside last 30 min | 0 / 0 | 105 / 35 | 148 / 55 | 112 / 41 |

`rebuild-leftshift` no longer beats `rebuild` on waiting in any row, and still adds changes inside the last
half hour; the earlier advantage was the reservation, not packing.

### Tournament length changes the answer

The same strategies from a two-event club night to a twelve-event, three-day open (4 seeds each; courts scaled
with the field):

| Last row = total player wait (min) | tiny | small | medium | large | xlarge |
| --- | ---: | ---: | ---: | ---: | ---: |
| Matches | 24 | 44 | 76 | 192 | 296 |
| place-ready | 1546 | 4137 | 9179 | 30925 | **56299** |
| rebuild | 1713 | 4974 | 7803 | 33882 | 25673 |
| rebuild-leftshift | **1272** | **3719** | **6575** | **20376** | **24177** |
| gated-leftshift | 1269 | 3821 | 9305 | 31264 | 41414 |
| rolling-horizon (3 h pinned) | 1637 | 4418 | 8989 | 30946 | 52539 |

- **Small and medium:** every strategy is acceptable. Compaction helps (10-28 % less waiting than place-ready), and the
  gated version keeps churn to a handful of changes. `place-ready` is still safe and close.
- **Large and above:** the worry about gap-filling is real. At twelve events over three days `place-ready`
  accumulates 56 000 minutes of waiting against 24 000 for the compacted rebuild (2.3 times as much), and its
  95th-percentile gap is 393 minutes against 286.
- **The catch is churn.** `rebuild-leftshift` gets there by pushing 2 200 published times later and changing
  558 of them inside the last half hour. Protecting the near term removes the gain: the gate leaves ready
  matches without a time for up to 19 hours at the top end, and pinning everything starting within 3 hours
  (`rolling-horizon`), or everything today (`future-days`), recovers almost none of it.
- A plain `rebuild` (no compaction) is the worst of both: later finish, idle courts, and the same churn.

Put differently, there is a frontier. Strategies that never surprise a player cannot also close the waiting
gap on a big field; the ones that close it do so by reshuffling matches people have been told about.

## The real Viet Nam Open entries

Everything above uses a synthetic field. This section replays the real entries of the Viet Nam Open on
staging: five events of 24, 18, 16, 11 and 24 entrants (three of them doubles), 100 players of whom 30 are in
more than one event. The fixture is `src/lib/tournament/scheduling/fixtures/viet-nam-open-field.json`; player
identities are replaced by anonymous labels and only who plays with whom is kept. Round one, round two (odd
fields, the held entrant, make-up matches, the crossover) and the draws come from the product's own builders
(`pairPlacementRoundOne`, `buildPlacementRoundTwo`, `buildCategoryView`, `buildTierBracket`), 166 matches in
all. What the tournament does not have is a setup: no days, no courts, no entrants yet, and its configured slots
(2 / 1 / 5 / 2 minutes, one court) read as test values. So days, courts and lengths are assumptions: placement
slot 20 and rest 10, knockout 25 and 30 (the defaults), matches 30 % faster to 60 % slower than the slot, seeds a
seeded shuffle. 20 seeds per scenario, paired: the same tournament under each strategy.

| Means over 20 seeds | place-ready | rebuild | rebuild wins on wait, of 20 seeds |
| --- | ---: | ---: | ---: |
| **6 courts, 2 days:** last end (h) / court idle (min) / player wait | 28.9 / 390 / 26787 | 29.6 / 434 / **23317** | 19 |
| **8 courts, 2 days:** last end / idle / wait | 27.1 / 682 / 23002 | 27.6 / 766 / **20286** | 20 |
| **10 courts, 2 days:** last end / idle / wait | 26.6 / 1070 / 20249 | 26.9 / 1177 / **17584** | 17 |
| **8 courts, 1 day:** last end / idle / wait | 13.7 / 1347 / 29058 | **12.8 / 871 / 24850** | 19 |
| *As configured today (1 court, 1 day, 2/1/5/2 min):* last end / idle / wait | **11.0 / 28 / 41028** | 11.3 / 46 / 42848 | 1 |

| Disruption (rebuild; place-ready is 0 in every row) | 6 courts | 8 courts | 10 courts | 8 courts, 1 day |
| --- | ---: | ---: | ---: | ---: |
| Published times pushed later | 308 | 242 | 184 | 253 |
| Changes inside the last 30 minutes | 143 | 140 | 115 | 145 |
| Largest single push | 17 h | 17 h | 17 h | 2.3 h |

**Reading it.**
- **With room to spare (two days), rebuild gives the players a clearly better day:** 12-13 % less total waiting,
  a 95th-percentile gap 4-13 % shorter, and a shorter worst gap (297 against 325 minutes at six courts), the
  better of the two on waiting in 17 to 20 of 20 seeds. It costs a little court idle (about 10 %) and finishes
  20-40 minutes later on average. It also moves a lot of published times: 180-310 times later per tournament,
  about 115-145 of them inside the last half hour, and the largest push is a whole night (a match spilling
  into the next day).
- **When the day is tight (8 courts, one day), place-ready struggles and rebuild is simply better:** it
  finishes 55 minutes sooner, idles 35 % fewer court minutes, and place-ready, which will not run a match
  past the close on its own, leaves ready matches without a time (95th percentile 87 minutes) and needs the
  organiser about twice. That is the case the closing-time rule was written for, and it shows its price.
- **As the tournament is configured today (one court, 2-minute slots) nothing is gained:** the day is bound by
  capacity, and place-ready is better on every axis. That setup is a placeholder, not a real plan.
- The gated rebuild keeps the near term still (43-66 pushes, under 50 changes inside the last half hour) but
  leaves ready matches without a time for hours at the worst (95th percentile 566 minutes at six courts) and
  needs the organiser once or twice, the same trade as before.

**A bug found by using real entries, now fixed.** `place-ready` threw `unknown-dependency` on 30-50 % of runs
on this field and never on rebuild. The 11-entrant event has a held entrant, so its second make-up match names
the first as a prerequisite; when place-ready could not keep the first where it stood (it collided with decided
history) it took it out of the problem but left the dependency, and the problem rejects a dependency on a match
it does not contain. The synthetic field never had prerequisites, so no earlier run could see it. In the app the
automatic pass swallows errors, so for any tournament with an odd event it would have quietly stopped placing
matches. A dropped prerequisite is now kept as a time floor (the dependent cannot start before it is due to end
where it stands), with a unit test and a regression test on this field.

**Caveats.** Days, courts and slot lengths are assumed, and seeds are random where the organiser would seed by
skill. The comparison between strategies on identical input is the point; the absolute numbers are indicative.
The sort of field matters: these events are bigger than the synthetic "medium" and have uneven tiers and
make-up matches, which the synthetic field could not.

## Recommendation (revised again)

1. **Replace the in-progress estimate in `fixedRange`** with `max(start + slot, now)`, rounded to whole
   milliseconds, with no margin. **Done** (`inProgressEnd`, `src/lib/tournament/in-progress.ts`). A margin
   would have been a second model beside the one the reflow, `placement_occupied_matches` and
   `schedule_conflicts` already use, and the sweep says it is not needed: of the shorter estimates this one
   gives the least idle court time (105 against 130 for +5 minutes) and among the fewest changes inside the
   last half hour (35 against 40) on the medium field. What it costs is more plans that publish the match after a
   running one before that one really ends (38 against 32), each then pushed later by the reflow, about 11
   minutes on average. The Desk's finish forecast and the Schedule page's projected finish use the same
   function. It does not touch the reflow, the conflict detection, the state-based start checks or the pin
   rules. The effect on a full rebuild: from 2-12 times the idle court time of gap-filling down to parity at
   small and medium sizes and about 1.3 times at large ones, finishing within a few minutes of `place-ready`
   up to the large field (about 3 hours later at the three-day field) while cutting player waiting by 18 %
   (medium), 29 % (large) and 50 % (three days); at tiny and small sizes the two are level. Real match
   durations should be checked against the sweep's assumed spread once they exist.
2. **Do not add a compaction pass.** It fails its decision rule once the estimate is fixed.
3. **Keep `place-ready` as the unattended path for now.** It is unaffected by the estimate, never changes a
   published time, and is equivalent to rebuild up to small fields. With the estimate fixed, a deliberate
   rebuild is the better tool for medium and larger fields (less waiting, no idle courts), and the organiser
   should be offered it with its cost stated.
4. **Automatic rebuild is still not recommended.** The churn (hundreds of later times, tens inside the last half
   hour) is unchanged and it still needs a version-checked writer. The decision belongs to the organiser.
5. **Separate follow-up:** large pushes of about 19 hours are matches spilling to the next day at the first day's
   close. That is a different mechanism from the estimate and worth its own look.

Not yet tried: letting the solver itself minimise a *never-later-than-published* term, and the effect of real
withdrawals, walkovers and player availability on the numbers.
