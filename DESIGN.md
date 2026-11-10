---
name: Tournova landing (The Match Call)
description: The Watch-mode front door of Tournova, drawn as a match-call slip in src/components/landing/; brand, interaction, UI type and the shared condensed faces are inherited from the app's tokens in src/styles.css.
colors:
  primary: "#22397A"
  primary-hover: "#1A2C5E"
  foreground: "#171A1D"
  slip-blue: "#22397a"
  slip-rule: "#2f4673"
  slip-paper: "#f7f7f6"
  slip-ink: "#0b0b0b"
  muted-foreground: "#5B656C"
  slip-pink-stock: "#faacbe"
typography:
  wordmark:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.02em"
  numerals:
    fontFamily: "Saira Extra Condensed, Roboto Condensed, Arial Narrow, sans-serif"
    fontSize: "6.6rem"
    fontWeight: 800
    lineHeight: 0.82
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "League Gothic, Arial Narrow, sans-serif"
    fontSize: "clamp(3.4rem, 1.2rem + 11cqw, 5.75rem)"
    fontWeight: 400
    lineHeight: 0.9
    letterSpacing: "-0.005em"
  value:
    fontFamily: "Roboto Condensed, Arial Narrow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.45rem, 0.6rem + 4.5cqw, 1.9rem)"
    fontWeight: 700
    lineHeight: 1
    fontFeature: "tnum"
  action:
    fontFamily: "Roboto Condensed, Arial Narrow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.01em"
  copy-heading:
    fontFamily: "Roboto Condensed, Arial Narrow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 700
    lineHeight: 1.15
  print:
    fontFamily: "Roboto Condensed, Arial Narrow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.25
  label:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.2
  nav:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
  link:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
  input:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
rounded:
  none: "0"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  gutter: "1rem"
  row: "1.25rem"
  inset-wide: "2rem"
components:
  button-call:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    typography: "{typography.action}"
    rounded: "{rounded.none}"
    padding: "0 1.25rem"
    height: "52px"
  button-call-hover:
    textColor: "{colors.primary-hover}"
  input-name:
    backgroundColor: "transparent"
    textColor: "{colors.slip-ink}"
    typography: "{typography.input}"
    rounded: "{rounded.none}"
    padding: "0 0.9rem"
    height: "48px"
  nav-link:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.nav}"
    height: "44px"
  nav-link-hover:
    textColor: "{colors.foreground}"
  follow-link:
    textColor: "{colors.primary}"
    typography: "{typography.link}"
    height: "44px"
  field-label:
    textColor: "{colors.slip-blue}"
    typography: "{typography.label}"
  call-number:
    textColor: "{colors.slip-ink}"
    typography: "{typography.numerals}"
    rounded: "{rounded.none}"
    padding: "0.4rem 0.75rem 0.5rem"
---

# Design System: Tournova landing (The Match Call)

## Overview

**Creative North Star: "The Match Call"**

The landing is the Watch-mode front door of the same Tournova system described in `docs/design-principles.md`, not a separate product. Its slip world (paper, tears, stamps, the League Gothic headline and the `--slip-*` print tokens) lives in `src/components/landing/`, styled by `src/components/landing/call-slip.css`. Everything else is inherited from the app's tokens in `src/styles.css`: the TournovaMark and the Roboto Condensed wordmark, the header nav labels (Sign in stays a plain nav link, by the user's choice), Instrument Sans for labels, fields and links, the app's condensed faces for printed values and the call number, and the app's navy (`--primary`) as the signal of interaction: the stamped action, body links, focus, selection and caret. The app's navy was taken from the slip's own ballpoint print, so the page and the product share one ink. A visitor who signs in should feel they walked through a door, not into another company.

The page is one match-call slip torn off a tournament desk pad. White carbonless paper with a faint grain, ballpoint-navy form rules and labels, black condensed numerals and headline at billboard scale, and a red rubber CALLED stamp. The copies underneath (canary, then pink) peek out below a torn edge and carry the next calls. The slip reads like a filled-in form rather than a marketing layout: every element is a printed field, a filled value, a stamp, a sheet, or one of the app's own controls set on the paper.

