# Design principles

Guidance for colour, type and size. This is not a rulebook and no test pins it: the
accessibility specs (`e2e/a11y.spec.ts`, `criteria.spec.ts`, `route-sweep.spec.ts`,
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
| Interaction | `--primary` | `#22397A` | Buttons, links, active nav, selected tab |
| Live | `--state-live-chip` | `#D6F1E3` | A live match: its status chip, and the connection badge |
| Playing | `--play`, `--play-surface` | `#16865C`, `#D6F1E3` | A court with a match on it right now |
| Success | `--success`, `--success-surface`, `--success-foreground` | `#16865C`, `#D6F1E3`, `#0E5A3A` | Healthy, completed: the family's fill, surface and ink |
| Warning | `--warn-*` | amber | Delayed, needs attention |
| Danger | `--destructive`, `--danger-*` | red | Overrun, error, destructive action |

Rules:

- **Navy is for interaction and nothing else.** If a thing is not clickable and not selected,
  it is not navy. A "ready" court tinted navy is acceptable because it is an action waiting.
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
  (`--primary-hover` 13.41:1, `--destructive-hover` 6.31:1) rather than away from it, so the
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
a colour, so a wall of eight courts can be read without reading any of them. Only the states that
ask for a hand - Overrun and Ready - tint the whole tile; on a live day most courts are playing,
and a board of green washes would bury them.

| State | Reads as | Colour |
| --- | --- | --- |
| Playing | A match is on | Green chip with ring on a white tile: the normal state, so it does not tint the tile |
| Overrun | On court past its slot | Amber chip with ring, amber wash: a delay, not a danger |
| Ready | Free, next match can start | Navy wash |
| Waiting | Free, next match not ready yet | Neutral, a deeper grey than Idle; the line beneath says why |
| Idle | Free, nothing queued | Neutral |

## Type

Three families:

- **Roboto Condensed** (`font-display`) for page titles, panel titles, the tournament's name
  in the workspace header and court numbers. Its figures are tabular, so times and counts in
  titles still line up.
- **Instrument Sans** (`font-body`, `font-score`) for everything else: the wordmark, body text, tables,
  forms, buttons and status pills, where a condensed face would cost legibility at 14px on a
  live Desk.
- **Saira Extra Condensed** 800 (`font-numeral`) for a single large number standing on its own:
  a score being entered on the Desk, the 404. Its figures are proportional, so it is never used
  where digits must align in a column.

Roboto Condensed and Saira are served from `public/fonts/`, not a font host.

The visitor's front door is drawn as the organiser's board: one printed sheet per court on the
app's own grey ground (`src/components/landing/court-sheets.css`). Its header is the app's
header style - a navy mark (20px) beside an ink wordmark (18px), plain text links in muted ink
(14px, 500) that turn ink and underline on hover, the open one ink and underlined - so moving
between the landing and the app keeps the brand and nav in place. The mark is the header's one
navy; the bar sits a step behind the page title it frames. Two exceptions are
deliberate and stay on that page: the sheets' clock times use **JetBrains Mono** (`font-mono`),
which product UI never uses, and the clash it circles is magenta, a hue the app does not have,
because it is a highlighter mark on a picture of paper rather than a state the app reports.

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

## Reader pages

Now, Schedule, My matches and Players are the Watch screens inside a tournament. They are read
on every screen the app supports, so their layout is set by the screen rather than by two
breakpoints:

- **The first match is on screen without scrolling**, at 320px, on a phone held sideways and on a
  1366×768 laptop. `ReaderPage` puts the title and the page's controls (days, filters) on one row
  with no subtitle, and `watch-short` (under 500px high) drops the tournament header's date line.
- **A match row leads with its court**, in a column of its own, then one side per line. A wave of
  matches that share a published time sits under one heading carrying the time - and the event
  and round when the whole wave shares them - rather than each row repeating them.
- **Lists are flat**: a hairline frame and rules. Shadow is kept for the courts in play and a
  player's next match. An empty list is a sentence under its title, not an empty frame.
- **Now shows the whole hall**: every court the day plays on, in number order, a free one as a
  quiet dashed tile, so a realtime update changes a tile and never the layout. The grid fits as
  many columns as the screen holds, as the Desk's does. From 1200×600 (`watch-wall`) Now is one
  viewport tall like the Desk's console, for a laptop or a screen on the venue's wall.
- **Schedule follows the running order's rule**: rows on a phone or tablet, a table from `lg`.
- **A court tile names both sides at reading weight**, the second opening with a muted "vs";
  bold names, a rule or a box around each side were all tried and read as noise. A free court
  says when it fills ("Next here at 10:25").
- **A score bolds only each game's winning number** (`GameScores`), so who took each game reads
  without comparing digits. The day switch is one segmented control, not a row of pills.

## Not decided

- A dark theme. It was removed on purpose; a dark Desk is an open question for dim halls.
- The final layout of Landing and Explore. Their mockups were deleted once the code became the
  reference, so there is nothing to build from but the pages themselves.
- Whether the type scale tokens in `styles.css` (`--type-t1` to `--type-t4`) should move to match
  the sizes above. The Desk currently sets sizes with utility classes.

## Words on screen

Too much text is the most common reason a screen reads as noisy. The rules:

- **A subtitle is one short sentence.** It says what the page is, not how to use it. The page's
  meta description is separate and is not repeated as the subtitle.
- **One prominent banner per page.** When several things need saying, the most urgent (a conflict,
  something that cannot be placed) goes first and the rest sit behind a count or a link.
- **Explanation goes behind an (i).** Use [`InfoNote`](../src/components/ui/info-note.tsx) for the
  "why" and "how it is worked out". It opens on hover, click and keyboard focus.
- **Text stays on screen only when it prevents a mistake** that cannot be undone, such as a
  delete or a reset that clears results.
- **Do not say the same thing twice on a page**, or on the page and the page it links to.

## Match metadata and narrow screens

Use layout spacing and wrapping to separate metadata, with no middle-dot separators.
Keep `MD R1` / `MD R2` as the compact placement identity. Knockout identity (`MD Draw A`)
and round (`Semifinal`) are separate units. Keep `Next` and the published time; the court's
state determines whether that next match is the tile's subject or follows a current match.
Use `Court 3` on operational screens and `min` for elapsed time. A chart may use numbered
rows under an explicit Court axis. Scores remain a single, unbroken value.

Court labels stay on one line; under a Court column, `Unassigned` is enough. The running
order uses match rows on phones and tablets, reserving the six-column table for desktop.
Desk cards fit as many columns as can retain 18rem per card, with one column on narrower
screens. A queued match's Next time has its own line above its identity, and the match
action has room beside Call next.

On mobile, score rows have a round/time header, full-width team names, then status, score
and the action. Dialog metadata uses separate lines for identity, court/time and scoring
rules. Public pages and account/access forms retain their existing field labels and hierarchy.

Call next remains an action after sending; Last sent is secondary metadata, not the button
name. The green cue describes player availability, independently of account reach. In the
preview, In Tournova and Not linked describe the player’s account contact status without treating a
missing account as an error. Instructions to call at the venue stay outside the Contact column. The send button names the recipient count.

Notifications belong in the account header, not over court or score controls. The trigger is a quiet, 44px circular bell before the account identity and Sign out,
with a compact unread badge and a complete accessible name at every screen size. Inbox items give the event
its own heading, an explicit unread label, and court/date/time metadata with a timezone.
