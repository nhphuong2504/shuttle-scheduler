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

/**
 * Compare two events by **id**, for a surface that has grouped its rows and kept only the key.
 *
 * A panel list built by walking matches knows the category id but not the event behind it, so it
 * cannot call `compareEventOrder` without a lookup. This is that lookup, stated once. An id that
 * resolves to nothing sorts last rather than first: on a screen the usual reason for one is a
 * category that has not loaded yet, and putting it at the top would make the list jump as data
 * arrives.
 */
export function compareEventIds(
  a: string | null | undefined,
  b: string | null | undefined,
  eventFor: (id: string) => { code: string; sort_order: number } | undefined,
): number {
  const eventA = a ? eventFor(a) : undefined;
  const eventB = b ? eventFor(b) : undefined;
  if (!eventA && !eventB) return 0;
  if (!eventA) return 1;
  if (!eventB) return -1;
  return compareEventOrder(eventA, eventB);
}
