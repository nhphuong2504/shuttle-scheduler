# Tournova design system

The system is a **cool neutral slate chassis with blue as the brand hue**. Hue is reserved
for state, brand action and destructive, so the chassis itself stays low chroma. There is no
warm earth palette and no terracotta, sage, indigo, mint or amber brand colour; those appear
only in deleted, superseded plans.

It lives in the repository so it travels with a clone: a fresh checkout carries its own design
authority. Where this document and the code disagree, the code is right and this document is
the bug.

## Audiences stay separate

This is product intent, and it is mandatory even though no test enforces it.

- A **moderator** works one court on one day in real time and is not shown tournament-wide
  forecasts.
- An **organiser** plans the tournament and is not shown desk-level operational noise.
- A **participant** is not an operator, and no surface presents participation or approval as
  authority.

## Where the system lives

| Concern | Source of truth |
| --- | --- |
| Colour, type, spacing, radii and elevation tokens | [`src/styles.css`](../src/styles.css) |
| Status vocabulary and tiers | [`src/lib/tournament/match-status.ts`](../src/lib/tournament/match-status.ts) |
| Court state vocabulary | [`src/lib/tournament/court-state.ts`](../src/lib/tournament/court-state.ts) |
| Shared components | [`src/components/app-shell.tsx`](../src/components/app-shell.tsx) |
| The last-resort document | [`src/lib/error-page.ts`](../src/lib/error-page.ts) |

## Colour tokens

All colour tokens are OKLCH and are defined in `:root`. Every colour utility resolves to a
`--color-*` key; there is no hex, no `rgb()` and no default Tailwind palette.

| Token | Value | Job |
| --- | --- | --- |
| `--background` | `oklch(0.975 0.004 250)` | The page |
| `--surface` | `oklch(1 0 0)` | Cards and panels |
| `--foreground` | `oklch(0.255 0.010 255)` | Body text |
| `--muted-foreground` | `oklch(0.505 0.009 252)` | Secondary text |
| `--primary` | `oklch(0.52 0.16 255)` | The brand action fill |
| `--primary-ink` | `oklch(0.52 0.16 255)` | Brand text on a `bg-primary/10` tint |
| `--success` | `oklch(0.44 0.072 190)` | Success fill |
| `--destructive` | `oklch(0.535 0.17 25)` | Destructive action and danger |
| `--border-control` | `oklch(0.643 0.008 250)` | Locates a control the user must find |
| `--border-selected` | `oklch(0.60 0.008 250)` | Marks a control as chosen |

`--accent` is **not** a brand colour. It is the shadcn convention name for the subtle hover
surface, and it stays neutral on purpose so a saturated fill does not appear in every
dropdown. Brand is `--primary`.

### Fill versus ink

**A fill colour and its text twin are separate tokens.** A colour light enough to sit *behind*
text is not usually dark enough to *be* text, and the two roles are solved against different
neighbours. `--primary` is a solid fill with `--primary-foreground` on it, while `--primary-ink`
is text on a `bg-primary/10` tint. When you introduce a new fill, check whether any text sits on
it; if so, it needs its own ink token. `--state-live-chip` / `--state-live-ink` is the pair done
properly, and the model the others follow.

### The three edge weights

Three border tokens exist and they are not interchangeable.

| Token | Job |
| --- | --- |
| `--hairline` (`--border`) | Separates and divides. Decorative, and exempt from WCAG 1.4.11 |
| `--border-control` (`--input`) | Locates a control the user must find. Solved against the page, at 3.09:1 |
| `--border-selected` | Marks a control as chosen. A selected state is state information, so it needs 3:1 |

**Its utility spells the word twice.** The colour key is already `--color-border-selected`, so
the edge is `border-border-selected` or `ring-border-selected`. A bare `border-selected` is not
a class Tailwind emits, so it is dropped from the build and the element keeps whatever edge it
inherited.

## Match states

The persisted statuses are exactly the five the `CHECK` constraints permit: `scheduled`,
`in-progress`, `reported`, `walkover`, `void`. Two are renamed for display, so the display
vocabulary is not the storage vocabulary: `in-progress` reads "Live" and `reported` reads
"Completed".

**Status is never colour alone.** Every state carries three redundant channels: a colour, a
distinct glyph and a text label. The hues mean one thing each.

- **Green** (`--state-live-*`) means live.
- **Teal** (`--success`) is the success hue, admitted deliberately so a positive tint cannot
  borrow the green that means live.
- **Red** (`--destructive`, `--danger-*`) means destructive or danger.
- **No state uses blue.** Blue is the brand accent, and a blue chip reads as a button.
- **Amber** is shared between warn callouts and the one warn state, which is flagged rather
  than hidden: a callout is page-level prose and a state is a row-level chip.

Match states are drawn through four tiers. Tier 1 is a saturated chip (`live`); tier 3 is a
neutral chip (`scheduled`, `void`); tier 4 is ink only, with no chip (`walkover`, `completed`),
because archive states recede by losing their container rather than by lightening their ink.
Tier 2 is deliberately vacant: its only members were states the database cannot produce, so
they were deleted rather than left implying a capability that does not exist.

**Byes are a draw condition, not a status.** The generator writes a bye as
`status: "reported"` with `note: "Bye"` and `is_bye: true`, so `bye` is vestigial and no display
table grows a `bye` entry. `isByeMatch()` accepts either signal, and `ByeMarker` renders it with
a dashed edge and the label "Bye". `isByeMatch` is for rendering only; the scheduler reads
`is_bye` directly.

## Court states

A court state is **derived and never stored**, and must not be conflated with a match status
(what happened to one match, persisted). The five states are `playing`, `overrun`, `free-ready`,
`free-blocked` and `idle`, derived by `deriveCourtState`.

The tile is a wash and the chip is the denser surface, in every state. That is what makes a chip
a *container* rather than text sitting on the card. `playing` reuses the match `live` tokens
rather than minting a second green, because the two encode the same fact from different vantage
points and never co-render.

## Typography and space

Tiers are named for the job the text does - glance, identify, support, reference - rather than
for a size. Choose a tier by what the text is doing. Apply tiers to text you are writing or
already changing; do not migrate Tailwind size classes in bulk, because a bulk rename changes no
pixel and records no judgement. The sizes live in `src/styles.css`.

Fonts are Plus Jakarta Sans for display and Inter for body and scores. Tabular numerals are
enforced on `table`, `input`, `time`, `td`, `th` and by the `font-score` utility, so scores,
timers and stats line up.

Radius derives from a single `--radius`. Elevation is two levels, `--elev-1` (`shadow-panel`)
and `--elev-2` (`shadow-raise`); both are tinted from `--ink` so shadows stay neutral.

## The last-resort document

[`src/lib/error-page.ts`](../src/lib/error-page.ts) is the response served when the application
itself failed to render. It is the **one place in `src/` that is not written against
`src/styles.css`**: it cannot link the stylesheet, because that is a build artifact the response
does not include. So it carries its own copy of the palette, under the same `--color-*` names,
and copies only the colours it paints with. Moving a token in the stylesheet means moving the
copy with it.
