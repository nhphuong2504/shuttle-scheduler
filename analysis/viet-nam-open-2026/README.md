# Viet Nam Open 2026 — completed tournament dataset

A snapshot of the finished two-day tournament, exported so the operational behaviour of the
scheduler and the live reflow can be analysed without a database. Committed to the repository on
purpose: `backups/` is git-ignored, so an export that lived there would not survive a change of
machine.

|                  |                                                                              |
| ---------------- | ---------------------------------------------------------------------------- |
| Tournament       | Viet Nam Open 2026 (`93034e9a-aab3-4fc1-80c5-36e5b7209c09`)                  |
| Project          | `dzilzdxzdrrbdimhbiwv` (staging)                                             |
| Venue timezone   | `America/Chicago`                                                            |
| Exported         | 2026-10-24 21:58 UTC, 14 minutes after the last match ended                  |
| Status at export | `in_progress` — **no match remains**                                         |
| Format           | Two-round placement feeding A/B/C/D knockout draws; 8 courts, 2 playing days |

All 51 placement matches and all 31 playable knockout matches are reported; the other 8 bracket rows
are byes. Every entrant played exactly two placement matches. The placement record sorted the field
into four single-elimination draws per event, and all 20 draws have a champion. The stored tournament
status was not flipped to `completed`: completing a tournament is an operator action, and this
snapshot captures the data as the desk left it.

## Files

