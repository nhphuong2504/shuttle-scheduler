import type { PlacementMatch } from "./data";

/** Existing compact event/round tag. The surface owns any Next/time prefix.
 * Pairing flags only affect the explanation, never the surrounding tile wording.
 */
export function placementMatchLabel(stage: string, code?: string): string {
  return [code, stage === "round1" ? "R1" : "R2"].filter(Boolean).join(" ");
}

export type PlacementMatchContext =
  | { kind: "both-in-round-two"; heldSide: "a" | "b" | null }
  | { kind: "different-round-one-results" };

type PresentationMatch = Pick<
  PlacementMatch,
  "stage" | "category_id" | "is_makeup" | "is_crossover" | "entrant_a_id" | "entrant_b_id"
>;

export function placementMatchContext(
  match: PresentationMatch,
  matches: readonly PresentationMatch[],
): PlacementMatchContext | null {
  if (match.stage !== "round2") return null;
  if (match.is_makeup) {
    const roundOne = matches.filter(
      (m) => m.category_id === match.category_id && m.stage === "round1",
    );
    const played = new Set(roundOne.flatMap((m) => [m.entrant_a_id, m.entrant_b_id]));
    const aHeld = !played.has(match.entrant_a_id);
    const bHeld = !played.has(match.entrant_b_id);
    // Incomplete data must not turn the opponent into the entrant held out of round one.
    const heldSide = roundOne.length && aHeld !== bHeld ? (aHeld ? "a" : "b") : null;
    return { kind: "both-in-round-two", heldSide };
  }
  return match.is_crossover ? { kind: "different-round-one-results" } : null;
}

export function placementMatchExplanation(
  context: PlacementMatchContext | null | undefined,
  nameA: string,
  nameB: string,
): string | null {
  if (!context) return null;
  if (context.kind === "different-round-one-results") {
    return "This placement match pairs a Round 1 winner with a Round 1 loser so both can complete their placement matches. The result counts towards draw assignment.";
  }
  const held = context.heldSide === "a" ? nameA : context.heldSide === "b" ? nameB : "one entrant";
  return `Because the field had an odd number of entrants, ${held} did not play in Round 1 and plays both placement matches in Round 2. Both matches count towards draw assignment.`;
}
