---
name: Tournova landing (The Court Board)
description: The Watch-mode front door of Tournova, drawn as the organiser's board of court sheets in src/components/landing/; the wall, sheet stock, ink, brand, UI type and interaction colour are the app's own tokens from src/styles.css.
colors:
  primary: "#22397A"
  foreground: "#171A1D"
  muted-foreground: "#5B656C"
  wall: "#F4F5F4"
  sheet: "#FFFFFF"
  ink: "#111111"
  ink-raised: "#2B2B2B"
  ink-soft: "#3A3D40"
  rule: "#2A2A2A"
  mark: "#D81B8A"
  hatch: "rgb(17 17 17 / 0.42)"
typography:
  wordmark:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(2rem, 5.2vw, 3.5rem)"
    fontWeight: 600
    lineHeight: 1.04
    letterSpacing: "-0.03em"
  subhead:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.125rem, 2.2vw, 1.5rem)"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  sheet-title:
    fontFamily: "Roboto Condensed, Arial Narrow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.06em"
  time:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    fontFeature: "tnum"
  clash-note:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.3
  clash-shift:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.2
  nav:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.2
  action:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.2
  link:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.2
rounded:
  sheet: "3px"
  action: "2px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  sheet-pad: "0.875rem"
  gutter: "1rem"
  form-gap: "0.625rem"
  row: "1.75rem"
  hero-inset: "2rem"
components:
  wordmark-link:
    textColor: "{colors.foreground}"
    typography: "{typography.wordmark}"
    height: "44px"
  nav-link:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.nav}"
    padding: "0 0.625rem"
    height: "44px"
  nav-link-hover:
    textColor: "{colors.foreground}"
  court-sheet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "0.875rem 0.875rem 1rem"
  sheet-title:
    textColor: "{colors.ink}"
    typography: "{typography.sheet-title}"
    padding: "0 0 0.375rem 0.125rem"
  time-row:
    textColor: "{colors.ink-soft}"
    typography: "{typography.time}"
    padding: "0 0.625rem 0 0.25rem"
    height: "{spacing.row}"
  time-row-moved:
    textColor: "{colors.mark}"
  clash-note:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.clash-note}"
    padding: "0.75rem 1.125rem"
  action-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.sheet}"
    typography: "{typography.action}"
    rounded: "{rounded.action}"
    padding: "0 1.5rem"
    height: "48px"
  action-primary-hover:
    backgroundColor: "{colors.ink-raised}"
  follow-link:
    textColor: "{colors.ink}"
    typography: "{typography.link}"
    height: "44px"
  headline:
    textColor: "{colors.ink}"
    typography: "{typography.headline}"
---

# Design System: Tournova landing (The Court Board)

## Overview

**Creative North Star: "The Court Board"**

The landing is the Watch-mode front door of the same Tournova system described in
`docs/design-principles.md`, not a separate product, and it is drawn as the thing the
product actually makes: the organiser's board on the hall wall, one printed sheet per court
pinned up for the day. Its world lives in `src/components/landing/` — `landing.tsx` for the
six sheets and the clash, `court-sheets.css` for everything visual, scoped to `.cs-page`.
Nothing else is new. The wall is the app's own `--background`, the sheet is the app's own
`--surface`, the type families are the app's, the wordmark and nav are the app header's, and
the only two token values the page adds are pen black on the sheet and the app's `--primary`
for the mark and the focus ring. A visitor who signs in walks through a door, not into another
company.

The page shows a problem already solved. Six court sheets hang slightly askew on the grey
wall with a stamped time column and a hand-hatched match column; between them one clash is
circled in highlighter magenta — L. Tran plays 11:10 and 11:22 — and next to the circle the
sheet it touches already reads the new time with the old one struck through. That is the
product's promise drawn before it is said: when a match runs late, the rest of the day keeps
up. The headline under the board says the same in one line, and one dark button offers the
one action.

Density is low and the two materials are plain: card stock and pen. Every mark on the page is
either a rule, a hatch, a struck time or a circle drawn by hand, so the board reads as
something a person made at a desk — not a screenshot of software. The only hue the app does
not own is the highlighter, and it appears once.

**Key Characteristics:**
- The wall is the app's `--background` and the sheets are its `--surface`; there is no separate landing palette.
- One navy, used only by the brand mark and the focus ring; everything else is pen black, paper white and muted grey.
- One highlighter magenta, used only for the circled clash and the time it moved.
- Times are JetBrains Mono with tabular figures — the one place a visitor sees the app's mono face.
- Court names are Roboto Condensed small caps; everything read as interface is Instrument Sans.
- Sheets are pinned, not placed: each carries a small tilt, a lift and a paper shadow.
- One authored motion: the sheets pin down in order, then the circle is drawn around the clash.

