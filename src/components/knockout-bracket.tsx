/**
 * A single-elimination bracket drawn as a mirrored tree: the top half opens on the left, the
 * bottom half on the right, and both close on the final in the middle, with each pair of matches
 * joined to the match it feeds.
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
 * tree is the one `StatusPill` already paints on a live match. The joining lines carry the one
 * other signal: the route out of a decided match is drawn in ink, a route not yet played is faint,
 * so how far a draw has got reads from across the room.
 *
 * Geometry: every column splits its height equally between its slots, and each slot centres its
 * card. Two neighbouring slots meet exactly at the centre of the match they feed in the next
 * column, so the joining lines need no measuring — each match draws a stub out of its card, half
 * of the bar to that meeting point, and the stub into the next round.
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

/** A match whose winner is known moves on, so the line out of it is a played path. */
function advanced(match: TierDrawMatch | undefined): boolean {
  if (!match) return false;
  if (isByeMatch(match)) return true;
  return (match.status === "reported" || match.status === "walkover") && !!match.winner_id;
}

/**
 * The line from one match to the match it feeds: a stub out of the card, half of the bar
 * that joins it to its pair, and the stub into the next round. Each match draws its own
 * half, so a played match inks its own route while its partner's stays faint.
 *
 * `toward` is the side the next round lies on: right for the top half, left for the bottom.
 * `place` says which half of the bar is this match's; a lone match (a semifinal, which feeds
 * the final straight across) has no bar at all.
 */
function Connector({
  toward,
  place,
  played,
}: {
  toward: "right" | "left";
  place: "upper" | "lower" | "single";
  played: boolean;
}) {
  const weight = played ? 2 : 1;
  const tone = played ? "bg-foreground" : "bg-border-control/50";
  const half = `${weight / 2}px`;
  const exitY = place === "upper" ? "100%" : place === "lower" ? "0%" : "50%";
  return (
    <>
      <span
        aria-hidden
        className={cn("pointer-events-none absolute", tone)}
        style={{ top: `calc(50% - ${half})`, [toward]: `calc(-1 * ${ARM})`, width: ARM, height: weight }}
      />
      {place === "single" ? null : (
        <span
          aria-hidden
          className={cn("pointer-events-none absolute", tone)}
          style={{
            top: place === "upper" ? `calc(50% - ${half})` : `calc(0% - ${half})`,
            bottom: place === "upper" ? `calc(0% - ${half})` : `calc(50% - ${half})`,
            [toward]: `calc(-1 * ${ARM} - ${half})`,
            width: weight,
          }}
        />
      )}
      <span
        aria-hidden
        className={cn("pointer-events-none absolute", tone)}
        style={{
          top: `calc(${exitY} - ${half})`,
          [toward]: `calc(-2 * ${ARM})`,
          width: ARM,
          height: weight,
        }}
      />
    </>
  );
}

