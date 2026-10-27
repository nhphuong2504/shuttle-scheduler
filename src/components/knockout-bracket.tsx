/**
 * A single-elimination bracket, drawn in whichever of three shapes fits the room it is given.
 *
 *   mirrored  The top half opens on the left, the bottom half on the right, and both close on
 *             the final in the middle with the champion over it. The clearest picture, and the
 *             widest: drawn only when every column fits without a scroll.
 *   linear    Every round left to right, ending in the champion. Narrower by almost half, so a
 *             bracket of 16 fits a desktop screen; where it still does not, the box scrolls and
 *             its edges fade toward the rounds that are out of view.
 *   rounds    One round at a time, picked from a row of tabs, the cards full width. For a phone,
 *             where two columns of cards side by side would truncate every name.
 *
 * The shape is chosen from the measured width of the box, not from the bracket's size, so a
 * bracket of 4 is mirrored on a laptop and a bracket of 32 is linear on the same screen. Both the
 * server and the first client render draw `linear`, which is legible at every width, and the
 * measurement upgrades it after hydration; the two renders therefore always agree.
 *
 * Pure layout. Which entrant is called what arrives from the caller as `label` (the full name,
 * for titles, the accessible name and the champion) and `names` (the lines a card shows - one per
 * player, so a doubles pair is two lines rather than one truncated to its first player). This file
 * decides how a bracket looks and nothing about who is in it.
 *
 * Every match card has the same structure: a header naming the match (`QF 2`) with its tag on the
 * right, then the two sides. A tag is drawn only for the states that change how a card should be
 * read - live, walkover, void, waiting - and always in the header, so it never covers a border or a
 * name. A slot nobody has reached yet names the match that feeds it in the same short code
 * (`Winner QF 2`), which the reader can find on the card it points at; the long form stays in the
 * title and the accessible name. A bye is a slim solid card, because a dashed one reads as a match
 * nobody has played yet.
 *
 * Colour follows the system's rule that a screen where nothing needs attention looks nearly grey.
 * A winner is marked by weight, a check and a word; no row is tinted. The only hue on the tree is
 * the one `StatusPill` paints on a live match and the champion's success surface. The joining lines
 * carry the one other signal: the route out of a decided match is drawn in ink, a route not yet
 * played is faint, so how far a draw has got reads from across the room.
 *
 * Geometry: every column splits its height equally between its slots, and each slot centres its
 * card. Two neighbouring slots meet exactly at the centre of the match they feed in the next
 * column, so the joining lines need no measuring - each match draws a stub out of its card, half of
 * the bar to that meeting point, and the stub into the next round. Cards may differ in height (a
 * pair is taller than a bye); the lines attach to the slot, not the card, so that costs nothing.
 */

import { Trophy } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { ByeMarker, StatusPill } from "@/components/app-shell";
import { roundName } from "@/lib/tournament/draws";
import type { TierDrawMatch } from "@/lib/tournament/data";
import { gamesLabel, parseGames, type GameScore } from "@/lib/tournament/format";
import { displayStateFor, isByeMatch } from "@/lib/tournament/match-status";
import { feederLabel, isTierMatchReady } from "@/lib/tournament/tier-draw";
import { cn } from "@/lib/utils";

type Label = (entrantId: string | null | undefined, fallback?: string) => string;
/** The lines a card shows for an entrant - one per player - or null when nobody is there. */
type Names = (entrantId: string | null | undefined) => readonly string[] | null;
type Shape = "mirrored" | "linear" | "rounds";

/** Lines between rounds. The stub and the bar share this width, so the gutter is twice it. */
const ARM_REM = 0.75;
const ARM = `${ARM_REM}rem`;

/** Width of a card with two games; each further game adds one score column. */
const CARD_BASE_REM = 13;
const SCORE_COLUMN_REM = 1;
/** Where there is room to spare, cards widen to fill the box - so names truncate less - up to this. */
const CARD_MAX_REM = 18;

/** States whose card needs a tag. Completed and a ready, unplayed match read without one. */
const TAGGED = new Set(["live", "walkover", "void"]);

/** The short name of a round, as a card's header and a feeder line say it: `QF`, `SF`, `R16`. */
function roundCode(bracketSize: number, round: number): string {
  const teamsLeft = bracketSize / 2 ** (round - 1);
  if (teamsLeft <= 2) return "Final";
  if (teamsLeft === 4) return "SF";
  if (teamsLeft === 8) return "QF";
  return `R${teamsLeft}`;
}