Density is low and the scale contrast is extreme. A giant boxed number and a two-line gothic headline sit next to small, precise form labels. Paper materials (grain, tears, stamp ink, the copies' edge shading, the action's rough frame) live in raster plates; everything drawn in CSS is flat and ruled.

**Key Characteristics:**
- Carbonless-paper ground with a tiled grain plate; no cream or aged tone.
- One navy for the whole product: the app's interaction colour and the slip's ballpoint print are the same ink.
- On the slip, navy acts on the mark, stamped action, follow link, focus, selection and caret; printed labels and rules are navy but never act.
- The app's mark, wordmark, nav labels, Instrument Sans, Roboto Condensed and Saira carry over; only League Gothic is the landing's alone.
- Red appears only inside the CALLED stamp raster.
- Torn edges, stamps and the copies are raster plates, used as images or as masks.
- One authored motion: the stamp presses down once.

## Colors

A white-paper palette with one navy ink shared by print and interaction, red only as the picture of a stamp, and canary and pink as paper stock.

### Primary
- **Tournova Navy** (primary, through `--slip-action`): the TournovaMark, the stamped action's label and frame, the follow link, the focus outline, text selection and the input caret. It is the app's `--primary` (also `--primary-ink` and `--ring`), aliased, never redefined on the landing.
- **Pressed Navy** (primary-hover, through `--slip-action-hover`): the stamped action on hover; the frame follows because it is inked in `currentColor`.

### Secondary
- **Ballpoint Navy** (slip-blue): printed form labels (No., Court, Time, Match call, Tournament name). It holds the same value as `--primary` because the app's navy was taken from it; the two stay named apart, so retuning interaction cannot silently re-ink the printed form, and print never takes on the hover or focus states.
- **Form-Rule Navy** (slip-rule): the 1.5px rules under labels, around the number box, around the name field and across the slip. Slightly greyer than the label navy so rules recede behind text.

### Tertiary
- **Pink Stock** (slip-pink-stock): the base of the pink sheet that fills the page below the slip, multiplied with the paper grain so it meets the pink in the copies plate. The canary copy and the stamp's red exist only inside their plates; no CSS-drawn element is red.

### Neutral
- **Carbonless White** (slip-paper): the page ground, under the tiled paper grain; also the selection text colour.
- **Carbon Black** (slip-ink): numerals, headline, filled values, copy print, input text.
- **App Ink** (foreground): the wordmark, and a nav link on hover or when it is the open page, as in the app header.
- **Muted Ink** (muted-foreground): header nav links at rest, Sign in included, as in the app header.

### Named Rules
**The One Navy Rule.** Print and interaction share one navy. What tells them apart is form, not hue: an interactive thing is a stamped frame, a link with an arrow, a focus outline or a selection; print is a small sentence-case label or a ruled line, and it never changes on hover or focus.

**The Print Never Acts Rule.** A navy label or rule is never clickable and never stands in for a control; the header nav, Sign in included, keeps the app header's neutral treatment (Muted Ink at rest, App Ink on hover) and turns navy only for focus.

**The Copies Are Stock Rule.** Canary and pink are paper stock, not accents. They appear as sheets under the slip (plate or pink fill), never as text, buttons or highlights. What is printed on a copy belongs to that sheet: in the landscape composition the copy heading's second line runs into the canary's torn edge and is cut along the tear by the canary mask, as a real carbon copy would be.

## Typography

**Brand and Title Font:** Roboto Condensed (`--font-display`, variable, with Arial Narrow fallback), on the slip for filled-in values, player names, the action label and copy lines (`--slip-form`)
**Numeral Font:** Saira Extra Condensed 800 (`--font-numeral`, through `--slip-number`), for the call number
**UI Font:** Instrument Sans (`--font-body`, through `--slip-ui`), for the wordmark, labels, nav, the name input and the follow link
**Headline Font:** League Gothic (`--slip-numerals`, with Arial Narrow fallback), the landing's alone

**Character:** The app's families carry everything the visitor reads as interface, so the header and form feel like Tournova, and the app's condensed title and numeral faces print the slip's values and number. League Gothic alone shouts the promise at poster scale. League Gothic, Roboto Condensed and Saira are self-hosted so the first viewport draws in its own lettering on venue wifi.