## Colors

Paper, pen and one highlighter on the app's own grey wall. There is no second palette to
learn: four neutrals and one ink come from the app, magenta comes from a marker.

### Primary
- **Tournova Navy** (#22397A): the brand mark at 20px in the header and the 2px focus outline
  on every focusable thing. It is the app's `--primary`, read, never redefined. It is not a
  fill, not a link colour and not a border on this page.

### Secondary
- **Highlighter Magenta** (#D81B8A, `--cs-mark`): the 2.5px ring around the clash note, the
  colour of the time that moved, and the tint of the note's shadow. It is a marker stroke on
  a picture of paper, not a status the app reports.

### Neutral
- **Wall** (#F4F5F4, `--background`): the page ground; the board hangs on the same grey as
  every other Tournova screen.
- **Sheet Stock** (#FFFFFF, `--surface`): the court sheets and the clash note; the app's card
  surface, untoned.
- **Pen Black** (#111111, `--cs-ink`): sheet titles, the clash note's text, the headline, the
  subhead, the follow link, and the fill of the one action.
- **Soft Ink** (#3A3D40, `--cs-ink-soft`): the times in the stamp column. Times are read at a
  glance across a room, so they stay dark rather than grey.
- **Rule** (#2A2A2A, `--cs-rule`): every 1.5px line — the sheet grid, the row rules, the
  time column's edge. Ruled a shade softer than the ink it frames so the numbers stay first.
- **Hatch** (rgb(17 17 17 / 0.42), `--cs-hatch`): the diagonal pen strokes filling a match
  slot. The lighter `rgb(17 17 17 / 0.28)` and `rgb(17 17 17 / 0.34)` steps exist for the
  fine-line and dense patterns only.
- **Muted Ink** (#5B656C, `--muted-foreground`): header nav at rest, and the old time once it
  is struck through. The strike is deliberate — `court-sheets.css` records that the struck
  time still reads at 4.5:1 on the wall and 6:1 on the sheet.
- **App Ink** (#171A1D, `--foreground`): the wordmark, and a nav link on hover.
- **Raised Black** (#2B2B2B): the one action's hover fill.

### Named Rules
**The Wall-First Rule.** The page ground is `--background` and the sheets are `--surface`.
Never introduce a landing-only paper, cream or tinted ground: the board has to look like it
was pinned to the same wall the app runs on.

**The One Navy Rule.** Navy is the mark and the focus ring, and nothing else. Links, borders,
titles and the primary action are ink; if a landing element wants to look interactive by
being navy, it is wrong — the action is dark and a link is underlined ink.

**The Highlighter Rule.** Magenta is a mark drawn on a picture of paper, never a state. It
may ring the clash and ink the time that moved; it may not colour a button, a label, an icon
or anything a visitor can press. The app has no magenta, and this page keeps it that way.

**The Blind-Proof Rule.** Nothing is carried by hue alone: the time that moved is also bold
and the old time is also struck through, and the clash is also the only note with a ring.

## Typography

**Display Font:** Roboto Condensed (variable, self-hosted from `public/fonts/`, with Arial
Narrow fallback) — court names only, in condensed small caps.
**Body Font:** Instrument Sans (Google Fonts, 400–700, with `ui-sans-serif`) — the wordmark,
nav, headline, subhead, the clash note and the action.
**Mono Font:** JetBrains Mono (Google Fonts, 500/700, with `ui-monospace`) — the clock times
in the sheets, and nowhere else.

**Character:** Two voices, as on a real board. The condensed face prints the sheet's fixed
label — which court this is — in small tracked caps, and the mono face prints the times in a
column whose digits line up. Everything the visitor reads as a sentence, or presses, is
Instrument Sans. Roboto Condensed and Saira are served by the app; Instrument Sans and
JetBrains Mono come from Google Fonts with `display=swap`, so a cold venue connection draws
the page in fallback faces rather than nothing.

### Hierarchy
- **Headline** (Instrument Sans 600, `clamp(2rem, 5.2vw, 3.5rem)`, 1.04, −0.03em,
  `text-wrap: balance`): the promise under the board, two lines, centred. It is the page's h1
  and the only large type on it.
- **Subhead** (Instrument Sans 500, `clamp(1.125rem, 2.2vw, 1.5rem)`, −0.01em): one line of
  plain explanation below the actions.
- **Wordmark** (Instrument Sans 600, 1.125rem, −0.02em): Tournova beside the mark (1.25rem,
  Tournova Navy), at the app header's size.
- **Sheet title** (Roboto Condensed 600, 0.9375rem, 0.06em tracking, uppercase): "Court 1" to
  "Court 6", printed on the sheet's top edge in a slightly smaller face than the times it
  governs.
- **Time** (JetBrains Mono 400, 0.75rem, tabular figures): the stamp column, one row per
  slot. Tabular figures are the point — the column reads as a column, and a struck old time
  sits level with the new one after it.
- **Clash note / shift** (Instrument Sans 600, 1rem / 0.875rem): the circled sentence and the
  "+12 min" that follows it.
- **Nav** (Instrument Sans 500, 0.875rem): Browse tournaments and Sign in, plain links.
- **Action / Link** (Instrument Sans 500, 1rem): the one button's label, and the follow link.

### Named Rules
**The Clock Is Mono Rule.** A time on this page is JetBrains Mono with tabular figures. Never
set a time in the body face, and never set anything else in the mono face — its use here is a
deliberate exception the app does not extend to product UI.

**The Board Is Not Set In Display Rule.** Roboto Condensed is on this page for court names
only. The headline, the note, the times' neighbours and every control are Instrument Sans;
the marketing voice is never condensed.

**The Struck Time Rule.** When a slot moves, the old time stays and is struck through, and the
new time is bold magenta after it. Replacing the old time, fading it out, or showing only the
new one deletes the evidence that the day kept up.

## Layout

The page is a wall: a header row, a centred hero holding the board, then the headline, the one
action and a line of explanation. The header keeps the app header's own measure — max
1400px, 0.75rem by 1rem padding rising to 1rem from 640px — so the brand does not shift
between the landing and the app. The hero is max 1200px, centred, with 1.5rem by 1rem by
4rem padding, opening to 2rem by 1.5rem by 5rem from 640px.

The board is one CSS grid of six sheets plus the clash, and it lays out in three steps:

- **Phones (below 640px):** two sheets across (courts 1 and 2), the clash on its own row, then
  court 6 on a third row at `min(100%, 15rem)`. Courts 3, 4 and 5 are not drawn: three sheets
  already make the point at this width, and a fourth would push the headline off the first
  screen. Gaps are 1rem by 0.75rem.
- **Tablets (640px to 959px):** six columns; courts 1, 2 and 3 sit across the first row, and
  the second row is split in half — the clash on the left, court 6 on the right. Gaps of
  1.25rem.
- **Laptops and walls (from 960px):** twelve columns, no row gap and 1.75rem columns. Courts
  1–4 hang across the top row; court 5, the clash and court 6 hang on the second row, each
  nudged up by a different amount (−1.5rem, −0.5rem, −0.25rem) so the pins do not read as a
  second row of a table.

Inside a sheet, the grid is two columns: an `auto` stamp column and a `1fr` match column, both
ruled 1.5px. The sheet draws only its top and right rule and the neighbour supplies the others,
so two sheets meeting never print a double line. Rows are `1.75rem` high, the same as the
hatch's row rhythm, so the pen strokes of the match column land on the rules of the stamp
column in every sheet.

Spacing rhythm: 0.25rem, 0.5rem, 0.625rem, 0.875rem, 1rem, 1.75rem, 2rem. The headline sits
2.75rem under the board on phones (1.5rem from 960px), the actions 1.75rem below it, and the
subhead 3rem below those. Every link, nav item and the action keeps a 44px target (48px for
the action) at every width.

### Named Rules
**The Pinned Rule.** A sheet is pinned, never placed: each carries its own tilt between −2.2
and 2.4 degrees, its own lift, and a paper shadow. No two sheets share an angle, and nothing
except a sheet and the circled note is allowed to be askew.

**The Rows Meet Rule.** The sheet rule, the row height (1.75rem) and the hatch's row rhythm are
one measurement. If the row height changes, every hatch pattern changes with it, or the board
stops looking drawn by hand on ruled stock.

## Elevation & Depth

Depth is physical: paper lying on a wall, not surfaces floating over a background. A sheet at
rest casts a soft three-layer shadow just wide enough to lift its edge off the grey; on hover
it rises 4px and the shadow deepens. The circled clash note gets one magenta-tinted shadow so
the mark reads as ink pressed hard enough to bruise the paper. Nothing else on the page has a
shadow — no header, no button, no text.

### Shadow Vocabulary
- **Sheet at rest** (`0 1px 0 rgb(0 0 0 / 0.04), 0 8px 18px -6px rgb(0 0 0 / 0.18), 0 2px 4px rgb(0 0 0 / 0.06)`):
  every court sheet, under its tilt and lift.
- **Sheet lifted** (`0 1px 0 rgb(0 0 0 / 0.04), 0 16px 28px -10px rgb(0 0 0 / 0.24), 0 3px 6px rgb(0 0 0 / 0.07)`):
  the same sheet 4px higher on hover.
- **Marked note** (`0 6px 16px -8px rgb(216 27 138 / 0.4)`): the clash note only, tinted by the
  highlighter.

### Named Rules
**The Paper-Lift Rule.** Elevation exists only where paper lifts off the wall. No shadow on
the header, the button, the headline or any CSS-drawn line, and no shadow that is not tied to
a sheet or to the circled note.

## Shapes

Card stock, straight rules and one drawn mark. Sheets are 3px-rounded at the corners (the
paper's own give, not a UI pill); the internal grid is square, drawn with 1.5px Rule strokes
and joined so no side doubles. Hatch fills are repeating linear gradients at three angles —
diagonal −55°, fine −45°, and a cross hatch at ±45° — in four patterns across the six sheets
(diagonal, fine, cross twice, dense twice), each with its own spacing and stroke weight, so
neighbouring sheets never repeat a stroke. The match column also carries a row rhythm drawn as
a repeating gradient, which is what makes the slots read as slots.

The clash is the page's one drawn gesture: a 2.5px magenta rectangle ringing a white note, a
"+12 min" beside it, and a hand-drawn arrow — a curved SVG path with a separate head, 48 by 20,
2px stroke, round caps — pointing at the sheet that moved. On a phone the arrow turns 90° and
points down, because the sheet is then below.

The one action is a 2px-rounded dark block; the follow link is text with a 1.5px underline 5px
under it, thickening to 2.5px on hover. There are no icons on the page except that arrow.

### Named Rules
**The Ruled-Form Rule.** If the board prints a line, it is a 1.5px Rule stroke, square, and
shared with its neighbour rather than doubled. Rounded corners belong to the paper, not to
anything printed on it.

**The Drawn-Mark Rule.** The circle and the arrow are the only two marks that are not type or
rules, and both must look drawn: a 2.5px ring and a two-path SVG arrow. Never replace them
with a chip, a badge, an icon font or a clip-path.

## Components

### Header
- **Shape:** one row, the app header's: mark plus wordmark left, plain links right, 1400px max,
  44px targets.
- **Brand:** the TournovaMark at 20px in Tournova Navy, then "Tournova" in Instrument Sans 600
  1.125rem at App Ink.
- **Nav:** Browse tournaments and Sign in in Instrument Sans 500 0.875rem, Muted Ink at rest,
  App Ink plus a 1.5px underline at 4px offset on hover (150ms colour transition), 0.625rem of
  side padding each.
- **Mobile:** below 420px the label shortens to "Browse" while the full label stays in the
  accessibility tree, the same breakpoint and the same short word as the app header.
- **Focus:** the shared 2px navy outline at 3px offset.

### Court sheet (signature)
The page's unit and its whole argument: a white sheet, tilted and pinned, holding a court's
day.
- **Shape:** 3px radius, 0.875rem padding (1rem at the foot), the shadow from Elevation, tilt
  and lift from the Pinned Rule.
- **Title:** "Court N" in Roboto Condensed 600 uppercase 0.9375rem, 0.06em tracked, above the
  grid.
- **Grid:** stamp column plus hatched match column, 1.5px Rule strokes, 1.75rem rows.
- **Hover:** rises 4px with a 220ms `cubic-bezier(0.2, 0.7, 0.2, 1)` transform and a 220ms
  shadow ease. The sheet is an illustration, not a control: hovering it does not open
  anything.

### Stamp column and time rows
- **Style:** JetBrains Mono 0.75rem tabular figures in Soft Ink, one 1.75rem row per slot,
  0.625rem right padding, 1.5px rules below each.
- **Moved slot:** the old time is wrapped in `<s>` in Muted Ink; the new time follows it in bold
  Highlighter Magenta. Both sit on the same row, so the change reads as a correction on a
  printed sheet.
- **Why struck:** the row is 12px type, and the strike is the second channel that carries
  "this moved" when the colour does not.

### Match column (hatch)
- **Style:** a grid of repeating row rules (1.5px every 1.75rem) under one of four hand-hatch
  patterns: diagonal, cross, fine lines or dense — each court keeps its own.
- **Rule:** the pattern belongs to the court, not to a match state. It is decoration that says
  "this slot is taken", and it never encodes a status.

### Clash note and shift (signature)
- **Shape:** white note, 2.5px Highlighter Magenta ring, 0.75rem by 1.125rem padding, the marked
  note shadow, no radius beyond the paper's 3px.
- **Text:** "Rest clash: L. Tran plays 11:10 and 11:22" in Instrument Sans 600 1rem, Pen Black.
- **Shift:** "+12 min" in Instrument Sans 600 0.875rem beside the note, then the drawn arrow.
- **Layout:** note and shift sit centred side by side with 0.5rem between them; below 640px the
  pair stacks and the arrow rotates 90°.
- **One per page:** exactly one clash is circled. A second circle would turn the promise into a
  feature list.

### Primary action
- **Shape:** Pen Black block, 2px radius, 48px high, 1.5rem side padding, label in Instrument
  Sans 500 1rem, Sheet White.
- **Behaviour:** a real `<button type="submit">` inside a plain `<form method="get">` to
  `/tournaments/new`, so the create flow is reachable before the page's script has loaded.
- **Hover / Active:** fill to Raised Black over 160ms; on press the block drops 1px.
- **Focus:** the shared navy outline. There is one primary action, and it is not navy: navy on
  this page is the brand, and a dark block is what a person would print.

### Follow link
- **Style:** Instrument Sans 500 1rem in Pen Black, underlined at 1.5px with a 5px offset,
  thickening to 2.5px on hover, 44px target. No arrow, no navy.
- **Pairing:** it sits beside the action, 2.25rem away, so following a tournament reads as the
  secondary road it is.

### Headline and subhead
- **Headline:** two lines, centred, `text-wrap: balance`, an h1 inside the hero's labelled
  `<section>`.
- **Subhead:** "When a match runs late, the rest of the day keeps up." in Instrument Sans 500,
  muted at the clamp above, 3rem under the actions.

## Do's and Don'ts

### Do:
- **Do** build the page from the app's tokens — `--background` wall, `--surface` sheet,
  `--foreground` ink, `--primary` mark and focus — and keep the `--cs-*` names local to
  `src/components/landing/court-sheets.css`.
- **Do** reuse the app header's mark, wordmark, nav labels, 44px targets and the 420px short
  label; the landing header is that header, not a version of it.
- **Do** pin every sheet with its own tilt, lift and shadow, and let the sheets on the second
  row sit at different heights.
- **Do** strike the old time and print the new one in magenta bold on the same row.
- **Do** keep exactly one circled clash, and let the sheet it touches already show the moved
  time.
- **Do** print court names in Roboto Condensed small caps and times in JetBrains Mono tabular
  figures; set everything else in Instrument Sans.
- **Do** give the board a `role="img"` with a label that states the six sheets and the clash,
  so a screen reader gets the same argument as the picture.
- **Do** run the arrival motion — sheets pinning in 60ms steps, then the circle — only under
  `prefers-reduced-motion: no-preference`, and keep the shared 2px navy focus outline.

### Don't:
- **Don't** invent a landing palette. No cream, no paper tint, no second grey: the wall is
  `--background` and the sheet is `--surface`.
- **Don't** use navy for links, borders, titles or the action; navy is the mark and the focus
  ring here.
- **Don't** use magenta on anything a visitor can press, or as a badge/chip/status colour.
- **Don't** set times in the body face or set anything but times in the mono face.
- **Don't** let the hatch encode state, and don't vary its density to mean anything other than
  which court's sheet it is.
- **Don't** replace the circle, the shift or the arrow with an icon, a pill, a tooltip or a
  badge; the marks are drawn, not componentised.
- **Don't** add a second primary action, or a nav item whose page does not exist yet.
- **Don't** let any sheet, note or header grow a shadow that is not in the Shadow Vocabulary.

### Honest exceptions
These differ from `docs/design-principles.md` on purpose and stay on this page:
- **JetBrains Mono is used for the clock times**, although product UI never uses `font-mono`.
  A board's times are set in a mono face; the product's own numbers use Saira and Instrument
  Sans.
- **Magenta exists only here.** The app has green (live), amber (overrun) and red
  (destructive); this page adds a highlighter hue because the circle is a mark on paper rather
  than a state the app reports.
- **The primary action is dark, not navy.** The app's primary button is navy; the landing's one
  action is a printed black block, because on this page navy belongs to the brand mark.
- **Sheets are 3px-rounded** while the app's own surfaces round at up to 1rem (`--radius`);
  card stock has a corner, a UI surface has a curve.
- **Selection is ink on the wall** (`::selection` inverts pen and paper) rather than the app's
  navy selection, so the page's one navy stays the mark.
- `court-sheets.css` restates the mono stack as `--cs-mono` instead of reading `--font-mono`.
  The stacks are identical today; the duplicate exists so the landing's type cannot change
  under the product's token.