/** The name on a card's header. The final is the only match of its round, so it has no number. */
function matchCode(bracketSize: number, round: number, slot: number): string {
  const code = roundCode(bracketSize, round);
  return code === "Final" ? code : `${code} ${slot}`;
}

/** `feederLabel`, said in the codes the card headers use. Round one has no feeder: `TBC`. */
function feederShort(bracketSize: number, round: number, slot: number, side: "a" | "b"): string {
  if (round <= 1) return "TBC";
  const feeder = side === "a" ? 2 * slot - 1 : 2 * slot;
  return `Winner ${roundCode(bracketSize, round - 1)} ${feeder}`;
}

/** A match whose winner is known moves on, so the line out of it is a played path. */
function advanced(match: TierDrawMatch | undefined): boolean {
  if (!match) return false;
  if (isByeMatch(match)) return true;
  return (match.status === "reported" || match.status === "walkover") && !!match.winner_id;
}

function Side({
  lines,
  name,
  placeholder,
  pairs,
  won,
  lost,
  scores,
  against,
}: {
  lines: readonly string[];
  /** The full name, for the title and the accessible name. */
  name: string;
  placeholder: boolean;
  /** Every side of a pairs bracket is two lines tall, filled or not, so its cards stay level. */
  pairs: boolean;
  won: boolean;
  lost: boolean;
  scores: readonly number[];
  against: readonly number[];
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 text-sm",
        pairs ? "min-h-11" : "min-h-7",
        won && "font-semibold",
        lost && "text-muted-foreground",
        placeholder && "text-muted-foreground",
      )}
      title={name}
    >
      <span aria-hidden className="w-3 shrink-0 text-center text-t4">
        {won ? "✓" : ""}
      </span>
      {/* One line per player, each truncated on its own, so a long first name never hides the
          partner. The full name is the accessible copy, so a truncated line is never the only one. */}
      <span aria-hidden className="flex min-w-0 flex-1 flex-col leading-tight">
        {lines.map((line, index) => (
          <span key={index} className="truncate">
            {line}
          </span>
        ))}
      </span>
      <span className="sr-only">{name}</span>
      {won ? <span className="sr-only">, winner</span> : null}
      {scores.map((score, index) => (
        <span
          key={index}
          aria-hidden
          className={cn(
            "w-4 shrink-0 text-right font-score text-t4 tabular-nums",
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

/** A card's header: the match's code, and its tag when it has one. */
function CardHeader({ code, tag }: { code: string; tag?: ReactNode }) {
  return (
    <div className="flex h-6 items-center justify-between gap-2 border-b border-hairline px-2">
      <span className="font-score text-t4 tabular-nums text-muted-foreground">{code}</span>
      {tag ? <span className="flex items-center leading-none [&_span]:py-0">{tag}</span> : null}
    </div>
  );
}

function MatchCard({
  match,
  bracketSize,
  label,
  names,
  pairs,
}: {
  match: TierDrawMatch;
  bracketSize: number;
  label: Label;
  names: Names;
  pairs: boolean;
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
      <div className="w-full rounded-md border border-hairline bg-muted/40" title={name}>
        <div className="flex min-h-7 items-center gap-1.5 px-2 py-1 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          <ByeMarker className="border-solid border-transparent bg-transparent px-0" />
        </div>
      </div>
    );
  }

  const sides = (["a", "b"] as const).map((side) => {
    const id = side === "a" ? match.entrant_a_id : match.entrant_b_id;
    const full = label(id, feederLabel(bracketSize, match.round, match.slot, side));
    return {
      key: side,
      name: full,
      lines: (id ? names(id) : null) ?? [
        id ? full : feederShort(bracketSize, match.round, match.slot, side),
      ],
      placeholder: !id,
      won: decided && !!id && match.winner_id === id,
      lost: decided && !!id && !!match.winner_id && match.winner_id !== id,
      scores: games.map((game) => (side === "a" ? game.a : game.b)),
      against: games.map((game) => (side === "a" ? game.b : game.a)),
    };
  });

  const tag = waiting ? (
    <span className="text-t4 text-muted-foreground">Waiting</span>
  ) : !display || TAGGED.has(display) ? (
    <StatusPill status={match.status} />
  ) : null;

  return (
    <div
      className={cn(
        "w-full rounded-md border bg-card",
        waiting ? "border-dashed border-border-control" : "border-border-control",
      )}
    >
      <CardHeader code={matchCode(bracketSize, match.round, match.slot)} tag={tag} />
      <div className="divide-y divide-hairline">
        {sides.map(({ key, ...side }) => (
          <Side key={key} pairs={pairs} {...side} />
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

/** A slot with no row yet: the road to it is known even while nobody is on it. */
function EmptyCard({
  bracketSize,
  round,
  slot,
  pairs,
}: {
  bracketSize: number;
  round: number;
  slot: number;
  pairs: boolean;
}) {
  return (
    <div className="w-full rounded-md border border-dashed border-border-control bg-card">
      <CardHeader code={matchCode(bracketSize, round, slot)} />
      <div className="divide-y divide-hairline">
        {(["a", "b"] as const).map((side) => (
          <Side
            key={side}
            lines={[feederShort(bracketSize, round, slot, side)]}
            name={feederLabel(bracketSize, round, slot, side)}
            placeholder
            pairs={pairs}
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
 * The line from one match to the match it feeds: a stub out of the card, half of the bar
 * that joins it to its pair, and the stub into the next round. Each match draws its own
 * half, so a played match inks its own route while its partner's stays faint.
 *
 * `toward` is the side the next round lies on. `place` says which half of the bar is this
 * match's; a lone match (a semifinal in the mirrored shape, the final in the linear one) has
 * no bar and feeds straight across.
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

/**
 * Who won the draw. Decided, it is the one success surface on the tree; undecided, it is a quiet
 * grey line rather than a dashed box, because a dashed box is what a match nobody has played
 * looks like and this is not a match.
 */
function Champion({ champion }: { champion: string | null }) {
  return (
    <section aria-label="Champion" className="w-full">
      {champion ? (
        <div className="flex w-full items-center gap-2.5 rounded-lg border border-hairline bg-success-surface px-3 py-2 text-success-foreground">
          <Trophy className="size-5 shrink-0" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="text-t4 font-semibold">Champion</span>
            <span className="min-w-0 break-words font-display text-base font-bold leading-tight">
              {champion}
            </span>
          </span>
        </div>
      ) : (
        <div className="flex w-full items-center gap-2.5 rounded-lg bg-muted/50 px-3 py-2 text-muted-foreground">
          <Trophy className="size-4 shrink-0" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="text-t4 font-semibold text-foreground">Champion</span>
            <span className="text-t4">Decided by the final</span>
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * The shape the box has room for, measured after hydration. `linear` until then, so the server
 * and the first client render agree. A shape is never changed by data, only by the box's width.
 */
function useShape(mirroredRem: number, linearMinRem: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [shape, setShape] = useState<Shape>("linear");
  const [widthRem, setWidthRem] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const width = el.clientWidth / rem;
      setShape(width >= mirroredRem ? "mirrored" : width >= linearMinRem ? "linear" : "rounds");
      setWidthRem(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [mirroredRem, linearMinRem]);
  return [ref, shape, widthRem] as const;
}

/** Fades on the scroll box's edges while there is bracket out of view on that side. */
function useScrollEdges(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) {
      setEdges({ start: false, end: false });
      return;
    }
    const measure = () => {
      const start = el.scrollLeft > 4;
      const end = el.scrollWidth - el.scrollLeft - el.clientWidth > 4;
      setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [active]);
  return [ref, edges] as const;
}

/**
 * A single-elimination bracket. Every slot of every round is drawn, from the bracket's size
 * rather than from the rows that exist, so a draw that has only played its first round still
 * shows its whole road. A slot without a row is a dashed card naming the matches that feed it.
 */
export function KnockoutBracket({
  rounds,
  bracketSize,
  label,
  names = () => null,
  pairs = false,
  ariaLabel,
  champion,
}: {
  rounds: ReadonlyMap<number, TierDrawMatch[]>;
  bracketSize: number;
  label: Label;
  /** One line per player of an entrant. Left out, a card shows `label` on one line. */
  names?: Names;
  /** A doubles event: every side is drawn two lines tall. */
  pairs?: boolean;
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
  const minCardRem = CARD_BASE_REM + SCORE_COLUMN_REM * (mostGames - 2);
  const minColumnRem = minCardRem + ARM_REM * 2;

  // The mirrored tree has a column per side round on each side of the final; the linear one a
  // column per round and the champion's. Below two columns' width, a phone gets one round at a time.
  const mirroredRem = (roundCount - 1) * 2 * minColumnRem + minCardRem;
  const [boxRef, measured, widthRem] = useShape(mirroredRem, minColumnRem * 2);
  const shape: Shape = roundCount === 1 ? "mirrored" : measured;

  // The card width that fills the box exactly in this shape, from the shape's own column count;
  // never under the minimum (the box scrolls instead) and never past the cap.
  const gutters = shape === "mirrored" ? (roundCount - 1) * 2 : roundCount;
  const cards = shape === "mirrored" ? 2 * roundCount - 1 : roundCount + 1;
  const fitted = widthRem === null ? 0 : (widthRem - 0.5 - gutters * ARM_REM * 2) / cards;
  const cardRem = Math.min(CARD_MAX_REM, Math.max(minCardRem, fitted));
  const columnRem = cardRem + ARM_REM * 2;
  const [scrollRef, edges] = useScrollEdges(shape === "linear");

  const card = (round: number, slot: number) => {
    const match = at(round, slot);
    return match ? (
      <MatchCard match={match} bracketSize={bracketSize} label={label} names={names} pairs={pairs} />
    ) : (
      <EmptyCard bracketSize={bracketSize} round={round} slot={slot} pairs={pairs} />
    );
  };

  const heading = (text: string, align: "left" | "center" | "right") => (
    <h4
      className={cn(
        "border-b border-hairline pb-1.5 text-sm font-semibold text-muted-foreground",
        align === "center" && "text-center",
        align === "right" && "text-right",
      )}
    >
      {text}
    </h4>
  );

  /** One round's column (or half of it), each card joined toward the round it feeds. */
  const column = (
    round: number,
    slots: number[],
    toward: "right" | "left",
    half?: "top" | "bottom",
  ) => {
    const name = roundName(bracketSize, round);
    return (
      <section
        key={`${half ?? "all"}-${round}`}
        aria-label={half ? `${name}, ${half} half` : name}
        className="flex shrink-0 flex-col"
        style={{
          width: `${columnRem}rem`,
          [toward === "right" ? "paddingRight" : "paddingLeft"]: `calc(${ARM} * 2)`,
        }}
      >
        {heading(name, toward === "left" ? "right" : "left")}
        <div className="flex flex-1 flex-col">
          {slots.map((slot) => (
            <div key={slot} className="relative flex flex-1 items-center py-3">
              {card(round, slot)}
              <Connector
                toward={toward}
                place={slots.length === 1 ? "single" : slot % 2 === 1 ? "upper" : "lower"}
                played={advanced(at(round, slot))}
              />
            </div>
          ))}
        </div>
      </section>
    );
  };

  const slotList = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => from + index);
  const sideRounds = Array.from({ length: roundCount - 1 }, (_, index) => index + 1);
  const final = at(roundCount, 1);

  let body: ReactNode;
  if (shape === "rounds") {
    body = (
      <RoundTabs
        roundCount={roundCount}
        bracketSize={bracketSize}
        ariaLabel={ariaLabel}
        initial={openRound(roundCount, slotsIn, at)}
        champion={champion}
        render={(round) => (
          <ul className="space-y-3">
            {slotList(1, slotsIn(round)).map((slot) => (
              <li key={slot}>{card(round, slot)}</li>
            ))}
          </ul>
        )}
      />
    );
  } else if (shape === "mirrored") {
    body = (
      <div className="mx-auto flex min-h-80 w-max">
        {sideRounds.map((round) => column(round, slotList(1, slotsIn(round) / 2), "right", "top"))}

        <section
          aria-label={roundName(bracketSize, roundCount)}
          className="flex shrink-0 flex-col"
          style={{ width: `${cardRem}rem` }}
        >
          {heading(roundName(bracketSize, roundCount), "center")}
          {/* Three rows, the outer two equal, so the final sits exactly at the height the
              semifinals' lines arrive at, with the champion standing on it from above. */}
          <div className="grid flex-1 grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <div className="flex flex-col items-center justify-end pt-3">
              <Champion champion={champion} />
              <span
                aria-hidden
                className={cn("h-4", advanced(final) ? "w-0.5 bg-foreground" : "w-px bg-border-control/50")}
              />
            </div>
            <div>{card(roundCount, 1)}</div>
            <div />
          </div>
        </section>

        {[...sideRounds]
          .reverse()
          .map((round) =>
            column(round, slotList(slotsIn(round) / 2 + 1, slotsIn(round) / 2), "left", "bottom"),
          )}
      </div>
    );
  } else {
    body = (
      <div className="flex min-h-64 w-max">
        {[...sideRounds, roundCount].map((round) => column(round, slotList(1, slotsIn(round)), "right"))}
        <div className="flex shrink-0 flex-col" style={{ width: `${cardRem}rem` }}>
          {/* The champion's column carries no heading of its own: the card says it. The spacer
              keeps it level with the rounds beside it. */}
          <div aria-hidden className="border-b border-transparent pb-1.5 text-sm">
            &nbsp;
          </div>
          <div className="flex flex-1 items-center py-3">
            <Champion champion={champion} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="w-full">
      {shape === "rounds" ? (
        body
      ) : (
        <div className="relative">
          {/* A box that scrolls must be reachable by keyboard, or a sideways scroll is a
              mouse-only gesture; the cards inside are read-only, so the box takes the focus. */}
          <div
            ref={scrollRef}
            role="region"
            aria-label={ariaLabel}
            tabIndex={0}
            className="max-w-full overflow-x-auto rounded-md pb-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {body}
          </div>
          {/* The rounds out of view are announced by the box's own scroll; the fades are for
              the eye, which otherwise reads the last visible column as the bracket's end. */}
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-card to-transparent transition-opacity",
              edges.start ? "opacity-100" : "opacity-0",
            )}
          />
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-card to-transparent transition-opacity",
              edges.end ? "opacity-100" : "opacity-0",
            )}
          />
        </div>
      )}
    </div>
  );
}

/** The earliest round with a slot still to decide; the final once every slot is decided. */
function openRound(
  roundCount: number,
  slotsIn: (round: number) => number,
  at: (round: number, slot: number) => TierDrawMatch | undefined,
): number {
  for (let round = 1; round <= roundCount; round += 1) {
    for (let slot = 1; slot <= slotsIn(round); slot += 1) {
      const match = at(round, slot);
      if (!match || (!advanced(match) && match.status !== "void")) return round;
    }
  }
  return roundCount;
}

/**
 * One round at a time, for a box too narrow for two columns. The tabs follow the WAI-ARIA tabs
 * pattern - arrows, Home and End move between them, and only the selected one is in the tab
 * order - and open on the round still being played, which is the one a phone reader came for.
 */
function RoundTabs({
  roundCount,
  bracketSize,
  ariaLabel,
  initial,
  champion,
  render,
}: {
  roundCount: number;
  bracketSize: number;
  ariaLabel: string;
  initial: number;
  champion: string | null;
  render: (round: number) => ReactNode;
}) {
  const [selected, setSelected] = useState(initial);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const idBase = ariaLabel.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const roundList = Array.from({ length: roundCount }, (_, index) => index + 1);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowRight: selected + 1,
      ArrowLeft: selected - 1,
      Home: 1,
      End: roundCount,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const round = ((next - 1 + roundCount) % roundCount) + 1;
    setSelected(round);
    tabs.current[round - 1]?.focus();
  };

  return (
    <section aria-label={ariaLabel} className="space-y-3">
      <Champion champion={champion} />
      <div
        role="tablist"
        aria-label={`${ariaLabel} rounds`}
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto rounded-lg bg-muted/50 p-1"
      >
        {roundList.map((round) => (
          <button
            key={round}
            ref={(node) => {
              tabs.current[round - 1] = node;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${round}`}
            aria-selected={round === selected}
            aria-controls={`${idBase}-panel`}
            tabIndex={round === selected ? 0 : -1}
            onClick={() => setSelected(round)}
            className={cn(
              "min-h-11 flex-1 shrink-0 rounded-md px-3 text-sm font-semibold whitespace-nowrap",
              round === selected
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span aria-hidden>{roundCode(bracketSize, round)}</span>
            <span className="sr-only">{roundName(bracketSize, round)}</span>
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${idBase}-panel`}
        aria-labelledby={`${idBase}-tab-${selected}`}
        // The cards are read-only, so the panel itself is the stop after the tabs.
        tabIndex={0}
        className="rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <h4 className="mb-2 text-sm font-semibold text-muted-foreground">
          {roundName(bracketSize, selected)}
        </h4>
        {render(selected)}
      </div>
    </section>
  );
}
