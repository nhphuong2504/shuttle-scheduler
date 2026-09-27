/**
 * Theme resolution.
 *
 * Two themes exist and both are solved independently in the stylesheet; this module
 * decides which one is in effect. The preference answers an environmental question -
 * "what can I see in this room?" - rather than an operational one. A dim hall and a
 * bright hall are the same task under different lighting, so the fallback is the
 * operating system's setting and the route has no opinion at all. That is why there
 * is no `defaultThemeFor(pathname)` below: the absence is the design, because
 * navigating to the Desk must never change the lighting.
 *
 * An explicit choice is stored; the absence of one is not. There is no stored value
 * meaning "follow the system", because that state is already spelled by having
 * nothing stored. That absence is the only thing that hands the decision to the
 * system, and nothing in the app creates it again once a choice exists — the
 * appearance control offers the two themes and no reset — so the system governs a
 * first visit and the first theme chosen after it is the one that sticks.
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
 * Note the absence of a pathname parameter. The default is the environment, so there
 * is nothing for a route to contribute - and passing one would invite exactly the
 * coupling this module is shaped to avoid.
 */
export function resolveTheme(stored: Theme | null, systemPrefersDark: boolean): Theme {
  return stored ?? (systemPrefersDark ? "dark" : "light");
}
