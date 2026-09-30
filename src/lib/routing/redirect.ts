/**
 * The address a sign-in returns to, and the rules that decide whether it may be one.
 *
 * A return address is a *query parameter*, which means it is written by whoever composed
 * the link - including a person hand-editing an address they copied from somewhere. Sent
 * to a router or a navigator unchecked, it is the classic open redirect: the sign-in page
 * is a trusted address, so a link to it that bounces onward to another origin is a
 * credible-looking way to hand somebody a phishing page. So the value is validated to a
 * **local path** and nothing else.
 *
 * ## The rules, and why each one is here
 *
 *  1. It must be a string that starts with `/`. Anything else - `https://…`, `javascript:`,
 *     `data:` - is not a path in this app.
 *  2. It must not start with `//`. That is a *protocol-relative* URL: the browser reads
 *     `//host/path` as `https://host/path`, and TanStack Router treats it as an absolute
 *     address and reloads the document at it. One leading slash, and a second one is a
 *     different origin.
 *  3. It must contain no backslash. The URL Standard normalises `\` to `/`, so `/\host` is
 *     `//host` to everything that parses URLs - including intermediate hops that check
 *     *before* this one.
 *  4. It must contain no control character. ASCII tab, newline and carriage return are
 *     **removed** from a URL before it is parsed, so `/<TAB>/host` is also `//host`, and
 *     the same trick works with `%09` decoded by anybody who decodes before validating.
 *  5. It must not be the sign-in page itself. A return to `/auth` is not a return: it is a
 *     loop, and it is the one address this app's own sign-in affordances would otherwise
 *     produce, because the shell that offers "Sign in" is rendered on the sign-in page too.
 *
 * The default for a rejected value is *no redirect at all*, which sends the caller to Home.
 * Dropping the parameter is deliberately preferred to repairing it: a repaired address is
 * still somebody else's path, while the absence of one is a page this app chose.
 *
 * The query and the fragment are allowed (`/explore?q=final`, `/draws#top`) because they
 * are part of a real page's address - a filter in the URL is worth returning to - and they
 * cannot change the origin of a path that already passed the rules above.
 */

/** The path the sign-in page itself lives at. */
const AUTH_PATH = "/auth";

/** ASCII control characters, which a URL parser strips before parsing. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * A local path, or nothing.
 *
 * Exported because there are two sides to the parameter and they must agree: the route
 * validates what it *receives*, and `signInSearch` validates what it *writes*. One
 * function, so a rule added here applies to both at once.
 */
export function localRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/")) return undefined;
  if (value.startsWith("//")) return undefined;
  if (value.includes("\\")) return undefined;
  if (CONTROL_CHARACTERS.test(value)) return undefined;
  if (value.split(/[?#]/, 1)[0] === AUTH_PATH) return undefined;
  return value;
}

/**
 * The search a sign-in link carries, so the caller comes back to the page they left.
 *
 * The shape is the auth route's own search schema - the route builds its `validateSearch`
 * result into this type - and it is one optional key: with a usable return address the link
 * carries it, and without one the link carries nothing. That is why this returns an object
 * to spread into `search` rather than a string: the caller cannot accidentally pass an
 * unvalidated address, because it never sees the parameter name.
 */
export interface SignInSearch {
  redirect?: string;
}

/**
 * Where a sign-in lands when there is no return address.
 *
 * Home, rather than a flat operational path: it is the page that resumes whatever the
 * caller was working in, and it is the one address that exists for a session that has not
 * chosen a tournament yet. It is a constant because two functions have to agree about it -
 * the one that decides where a sign-in lands, and the one that decides whether a link
 * needs to say where to go at all.
 */
export const SIGNED_IN_HOME = "/" as const;

/**
 * The return address for a link to `/auth`, as the `search` its route accepts.
 *
 * `returnTo` is usually `useLocation().href` - the page the reader is on - which is always
 * local, and is validated anyway: the sign-in page is reached from an address a person can
 * edit, so the *writer* must not be the only thing standing between a hand-edited link and
 * an open redirect.
 *
 * An address that is already where a bare sign-in lands is not written down. A parameter
 * that changes nothing is still a parameter: it lengthens every address on the front door
 * and in the public nav to say what the default already says. The two are kept in step by
 * `SIGNED_IN_HOME` rather than by a literal here, so this cannot drift from the fallback it
 * is comparing against.
 */
export function signInSearch(returnTo: string): SignInSearch {
  const redirect = localRedirect(returnTo);
  if (redirect === undefined || redirect === SIGNED_IN_HOME) return {};
  return { redirect };
}

/**
 * Where a sign-in or sign-up lands.
 *
 * `undefined` is spelled into the property type deliberately rather than left to the
 * optional marker, because this takes `Route.useSearch()`'s result directly and that result
 * is `{ redirect: string | undefined }` under `exactOptionalPropertyTypes`. Without it every
 * call site would have to rebuild the object to narrow the key away.
 */
export function signedInDestination(search: { redirect?: string | undefined }): string {
  return search.redirect ?? SIGNED_IN_HOME;
}
