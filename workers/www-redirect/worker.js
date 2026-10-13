/**
 * The `www` address, redirected to the app's canonical host.
 *
 * ## Why this is its own Worker rather than a rule on the zone
 *
 * A redirect belongs at the edge for an alias like this, and Cloudflare has two native
 * places to put one: a zone Redirect Rule, or the main application Worker. Neither was
 * available:
 *
 *  - **Zone rules are out of reach.** The deployment token can publish Workers and nothing
 *    else - every redirect phase on the zone answers `403 10000 Authentication error`. So a
 *    Redirect Rule would have to be created by hand in the dashboard, which is exactly the
 *    arrangement this file exists to avoid: an address that survives every rebuild while
 *    nothing in the repository explains where it comes from.
 *  - **The application Worker cannot cover this.** It is deployed with a static-assets
 *    binding, and Workers serve a matching asset *without invoking the script*. A host check
 *    in its `fetch` would therefore redirect `/` and leave `/assets/*`, `/brand/*` and every
 *    other real file answering on `www`. A redirect that covers most paths is worse than none,
 *    because the leak is invisible until something links to a file.
 *
 * A Worker with no assets bound has no such hole: every request reaches this handler, so
 * every path and query redirects, including the hashed asset URLs and the `/?code=...`
 * callback an email link can land on.
 *
 * ## Why 301 and not 308
 *
 * 301 is the permanent redirect an alias wants, and browsers settle on it. 308 would also
 * preserve the method, which matters for a `POST` - but nothing posts to the alias: `www` is
 * a typed address and an old link, and the app's only writes come from pages a user has
 * already reached on the canonical host. Trading the cache behaviour of the status every
 * tool expects for method preservation nothing here needs is the wrong direction.
 *
 * ## The target is a constant, not a variable
 *
 * There is one canonical host, and it is stated here the way the main Worker's name is
 * stated in `vite.config.ts` - so the address is reviewable in the repository rather than
 * discovered from a dashboard. A `[vars]` entry would let a deploy retarget the redirect
 * without a diff, which is the failure mode, not the flexibility.
 */

/** The one address the app is served on. Everything else that reaches here is an alias. */
const CANONICAL_HOST = "tournova.app";

export default {
  fetch(request) {
    const url = new URL(request.url);

    // Nothing to do if this Worker is ever reached on the canonical host itself - which
    // would be a misconfigured route, and a redirect to ourselves is a loop.
    if (url.hostname === CANONICAL_HOST) {
      return new Response("This Worker serves the www alias only.", { status: 404 });
    }

    // Only the authority moves. The path, the query and any `/%20`-style encoding are
    // carried over untouched, which is what makes this safe for an auth callback: Supabase
    // appends `?code=...` or `#access_token=...` to the address it was given, and both
    // survive a redirect the browser performs.
    url.protocol = "https:";
    url.hostname = CANONICAL_HOST;
    url.port = "";

    return Response.redirect(url.toString(), 301);
  },
};
