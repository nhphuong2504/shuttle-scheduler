# Tournova design system

This document describes the design system **as shipped**. It is descriptive, not
prescriptive: where this document and the code disagree, the code is right and
this file is the thing to fix.

Two consequences worth stating up front, because they are the reason this file
exists at all:

- It records current behaviour, so it does not introduce design decisions. If a
  rule here cannot be pointed at in the code, treat it as a bug in this file.
- It lives in the repository so it travels with a clone. The design work was
  originally documented in a Cursor canvas outside the repo, which meant a fresh
  checkout had no design authority at all.

The system is a **cool neutral slate chassis with blue as the brand hue**. There
is no warm earth palette and no terracotta, sage, indigo, mint or amber brand
colour; those appear only in deleted, superseded plans. If you find a document
recommending them, it is stale.

## Where the system lives

| Concern | Source of truth |
| --- | --- |
| Colour, type, spacing, radii, elevation tokens | [`src/styles.css`](../src/styles.css) |
| Status vocabulary and tiers | [`src/lib/tournament/match-status.ts`](../src/lib/tournament/match-status.ts) |
| Court state vocabulary | [`src/lib/tournament/court-state.ts`](../src/lib/tournament/court-state.ts) |
| Theme resolution | [`src/lib/design/theme.ts`](../src/lib/design/theme.ts) |
| Shared components | [`src/components/app-shell.tsx`](../src/components/app-shell.tsx) |
| Pre-hydration appearance bootstrap | [`src/routes/__root.tsx`](../src/routes/__root.tsx) |
| The last-resort document | [`src/lib/error-page.ts`](../src/lib/error-page.ts) — carries its own copy of the palette; see [below](#the-last-resort-document) |

## Chassis

The chassis is deliberately low-chroma. Hue carries meaning, so it must not also
be decoration.

- Surfaces sit at hue 250-262 with chroma at or below 0.008. The neutral ramp runs
  from `--background` through `--surface` to `--card`.
- **Hierarchy is carried by lightness and weight**, not by hue or by borders. Cards
  are lighter than the page in dark mode and separated by a hairline in light mode.
- **Hue is reserved for state, brand action and destructive.** A view should show
  about three saturated elements: the brand action (`--primary`), the live state
  (`--state-live-*`), and a destructive action when one is present.
- `--accent` is **not** a brand colour. It is the shadcn convention name for the
  subtle hover surface, and it stays neutral on purpose (chroma 0.006-0.007) so a
  saturated fill does not appear in every dropdown and menu item. Brand is
  `--primary`.
- The page background is flat. There is no decorative gradient, because a gradient
  shifts the effective background under every measured contrast pair and makes
  ratios vary by scroll position.

### The three edge weights

Three border tokens exist and they are not interchangeable.

| Token | Job | Notes |
| --- | --- | --- |
| `--hairline` (`--border`) | Separates and divides | Decorative. Exempt from WCAG 1.4.11 |
| `--border-control` (`--input`) | Locates a control the user must find | Solved against the page, at 3.09:1 |
| `--border-selected` | Marks a control as chosen | Solved against the container *and* the segment fill |

`--border-control` is solved against the page rather than the card because inputs
sit on the page, and the page is the darker of the two, so it is the binding
constraint.

`--border-selected` exists because a selected state is state information, and
WCAG 1.4.11 requires state information to reach 3:1. Marking "selected" with a
fill that equals the surface colour on a muted container measures 1.09:1 in light
and 1.02:1 in dark, so the selected segment was not a shape at all. It is applied
as `ring-1 ring-border-selected` on active segmented-control buttons and tabs.

## Colour tokens

All colour tokens are OKLCH and are defined twice: once in `:root` for light and
once in `.dark` for dark. Every colour token must be defined in both blocks;
[`tokens.test.ts`](../src/lib/design/tokens.test.ts) enforces that parity, because
a token missing from `.dark` silently inherits its light value rather than failing.

Selected values, for reference:

| Token | Light | Dark |
| --- | --- | --- |
| `--background` | `oklch(0.975 0.004 250)` | `oklch(0.17 0.008 260)` |
| `--surface` | `oklch(1 0 0)` | `oklch(0.215 0.008 262)` |
| `--foreground` | `oklch(0.255 0.010 255)` | `oklch(0.95 0.005 255)` |
| `--muted-foreground` | `oklch(0.505 0.009 252)` | `oklch(0.633 0.009 252)` |
| `--primary` | `oklch(0.52 0.16 255)` | `oklch(0.635 0.16 255)` |
| `--primary-ink` | `oklch(0.52 0.16 255)` | `oklch(0.66 0.14 255)` |
| `--success` | `oklch(0.44 0.072 190)` | `oklch(0.72 0.09 190)` |
| `--destructive` | `oklch(0.535 0.17 25)` | `oklch(0.654 0.17 25)` |
| `--border-control` | `oklch(0.643 0.008 250)` | `oklch(0.513 0.008 250)` |
| `--border-selected` | `oklch(0.60 0.008 250)` | `oklch(0.60 0.008 250)` |

Blue stays blue in both themes: same hue family, lightened. There is no
hue swap between themes.

### Fill versus ink

The rule that has been applied most often, and the one most worth preserving:

> **A fill colour and its text twin are separate tokens.** A colour light enough
> to sit *behind* text is not usually dark enough to *be* text, and the two roles
> are solved against different neighbours.

Instances in the shipped system:

- `--primary` is a solid fill with `--primary-foreground` on it, **and** `--primary-ink`
  is text on a `bg-primary/10` tint. The dark `--primary` is lightened so it reads
  as a bright blue fill, and at that lightness it measured 4.37:1 as ink on a
  primary-tinted row - a marginal miss on the 4.5:1 that 14px semibold text needs.
  `--primary-ink` is a separate, brighter solved value.
- `--success` is a **fill only**. It is used as `bg-success/10` through `/50`. It is
  not text-safe in dark mode (2.95:1 on a card), so a text use would need an ink
  twin. Success fill and success ink are therefore semantically distinct things,
  and `--success` currently has no ink counterpart.
- `--state-live-chip` and `--state-live-ink` are the chip/ink pair done properly,
  and are the model the others follow.

When you introduce a new fill, check whether any text sits on it. If so, it needs
its own ink token.

## Match states

The persisted statuses are exactly the five the `CHECK` constraints permit:
`scheduled`, `in-progress`, `reported`, `walkover`, `void`. Two are renamed for
display, so the display vocabulary is not the storage vocabulary:

| Persisted | Display | Label | Tier |
| --- | --- | --- | --- |
| `scheduled` | `scheduled` | Scheduled | 3 |
| `in-progress` | `live` | Live | 1 |
| `reported` | `completed` | Completed | 4 |
| `walkover` | `walkover` | Walkover | 4 |
| `void` | `void` | Void | 3 |

### Tiers decide how a state is drawn

Tiers are the structural idea, and they are about treatment rather than colour:

| Tier | Treatment | Members |
| --- | --- | --- |
| 1 | Saturated chip | `live` |
| 2 | Shared amber | *(unoccupied)* |
| 3 | Neutral chip | `scheduled`, `void` |
| 4 | **No chip** - ink only | `walkover`, `completed` |

- **Tier 2 is deliberately vacant.** Its only members were `paused` and `called`,
  which the database cannot produce, so the states and their amber tokens were
  deleted rather than left implying a capability that does not exist. The amber
  hue survives where it is real: `--warn-surface` and its siblings.
- **Tier 4 has no chip token, by design.** `TIER4_DISPLAY_STATES` is derived from
  the tier map, so the two cannot disagree. A tier-4 state renders as inline text
  at `--state-completed-ink` with no fill, no border and no radius. Archive states
  recede by losing their container, not by lightening their ink - the lightest grey
  that still clears 4.5:1 on a surface is about L 0.55, so a lightened archive ink
  would be illegal.
- Both tier-4 members share one ink and stay distinguishable through label and
  glyph. `void` is tier 3 rather than tier 4 because it is an *exceptional* neutral:
  a filled chip reads as marked rather than as absent data.

### Status is never colour alone

Every state carries **three** redundant channels: a colour, a distinct glyph, and a
text label. This is not a nicety, it is load-bearing. The dark neutral ramp is
compressed enough that the void chip separates from the scheduled chip by only
7.2% of luminance, against 14.2% in light. In dark mode the chip's heavier ring,
its glyph and its label are what carry the distinction.

### Red and green mean one thing each

- **Green** (`--state-live-*`) means live.
- **Teal** (`--success`) is the success hue, admitted as a fourth hue deliberately.
  Green is reserved for live, so a positive tint cannot borrow it without green
  meaning live, done and selected at once. Teal sits about 40 degrees from live
  green and 65 from brand blue.
- **Red** (`--destructive`, `--danger-*`) means destructive or danger.
- **No state uses blue.** Blue is the brand accent, and a blue chip reads as a button.
- **Amber** is shared between the warn callouts and tier 2, which is flagged rather
  than hidden: a callout is page-level prose and a state is a row-level chip, and
  both carry a glyph.

### Byes are a draw condition, not a status

A bye is permitted by the schema on `draw_matches` and `tier_draw_matches` but is
written by nothing. The generator writes a bye as `status: "reported"`,
`note: "Bye"`, `is_bye: true`. So `bye` is **vestigial**, and:
- `VESTIGIAL_MATCH_STATUSES` names it so the distinction is recorded rather than
  rediscovered, and no display table grows a `bye` entry.
- `isByeMatch()` accepts **either** signal (`is_bye` or `note === "Bye"`), because
  both are really written and the app previously checked one or the other depending
  on the file.
- `ByeMarker` renders it with a **dashed edge** and the label "Bye". The dashed
  outline is already the app's vocabulary for "not a real thing", so it reads as
  provisional without colour and without inventing a sixth status.
- `isByeMatch` is for rendering only. It is deliberately not a scheduling predicate;
  the scheduler reads `is_bye` directly, and this must not become a second opinion.

## Court states

A court state is **derived and never stored**, and must not be conflated with a
match status:

| | Meaning | Persistence |
| --- | --- | --- |
| Match status | What happened to one match | Persisted, a closed schema set |
| Court state | What a court is doing right now | Derived, never stored |

The five states are `playing`, `overrun`, `free-ready`, `free-blocked`, `idle`,
derived by `deriveCourtState` in `desk.ts`. Each has a label, a chip and a tile
treatment:

| State | Label | Chip | Tile edge |
| --- | --- | --- | --- |
| `playing` | Playing | `bg-state-live-chip text-state-live-ink` | live ink at 35%, live chip at 30% |
| `overrun` | Overrun | `bg-danger-surface text-danger-foreground` | danger border, danger surface at 40% |
| `free-ready` | Ready | `bg-primary/10 text-primary-ink` | primary at 40%, primary at 5% |
| `free-blocked` | Waiting | `bg-warn-surface text-warn-foreground` | resting hairline |
| `idle` | Idle | `bg-muted text-muted-foreground` | resting hairline |

Three things about this table are deliberate:

- **The tile is a wash and the chip is the denser surface, in every state.** That is what
  makes a chip a *container* rather than text sitting on the card. `playing` was the one
  exception and it was a defect: its tile painted the full `--state-live-chip` - the same
  fill the chip paints - so the "Playing" pill had no edge at all. Measured on the rendered
  board the two were byte-identical in both themes (1.000:1, against 1.087:1 for the
  weakest other state), so the state a moderator reads most often was the one state drawn
  as bare text. `playing`'s tile is now a 30% wash of the chip, which is still far more
  tinted than `free-ready`'s 5%: the order of the wall is overrun, then playing, then
  ready, then the two neutrals that ask for nothing.
- **`playing` reuses the match `live` tokens** rather than minting a second green.
  The two encode the same fact from different vantage points, and they never
  co-render, so a separate green would be a distinction the reader can see but
  cannot use.
- **`free-ready` uses `bg-primary/10`, not `/12`.** `--primary-ink` was solved
  against `/10`; carrying a slightly darker tint put the pair at 4.41:1 in light
  mode, under the 4.5:1 that 14px needs. This chip only exists on a populated court
  board, which is why no scan had measured it. One ink pair per fill.

## Theme

Light and dark are both solved independently. There is no filter, no opacity flip
and no automatic inversion - each token is chosen for its own theme.

- Applied by putting `.dark` on `<html>`; the `dark:` variant is already wired to it.
- **`color-scheme` is part of the theme, not decoration.** Without it, scrollbars
  and native control interiors stay light and a correctly dark layout reads as
  half-finished.
- **A stored choice always wins.** There is no stored value meaning "follow the
  system" - that state is spelled by having nothing stored. The appearance control
  shows Light and Dark only and offers no way back to the system, so once a choice
  exists the system no longer has a say: the system governs a first visit and nothing
  after it.
- **Theme takes no pathname.** Its fallback is the operating system, not the route.
  Navigating to the Desk must never change the lighting. The absence of a
  `defaultThemeFor(pathname)` is the design, not an omission.
- Applied **before React runs** by a pre-hydration script in
  [`__root.tsx`](../src/routes/__root.tsx), so there is no flash and no hydration
  mismatch. The script is injected with the shared constant rather than restating it.

## Typography

Tiers are named for the **job** the text does, not for its size, so the scale can be
adjusted without any component changing its markup.

| Tier | Job | Examples | Size / line height |
| --- | --- | --- | --- |
| T1 Glance | Values read without scanning | match score, timer | 24 / 28 |
| T2 Identify | Things named while moving | court id, player names, status | 14 / 20 |
| T3 Read | Content read in sequence | body copy, form values | 14 / 20 |
| T4 Reference | Detail found on demand | timestamps, captions, hints | 12 / 16 |

Sizes in px; each tier emits font-size and line-height together as `text-tN`.

- **12px is the floor.** Nothing in the app may render below it. The legacy scale
  had 64 uses of 11px and 18 of 10px, which is the defect the scale exists to remove
  rather than a preference being expressed. Enforced statically and in the rendered
  DOM.
- **Fonts:** Plus Jakarta Sans for display (`--font-display`), Inter for body
  (`--font-body`) and scores (`--font-score`). All are loaded in
  [`__root.tsx`](../src/routes/__root.tsx).
- **Tabular numerals are enforced** on `table`, `input`, `time`, `td` and `th`, and
  by the `font-score` utility, so scores, timers and stats line up.
- `cn()` is built on an **extended `tailwind-merge`** whose config knows `text-tN` is
  a font-size group. Without that, `cn("text-t1", "text-muted-foreground")` would
  strip the size class and silently change the type scale.

## Radius, elevation and spacing

- Radius derives from a single `--radius: 0.875rem`, with `--radius-sm|md|lg|xl|2xl|3xl`
  computed around it. Prefer the derived tokens over literals.
- Elevation is two levels: `--elev-1` (`shadow-panel`) and `--elev-2` (`shadow-raise`).
  Both are tinted from `--ink`, which is theme-scoped, so shadows stay neutral and
  correct in both themes.
- The elevation tint source and the body text colour are separate tokens. They happen
  to share a value, but the roles differ.

## The last-resort document

[`src/lib/error-page.ts`](../src/lib/error-page.ts) is the response served when the application
itself failed to render. It is the **one place in `src/` that is not written against
`src/styles.css`**, and it is worth understanding why rather than rediscovering it.

It cannot link the stylesheet: that is a build artifact the response does not include, and a crash
page that depends on the thing that just crashed is not a crash page. So it is a standalone
document with its own `<style>`, and it carries **its own copy of the palette**, under the same
`--color-*` names. Three properties keep that copy from becoming a second source of truth:

- **It is a copy, not a palette.** It declares no colour the design system has not solved, and
  `tokens.test.ts` asserts that every value it declares is byte-identical to the corresponding
  token in `styles.css` for the theme it belongs to. Moving a token in the stylesheet therefore
  fails the suite until the copy moves with it, which is the only thing that makes a duplicated
  value safe here.
- **It follows the operating system, not a stored choice.** The stored choice lives in the
  application's own storage and is unreachable from a document that failed before the application
  ran. `prefers-color-scheme` is the documented fallback for a caller with nothing stored, so a
  dark venue gets a dark crash page rather than a white flash.
- **It uses the shipped type tiers** — T3 for prose, T1 for the heading — and a `system-ui` font
  stack, because a crash page must not wait on a network font to decide whether it has a layout.

Seven colours are copied: `background`, `foreground`, `surface`, `muted-foreground`,
`border-control`, `primary` and `primary-foreground`. Nothing is copied that the document does not
paint with.

## Components

Shared components and what they are for. All are exported from
[`app-shell.tsx`](../src/components/app-shell.tsx) unless noted.

| Component | Purpose |
| --- | --- |
| `WorkspaceShell` | One tournament's chrome, rendered once by [`tournaments/$tournamentId/route.tsx`](../src/routes/tournaments/$tournamentId/route.tsx): tournament name, lifecycle pill, section nav, appearance control, session block, and the shared read-only notice |
| `PublicShell` | The chrome for pages that are not about one tournament (sign-in today; Explore and the landing page next): brand, flat nav, appearance control, session block, title and subtitle |
| `Page` | One page inside a shell: its title row, then its content. `PageHeader` is the row it renders |
| `TournamentStatusPill` | A tournament's lifecycle word drawn through the match tiers: upcoming → tier 3 neutral chip, in progress → tier 1 live chip, completed → tier 4 ink only |
| `ReadOnlyNotice` | The one read-only treatment, shared by a signed-out visitor and a signed-in viewer |
| `Panel` | The standard bordered surface with an optional title bar |
| `StatTile` | One labelled number, with `normal` / `good` / `warn` / `danger` tones |
| `EmptyState` | Dashed-border placeholder for "nothing here yet" |
| `StatusPill` | Renders a persisted status through the tier rules |
| `ByeMarker` | Renders a bye as a draw condition |
| `MatchFormatCard` ([`match-format.tsx`](../src/components/match-format.tsx)) | Scoring, match length and rest gap per stage, in one card |
| `StageProgressList` ([`stage-progress.tsx`](../src/components/stage-progress.tsx)) | Format-agnostic stage progress rows |
| `ScheduledFinish` / `DayScheduleStatus` ([`schedule-status.tsx`](../src/components/schedule-status.tsx)) | Scheduled finish measured against the official close, and per-day status |
| `ConnectionBadge` ([`connection-badge.tsx`](../src/components/connection-badge.tsx)) | The live-connection readout, shared by the Desk and the Schedule page: four states, each with its own word, as a `role="status"` live region. It owns the clock that ages its own "last change" copy |

**The shell is split by audience, not by page.** `WorkspaceShell` mounts once per tournament
from the layout route, so the header and the nav survive a move between the pages under it,
and the tournament's own identity is stated by the chrome rather than by whichever page
happened to pass a title. `PublicShell` is for the pages that have no tournament to name.
A page renders `Page`, never a shell; `src/routes/-surfaces.test.ts` fails the suite if a
page starts drawing chrome of its own again. Match tiers and lifecycle tiers are one
vocabulary, which is why `TournamentStatusPill` reuses `--state-*` rather than minting a
second set of lifecycle colours.

`StatTile` carries a rule worth knowing: **a toned tile's label takes the tone's own
ink**, not `text-muted-foreground`. The neutral ink is solved against neutral
surfaces and cannot be expected to clear a tinted one. On the warning surface in dark
mode the neutral label measured 3.95:1 against the 4.5:1 that 12px needs. Each tone
already has an ink solved against its own surface, which is what `--warn-foreground`
and `--danger-foreground` are.

## Do and don't

**Do**

- Use a token. Every colour utility must resolve to a `--color-*` key.
- Use the type tiers. A component names the job (`text-t2`), and the scale decides the size.
- Give every state a glyph and a label as well as a colour.
- Use `bg-primary/10` for primary-tinted fills; it is the tint `--primary-ink` was solved against.
- Check a new fill for text sitting on it, and add an ink twin if there is any.
- Measure. Contrast claims in this system are numbers, and a plausible-looking value
  has been wrong more than once.

**Don't**

- Don't hardcode a colour, a hex, an `rgb()`, or an arbitrary `text-[13px]`. The single documented
  exception is the last-resort document, which cannot link the stylesheet and copies values that
  `tokens.test.ts` holds in lockstep with the palette — see
  [The last-resort document](#the-last-resort-document).
- Don't render text below 12px, and don't introduce a size off the tier scale.
- Don't convey status with colour alone.
- Don't give a tier-4 state a chip; tier 4 is ink only.
- Don't use a state hue for decoration, and don't introduce a new hue without solving
  it for both themes and checking it in grayscale.
- Don't use `--accent` as a brand colour.
- Don't reach for a blue chip for a state - blue means brand action.
- Don't make the theme resolve from the route; its fallback is the environment.

## The gates that enforce this

`npm run typecheck && npm run test && npm run test:e2e`

| Gate | Covers |
| --- | --- |
| [`tokens.test.ts`](../src/lib/design/tokens.test.ts) | Token references resolve; theme parity; tier-4 ink sharing; the 12px floor; the type scale is complete; dead tokens; every colour utility has a theme key; the crash document's palette copy stays identical to `styles.css` |
| [`status-pill.test.tsx`](../src/components/status-pill.test.tsx), [`stat-tile.test.tsx`](../src/components/stat-tile.test.tsx) | Component rendering per tier and per tone |
| [`-surfaces.test.ts`](../src/routes/-surfaces.test.ts) | Source-level guards on UI decisions that components cannot see |
| [`e2e/a11y.spec.ts`](../e2e/a11y.spec.ts) | Axe across every route in both themes, as a pinned baseline |
| [`e2e/states.spec.ts`](../e2e/states.spec.ts) | Every court state and urgency treatment, rendered with data in the app |
| [`e2e/criteria.spec.ts`](../e2e/criteria.spec.ts) | WCAG criteria Axe cannot see: 1.4.11, 1.4.10, 2.4.11, 2.3.3, 2.5.7 |
| [`e2e/theme.spec.ts`](../e2e/theme.spec.ts) | Precedence, persistence and pre-paint application |
| [`e2e/typography.spec.ts`](../e2e/typography.spec.ts), [`e2e/matrix.spec.ts`](../e2e/matrix.spec.ts) | The 12px floor in the rendered DOM, and contrast across the full matrix |
| [`e2e/hydration.spec.ts`](../e2e/hydration.spec.ts) | No route discards its server render |

Axe is a floor, not a verdict. It reads the DOM and the computed cascade and reliably
catches missing names, bad roles and resolvable contrast. It cannot judge whether a
focus order is logical, whether a label is understandable, or whether the hierarchy
communicates priority. Those belong to the manual checklist in
[`ux-review-checklist.md`](./ux-review-checklist.md).
