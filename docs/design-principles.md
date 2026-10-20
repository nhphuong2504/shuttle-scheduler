# Design principles

Guidance for colour, type and size. This is not a rulebook and no test pins it: the
accessibility specs (`e2e/a11y.spec.ts`, `criteria.spec.ts`, `matrix.spec.ts`,
`states.spec.ts`) are the only enforcement. Break a principle when a screen needs it, and say
why in the PR.

The values live in [`src/styles.css`](../src/styles.css). This file explains what they are for.

## Two modes

The app has two kinds of screen, and they should not feel like two products.

| | **Operate** | **Watch** |
| --- | --- | --- |
| Screens | Desk, Scores while entering, Schedule while planning | Landing, Explore, a tournament seen read-only |
| Reader | An operator, at a desk, mid-match, on imperfect wifi | A player or spectator, on a phone |
| Goal | Know what needs doing, do it once, never misclick | Find a match, see the score |
| Density | Dense, 44px targets, state is the loudest thing | Airy, one clear next step |

Both share the same tokens and the same meaning of every colour. The Desk is the reference: if a
choice works there, the Watch screens inherit it with more room.

## Colour

Neutral by default. A screen where nothing needs attention should look nearly grey. Colour
appears only when it carries meaning, and one colour carries one meaning.

| Role | Token | Hex | Means |
| --- | --- | --- | --- |
| Ground | `--background` | `#F4F5F4` | The page |
| Surface | `--surface`, `--card` | `#FFFFFF` | Cards and panels |
| Text | `--foreground` | `#171A1D` | Primary text |
| Text, secondary | `--muted-foreground` | `#5B656C` | Supporting text, captions |
| Hairline | `--border` | `#D9DDDF` | Decorative edges only |
| Control edge | `--border-control` | `#7F8A91` | Anything the user must locate: inputs, selects |
| Interaction | `--primary` | `#5B4FC7` | Buttons, links, active nav, selected tab |
| Live | `--state-live-chip` | `#D6F1E3` | A live match: its status chip, and the connection badge |
| Playing | `--play`, `--play-surface` | `#16865C`, `#D6F1E3` | A court with a match on it right now |
| Success | `--success`, `--success-surface`, `--success-foreground` | `#16865C`, `#D6F1E3`, `#0E5A3A` | Healthy, completed: the family's fill, surface and ink |
| Warning | `--warn-*` | amber | Delayed, needs attention |
| Danger | `--destructive`, `--danger-*` | red | Overrun, error, destructive action |

Rules:

- **Violet is for interaction and nothing else.** If a thing is not clickable and not selected,
  it is not violet. A "ready" court tinted violet is acceptable because it is an action waiting.
- **Green is for live, and it never stands alone.** Green is the colour a reader already
  associates with "live", and it carries three roles: a court that is playing, a match that is
  live, and the connection being up. Every one of them also has a word and a glyph, so the hue is
  never the only signal. The chip values (`#D6F1E3` on `#0E5A3A`) clear 6.9:1, so the rule that
  mattered when live was lime still holds: a live chip carries ink text, and the hue is never used
  as text, a border or an icon on a light surface.
- **The court state and the match status are separate tokens even where they agree.** `--play*` is
  the court board's own green and `--state-live-*` the match status's; they hold the same value
  today, and that is deliberate, but they are named apart so retuning one cannot silently re-tint
  the other. `--play` is the family's edge, `--play-surface` its fill - the chip at full strength
  and the court tile as a wash of it - and `--play-foreground` the ink on it; `playing` is
  therefore built exactly like `overrun`, one green where that one is amber.
- **Success, warning, info and danger each have three stops.** A saturated fill (a button, a dot,
  an icon), a surface it sits on, and a darker ink for text: `--warn-*`, `--info-*`, `--danger-*`
  and `--success-*` name all three. Do not use the fill as text: amber `#C97812` is 3.4:1 on
  white, the text ink `#8F5300` is 5.5:1. A feedback surface — a callout, a badge, a toast — takes
  all three from one family rather than a tint from one and an ink from another.
