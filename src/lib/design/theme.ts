/**
 * Theme resolution.
 *
 * Two themes exist and both are solved independently in the stylesheet; this module
 * decides which one is in effect. It is modelled on `density.ts` and deliberately
 * not merged with it, because the two preferences answer different questions and
 * have different fallbacks:
 *
 *   Density  "how much can I fit on this screen?"   Operational - it is a property
 *            of the *task*. The Desk is a dense list, so Compact is its default, and
 *            the default is therefore a function of the route.
 *
 *   Theme    "what can I see in this room?"        Environmental - it is a property
 *            of the *place*. A dim hall and a bright hall are the same task with
 *            different lighting, so the fallback is the operating system's setting
 *            and the route has no opinion at all.
 *
 * Sharing one module for both would have forced one of those two fallbacks onto the
 * other, and the route-shaped answer is simply wrong for theme: navigating to the
 * Desk must never change the lighting. Keeping them apart also means a bug in either
 * resolution rule cannot silently change the other preference, and it is why there
 * is no `defaultThemeFor(pathname)` below - the absence is the design.
 *
 * An explicit choice is stored; the absence of one is not. There is no stored value
 * meaning "follow the system", because that state is already spelled by having
 * nothing stored - so choosing System is the same operation as choosing nothing, and
 * the operator can always get back to it.
 *
 * Kept pure and free of browser APIs so the precedence rule is testable without a
 * DOM, and so the same rule can be shared with the pre-hydration script.
 */

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "tournova.theme";

/**
 * The class the stylesheet keys its dark tokens off. `.dark` is declared in
 * `styles.css` and the `dark:` variant is already wired to it, so this is a switch
 * being thrown rather than a convention being invented.
 */
export const DARK_CLASS = "dark";

/** The media query whose result is the fallback when no choice has been made. */
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/** Storage may hold anything, including values from an older build. */
export function parseStoredTheme(raw: string | null | undefined): Theme | null {
  return isTheme(raw) ? raw : null;
}

/**
 * The effective theme.
 *
 * A stored choice always wins, whatever the system says. This is the precedence rule
 * the module exists to encode: once an operator has said "dark" in a bright room,
 * resizing the window or arriving after sunset must not overrule them.
 *
 * Note the absence of a pathname parameter. Density needs one because its default is
 * a route; theme's default is the environment, so there is nothing for a route to
 * contribute - and passing one would invite exactly the coupling this module is
 * shaped to avoid.
 */
export function resolveTheme(stored: Theme | null, systemPrefersDark: boolean): Theme {
  return stored ?? (systemPrefersDark ? "dark" : "light");
}