### Hierarchy
- **Numerals** (Saira Extra Condensed 800, 6.6rem phones, 9.5rem tablets, 25.6cqw landscape, line-height 0.82, 0.75 in landscape): the call number inside its ruled box. One per slip; its figures are proportional, so it is used only for a number standing alone.
- **Headline** (League Gothic 400, fluid clamp, line-height 0.9, balanced wrap): the promise printed as the slip's title, one line per sentence when width allows.
- **Wordmark** (Instrument Sans 600, 1.125rem, -0.02em): Tournova beside the mark (1.25rem tall, in Tournova Navy), at the app header's scale.
- **Value** (Roboto Condensed 700, fluid clamp, line-height 1, tabular figures, never wraps): a filled-in field value such as court and time; it shrinks on the narrowest phones instead of breaking "Court 4".
- **Action** (Roboto Condensed 700, 1.375rem on phones and tablets, clamp(1.375rem, 2.65cqw, 2.8rem) in landscape, never squeezed): the stamped action label.
- **Copy heading** (Roboto Condensed 700, 1.35rem on phones, clamp(1.0625rem, 2.15cqw, 2.25rem) in landscape, line-height 1.15, 1.12 in landscape): the line printed on the next copy.
- **Print** (Roboto Condensed 500, 1rem, clamp(1rem, 1.7cqw, 1.8rem) in landscape, line-height 1.25): player names. Copy lines use the same face at 700 with tabular figures (1.1rem on phones, clamp(1rem, 2.05cqw, 2.15rem) in landscape), and the following number at 700 (1.1rem on phones, clamp(1rem, 2.2cqw, 2.3rem) in landscape).
- **Link** (Instrument Sans 600, 1rem, clamp(1rem, 1.6cqw, 1.7rem) in landscape): the follow link.
- **Input** (Instrument Sans 500, 1rem, clamp(1rem, 1.5cqw, 1.6rem) in landscape): what the visitor types into the name field.
- **Nav** (Instrument Sans 500, 0.875rem): header items, Sign in included, as plain links in Muted Ink.
- **Label** (Instrument Sans 500, 0.875rem on phones and tablets, clamp(0.875rem, 1.64cqw, 1.72rem) in landscape and clamp(0.875rem, 1.5cqw, 1.6rem) for the name label, line-height 1.2, Ballpoint Navy, sentence case): printed form labels.

In the landscape composition the slip is one printed form: everything inside it is sized in container-query units in the comp's proportions to its neighbours, set about 15% under the 1280x720 comp, with rem floors at the app's sizes and rem caps that stop growth near 1680px wide. The call number, headline, values, stamp and plates scale uncapped with the sheet. Only the header above the tear stays near the app's scale. In `call-slip.css` the variable `--slip-numerals` holds League Gothic (the headline) and `--slip-number` holds the numeral face (the digits). Choose by role, not by variable name.

### Named Rules
**The Printed-Label Rule.** Labels are the form's own field names, in Ballpoint Navy sentence case Instrument Sans, sitting on a rule. They name the value beneath them; they never introduce a section or sell.

**The Fill-In Rule.** What the slip has already printed (times, courts, names, copy lines) is Roboto Condensed with tabular figures where digits align; the lone call number goes to Saira and the headline to League Gothic. What the visitor reads as interface or types is Instrument Sans.

**The One Form Rule.** The header above the tear is the app's header at the app's scale. Below it, the slip is one printed form whose parts keep their proportions to each other: labels, names, the field, the action, the follow link and the copy lines grow with the sheet alongside the number and headline, never below the app's sizes and capped for very wide screens, so no part of the form is set at a different scale from the rest.

**The Poster Face Rule.** League Gothic never leaves `src/components/landing/`, and the landing never sets its interface in any condensed face.

## Layout

The slip is a single container (`inline-size` container query) over a full-height page. Gutters are 1rem on phones and 2rem from 640px. The pink sheet continues below the slip to fill the viewport, inset to match the pink copy in the plate.

