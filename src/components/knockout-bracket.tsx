/**
 * A single-elimination bracket drawn as a tree: one column per round, the first round on the
 * left and the final on the right, with each pair of matches joined to the match it feeds.
 *
 * Pure layout. Which entrant is called what, and which match is a bye, arrive from the caller —
 * the same `label` and `isByeMatch` the list this replaces used — so this file decides how a
 * bracket looks and nothing about who is in it.
 *
 * Every match card is the same height: two rows, one line each. State is said by exception. A
 * decided match shows its scores and a check, and a match with both sides known and nothing
 * played is a plain card, so neither needs a label; only the states that change how a card
 * should be read — live, walkover, void, waiting — carry a tag, and the tag sits on the card's
 * top edge so it costs no height. A bye is a slim solid card, because a dashed one reads as a
 * match nobody has played yet.
 *
 * Colour follows the system's rule that a screen where nothing needs attention looks nearly
 * grey. A winner is marked by weight, a check and a word; no row is tinted. The only hue on the
 * tree is the one `StatusPill` already paints on a live match.
 *
 * Geometry: every column splits its height equally between its pairs, and each pair splits
 * equally between its two matches. That puts the centre of a pair exactly at the centre of the
 * match in the next column, so the joining lines need no measuring — a vertical bar between the
 * two matches' centres and a stub out of its middle.
 */

import { Trophy } from "lucide-react";

import { ByeMarker, StatusPill } from "@/components/app-shell";
import { roundName } from "@/lib/tournament/draws";
import type { TierDrawMatch } from "@/lib/tournament/data";
import { gamesLabel, parseGames, type GameScore } from "@/lib/tournament/format";
import { displayStateFor, isByeMatch } from "@/lib/tournament/match-status";
import { feederLabel, isTierMatchReady } from "@/lib/tournament/tier-draw";
import { cn } from "@/lib/utils";

type Label = (entrantId: string | null | undefined, fallback?: string) => string;

/** Lines between rounds. The stub and the bar share this width, so the gutter is twice it. */
const ARM = "0.75rem";

/** Width of a card with two games; each further game adds one score column. */
const CARD_BASE_REM = 12.5;
const SCORE_COLUMN_REM = 1;

/** States whose card needs a tag. Completed and a ready, unplayed match read without one. */
const TAGGED = new Set(["live", "walkover", "void"]);

function Side({
  name,
  placeholder,
  won,
  lost,
  scores,
  against,
}: {
  name: string;
  placeholder: boolean;
  won: boolean;
  lost: boolean;
  scores: readonly number[];
  against: readonly number[];
}) {
  return (
    <div
      className={cn(
        "flex h-6 items-center gap-1.5 px-2 text-sm",
        won && "font-semibold",
        lost && "text-muted-foreground",
        placeholder && "text-t4 italic text-muted-foreground",
      )}
    >
      <span aria-hidden className="w-3 shrink-0 text-center text-t4">
        {won ? "✓" : ""}
      </span>
      {/* One line keeps every card the same height; the full name stays on the title and in
          the accessible name, so a truncated one is never the only copy. */}
      <span className="min-w-0 flex-1 truncate" title={name}>
        {name}
      </span>
      {won ? <span className="sr-only">Winner</span> : null}
      {scores.map((score, index) => (
        <span
          key={index}
          aria-hidden
          className={cn(
            "w-4 shrink-0 text-right font-score text-t4",
            // The game's own winner is the heavier number, so a 2-1 reads game by game.
            score > (against[index] ?? 0)
              ? "font-semibold text-foreground"
              : "text-muted-foreground",
          )}
        >
          {score}
        </span>
      ))}
    </div>
  );
}

function MatchCard({
  match,
  bracketSize,
  label,
}: {
  match: TierDrawMatch;
  bracketSize: number;
  label: Label;
}) {
  const decided = match.status === "reported" || match.status === "walkover";
  const bye = isByeMatch(match);
  const waiting =
    !bye &&
    match.status === "scheduled" &&
    !isTierMatchReady({ entrantAId: match.entrant_a_id, entrantBId: match.entrant_b_id });
  const display = displayStateFor(match.status);
  const games: GameScore[] = decided && !bye ? parseGames(match.games) : [];

  if (bye) {
    // The entrant who advances; the empty side of a bye is not worth a row.
    const advancing = match.entrant_a_id ?? match.entrant_b_id;
    const name = label(advancing, "TBC");
    return (
      <div className="w-full rounded-md border border-hairline bg-muted/40">
        <div className="flex h-[22px] items-center gap-1.5 px-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium" title={name}>
            {name}
          </span>
          <ByeMarker className="border-solid border-transparent bg-transparent px-0" />
        </div>
      </div>
    );
  }

  const sides = (["a", "b"] as const).map((side) => {
    const id = side === "a" ? match.entrant_a_id : match.entrant_b_id;
    return {
      key: side,
      name: label(id, feederLabel(bracketSize, match.round, match.slot, side)),
      placeholder: !id,
      won: decided && !!id && match.winner_id === id,
      lost: decided && !!id && !!match.winner_id && match.winner_id !== id,
      scores: games.map((game) => (side === "a" ? game.a : game.b)),
      against: games.map((game) => (side === "a" ? game.b : game.a)),
    };
  });

  const tag = waiting ? (
    <span className="rounded-full border border-dashed border-border-control bg-card px-2 font-score text-t2 uppercase tracking-wide text-muted-foreground">
      Waiting
    </span>
  ) : !display || TAGGED.has(display) ? (
    <span className="rounded-full bg-card px-1">
      <StatusPill status={match.status} />
    </span>
  ) : null;

  return (
    <div
      className={cn(
        "relative w-full rounded-md border bg-card",
        waiting ? "border-dashed border-border-control" : "border-border-control",
      )}
    >
      {tag ? (
        <div className="absolute -top-3.5 right-2 z-10 leading-none [&_span]:py-0">{tag}</div>
      ) : null}
      <div className="divide-y divide-hairline">
        {sides.map(({ key, ...side }) => (
          <Side key={key} {...side} />
        ))}
      </div>
      {/* The words a sighted reader gets from the scores and the check. */}
      <span className="sr-only">
        {waiting
          ? "Waiting for teams"
          : display === "completed" || display === "scheduled"
            ? display === "completed"
              ? "Completed"
              : "Scheduled"
            : ""}
        {games.length ? `. Games ${gamesLabel(games)}` : ""}
      </span>
    </div>
  );
}

