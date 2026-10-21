/** Fixed round-two sources for fields divisible by four. Odd fields and crossover stay adaptive. */
import type { GeneratedPlacementMatch, PlacementEntrantRef } from "./placement";

export interface PlacementFeederSlot {
  key: string;
  sourceAKey: string;
  sourceBKey: string;
  outcome: "winner" | "loser";
}

/** Match the persisted generation_key ordering used by fetchPlacementMatches (including r1-10). */
export function placementFeederSlots(
  entrants: readonly PlacementEntrantRef[],
  roundOne: readonly GeneratedPlacementMatch[],
): PlacementFeederSlot[] {
  if (entrants.length < 4 || entrants.length % 4 !== 0) return [];
  const ordered = [...roundOne].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const active = new Set(entrants.map((e) => e.id));
  const seen = new Set(ordered.flatMap((m) => [m.entrantAId, m.entrantBId]));
  if (
    ordered.length * 2 !== entrants.length ||
    seen.size !== entrants.length ||
    [...seen].some((id) => !active.has(id)) ||
    ordered.some((m) => m.stage !== "round1") ||
    new Set(ordered.map((m) => m.key)).size !== ordered.length
  )
    return [];
  const half = ordered.length / 2;
  return (["winner", "loser"] as const).flatMap((outcome, section) =>
    ordered.slice(0, half).map((source, index) => ({
      key: `r2-${section * half + index + 1}`,
      sourceAKey: source.key,
      sourceBKey: ordered[half + index]!.key,
      outcome,
    })),
  );
}

export function resolvePlacementFeederSlots(
  slots: readonly PlacementFeederSlot[],
  roundOne: readonly GeneratedPlacementMatch[],
  winners: ReadonlyMap<string, string | null>,
): GeneratedPlacementMatch[] {
  const byKey = new Map(roundOne.map((m) => [m.key, m]));
  const side = (key: string, outcome: PlacementFeederSlot["outcome"]): string | null => {
    const match = byKey.get(key);
    const winner = winners.get(key);
    if (!match || !winner || ![match.entrantAId, match.entrantBId].includes(winner)) return null;
    return outcome === "winner"
      ? winner
      : winner === match.entrantAId
        ? match.entrantBId
        : match.entrantAId;
  };
  return slots.flatMap((slot) => {
    const a = side(slot.sourceAKey, slot.outcome);
    const b = side(slot.sourceBKey, slot.outcome);
    return a && b
      ? [
          {
            key: slot.key,
            stage: "round2" as const,
            entrantAId: a,
            entrantBId: b,
            isMakeup: false,
            isCrossover: false,
            prerequisiteKeys: [slot.sourceAKey, slot.sourceBKey],
          },
        ]
      : [];
  });
}
