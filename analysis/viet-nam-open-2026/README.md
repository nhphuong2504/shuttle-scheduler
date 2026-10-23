# Viet Nam Open 2026 — day 1 dataset

A snapshot of the finished tournament day, exported so the operational behaviour of the scheduler
and the live reflow can be analysed without a database. Committed to the repository on purpose:
`backups/` is git-ignored, so an export that lived there would not survive a change of machine.

| | |
| --- | --- |
| Tournament | Viet Nam Open 2026 (`93034e9a-aab3-4fc1-80c5-36e5b7209c09`) |
| Project | `dzilzdxzdrrbdimhbiwv` (staging) |
| Venue timezone | `America/Chicago` |
| Exported | 2026-10-23 22:04 UTC, after the last match of day 1 finished |
| Status at export | `in_progress` — 46 of 51 matches reported, 5 carried to day 2 |

## Files

| File | Rows | What it is |
| --- | ---: | --- |
| `summary.json` | — | Counts, per-category shape, day-1 utilisation, duration and drift statistics, and the 5 matches that moved to day 2. Start here. |
| `matches.csv` | 51 | One row per match, with times, court, sides, result and the scheduling fields. See "Columns" below. |
| `desk-activity.csv` | 352 | The audit trail: every start, result, time shift and court move, in order, with before/after values. |
| `entrants.csv` | 51 | Entrant per event: seed, tier, waiver, team label. |
| `teams.csv` | 51 | Team per event: player ids, seed, withdrawn flag. |
| `players.csv` | 40 | The roster this tournament used. |
| `categories.csv`, `courts.csv`, `days.csv` | 5 / 8 / 2 | The events, the courts and the day windows. |
| `tournament.json` | — | Every table above in one file, raw, with the same field names as the database. Use this when a script wants the whole shape rather than a flat view. |

## Time semantics — read this before analysing

Every timestamp is stored in UTC (`...Z` / `+00:00`) and displayed by the app in `America/Chicago`.
Day 1 ran 15:04–17:00 local, i.e. 20:04–22:00 UTC.

Two different times per match, and they mean different things:

- **`scheduled_time`** — the *published* start: what the desk board told the players. It can move
  later (the live reflow only pushes) or, when the desk starts a match early, be later than reality.
- **`started_at` / `ended_at`** — what actually happened, stamped by the start and report RPCs.

So:

| Derived column | Meaning |
| --- | --- |
| `first_published_time` | The earliest time ever published for this match, recovered from its own activity. The build's original intent. |
| `drift_from_first_publish_min` | `scheduled_time − first_published_time`. How far the live reflow moved the match after the build. |
| `published_start_delay_min` | `started_at − scheduled_time`. Negative means the desk started it early, which is allowed. |
| `actual_duration_min` | `ended_at − started_at`. |
| `overrun_min` | `actual_duration − slot_minutes`. Positive means the match ran over its slot. |

`slot_minutes` is 10 and the rest gap is 5 for this tournament (both in `summary.json`).

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

## Columns in `desk-activity.csv`

`id`, `occurred_at_utc`, `occurred_at_local`, `action`, `match_id`, `match_label`, `attached`,
`from_status`, `to_status`, `from_time`, `to_time`, `from_court`, `to_court`, `actor_id`,
`details_json`.

`action` is one of `started`, `reported`, `time-shifted`, `court-moved`, `reset`, `walkover`,
`voided`.

- `time-shifted` is **always** the live reflow: it only ever writes a later time.
- `court-moved` is a build, a rebuild, or a hand-move. A row with `to_court` but no `to_time` is the
  clearing half of a rebuild; a row with both is the write half.

## Caveats

- **`attached = false`** marks 32 rows whose match no longer exists. All 32 have exactly one event —
  a single placement — and were never played. They fall into two groups:
  - **23 at 15:03:07**, placing the whole field at 15:02 — one minute before that day would have
    started. They were cleared within a minute and replaced wholesale by the 15:04:39 build that
    produced this day. They are the attempt that was abandoned before anybody played.
  - **9 at 16:23:12, 16:34:39 and 16:47:20**, three at a time, each placed on a **day-2** slot
    (12:01–12:51 the next morning). The current round-two rows were all created earlier
    (15:16–16:03) and each holds exactly one placement event, so these nine are a superseded
    generation rather than these rows moving. The database keeps no delete audit, so which code
    path removed them cannot be settled from this data alone.

  Filter on `attached = true` for any analysis of the schedule itself. They are kept because
  deleting them would make the log claim the day started clean.
- **5 matches are on day 2** (`summary.spill`). Two of them (`XD r2-5`, `XD r2-makeup-2`) were first
  published at 16:55 and 17:01 on day 1 and were carried to 12:01 the next morning — those two are
  the only large "drift" figures in the data and are a day-boundary spill, not intra-day reflow.
  The `drift` block in `summary.json` therefore counts completed matches only.
- **`reported_time`** is when the desk saved the result, not when the match ended. On this day they
  are within a second of each other, so no back-dating was used.
- The tournament was reset and rebuilt earlier the same afternoon. This dataset is the day as it was
  actually played, not the earlier attempts, which no longer exist in the database.

## What the data says at a glance

| | |
| --- | --- |
| Matches started on day 1 | 46 |
| First start / last end | 15:04:52 / 16:59:06 local |
| Mean match duration | 11.9 min (slot 10) |
| Matches over their slot | 41 of 46; largest overrun 6.8 min |
| Court utilisation | 0.588 (545 of 928 available court-minutes) |
| Matches the reflow moved | 38, mean +4.0 min, largest +8.5 min |
| Carried to day 2 | 5 |

Two things follow from those numbers and are worth keeping in mind when reading the log:

1. The 10-minute slot is systematically short. A match on this day averaged 11.9 minutes, so the
   tail of the schedule is pushed out by roughly 2 minutes per match on every court, which is what
   the reflow drift accumulates from.
2. Because the reflow only pushes, that drift is one-way: it never recovers the time a short match
   saves. That is why the day finished within one minute of the 17:00 close despite starting 46
   matches.

## Loading it

```python
import pandas as pd

matches  = pd.read_csv("analysis/viet-nam-open-2026/matches.csv")
activity = pd.read_csv("analysis/viet-nam-open-2026/desk-activity.csv")

# times are UTC; convert for anything the desk would read
for col in ["scheduled_time", "first_published_time", "started_at", "ended_at"]:
    matches[col] = pd.to_datetime(matches[col], utc=True).dt.tz_convert("America/Chicago")

# the schedule-only trail: attached rows, reflow shifts only
reflow = activity[(activity["attached"] == True) & (activity["action"] == "time-shifted")]
```

`matches.csv` and the other CSVs carry a UTF-8 byte-order mark so Excel opens them correctly.
Standard `read_csv` ignores it.

## Re-exporting

The snapshot is a point-in-time copy, so it does not follow the database if the tournament is edited
further. To take it again, query the same tournament (`93034e9a-…`, staging project
`dzilzdxzdrrbdimhbiwv`) with a Supabase personal access token; every table is scoped by
`tournament_id`, and `desk_activity` is reached through the match ids and the court ids as described
above.
