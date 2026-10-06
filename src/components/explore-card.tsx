import { Link, useRouter } from "@tanstack/react-router";

import { RegistrationStatePill, TournamentStatusPill } from "@/components/app-shell";
import { signInSearch } from "@/lib/routing/redirect";
import type { TournamentSummary } from "@/lib/tournament/data";
import { countText, dateRangeText } from "@/lib/tournament/summary-format";

/**
 * The two action treatments, named once.
 *
 * They were written inline at each call site, which was fine while there was one action per
 * card and stopped being fine when registering gained a second spelling - the signed-in one
 * and the trip to sign in have to look like the same button, or the gate reads as a
 * different offer rather than as the same one behind a door.
 */
const ACTION_PRIMARY =
  "inline-flex min-h-11 items-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90";
const ACTION_OUTLINE =
  "inline-flex min-h-11 items-center rounded-lg border border-border-control px-5 text-sm font-semibold transition-colors hover:bg-muted";

/**
 * One tournament on Explore, drawn for somebody deciding what to follow.
 *
 * `TournamentCard` is the card for a page that works on tournaments (My Tournaments) and is
 * shared with it, so Explore draws its own: a larger title, the facts in the order a visitor
 * asks them (when, where, how big), and one primary action that matches the tournament's
 * state - follow it, see how it went, or look at the details. Registering is offered only
 * while the window is open.
 *
 * ## Registering needs a session, and the card says which one it has
 *
 * A tournament's registration form is on the participant page, which is written for
 * somebody deciding to enter - so a signed-in caller is sent there and registers. A visitor
 * has no session, and sending them to a form they cannot submit would be a longer way round
 * to a refusal, so they are sent to sign in instead, carrying the participant page as the
 * place to come back to. It is the same trip, and the same words ("Sign in to register"),
 * that the participant page itself offers a signed-out caller; the card just reaches it in
 * one hop rather than two.
 *
 * `signedIn` is a prop rather than a `useSession()` read here because the page already holds
 * the answer for its own header, and one component asking the auth store the same question
 * once per card is how the header and the cards would eventually disagree.
 *
 * Every fact still comes from the one `tournament_summary` row. The facts are a plain list
 * with `min-w-0` for the same reason as `TournamentCard`: a long venue or date range must
 * wrap instead of widening the grid cell and scrolling the page sideways on a phone.
 */
export function ExploreCard({
  summary,
  signedIn,
}: {
  summary: TournamentSummary;
  /** Whether the caller holds a session, which decides where registering leads. */
  signedIn: boolean;
}) {
  const { status } = summary;
  const action =
    status === "in_progress"
      ? { label: "Follow live scores", primary: true }
      : status === "completed"
        ? { label: "See results", primary: false }
        : { label: "View details", primary: false };

  /**
   * The participant page as a path, built by the router rather than pasted.
   *
   * `/auth`'s `redirect` is a plain string, and the participant address is a route with a
   * parameter. Writing `/tournaments/${id}` here would be a second spelling of a path the
   * route tree already owns - and the one that would go stale, because nothing type-checks
   * a template literal against a route.
   */
  const participantHref = useRouter().buildLocation({
    to: "/tournaments/$tournamentId",
    params: { tournamentId: summary.id },
  }).href;

  return (
    <article className="flex h-full min-w-0 flex-col gap-3 rounded-xl border border-hairline bg-surface p-5 shadow-panel">
      <div className="flex flex-wrap items-center gap-2">
        <TournamentStatusPill status={status} />
        {/* Only the window states that tell a visitor something the status does not: "started"
          and "completed" repeat it. */}
        {["opens_soon", "open", "closed"].includes(summary.registration_state) ? (
          <RegistrationStatePill state={summary.registration_state} />
        ) : null}
      </div>

      <h3 className="min-w-0 break-words font-display text-2xl font-bold leading-tight">
        <Link
          to="/tournaments/$tournamentId/entries"
          params={{ tournamentId: summary.id }}
          className="rounded-sm hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {summary.name}
        </Link>
      </h3>

      <ul className="min-w-0 space-y-1 text-base text-muted-foreground">
        <li className="break-words">{dateRangeText(summary.starts_at, summary.ends_at)}</li>
        <li className="break-words">{summary.venue_name || "Venue not set"}</li>
        <li className="font-score tabular-nums">
          {countText(summary.entry_count, "entry", "entries")} ·{" "}
          {countText(summary.category_count, "event", "events")}
        </li>
      </ul>

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <Link
          to="/tournaments/$tournamentId/entries"
          params={{ tournamentId: summary.id }}
          className={action.primary ? ACTION_PRIMARY : ACTION_OUTLINE}
        >
          {action.label}
        </Link>
        {summary.registration_state === "open" ? (
          signedIn ? (
            <Link
              to="/tournaments/$tournamentId"
              params={{ tournamentId: summary.id }}
              className={ACTION_PRIMARY}
            >
              Register
            </Link>
          ) : (
            <Link
              to="/auth"
              search={signInSearch(participantHref, "register")}
              className={ACTION_PRIMARY}
            >
              Sign in to register
            </Link>
          )
        ) : null}
      </div>
    </article>
  );
}
