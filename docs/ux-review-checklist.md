# UX review checklist

The checks no automated gate can make, plus the record that says whether they were run.

## Why this is a document and not a test

Axe reads the DOM and the computed cascade. It reliably catches a missing accessible name,
a wrong role, a resolvable contrast failure, and a duplicate id. It cannot judge whether the
focus order is logical, whether a heading hierarchy communicates priority, or whether a
moderator can read a court state from three metres away. Those are judgements, and the only
instrument for them is a person looking at the screen.

That leaves a gap with a familiar shape: the machine-checked gates are green, so the phase
looks verified, and nothing records whether anyone actually looked. This file closes that by
requiring a written record, including an explicit statement of how many tests were skipped.
A skipped test is never a passing test, and an unrun checklist is never a green light.

## Before you start

```sh
npm run dev          # then open http://localhost:8080
```

The Desk is the surface that matters most. If you have no tournament with data in it, the
rendered Playwright fixture is the reference for what populated looks like:
`e2e/fixtures/desk-mock.ts` describes eight live courts, long doubles pairings, three-game
scores at the 30-point cap, and every court state.

The checks below are grouped by what they need. Mark each one **pass**, **fail** (with a
note), or **not applicable** (with a reason). "Not applicable" is a decision, not a skip.

---

## 1. Status recognition

The design's central claim is that a state is readable from shape and label without relying
on colour. Each check is done twice: once normally, once in a grayscale screenshot.

| # | Check | How to set it up |
| --- | --- | --- |
| 1.1 | Every match status is distinguishable in grayscale | Screenshot the Desk, convert to grayscale, and check each row is still identifiable |
| 1.2 | Every court state has a distinct label, not just a distinct tint | Compare `playing`, `overrun`, `free-ready`, `free-blocked`, `idle` side by side |
| 1.3 | `void` does not read as simply absent or empty data | It is tier 3, a filled neutral chip with a heavier ring |
| 1.4 | `walkover` and `void` are not confusable | They are the closest pair in the vocabulary; check glyph and label carry it |
| 1.5 | A bye reads as a draw condition, not a played match | Dashed edge, "Bye" label, no status pill |
| 1.6 | `completed` and `walkover` recede without becoming illegible | Tier 4 is ink only; verify it is still readable, not merely quiet |

## 2. Hierarchy and scan speed

| # | Check | How to set it up |
| --- | --- | --- |
| 2.1 | The most urgent item on each screen is the most visually prominent | Desk with an overrun court and a ready court |
| 2.2 | Player names, court id, score and timer are readable at a glance | Desk at 1920x1080, then at 1366x768 |
| 2.3 | No more than roughly three saturated elements compete on one view | Count the brand action, live state, and any destructive action |
| 2.4 | The heading order communicates the hierarchy | `h1` is the page, `h2` is a panel; no level is skipped |
| 2.5 | An operator can tell what to do next without reading a paragraph | Time yourself: under five seconds from looking to knowing |

## 3. Legibility and fit

| # | Check |
| --- | --- |
| 3.1 | Nothing clips or overlaps — check the longest doubles pairing and the widest score (`30-29, 29-30, 30-28`) |
| 3.2 | The scale holds at 1366x768 and at 1920x1080 — nothing cramped, nothing sparse |
| 3.3 | At 1366x768, the tables do not require horizontal scrolling for their primary columns |
| 3.4 | Nothing renders below the 12px floor, including the smallest reference text |

## 4. Focus and keyboard

| # | Check |
| --- | --- |
| 4.1 | The focus ring is visible on every control, including the active nav pill and the active segmented-control button |
| 4.2 | Tab order follows the visual reading order, including inside the score dialog |
| 4.3 | The focus ring is never hidden behind a sticky header as you tab down |
| 4.4 | A dialog traps focus while open and returns it to its opener on close |
| 4.5 | The score dialog can be completed with the keyboard alone |

## 5. Empty, loading and error states

These are the states a fixture is least likely to produce, and the ones an operator meets
first on the day.

| # | Check | How to set it up |
| --- | --- | --- |
| 5.1 | Every route renders a deliberate empty state, not a blank panel | Point the mock at an empty dataset, or use a tournament with nothing generated |
| 5.2 | Empty states say what will appear and what to do | Read them; "No data" is a failure |
| 5.3 | A failed request shows an error state, not an empty one | Block `**/rest/v1/**` in devtools and reload |
| 5.4 | The signed-out view is clearly read-only and explains how to sign in | Load the Desk with no session |
| 5.5 | The realtime indicator's offline and error states are distinguishable from live | Toggle the browser offline |

## 6. Wording

| # | Check |
| --- | --- |
| 6.1 | The day's latest finish is stated as a fact about the schedule, never as a prediction. `finish-wording.ts` reports "Last match scheduled to finish …"; no forecast of when the event *will* end exists in this app, so no wording may imply one |
| 6.2 | No label uses a raw database value (`in-progress`, `reported`) instead of its display label (`Live`, `Completed`) |
| 6.3 | Destructive actions name what they destroy, and the confirmation does not soften it |

## 7. Themes

| # | Check |
| --- | --- |
| 7.1 | Every screen above is checked in **both** light and dark |
| 7.2 | Nothing looks "half-dark": scrollbars, inputs and native controls follow the theme |
| 7.3 | The dark theme is not a dimmed light theme — check the neutral ramp separates surfaces |

---

## The record

Every phase close appends a row. The skip count is **required**: write `0` if zero, and if it
is not zero, say which tests skipped and why. A phase cannot be closed with a blank count.

| Date | Phase / change | Reviewer | Checks run | Result | Skips | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-20 | Repository audit and workflow | — | none | not yet run | 0 | Checklist introduced. The machine gates ran clean (`test:e2e:final`: 297 passed, 0 skipped), but this change also carries a user-visible layout fix, so §3 (density and legibility) and §5 (empty states) need a human pass before the row can say more. |

### Result values

- **pass** — every applicable check passed.
- **pass with notes** — passed, with items recorded in Notes that should be watched.
- **fail** — something did not pass. Name the check number and open an issue or fix it.
- **not yet run** — the checklist has not been performed for this change. This is only
  acceptable for a change with no user-visible surface.

### What counts as user-visible

Anything an operator can see: layout, copy, tokens, component markup, route structure,
state presentation, or error handling. A docs-only, test-only, or tooling-only change does
not require a run, and should say so explicitly rather than leaving the row blank.