- **Phones (below 640px):** reading order on a two-column grid. Header wraps, wordmark above the nav row; below 23rem "Browse tournaments" shortens to "Browse", the same breakpoint and short label as the app header. Number box left, fields right in two columns (Match call spans both), the stamp right-aligned below, then the headline, a top-ruled form block (label, field, action stacked), the follow link and the copies band (13.5rem tall, bleeding to both edges).
- **Tablets (640px to 959px, and any portrait width from 640px):** number box and a three-column field row share the first grid row; the stamp lands under the fields beside the number. The form becomes a two-column row (field, then action), the follow link below.
- **Landscape from 960px:** the slip holds a fixed 16:9 frame (56.25cqw tall) and every element sits at its measured place in percent of a 1280x720 composition, so the whole form scales as one sheet; interface type inside it is capped near 1680px wide. The header is set near the app's size and centred in the strip above the tear. Two full-width navy rules divide the headline, the form row and the copies. This absolute composition belongs to this page; new landing sections use the grid rhythm above, not the percentages.

Spacing rhythm: 0.25rem, 0.5rem, 0.75rem, 1rem, 1.25rem, 2rem. Field grids use 0.9rem by 1rem gaps; the slip uses 1.25rem rows. Every link, nav item, field and button keeps the app's 44px minimum target at every width, the landscape composition included.

## Elevation & Depth

Flat surfaces, with depth only where one sheet of paper lies on another. The slip lies on the copies, which lie on the pink sheet; the overlap is shown by the torn edges and edge shading in the raster plates (top tear, copies plate) and by soft CSS shadows that trace those tears. The stamp's ink texture and the action frame's rough print are rasters too.

### Named Rules
**The Paper-Only Depth Rule.** Elevation exists only where one sheet lies on another, and every shadow follows a real torn edge: the top tear carries a soft `drop-shadow` of its own fibres, and each copy's tear casts a blurred neutral band (rgb(20 20 24 / 0.3), 4px / 0.3cqw drop, 3px / 0.25cqw blur) shaped by that sheet's own outline mask (`copies-slip-mask.png`, `copies-yellow-mask.png`: the outline nudged down minus itself). The canary's tear also shows a 2px white paper rim from the same mask. No `box-shadow` on any CSS-drawn box, and no shadow that does not trace a sheet.

## Shapes

The slip's printed matter is square (radius 0): the number box, the field rules, the name input. Structure is drawn with 1.5px Form-Rule Navy strokes, as open underlines for fields and closed boxes for the number and the input; in landscape the poster rules (number box, field underlines, slip dividers) scale to 0.12 to 0.16cqw while the name field keeps 1.5px. Irregular silhouettes (torn edges, the stamp's rough frame, the action's double-ruled frame) come only from rasters, either placed as images or applied as CSS masks and inked with a token colour.

**The Ruled-Form Rule.** If the slip prints it in CSS, it is a straight navy rule or a square ruled box. If it is torn, inked or rough, it is a plate.

## Components

### Buttons
Stamped, not filled: the primary action is navy ink printed inside a stamp frame on the paper.
- **Shape:** the double-ruled stamp frame comes from the cta-frame plate, used as a CSS mask stretched to the button and filled with `currentColor`; no CSS border or radius.
- **Primary:** transparent fill, Tournova Navy label and frame, label never wraps. Phones and tablets: 52px minimum height, 0 1.25rem padding. Landscape: the comp's box (30.47% by 11.94% of the slip).
- **Hover / Focus:** label and frame shift together to Pressed Navy (a 160ms ease-out colour transition when motion is allowed). Focus draws the shared 2px navy outline at 3px offset. On press the label drops 1px.
- **Sign in:** a plain nav link like Browse tournaments: Instrument Sans 500, Muted Ink, App Ink and an underline on hover, the shared navy focus outline.
- There is one primary action per slip; secondary actions are links.

### Inputs / Fields
- **Style:** a square 1.5px Form-Rule Navy box at every width, transparent over the paper, 0.9rem inline padding, Carbon Black Instrument Sans 500, navy caret; 48px minimum height on phones and tablets, and in landscape the comp's box (36.48% wide, max(2.75rem, 7.22%) tall). The label sits above it as a printed form label.
- **Focus:** the 2px navy outline drawn flush (offset 0) so it reads as the box's own edge thickening.

