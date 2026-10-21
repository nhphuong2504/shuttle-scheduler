import { Link, useRouter } from "@tanstack/react-router";

import { DemoPill, RegistrationStatePill, TournamentStatusPill } from "@/components/app-shell";
import { signInSearch } from "@/lib/routing/redirect";
import { tournamentPhase } from "@/lib/tournament/phase";
import type { TournamentSummary } from "@/lib/tournament/data";
import { countText, dateRangeText } from "@/lib/tournament/summary-format";
import { readerHomeFor } from "@/lib/tournament/reader-home";

/**
 * The two action treatments, named once.
 *
 * They were written inline at each call site, which was fine while there was one action per
 * card and stopped being fine when registering gained a second spelling - the signed-in one
 * and the trip to sign in have to look like the same button, or the gate reads as a
 * different offer rather than as the same one behind a door.
 */
const ACTION_PRIMARY =
  "inline-flex min-h-11 items-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover";
const ACTION_OUTLINE =
  "inline-flex min-h-11 items-center rounded-lg border border-border-control px-5 text-sm font-semibold transition-colors hover:bg-muted";

/**
 * The focus ring on the dark live card.
 *
 * The page's own ring is violet, which sits at about 2.8:1 against the card's near-black, under
 * the 3:1 a focus indicator needs. A light ring with an offset the colour of the card clears it
 * on every control the card holds.
 */
const ON_DARK_FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background focus-visible:ring-offset-2 focus-visible:ring-offset-foreground";

/**
 * The one way in to registering, shared by every shape of Explore row.
 *
 * Drawn only while the window is open. A signed-in caller goes to the participant page, where
 * the form is; a visitor has no session, so they are sent to sign in carrying the participant
 * page as the place to come back to - the same trip, and the same words, that the participant
 * page itself offers.
 *
 * The participant page is built by the router rather than pasted: `/auth`'s `redirect` is a
 * plain string, and the address is a route with a parameter. Writing `/tournaments/${id}` here
 * would be a second spelling of a path the route tree owns, and the one that would go stale,
 * because nothing type-checks a template literal against a route.
 */
export function RegisterAction({
  summary,
  signedIn,
  onDark = false,
}: {
  summary: TournamentSummary;
  signedIn: boolean;
  /** On the dark live card, where the default focus ring is too close to the surface. */
  onDark?: boolean;
}) {
  const className = onDark ? `${ACTION_PRIMARY} ${ON_DARK_FOCUS}` : ACTION_PRIMARY;
  const participantHref = useRouter().buildLocation({
    to: "/tournaments/$tournamentId",
    params: { tournamentId: summary.id },
  }).href;

  if (summary.registration_state !== "open") return null;
  return signedIn ? (
    <Link
      to="/tournaments/$tournamentId"
      params={{ tournamentId: summary.id }}
      className={className}
    >
      Register
    </Link>
  ) : (
    <Link to="/auth" search={signInSearch(participantHref, "register")} className={className}>
      Sign in to register
    </Link>
  );
}

/** The outline treatment, for the secondary action beside a primary one. */
export const EXPLORE_ACTION_OUTLINE = ACTION_OUTLINE;

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
  variant = "default",
}: {
  summary: TournamentSummary;
  /** Whether the caller holds a session, which decides where registering leads. */
  signedIn: boolean;
  /**
   * `live` is the dark card Explore gives to what is being played right now, so the one thing
   * a visitor may want to open this minute is not another card in a grid. It draws the same
   * facts and the same actions; only the surface differs.
   */
  variant?: "default" | "live";
}) {
  const live = variant === "live";
  const { status } = summary;
  const action =
    status === "in_progress"
      ? { label: "Follow live scores", primary: true }
      : status === "completed"
        ? { label: "See results", primary: false }
        : { label: "View details", primary: false };

  return (
    <article
      className={
        live
          ? "flex h-full min-w-0 flex-col gap-3 rounded-xl bg-foreground p-6 text-background"
          : "flex h-full min-w-0 flex-col gap-3 rounded-xl border border-hairline bg-surface p-5 shadow-panel"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <TournamentStatusPill status={status} phase={tournamentPhase(summary)} />
        {/* Only the window states that tell a visitor something the status does not: "started"
          and "completed" repeat it. */}
        {["opens_soon", "open", "closed"].includes(summary.registration_state) ? (
          <RegistrationStatePill state={summary.registration_state} />
        ) : null}
        {/*
          Last in the row, because it qualifies the two pills before it rather than joining
          them: the status and the window are what this tournament is doing, and this says
          that the tournament doing it is a stand-in. On the dark live card it takes light ink
          and a lighter dash, since the neutral grey it uses on a white card is under 3:1
          against the near-black one.
        */}
        {summary.is_demo ? (
          <DemoPill className={live ? "text-background/80 border-background/40" : undefined} />
        ) : null}
      </div>

      <h3 className="min-w-0 break-words font-display text-2xl font-bold leading-tight">
        <Link
          to={readerHomeFor(summary.status)}
          params={{ tournamentId: summary.id }}
          className={
            live
              ? "rounded-sm text-background hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-live-chip focus-visible:ring-offset-2 focus-visible:ring-offset-foreground"
              : "rounded-sm hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          }
        >
          {summary.name}
        </Link>
      </h3>

      <ul
        className={
          live
            ? "min-w-0 space-y-1 text-base text-background/80"
            : "min-w-0 space-y-1 text-base text-muted-foreground"
        }
      >
        <li className="break-words">{dateRangeText(summary.starts_at, summary.ends_at)}</li>
        <li className="break-words">{summary.venue_name || "Venue not set"}</li>
        <li className="font-score tabular-nums">
          {countText(summary.entry_count, "entry", "entries")},{" "}
          {countText(summary.category_count, "event", "events")}
        </li>
      </ul>

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <Link
          to={readerHomeFor(summary.status)}
          params={{ tournamentId: summary.id }}
          className={
            live
              ? `inline-flex min-h-11 items-center rounded-lg bg-state-live-chip px-5 text-sm font-semibold text-state-live-ink transition-colors hover:brightness-95 ${ON_DARK_FOCUS}`
              : action.primary
                ? ACTION_PRIMARY
                : ACTION_OUTLINE
          }
        >
          {action.label}
        </Link>
        <RegisterAction summary={summary} signedIn={signedIn} onDark={live} />
      </div>
    </article>
  );
}