/** A slot with no row yet: the road to it is known even while nobody is on it. */
function EmptyCard({ bracketSize, round, slot }: { bracketSize: number; round: number; slot: number }) {
  return (
    <div className="w-full rounded-md border border-dashed border-border-control bg-card">
      <div className="divide-y divide-hairline">
        {(["a", "b"] as const).map((side) => (
          <Side
            key={side}
            name={feederLabel(bracketSize, round, slot, side)}
            placeholder
            won={false}
            lost={false}
            scores={[]}
            against={[]}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * A single-elimination bracket drawn mirrored: the top half runs left to right, the bottom
 * half right to left, and the two meet at the final in the middle, with the champion above it.
 * Both semifinals sit level with the final, so the decisive match is the centre of the picture
 * rather than the far edge of a scroll.
 *
 * Every slot of every round is drawn, from the bracket's size rather than from the rows that
 * exist, so a draw that has only played its first round still shows its whole road. A slot
 * without a row is a dashed card naming the matches that feed it.
 */
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
  const roundCount = Math.max(1, Math.ceil(Math.log2(Math.max(2, bracketSize))), ...rounds.keys());
  const bySlot = new Map<string, TierDrawMatch>();
  for (const [round, matches] of rounds) {
    for (const match of matches) bySlot.set(`${round}:${match.slot}`, match);
  }
  const at = (round: number, slot: number) => bySlot.get(`${round}:${slot}`);
  const slotsIn = (round: number) => Math.max(1, 2 ** (roundCount - round));

  // Every card in a bracket is as wide as the longest match, so they stay level.
  let mostGames = 2;
  for (const matches of rounds.values()) {
    for (const match of matches) mostGames = Math.max(mostGames, parseGames(match.games).length);
  }
  const cardRem = CARD_BASE_REM + SCORE_COLUMN_REM * (mostGames - 2);

  const card = (round: number, slot: number) => {
    const match = at(round, slot);
    return match ? (
      <MatchCard match={match} bracketSize={bracketSize} label={label} />
    ) : (
      <EmptyCard bracketSize={bracketSize} round={round} slot={slot} />
    );
  };

  // One column per round on each side of the final, the bottom half's in reverse order.
  const sideRounds = Array.from({ length: roundCount - 1 }, (_, index) => index + 1);
  const halfColumn = (round: number, half: "top" | "bottom") => {
    const total = slotsIn(round);
    const perHalf = total / 2;
    const first = half === "top" ? 1 : perHalf + 1;
    const slots = Array.from({ length: perHalf }, (_, index) => first + index);
    const toward = half === "top" ? "right" : "left";
    const name = roundName(bracketSize, round);
    return (
      <section
        key={`${half}-${round}`}
        aria-label={`${name}, ${half} half`}
        className="flex shrink-0 flex-col"
        style={{
          width: `calc(${cardRem}rem + ${ARM} * 2)`,
          [toward === "right" ? "paddingRight" : "paddingLeft"]: `calc(${ARM} * 2)`,
        }}
      >
        <h4
          className={cn(
            "border-b border-hairline pb-1.5 text-sm font-semibold text-muted-foreground",
            half === "bottom" && "text-right",
          )}
        >
          {name}
        </h4>
        <div className="flex flex-1 flex-col">
          {slots.map((slot) => (
            <div key={slot} className="relative flex flex-1 items-center py-3">
              {card(round, slot)}
              <Connector
                toward={toward}
                place={perHalf === 1 ? "single" : slot % 2 === 1 ? "upper" : "lower"}
                played={advanced(at(round, slot))}
              />
            </div>
          ))}
        </div>
      </section>
    );
  };

  const final = at(roundCount, 1);

  return (
    // A box that scrolls must be reachable by keyboard, or a sideways scroll is a mouse-only
    // gesture; the cards inside are read-only, so the box itself takes the focus.
    <div
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      className="max-w-full overflow-x-auto rounded-md pb-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <div className="mx-auto flex min-h-64 w-max">
        {sideRounds.map((round) => halfColumn(round, "top"))}

        <section
          aria-label={roundName(bracketSize, roundCount)}
          className="flex shrink-0 flex-col"
          style={{ width: `${cardRem}rem` }}
        >
          <h4 className="border-b border-hairline pb-1.5 text-center text-sm font-semibold text-muted-foreground">
            {roundName(bracketSize, roundCount)}
          </h4>
          <div className="relative flex flex-1 flex-col">
            <div className="flex flex-1 items-center py-3">{card(roundCount, 1)}</div>

            {/* The champion stands over the final, joined to it by one short line. */}
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute left-1/2 -translate-x-1/2",
                advanced(final) ? "w-0.5 bg-foreground" : "w-px bg-border-control/50",
              )}
              style={{ bottom: "calc(50% + 2.5rem)", height: "1.25rem" }}
            />
            <section
              aria-label="Champion"
              className="absolute inset-x-0"
              style={{ bottom: "calc(50% + 3.75rem)" }}
            >
              {champion ? (
                <div className="flex w-full items-center gap-2.5 rounded-lg border border-hairline bg-success-surface px-3 py-2 text-success-foreground">
                  <Trophy className="size-5 shrink-0" aria-hidden />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-t2 font-semibold uppercase tracking-wide">Champion</span>
                    <span className="min-w-0 break-words font-display text-base font-bold leading-tight">
                      {champion}
                    </span>
                  </span>
                </div>
              ) : (
                <div className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-border-control bg-card px-3 py-2 text-muted-foreground">
                  <Trophy className="size-4 shrink-0" aria-hidden />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-t2 font-semibold uppercase tracking-wide">Champion</span>
                    <span className="text-t4 italic">Decided by the final</span>
                  </span>
                </div>
              )}
            </section>
          </div>
        </section>

        {[...sideRounds].reverse().map((round) => halfColumn(round, "bottom"))}
      </div>
    </div>
  );
}