export function KnockoutBracket({
  rounds,
  bracketSize,
  label,
  ariaLabel,
  champion,
}: {
  rounds: ReadonlyMap<number, TierDrawMatch[]>;
  bracketSize: number;
  label: Label;
  ariaLabel: string;
  /** The winner of the final, named; null while the final is undecided. */
  champion: string | null;
}) {
  const columns = [...rounds.entries()].sort(([a], [b]) => a - b);

  // Every card in a bracket is as wide as the longest match, so they stay level.
  let mostGames = 2;
  for (const [, matches] of columns) {
    for (const match of matches) mostGames = Math.max(mostGames, parseGames(match.games).length);
  }
  const cardRem = CARD_BASE_REM + SCORE_COLUMN_REM * (mostGames - 2);

  return (
    // A box that scrolls must be reachable by keyboard, or a sideways scroll is a mouse-only
    // gesture; the cards inside are read-only, so the box itself takes the focus.
    <div
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      className="max-w-full overflow-x-auto rounded-md pb-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <div className="flex min-w-max">
        {columns.map(([round, matches], index) => {
          // Two consecutive slots feed one match in the next round, so they are one pair.
          const pairs = new Map<number, TierDrawMatch[]>();
          for (const match of matches) {
            const key = Math.ceil(match.slot / 2);
            pairs.set(key, [...(pairs.get(key) ?? []), match]);
          }
          // Every round is joined onward: the final feeds the champion, which closes the tree.
          const joined = true;

          return (
            <section
              key={round}
              aria-label={roundName(bracketSize, round)}
              className="flex shrink-0 flex-col"
              style={{
                width: joined ? `calc(${cardRem}rem + ${ARM} * 2)` : `${cardRem}rem`,
                paddingRight: joined ? `calc(${ARM} * 2)` : undefined,
              }}
            >
              <h4 className="pb-1 text-sm font-semibold text-muted-foreground">
                {roundName(bracketSize, round)}
              </h4>
              <div className="flex flex-1 flex-col">
                {[...pairs.entries()].map(([key, pair]) => (
                  <div key={key} className="relative flex flex-1 flex-col">
                    {pair.map((match) => (
                      <div key={match.id} className="flex flex-1 items-center pb-1 pt-4">
                        <MatchCard match={match} bracketSize={bracketSize} label={label} />
                      </div>
                    ))}
                    {joined ? (
                      <>
                        {/* The bar joins the two matches; a lone match needs only the stub. */}
                        {pair.length > 1 ? (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute rounded-r-md border-y border-r border-border-control"
                            style={{ top: "25%", bottom: "25%", right: `-${ARM}`, width: ARM }}
                          />
                        ) : null}
                        <span
                          aria-hidden
                          className="pointer-events-none absolute border-t border-border-control"
                          style={{ top: "50%", right: `calc(${ARM} * -2)`, width: ARM }}
                        />
                      </>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          );
        })}

        <section
          aria-label="Champion"
          className="flex shrink-0 flex-col"
          style={{ width: `${cardRem}rem` }}
        >
          <h4 className="pb-1 text-sm font-semibold text-muted-foreground">Champion</h4>
          <div className="flex flex-1 items-center pb-1 pt-4">
            {champion ? (
              <div className="flex w-full items-center gap-2 rounded-md border border-hairline bg-success-surface px-2.5 py-2 text-success-foreground">
                <Trophy className="size-5 shrink-0" aria-hidden />
                <span className="min-w-0 break-words font-display text-base font-bold leading-tight">
                  {champion}
                </span>
              </div>
            ) : (
              <div className="flex w-full items-center gap-2 rounded-md border border-dashed border-border-control px-2.5 py-2 text-t4 text-muted-foreground">
                <Trophy className="size-4 shrink-0" aria-hidden />
                No champion yet
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
