import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { useSession } from "@/hooks/useSession";
import { signInSearch, type SignInIntent } from "@/lib/routing/redirect";

/**
 * Sends a caller with no session to the sign-in page, and says why.
 *
 * The two addresses that need this - the create flow and My Tournaments - need it for the
 * same reason: each is a page whose whole content is somebody's own work, so a caller
 * without a session has nothing to read there. `/tournaments/new` is the sharper case of the
 * two, because the database refuses to create a tournament for an anonymous caller and the
 * sign-up path is open on purpose; either way the useful thing to hand a visitor is the way
 * in, not a notice saying a way in exists.
 *
 * ## Three properties, and each one is a bug that was found rather than a precaution
 *
 * **Nothing happens before `ready`.** The session is read from the browser, and this app
 * renders on the server first - where there is never a session. Acting on the first
 * `signedIn === false` would bounce a signed-in caller to the sign-in page on their first
 * paint, so the wizard would never be reachable by a link. A `beforeLoad` guard has the same
 * defect for the same reason, which is why this is an effect in the page.
 *
 * **The trip is made once.** `navigate` moves the location, and the page reads the location -
 * so an effect that depends on it re-runs against its own result. The second run is not
 * harmless: by then this page's address *is* `/auth`, and `/auth` is the one return address
 * `localRedirect` refuses (a return to the sign-in page is a loop), so `signInSearch` answers
 * `{}` and the second navigation wipes the `redirect` and `intent` the first one wrote. The
 * visitor lands on a bare sign-in page having been told nothing, and the page they left is
 * no longer where signing in takes them.
 *
 * **`replace`, not a push.** A Back button that landed here again would only redirect again,
 * so the entry the caller came from is the one worth keeping.
 *
 * ## Why the notice is neutral rather than an error
 *
 * `--destructive` and its family mean an act that destroys competition data, or a match that
 * has overrun. Being asked to sign in is neither, and the design system's rule is that a hue
 * appears only where it carries a meaning. It is also the difference between a notice that
 * passes and one that does not: the red toast measured 4.4:1 against its own fill, under the
 * floor, which is why `styles.css` carries the app's own palette for it.
 *
 * `notice` is the *reason*, said at the moment of the redirect. What happens *next* - which
 * page the caller ends up on - is the sign-in page's to say, from the `intent`; see
 * `signInIntentText`. A page with no errand to name passes no intent and gets the generic
 * sentence, which is what that default is for.
 */
export function useSignInRedirect({
  notice,
  intent,
}: {
  /** The reason, in the page's own words, shown once as the caller is sent away. */
  notice: string;
  /** The errand, if this page has one the sign-in page can name a destination for. */
  intent?: SignInIntent;
}): void {
  const navigate = useNavigate();
  const { signedIn, ready } = useSession();
  const href = useLocation({ select: (location) => location.href });
  const sentToSignIn = useRef(false);

  useEffect(() => {
    if (!ready || signedIn || sentToSignIn.current) return;
    sentToSignIn.current = true;
    toast(notice);
    void navigate({ to: "/auth", search: signInSearch(href, intent), replace: true });
  }, [ready, signedIn, href, navigate, notice, intent]);
}
