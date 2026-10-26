/**
 * The five standard events, and the order they are presented in.
 *
 * Badminton has a conventional order for them - the singles first, then the doubles, with the
 * men's event ahead of the women's - and it is the order setup offers them in. That is a
 * different fact from `categories.sort_order`, which records the order the organiser pressed
 * the toggles: a tournament built by adding WS before MS stores WS at 1, and any screen that
 * reads `sort_order` alone lists women's singles first. The placement stage lists *events*,
 * not one fixture, so it uses this order rather than the insertion one.
 *
 * Event codes are not constrained to these five, so `compareEventOrder` keeps anything else
 * after them, in its own configured order, rather than dropping it or refusing to sort.
 */
export interface StandardEvent {
  code: string;
  name: string;
  entryType: "individual" | "pair";
  gender: "men" | "women" | "mixed" | "open";
}

export const STANDARD_EVENTS: readonly StandardEvent[] = [
  { code: "MS", name: "Men's Singles", entryType: "individual", gender: "men" },
  { code: "WS", name: "Women's Singles", entryType: "individual", gender: "women" },
  { code: "MD", name: "Men's Doubles", entryType: "pair", gender: "men" },
  { code: "WD", name: "Women's Doubles", entryType: "pair", gender: "women" },
  { code: "XD", name: "Mixed Doubles", entryType: "pair", gender: "mixed" },
];

const RANK = new Map(STANDARD_EVENTS.map((event, index) => [event.code, index]));

/** Where a code sits in the standard order; `STANDARD_EVENTS.length` when it is not one of them. */
export function eventRank(code: string): number {
  return RANK.get(code) ?? STANDARD_EVENTS.length;
}

/** The standard order first, then anything else by its configured order, then by code. */
export function compareEventOrder(
  a: { code: string; sort_order: number },
  b: { code: string; sort_order: number },
): number {
  return (
    eventRank(a.code) - eventRank(b.code) ||
    a.sort_order - b.sort_order ||
    a.code.localeCompare(b.code)
  );
}
