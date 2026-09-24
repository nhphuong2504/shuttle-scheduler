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

Every PR or phase close that includes a **user-visible** change appends exactly one row.
A change with no user-visible surface requires no UX review run and no row — state that
plainly in the PR instead. The one exception is a PR/phase-close artifact that must record,
for the record's sake, that no user-visible review applied: that row's Checks run is
`none` and its Result is `not yet run`.

The skip count is **required**: write `0` if zero, and if it is not zero, say which tests
skipped and why. A PR or phase close cannot be recorded with a blank count.

| Date | Phase / change | Reviewer | Checks run | Result | Skips | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-09-20 | Repository audit and workflow | — | none | not yet run | 0 | Checklist introduced. The machine gates ran clean (`test:e2e:final`: 297 passed, 0 skipped), but this change also carries a user-visible layout fix, so §3 (density and legibility) and §5 (empty states) need a human pass before the row can say more. |
| 2026-09-23 | Court settings reorganised on `/placement-schedule` | — | §2.4, §3.1–3.4, §6.2, §7.1 — both themes at 1366x768, 1920x1080 and 2560x1440, Settings open | pass with notes | 0 | The venue's court pool moved out of the day cards into one section of its own, with each day narrowing it; adding a court now joins every day. §3.4: no rendered text below 12px in any cell. §3.1/§3.2: no document-level horizontal overflow, and the longest strings on the panel fit. §2.4: `h1` page → `h2` Settings → `h3` per section, no level skipped. §6.2: no raw database value is used as a status label; the running order still reads Completed/Live/Scheduled/Walkover. The three settings explanations (Courts, Playing days, Match format) were then removed at review, so each section is now a heading and its controls. Notes: four `Input` nodes (the day window and break time fields) report 2–4px of internal scroll overflow; they predate this change, the page itself does not scroll, and nothing is visually clipped. §1, §4 and §5 are unchanged by this work and were not re-run. |
| 2026-09-23 | Tournament settings panel redesigned on `/placement-schedule` | — | §2.4, §3.1–3.4, §4, §5, §6.2, §7.1 — both themes at 1366x768, 1920x1080 and 390px, panel open, days with and without breaks and a break added | pass with notes | 0 | The panel is now one continuous flow: a section header row (title plus the section's own summary) over a full-width body, replacing the fixed 13rem label column, so Venue courts, Playing days and Match format share a single rhythm. The court pool is a labelled stepper (− / count / +) rather than prose beside two ghost buttons, and each day is a compact row that keeps its date, start and end, its court toggles and its breaks. A day's breaks render in place behind a single "Add break" control: the row no longer carries a "Breaks (n)" disclosure that reveals a second "Add break", so adding a window is one click and an existing window can be corrected without first adding and then deleting a row. §2.4: `h1` page → `h2` Tournament settings → `h3` section → `h4` day / stage, no level skipped. §3.1/§3.2: `main` reports zero horizontal overflow at 1366 and 1920, and no document-level scroll at 390. §3.4: nothing renders below 12px. §6.2: no raw database value is used as a label. §7.1: both themes. §4: the new controls are ordinary buttons and inputs, and `e2e/criteria.spec.ts` re-ran 175 focus stops per theme with every indicator at or above 3:1. §5 is unchanged by this work and was not re-run. `npm run test:e2e`: 162 passed, 0 skipped. Notes: extending the panel scan to a break row found a real defect — the row's two time inputs had no accessible name at all (a placeholder is not a name), which the new scan failed on until the row gained a group label and named fields; that is the argument for scanning an opened surface rather than trusting the route sweep. At 390px the native date and time inputs report 7–19px of internal content overflow while the page itself does not scroll and nothing is visually clipped — the widths are unchanged from before this work. |
| 2026-09-23 | Picker glyphs replaced with icons from the set | — | §3.1–3.4, §4.1, §7.1–7.2 — both themes at 1366x768, 1920x1080 and 390px, panel open with a break added | pass with notes | 0 | Twelve fields across `placement-schedule.tsx`, `schedule.tsx` and `DetailsStep.tsx` each drew the browser's own calendar and clock inside their right edge. That glyph takes no `--color-*` token, no size the design system can set and no focus ring — on a dark surface the only lever the theme had over it was `color-scheme` — so it was the one element in the panel outside the cascade. It is removed by `.picker-field::-webkit-calendar-picker-indicator` in `styles.css` and replaced by one `PickerInput`, scoped to the class rather than to `input[type=date]` so a future field is not stripped of its native control by deciding to exist. §7.2 now holds with no exception to note. Notes: (1) the replacement is a real `<button>` calling `showPicker()`, not decoration — the glyph it replaces was already a separate click target, so a decorative swap would have silently removed the only way into the popup. §4.1: it takes the shared ring, asserted by tabbing to it from its own field; Chromium keeps a date field's month and day as two further tab stops inside the field, so the control is the third stop rather than the first. (2) Each control is named for the field it opens ("Open the calendar for day 1"), because a day list holds three fields per day and one name repeated down the page names none of them. (3) §3.1/§3.2: `main` reports zero horizontal overflow at 1366, 1920 and 390, and no date or time field reports internal content overflow. The 2–4px and 7–19px recorded on the two rows above are no longer measured; the engine's glyph occupying that space is the likeliest reading but was not isolated, so it is not claimed. (4) The removal is proved rather than asserted: the indicator is a user-agent pseudo-element that `getComputedStyle(el, "::pseudo")` reports the default for whether or not the rule applies, so it cannot be used as evidence. It was confirmed by rendering the same field with and without the class side by side — with the class draws no glyph, without it draws the calendar. (5) Discipline and coverage: `e2e/criteria.spec.ts` still reports 175 focus stops per theme, unchanged, and that is expected rather than reassuring — `/setup` mounts its review step for a live tournament and `/schedule`'s day windows render nothing under the fixture, so neither contributes a stop, and the settings panel sits behind a toggle no route sweep opens. The control is therefore covered by `src/components/ui/picker-input.test.tsx`, including the two `showPicker()` fallback paths that Chromium never takes; the wizard's first step, which no e2e can reach, by `src/components/tournament-setup/DetailsStep.test.tsx`; and `src/lib/design/pickers.test.ts` fails the suite if any date or time field goes back to a raw `<Input>` or `<input>`. §1, §2 and §6 are unchanged by this work and were not re-run; §5 still not re-run. `npm run test:e2e:final`: 163 passed, 0 skipped. |
| 2026-09-23 | Time values given room from the picker icon | — | §3.1–3.2, §7.1 — panel open with a break added, at 1366x768, 1920x1080 and 390px, both themes | pass with notes | 0 | The clock sat almost on top of the value in the Start and End fields: measured, the day window's value ended **2px** short of the icon at 1366 and **overlapped it by 8px** at 390, and the break row's cleared it by 1px at 390. The cause is not the padding. A date or time value is laid out from its field's content-box left edge, so `padding-right` cannot create that space — `pr-9` was in place throughout, and a field too narrow for its value paints straight through it and under the glyph. The only lever is the field's width, and the painted width moves with the type size, which `Input` sets to 16px below `md` and 14px above it. The widths therefore step down at the same breakpoint the type does: day times and break times `w-33 md:w-32`, dates `w-38 md:w-36`. Notes: (1) The 16px case is the binding one and is the whole reason the original 7rem passed at 1366 and failed at 390 — sizing for the wider rendering looked correct on a desktop and put the phone's value under the icon. (2) A first attempt at 8.5rem overshot: it gave a 26px gap on desktop against the 17px the date field has, which is airier than the neighbouring field rather than matching it. The widths were then chosen to reproduce the date field's own spacing, which is the in-app reference for "right" — 18–19px against the date's 17px at 1366 and 1920, 12–13px against its 13px at 390. (3) The measurement had to be built: a date or time value is UA-rendered, so there is no node to measure, and `scrollWidth` on a clone of the field over-reports because Chromium gives these fields a minimum content width. A span carrying the same text and the field's resolved font is the reliable proxy — but only once the font is set from its individual properties, because the computed `font` shorthand is the empty string and a span that silently falls back measures 14px and 16px fields as identical, which is exactly the error that hid the mobile case. (4) Guard: `e2e/staff-surfaces.spec.ts` now measures that every picker's value fits the box its padding reserves, at both widths. It is stated as that invariant rather than as a pixel gap because it is the true condition — the reservation ends 4px ahead of the icon, so a value that fits it cannot reach the glyph — and it caught a second instance the eye had not: the **date** fields were 1px over their reservation at 390 as well, so they are fixed here too. (5) `DetailsStep`'s two date fields carry no width and need none: they sit in a one-to-three column grid and are 300px+ at every viewport, so the fit guard does not extend to them; their spacing is covered by the rendered component test and the source guard. (6) §3.1/§3.2: `main` reports zero horizontal overflow at 1366, 1920 and 390, and no picker field reports internal content overflow. The day row wraps one field earlier at 390 than it did, which is the room the fix needs. §4, §5, §6 unchanged by this work and not re-run. `npm run test:e2e:final`: 164 passed, 0 skipped. |

### Result values

- **pass** — every applicable check passed.
- **pass with notes** — passed, with items recorded in Notes that should be watched.
- **fail** — something did not pass. Name the check number and open an issue or fix it.
- **not yet run** — no user-visible review applied, because the change had no user-visible
  surface. Use it only when the PR/phase-close artifact needs to document that. A change
  with a user-visible surface may never be recorded as `not yet run`; it gets a real result.

### What counts as user-visible

Anything an operator can see: layout, copy, tokens, component markup, route structure,
state presentation, or error handling. A docs-only, test-only, or tooling-only change
requires neither a run nor a row — say so in the PR. Where the artifact's record needs a
line anyway, write `not yet run` with the reason in Notes rather than leaving the outcome
blank.
