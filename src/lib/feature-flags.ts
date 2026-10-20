/**
 * Features that are built but not yet offered.
 *
 * Read once, at build time, from a `VITE_` variable: off unless the build sets it to "1". A flag
 * holds back UI whose feature is not finished, so production never shows a control that does
 * nothing. It is not a secret and not an access rule - a `VITE_` value is compiled into the
 * client bundle, and every gate on who may do what still lives on the server.
 */

/**
 * The Desk's "Call next" button and its dialog. The layout is built; sending a message to a
 * player is not, so it stays off until it is. The browser suite turns it on (see
 * `playwright.config.ts`) so the layout is checked while it waits.
 */
export const NOTIFY_PLAYERS_ENABLED = import.meta.env["VITE_FEATURE_NOTIFY_PLAYERS"] === "1";
