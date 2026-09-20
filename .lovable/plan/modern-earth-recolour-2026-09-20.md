# Modern Earth recolour — SUPERSEDED

> **Do not implement.** This plan was replaced by the cool neutral slate chassis, which
> is now shipped in `src/styles.css`.
>
> Why it was abandoned: the chassis direction changed from warm earth to cool slate, and
> this plan's state palette described nine match states when the database enforces five.
> Re-applying it would revert both decisions.
>
> Current sources of truth:
> - Tokens and component behaviour: `src/styles.css`
> - The design system and its phased plan: `design-system-review.canvas.tsx`
>
> The rest of this file is kept as a historical record and is not a specification.
> `state` and `sage` references below are historical and do not reflect the shipped system.

---

A colour and typography refresh only. No changes to tournament rules, scheduling, scoring, or any data.

## The look

Clay & Sage: oat/linen backgrounds, warm terracotta as the main accent, sage green for positive states, deep espresso text. Light theme only.

- Backgrounds: warm oat instead of the current cool grey-blue
- Primary buttons, active tab, links: terracotta clay
- Good/complete/live-OK states: sage green (replaces mint)
- Warnings: warm ochre; problems: muted brick red
- Text: espresso brown-black instead of indigo-black
- The soft coloured glows behind the page become warm clay/sage tints

## Fonts

Warmer pairing to match the earth palette:

- Headings and page titles: a grounded humanist serif-adjacent display face
- Body text: a warm humanist sans
- Scores and times keep a monospaced face so numbers stay aligned

## Screens covered

Every tab picks the new colours up automatically because they all use shared tokens: Desk, Registration, Placement, Knockout, Schedule, Scores, Tournament setup, Staff, Sign in. I will walk each one afterwards and fix any spot that still looks off — court state colours on the Desk, bracket cards on Knockout, status chips, the Schedule settings panel, and the setup wizard step bar.

## Technical notes

- Rewrite the token values in `src/styles.css` (`:root`) — `--background`, `--surface`, `--hairline`, `--primary`, `--accent`, `--ink`, `--brand`, `--mint`, `--coral`, `--amber`, `--cyan`, warn/info/danger triplets, chart and sidebar tokens — in oklch. Token names stay the same, so no component needs a rename.
- Update the body background gradient tints and the elevation shadows to warm-tinted.
- Swap `--font-display` / `--font-body` in `@theme inline` and update the Google Fonts `<link>` in `src/routes/__root.tsx`; keep `--font-score` monospaced.
- Sweep components for any hardcoded colour utilities left over and move them to tokens.
- Verify with typecheck, build, and a browser pass over each route.