| File                                       |      Rows | What it is                                                                                                                                           |
| ------------------------------------------ | --------: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `summary.json`                             |         — | Counts, per-category shape, day and stage statistics, champions, the two carried matches, rest gaps. Start here.                                     |
| `matches.csv`                              |        51 | One row per **placement** match, with times, court, sides, result and the scheduling fields.                                                         |
| `draw-matches.csv`                         |        39 | One row per **knockout draw** match: 31 played and 8 byes. Empty time fields on a bye are intentional.                                               |
| `desk-activity.csv`                        |       598 | The audit trail: every start, result, time shift and court move across both days, in order, with before/after values.                                |
| `entrants.csv`                             |        51 | Entrant per event: seed, tier, waiver, team label.                                                                                                   |
| `teams.csv`                                |        51 | Team per event: player ids, seed, withdrawn flag.                                                                                                    |
| `players.csv`                              |        40 | The roster this tournament used. Names and genders only.                                                                                             |
| `categories.csv`, `courts.csv`, `days.csv` | 5 / 8 / 2 | The events, the courts and the day windows.                                                                                                          |
| `tournament.json`                          |         — | Every table above in one file, raw, with the same field names as the database. Use this when a script wants the whole shape rather than a flat view. |
| `export.mjs`                               |         — | The read-only re-export script. Not data; see [Re-exporting](#re-exporting).                                                                         |

## Time semantics — read this before analysing

Every timestamp is stored in UTC (`...Z` / `+00:00`) and displayed by the app in `America/Chicago`.
Day 1 ran 15:04–17:00 local (20:04–22:00 UTC); day 2 ran 12:01–18:30 local (17:01–23:30 UTC) and
actually finished at 16:44 local.

Two different times per match, and they mean different things:

- **`scheduled_time`** — the _published_ start: what the desk board told the players. It can move
  later (the live reflow only pushes) or, when the desk starts a match early, be later than reality.
  It is nullable: two knockout matches were started within two minutes of their draw being built,
  before a time had been published.
- **`started_at` / `ended_at`** — what actually happened, stamped by the start and report RPCs.

So:

| Derived column                 | Meaning                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `first_published_time`         | The earliest time ever published for this match, recovered from its own activity. The build's original intent.               |
| `drift_from_first_publish_min` | `scheduled_time − first_published_time`. How far the published time moved after the build.                                   |
| `published_start_delay_min`    | `started_at − scheduled_time`. Negative means the desk started it early, which is allowed. Blank when no time was published. |
| `actual_duration_min`          | `ended_at − started_at`.                                                                                                     |
| `overrun_min`                  | `actual_duration − slot_minutes`. Positive means the match ran over its slot.                                                |

`slot_minutes` is **10 for placement and 20 for knockout**; the rest gaps are 5 and 10 minutes.
Scoring differs too: placement is one game to 21, knockout is best of three. Both values are in
`summary.json`.

For a knockout match, `first_published_time` can be hours before both sides were known: a bracket
row is published when the draw is built, then pushed while it waits for feeders. Its drift is
therefore **waiting time**, not reflow caused by play. The placement rows do not have that
complication.

## Columns in `matches.csv`

`match_id`, `category`, `stage` (`round1`/`round2`), `generation_key`, `status`, `court_number`,
`scheduled_time`, `first_published_time`, `started_at`, `ended_at`, `reported_time`,
`published_start_delay_min`, `drift_from_first_publish_min`, `actual_duration_min`, `slot_minutes`,
`overrun_min`, `side_a`, `side_b`, `winner_side` (`A`/`B`), `games` (JSON array), `is_makeup`,
`is_crossover`, `prerequisite_count`, `prerequisite_keys`, `note`.

`is_makeup` marks the two matches an entrant plays in round two when their event had an odd field
and they were held out of round one. `prerequisite_keys` is the format-level ordering rule those
matches carry (`r2-makeup-2` waits on `r2-makeup-1` plus three other round-two matches) — it is not
a player-rest rule, and the two are deliberately separate concepts.

## Columns in `draw-matches.csv`

`match_id`, `category`, `draw` (`A`/`B`/`C`/`D`), `round`, `slot`, `status` (`reported`/`bye`),
`is_bye`, `court_number`, `scheduled_time`, `first_published_time`, `started_at`, `ended_at`,
`reported_time`, `published_start_delay_min`, `drift_from_first_publish_min`, `actual_duration_min`,
`slot_minutes`, `overrun_min`, `side_a`, `side_b`, `winner_side`, `games`, `note`.

A bye has one side, no time and `is_bye = true`; its `winner_side` is `A` because the bracket
advances the entrant. A draw with one entrant has **no match row at all** (the bracket sizes are 1,
2 or 4), so it cannot be counted from this file; `summary.json` records those champions with
`decidedWithoutAMatch`.

## Columns in `desk-activity.csv`

`id`, `occurred_at_utc`, `occurred_at_local`, `action`, `match_table`, `match_id`, `match_label`,
`attached`, `from_status`, `to_status`, `from_time`, `to_time`, `from_court`, `to_court`, `actor_id`,
`details_json`.

`action` is one of `started`, `reported`, `time-shifted`, `court-moved`, `reset`, `walkover`,
`voided`. This dataset contains only the first four.

- `match_table` is `placement_matches` or `tier_draw_matches`; the two match tables have different
  slot lengths, so filter on it before comparing durations.
- `attached` is true when the match still exists in either match table. A false row is a trace of a
  build that was deleted; see [Caveats](#caveats).
- `time-shifted` is the live reflow. It normally only writes a later time (one row is the exception
  described below).
- `court-moved` is a build, a rebuild, or a hand-move. A row with `to_court` but no `to_time` is the
  clearing half of a rebuild; a row with both is the write half.

## Caveats

- **Player identities are synthetic.** The tournament is staging data: the 40 names in
  `players.csv` and `tournament.json` are made up, while the schedule, the durations and the
  audit trail are real output of the product.
- **23 attached = false rows.** All are at 15:03:07 on day 1, placing the whole field at 15:02 — one
  minute before that day would have started. They were cleared within a minute and replaced
  wholesale by the 15:04:39 build that produced the day. They are the attempt that was abandoned
  before anybody played. Filter on `attached = true` for any analysis of the schedule itself; they
  are kept because deleting them would make the log claim the day started clean.
- **The day-1 snapshot misread nine rows.** It marked the 16:23–16:47 placements as unattached and
  called them a superseded generation. They are all tier-draw placements, their match ids are
  present in that snapshot's `tier_draw_matches`, and they are attached here. The earlier note was
  an export bug: the flag only checked the placement table.
- **Two knockout matches have no published time.** `MS draw A r1 s2` started at 12:31:46 local and
  `XD draw C r1 s1` at 12:14:13; both draws had been built moments earlier. Their `scheduled_time`,
  `first_published_time`, delay and drift are blank, not zero.
- **One `time-shifted` row moves a match earlier.** `XD r2-makeup-2` was published on day 2 at
  12:01, pulled back to 17:01 on day 1 at 16:36, and returned to day 2 at 16:47. It is the only
  negative shift in 309 rows, and it is a day-boundary reassignment rather than reflow.
- **Two placement matches crossed the day boundary.** `XD r2-5` and `XD r2-makeup-2` were first
  published at 16:55 and 17:01 on day 1 and played at 12:01 on day 2. Their 1146 and 1140 minute
  drifts are planning decisions, not reflow; `stages.placement.drift.intraDay` excludes them.
- **Three draws were decided without a match.** `WS C`, `MD C` and `WD C` each had one entrant.
  They are champions in the data but have no `draw-matches.csv` row; eight byes are the other
  matches that never needed a court.
- **No result corrections, walkovers, resets or voids.** `match_result_history` is empty and the
  activity trail contains no such action. `reported_time` is within a second of `ended_at`, so no
  result was back-dated.
- **The tournament was reset and rebuilt earlier.** The activity table still holds 34 rows from
  19–21 October, outside the two play days. This dataset is the tournament as it was actually
  played, not those earlier attempts.
- The CSV files carry a UTF-8 byte-order mark so Excel opens them correctly. Standard `read_csv`
  ignores it.

## What the data says

|                                         |               Day 1 |                     Day 2 | Whole tournament |
| --------------------------------------- | ------------------: | ------------------------: | ---------------: |
| Matches started                         |        46 placement | 5 placement + 31 knockout |               82 |
| First start / last end (local)          | 15:04:52 / 16:59:06 |       12:01:07 / 16:44:07 |                — |
| Court-minutes used                      |               545.4 |                     808.3 |           1353.7 |
| Court capacity in the configured window |                 928 |                      3112 |             4040 |
| Utilisation of the configured window    |               0.588 |                     0.260 |            0.335 |
| Utilisation of the elapsed day          |               0.597 |                     0.357 |                — |

`court_minutes` is the sum of actual match durations; capacity is courts × the configured day
window. Changeover, rest and idle courts are not counted as used, which is why the configured-window
figure on day 2 is low even though the day ran from 12:01 to 16:44.

### The 10-minute placement slot is short, and the day still closes on time

- 51 placement matches, mean 11.8 minutes (median 11.7, range 6.0–16.8) against a 10-minute slot.
- 46 of 51 ran over their slot (90%). Mean overrun among those 46 is 2.3 minutes, 1.8 across all
  matches; the largest is 6.8.
- 40 of the 49 non-carried placement matches were republished later by the reflow, mean +3.9
  minutes over those 40, largest +8.5.
- Day 1 started at 15:04:52 and finished at 16:59:06, 54 seconds before its 17:00 close, with 46
  matches on 8 courts. That is the reflow working: it pushes the tail out as matches overrun, but it
  does not pull it back when a match is short.
- The desk did not systematically start early: the published-start delay is +0.9 minutes on
  average (median +0.5), with a range from −3.7 to +9.6.

### The 20-minute knockout slot is closer, but still short

- 31 knockout matches played, mean 24.2 minutes (median 21.6, range 8.2–47.5) against a 20-minute
  slot. 27 of 31 ran over (87%), mean overrun 5.5 minutes among them, largest 27.5.
- 8 byes and 3 single-entrant draws removed work, so the knockout stage took 4 hours 43 minutes
  rather than the 6 hours 29 minutes the day window allowed. Day 2 ended at 16:44, one hour and
  46 minutes early.
- Published-start delay for the 29 knockout matches with a time is +2.7 minutes on average
  (median +0.6), from −10.6 to +14.6.

### Knockout drift is waiting for feeders, not reflow from play

- 26 of the 29 knockout matches with a first publication moved; median +11.4 minutes, mean +26.4
  among those 26, largest +180.2.
- That is the bracket behaving as designed: a match is published as soon as its draw exists, but it
  cannot be played until both feeders finish. The reflow pushes it while it waits. Do not compare
  this figure with the placement drift and conclude that knockout play is less predictable.
- Two matches were started so soon after their draw was built that they never had a published time
  at all.

### The day boundary is a separate kind of movement

The two XD matches carried to day 2 account for the only large placement drifts (1146 and 1140
minutes). They were published at 16:55 and 17:01 on day 1, one at the day's close and one a minute
past it, then played at 12:01 the next morning. `summary.json` reports them separately in `carried`
and keeps them out of the intra-day drift figures.

### Rest was tight but mostly legal

Across 177 same-day player turnarounds (previous `ended_at` to next `started_at`, all four players
checked in doubles):

- minimum 4.6 minutes, for Bui Nguyet between `XD round1 r1-6` and `WD round2 r2-makeup-1`;
- median 17 minutes;
- one turnaround under 5 minutes and 52 under 10.

The applicable gap depends on the later match's stage (5 minutes placement, 10 knockout), and the
desk may start a match early, so a 4.6-minute turnaround is not automatically a rule violation. It
is the tightest case the day produced.

### Every draw was decided

| Draw | MS        | WS          | MD                        | WD                      | XD                      |
| ---- | --------- | ----------- | ------------------------- | ----------------------- | ----------------------- |
| A    | Do Nam    | Truong Diep | Do Huy / Duong Duy        | Do Van / Ly Van         | Cao Binh / Do Van       |
| B    | Do Huy    | Dinh Giang  | Dang Manh / Vo Bao        | Ly Ngoc / Duong Linh    | Dang Manh / Huynh Trang |
| C    | Dinh Minh | Le Nhung\*  | Duong Thanh / Cao Thien\* | Le Nhung / Dinh Nhung\* | Cao Thien / Ly Van      |
| D    | Mai Khoa  | Dang Diep   | Do Anh / Duong Khang      | Huynh Trang / Le Xuan   | Dang Nam / Truong Diep  |

`*` sole entrant in that draw; champion without a match. Final scores and sides are in
`summary.json` under `perCategory[].knockout.tiers[].final`.

### Activity volume

598 rows over the two days: 352 on day 1 and 246 on day 2. By action: 125 `court-moved` (115 writes,
10 clears), 309 `time-shifted`, 82 `started`, 82 `reported`. Of the 598, 575 are attached and 23 are
the abandoned-build rows at 15:03:07.

## Loading it

```python
import pandas as pd

matches  = pd.read_csv("analysis/viet-nam-open-2026/matches.csv")
draws    = pd.read_csv("analysis/viet-nam-open-2026/draw-matches.csv")
activity = pd.read_csv("analysis/viet-nam-open-2026/desk-activity.csv")

# times are UTC; convert for anything the desk would read
for col in ["scheduled_time", "first_published_time", "started_at", "ended_at"]:
    matches[col] = pd.to_datetime(matches[col], utc=True).dt.tz_convert("America/Chicago")
    draws[col]   = pd.to_datetime(draws[col], utc=True).dt.tz_convert("America/Chicago")

# the schedule-only trail: attached rows, reflow shifts only
reflow = activity[(activity["attached"]) & (activity["action"] == "time-shifted")]
```

`matches.csv` and the other CSVs carry a UTF-8 byte-order mark; `read_csv` handles it.

## Re-exporting

The snapshot is a point-in-time copy, so it does not follow the database if the tournament is edited
further. To take it again:

```bash
node analysis/viet-nam-open-2026/export.mjs
```

The script sends read-only `SELECT`s to the staging project named at the top of the file, through
the Management API, using `SUPABASE_ACCESS_TOKEN` from the environment or the repository `.env`. It
pulls activity by the two playing days rather than by match id, which is why deleted-match rows
survive, and it drops player email, phone and profile id, organiser contact fields and the owner
profile id on the way out. It rewrites the CSVs, `tournament.json` and `summary.json`; **README.md
is prose and has to be updated by hand** when the numbers change.

Do not point it at the production project. The tournament id and project ref are constants at the
top of the script for exactly that reason.