- **The toasts are the one third-party surface this system repaints.** Sonner ships its own
  version of the success and error pairs, and its error text measured 4.14:1 against its own fill
  for every error toast the app raised — invisible to any sweep, because a toast only exists after
  an action. The rule at the foot of [`styles.css`](../src/styles.css) puts both toasts on the
  tokens above, and `criteria.spec.ts` measures them.
- **A filled control darkens on hover, and never lightens.** The fill exists to carry white text
  at 4.5:1, and lightening it spends that headroom. `--destructive` is 4.93:1 at rest, so the
  shadcn `hover:bg-destructive/90` default composited to 4.22:1 — under the floor, in the one
  state a pointer left resting on a control produces. Hover therefore moves *toward* the ink
  (`--primary-hover` 8.76:1, `--destructive-hover` 6.31:1) rather than away from it, so the
  hovered state can never be the state that fails. Lightness moves and the hue does not, so the
  control reads as the same colour pressed in.
- **Colour is never the only signal.** Every state also has a word and a glyph. Green and red
  are close under red-green colour blindness, so completed and overrun must differ by label and
  icon, not by hue.
- **Do not add a hue.** Five semantic colours and a neutral ground is the budget. A new need
  usually means a new label, not a new colour.
- **Large tinted areas stay pale.** A tinted tile is a wash, not a block. Saturated surfaces are
  for the single primary action on a screen.

## Court state

The five derived states in `src/lib/tournament/court-state.ts`. Each has a label, a glyph and
a colour, so a wall of eight courts can be read without reading any of them.

| State | Reads as | Colour |
| --- | --- | --- |
| Playing | A match is on | Green chip with ring, green wash |
| Overrun | On court past its slot | Amber chip with ring, amber wash: a delay, not a danger |
| Ready | Free, next match can start | Violet wash |
| Waiting | Free, next match not ready yet | Neutral, a deeper grey than Idle; the line beneath says why |
| Idle | Free, nothing queued | Neutral |

## Type

Two families: **Bricolage Grotesque** (`font-display`) for page titles, panel titles and court
numbers, **Instrument Sans** for everything else.

The visitor's front door adds a third, **JetBrains Mono** (`font-mono`), for its own small labels
only - clock times and step names around the scheduling demo. Product UI never uses it, including
the pictures of the Desk on that page. The same page uses violet for "moved later" in its
scheduling diagram: an exception to "violet is for interaction", kept because it is the
scheduler's action being shown, and confined to that illustration.

- **Body and controls: 14px minimum, 16px for what is read on the move.** Names on a court tile
  and match names in dialogs are 16px. 12px is for tertiary detail only
  (a timestamp, a footnote) and never for navigation, labels or buttons.
- **Labels are sentence case.** Do not set labels in uppercase with wide tracking. It is slower to
  read and the old 12px uppercase labels were the smallest text on the Desk.
- **Chrome is not smaller than content.** Navigation, panel titles and column headers are at
  least as large as the rows they label.
- **Numbers use tabular figures** (`tabular-nums`): times, scores, counts, progress. Columns
  must line up while values change.
- **Scores and court numbers are the largest type on an Operate screen.** Score inputs are 30px,
  a court number is the first thing in its tile.

Scale in use on the Desk: panel title 16px bold, nav 14px semibold, body and chips 14px, names
16px semibold, dialog title 24px, score input 30px bold.

## Size and space

- **Targets are 44px minimum on Operate screens**: nav links, day selector, Refresh, rows in Act
  now, dialog buttons and inputs. Watch screens follow the same floor on a phone.
- **Primary action in a dialog is 48px** and full width.
- **Corners:** the base radius is 16px. Dense tiles and rows use less, cards use it.
- **One primary action per tile or dialog.** Secondary and exceptional actions (walkover, void)
  are visually quieter and sit apart, and anything destructive asks for confirmation.
- **Do not move things when data changes.** Realtime updates change content, not layout.

## Not decided

- A dark theme. It was removed on purpose; a dark Desk is an open question for dim halls.
- The Watch screens' final layout (Landing, Explore). Their mockups were deleted once the code
  became the reference, so there is nothing to build from but the pages themselves.
- Whether the type scale tokens in `styles.css` (`--type-t1` to `--type-t4`) should move to match
  the sizes above. The Desk currently sets sizes with utility classes.
