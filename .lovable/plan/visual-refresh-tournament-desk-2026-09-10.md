# Visual refresh — tournament desk

Presentation only. No changes to tournament rules, scheduling, scoring, or database logic.

## Look and feel

- Keep the current indigo / mint / amber palette, refined into a cleaner, calmer set of surfaces and status colours.
- Space Grotesk for headings and numbers, DM Sans for body text, loaded properly so screens look the same on every laptop and tablet.
- Dashboard density: a compact stats strip on top, tight information panels below — built for a desk team scanning quickly, not for scrolling.

## Screens covered

All of them, so the app feels like one product:

- **Desk** — tighter court board with clearer state colours (playing, overrunning, free, blocked), a live elapsed-time readout, a slimmer alerts strip, and a cleaner score window.
- **Registration** — clearer form grouping, better spacing, friendlier errors, readable player list.
- **Pools** — standings tables that are easy to read across a room; rank, wins and point difference stand out.
- **Scores** — consistent table styling, clearer status chips and action buttons.
- **Draws** — bracket rounds laid out with clearer columns, byes and winners easy to spot.
- **Schedule** — the running order table gets sticky headers, zebra rows, and per-court colour cues; day blocks read as separate cards.
- **Staff / Sign in** — matched styling with the rest.

## Shared polish

- One header treatment: current page clearly marked, sign-in state readable at a glance.
- Consistent panel, table, badge, and button styling everywhere, replacing today's per-page variations.
- Empty and loading states that say what is happening instead of showing a blank panel.
- Works down to tablet width; large touch targets for the buttons the desk actually presses.
- Page titles and descriptions checked per screen.

## Technical notes

- Extend the token set in `src/styles.css` (surfaces, status colours, elevation, table and font tokens); no hardcoded colour utilities in components.
- Add the web fonts via a `<link>` in `src/routes/__root.tsx`.
- Refactor `AppShell`, `Panel`, `StatusPill` in `src/components/app-shell.tsx` and add small shared presentation pieces (stat tile, data table wrapper, empty state).
- Route files change in markup and class names only; data hooks, actions in `src/lib/tournament/*`, and all queries/mutations stay untouched.
- Verify with typecheck, build, and a browser pass over each route.
