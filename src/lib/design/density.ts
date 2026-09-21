/**
 * Density resolution.
 *
 * Two modes exist and both are real: Comfortable is the general default, Compact
 * is the Desk default. "Default" here means *the value used when the operator has
 * expressed no preference* - it is not a value written on the operator's behalf.
 *
 * That distinction is the whole point of this module. The obvious implementation
 * of "the Desk is compact by default" is to call `setDensity("compact")` when the
 * Desk mounts, which writes to storage, and from that moment the operator's
 * absence of a choice has been converted into a choice they cannot undo by
 * navigating away. Resolving the default at read time instead keeps the two
 * states - "I chose compact" and "I am on the Desk" - separate, so an explicit
 * preference always survives.
 *
 * Kept pure and free of browser APIs so the precedence rules are testable without
 * a DOM, and so the same function can be shared with the pre-hydration script.
 */

export type Density = "comfortable" | "compact";

export const DENSITY_STORAGE_KEY = "tournova.density";

/**
 * Routes whose default is Compact.
 *
 * These are the dense operational lists - the live court board and the score
 * list. Mirrored into the pre-hydration script in `__root.tsx`, which cannot
 * import this module; that script is injected with this array rather than
 * restating it, so there is still one source of truth.
 */
export const DESK_PATHS = ["/", "/matches"] as const;

export function isDensity(value: unknown): value is Density {
  return value === "comfortable" || value === "compact";
}

/** Storage may hold anything, including values from an older build. */
export function parseStoredDensity(raw: string | null | undefined): Density | null {
  return isDensity(raw) ? raw : null;
}

/** `/matches/` and `/matches` are the same route. */
function normalizePathname(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** The density a route uses when no preference has been expressed. */
export function defaultDensityFor(pathname: string): Density {
  return (DESK_PATHS as readonly string[]).includes(normalizePathname(pathname))
    ? "compact"
    : "comfortable";
}

/**
 * The effective density.
 *
 * A stored preference always wins, whatever route it was chosen on. This is the
 * precedence rule the whole module exists to encode: an explicit choice is never
 * overridden by a route default.
 */
export function resolveDensity(stored: Density | null, pathname: string): Density {
  return stored ?? defaultDensityFor(pathname);
}
