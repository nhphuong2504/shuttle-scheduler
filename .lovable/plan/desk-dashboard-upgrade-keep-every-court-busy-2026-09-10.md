# Desk dashboard upgrade: keep every court busy

The desk screen becomes a court-filling tool. Its main job: when a court frees up, show instantly which match should go on it and let one click send it there.

## 1. Court board (the top half)

Each of the 8 court cards, tuned for laptop screens:

- **Live clock**: minutes on court, counting up every 30 seconds. Neutral while inside the planned slot, amber near the cap, red past it.
- **Real names**: all individual player names for doubles, not team codes.
- **Next two queued matches** with their times, instead of just one.
- **Actions right on the card**: Start, Enter score, and Free court — no window needed for the common moves. The score window still opens for full entry and corrections.
- Free courts look clearly different: a large "Send next match" button instead of an empty panel.

## 2. Ready-to-send queue (the new core panel)

A list beside the board of matches that could start right now, each showing category, players, and how long the players have rested.

- Every entry is checked against the rules already in the app: nobody already playing, and the required rest gap since their last match.
- Matches that pass are marked **Ready** and can be sent to any free court in one click (pick the court from the button, or the card's "Send next match" pre-fills it).
- Matches that fail show the reason in plain words: "Anna is on Court 3" or "Rested 12 of 30 min" — with a live countdown to when they become ready.
- Ordered by scheduled time, so the queue follows the plan but never lies about who can actually play.
- A header line says how many courts are free and how many matches are ready, e.g. "3 courts free · 7 ready to go".

## 3. Alerts, tightened

Existing alerts stay (pools past their finish, matches over their slot) and gain a jump link that opens the relevant court or match, so the desk can act without hunting.

## 4. Progress strip

The category progress and totals panels shrink into one compact strip under the board so the board and queue own the screen.

## Technical notes

- All work is in `src/routes/index.tsx` plus small new components; no schema or business-logic changes.
- Readiness reuses `checkStartConstraints` and `restGapForKind` from `src/lib/tournament/scheduler.ts`; sending a match reuses `startMatch` from `src/lib/tournament/actions.ts` with the chosen court id.
- "Free court" clears `court_id` / resets live state via the existing reset path; no new database functions.
- A single 30-second ticker drives all clocks and countdowns; realtime refresh stays as it is.
- Colours come from the existing tokens (`warn-*`, `danger-*`, `mint`, `amber`) — no new hardcoded colours.