### Navigation
- **Style:** the app header's mark, labels and short-label breakpoint. Left: the TournovaMark in Tournova Navy (1.25rem tall) beside the Instrument Sans wordmark in App Ink. Right: "Browse tournaments" and Sign in, in Instrument Sans 500, Muted Ink, each with a 44px minimum target. There is no placeholder item: a section is added to the nav when its page exists.
- **Hover:** App Ink and a 1.5px underline at 4px offset (a 150ms colour transition).
- **Mobile:** the header wraps, wordmark above the nav row; "Browse" replaces the full label below 23rem.

### Follow link
Tournova Navy Instrument Sans 600 (sizes under Typography) with an inline arrow, 44px minimum target; on hover it underlines like the nav, and when motion is allowed the arrow slides 0.2em right (220ms, ease-out-expo).

### Call number box (signature)
A square 1.5px ruled box holding a small navy "No." label and the call number in Saira Extra Condensed at billboard scale. It is the slip's anchor and appears once.

### Ruled field (signature)
Navy label on a 1.5px rule, value or names below. Values are Roboto Condensed 700 with tabular figures; player names drop to 500.

### Stamp
The CALLED status is a raster stamp (stamp plate) placed on the slip from the first frame. When motion is allowed it presses once: 620ms, 350ms delay, from slightly large, rotated and blurred to settled. This is the only authored entrance motion; with reduced motion the stamp is simply there.

### Copies band
The canary and pink copies are a single raster plate under the slip's bottom tear. Text printed on the canary copy (the next call line and a short heading) is Roboto Condensed 700 in Carbon Black, confined by a mask of the canary sheet's own outline (copies-yellow-mask plate), so where a line runs into the torn edge it is cut along the tear rather than by a straight box edge. In the landscape composition the heading's second line is deliberately cut this way. The following number sits on the pink copy.

## Do's and Don'ts

### Do:
- **Do** keep the slip world (plates, League Gothic, `--slip-*` print tokens) inside `src/components/landing/`, and take brand, interaction, UI type and the condensed faces from the app's tokens in `src/styles.css`.
- **Do** use the app's navy (`--primary`, aliased as `--slip-action`) for the primary action, body links, focus, selection and caret; header nav and Sign in stay Muted Ink at rest.
- **Do** make interaction legible by form when it shares the print's navy: a stamped frame, an arrowed link, an outline.
- **Do** reuse the app header's mark, wordmark, nav labels and short-label breakpoint rather than drawing landing versions; Sign in is a plain nav link here.
- **Do** draw the slip's structure with 1.5px Form-Rule Navy rules and square boxes (radius 0).
- **Do** put labels in Ballpoint Navy sentence case Instrument Sans directly above the rule they name.
- **Do** render paper (grain, tears, copies, stamp ink, the action frame) as raster plates, placed as images or applied as masks, and self-host every face.
- **Do** keep the header at the app's scale and let the slip below it scale as one form in the comp's proportions, never below the app's sizes or 44px targets and capped near 1680px wide; keep the shared 2px navy focus outline.
- **Do** respect reduced motion: the stamp press, the action's colour transition and the follow-arrow slide run only under `prefers-reduced-motion: no-preference`.

### Don't:
- **Don't** apply `--slip-*` tokens, League Gothic or the paper plates to Desk, Schedule, Explore or any product UI.
- **Don't** make a printed navy label or rule clickable, or give it hover or focus states.
- **Don't** make anything red that the visitor can act on; red is only the CALLED stamp, a picture of a rubber stamp rather than a state.
- **Don't** add `box-shadow` to CSS-drawn boxes, cast a shadow that does not trace a torn sheet, or round the slip's printed boxes; rough corners belong only to paper and stamp rasters.
- **Don't** use cream, aged or tinted paper for the slip; the ground is Carbonless White under grain.
- **Don't** use canary or pink as accent colours for text, buttons or highlights.
- **Don't** imitate torn edges or stamp texture with CSS gradients or clip-paths; roughness always comes from a plate.

### Honest exceptions
These differ from `docs/design-principles.md` on purpose and stay on this page:
- The slip's printed labels and rules are navy without being interactive, although navy means interaction in the app; they are a picture of a printed form, not controls.
- The CALLED stamp is red although product red means danger, because it is a picture of a rubber stamp rather than a state the app reports.
- The slip's square corners differ from the app's rounded cards.
- The name field is ruled in Form-Rule Navy rather than `--border-control`; it is the slip's printed box, and its contrast on the paper is higher than the app's control edge.
