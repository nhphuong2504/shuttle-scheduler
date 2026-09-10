# Draws tab: bracket-first redesign

Strip the summary numbers and make the bracket itself the whole screen.

## Remove

- The four tiles above the bracket (Entrants, Matches played, Still to play, Champion). The bracket already carries this information.

## Bracket becomes the focus

- The bracket fills the panel edge to edge, with no card frame competing for attention.
- Round headers stay pinned at the top while you scroll sideways, so you always know which round you are looking at.
- Real connector lines join each pair of matches to the one that follows, so the path to the final reads at a glance.
- Match cards get tighter: names and scores on one line each, seed-free, so more of the draw fits on screen.
- Progress moves into a single small line next to the round header (for example "3/4 played") instead of a tile row.
- The champion stays as the final column, shown as a trophy card that lights up when decided.

## Reading the state faster

- Finished matches are calm grey with the winner bolded; the loser dims.
- A live match pulses with the accent colour so it is findable while scanning.
- Rounds not yet created show as dashed placeholders, keeping the shape of the full draw (Quarterfinal, Semifinal, Final) visible from the start.
- Small draws (2 or 4 entrants) render the same way, just fewer columns.

## Extra polish

- A "fit to screen" toggle that shrinks the bracket so a full 8-team draw fits without sideways scrolling.
- Hovering a team highlights that team through the rest of the bracket.

## Technical notes

All changes stay in `src/routes/draws.tsx` (plus small shared styles in `src/styles.css` if needed). No changes to draw generation, seeding, advancement, scoring, database functions, or data hooks. `roundName` from `src/lib/tournament/draws.ts` keeps naming rounds; the round count keeps deriving from `bracket_size`. Connectors are drawn with CSS pseudo-elements between round columns, not an SVG layer, to avoid layout coupling.
