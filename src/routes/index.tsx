import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { useMemo } from "react";

import { EmptyState, Panel, PublicShell } from "@/components/app-shell";
import { TournamentCard } from "@/components/tournament-card";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { isConfigurable } from "@/lib/auth/authorization";
import { signInSearch } from "@/lib/routing/redirect";
import {
  useCurrentTournamentPointer,
  useExploreTournaments,
  useMyTournaments,
} from "@/lib/tournament/data";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Tournova Tournament Ops" },
      {
        name: "description",
        content:
          "Run a badminton tournament from one console: entries, draws, the day's schedule and live scoring at the desk.",
      },
      { property: "og:title", content: "Tournova Tournament Ops" },
      {
        property: "og:description",
        content:
          "Run a badminton tournament from one console: entries, draws, the day's schedule and live scoring at the desk.",
      },
      { property: "og:type", content: "website" },
      { property: "twitter:card", content: "summary" },
    ],
  }),
  component: HomePage,
});

/**
 * The front door, in two readings.
 *
 * `/` serves the two audiences this app has before either of them is inside a
 * tournament, and it decides between them on one fact - whether there is a session:
 *
 *  - **Landing**, for a visitor: what Tournova is, and the two ways in. **Placeholder:**
 *    this page has not been designed yet, and its copy and layout are stand-ins to be
 *    replaced, not decisions to preserve.
 *  - **Home**, for somebody signed in: the tournament they were last working in, the rest
 *    of their own, and what else is on. This is a *resume* surface, not a catalogue -
 *    Explore is the catalogue, and it is one link away in both the nav and the panels.
 *
 * ## Why this is one route and not two
 *
 * The address is the same address for both readers, and only one of them can be true at a
 * time. Splitting it into `/` and `/home` would mean a redirect on every visit for the
 * signed-in half, and a second definition of where the app's front door is - which is the
 * defect the temporary shim was removed to avoid. It also means no link has to know who
 * it is sending somebody to.
 *
 * ## Why the session decides in the page rather than in a guard
 *
 * The session lives in the browser and this app renders on the server first, so a
 * `beforeLoad` guard would decide during server rendering, where there is never a
 * session - it would render Landing for a signed-in caller on their first paint and swap
 * the page underneath them. The check is therefore the same page-level one `/me/tournaments`
 * and `/tournaments/new` already use. The cost is that a signed-in caller sees Landing for
 * the moment before `useSession` settles, which is the same moment the header's own sign-in
 * button takes to become an email address.
 *
 * ## What Home deliberately does not repeat
 *
 * The three panels would otherwise show the same card twice or three times for a caller
 * who owns one tournament, which reads as a bug rather than as thoroughness. So each
 * panel renders what the ones above it have not: Continue holds the working tournament,
 * Your tournaments holds the caller's *other* ones, and Discover holds what is neither.
 * Each exclusion is stated in its own empty state, so nothing is silently dropped.
 */
function HomePage() {
  const { signedIn } = useSession();
  return signedIn ? <SignedInHome /> : <Landing />;
}

/**
 * PLACEHOLDER - the signed-out front door has not been designed.
 *
 * This is a stand-in, not a decision. It exists only so a visitor has somewhere to land
 * and two working ways forward: browse what is on, or sign in. The copy, the layout and
 * the explanatory panels that used to live here are all to be replaced wholesale when the
 * landing page is picked up - do not treat any of it as a pattern to copy, and do not
 * polish it. (The equivalent note is in `AGENTS.md`, under "The landing page is a
 * placeholder".)
 */
function Landing() {
  const href = useLocation({ select: (location) => location.href });

  return (
    <PublicShell
      title="Tournova"
      subtitle="A placeholder front door. The real landing page has not been designed yet; for now, browse what is on or sign in to run a tournament."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild>
          <Link to="/explore">Browse tournaments</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to="/auth" search={signInSearch(href)}>
            Sign in
          </Link>
        </Button>
      </div>
    </PublicShell>
  );
}

/**
 * The resume surface, for somebody signed in.
 *
 * Three panels, each of which knows something the ones above it do not: which tournament
 * the caller was working in, which other ones are theirs, and what else exists. All three
 * read the same summary row shape, so a tournament cannot be described one way here and
 * another way on Explore.
 */
function SignedInHome() {
  const pointer = useCurrentTournamentPointer();
  const mine = useMyTournaments();
  const discover = useExploreTournaments({});

  const pointerId = pointer.data ?? null;
  const mineRows = mine.summaries;
  /**
   * The pointer resolves to a *card* only if it is also one of the caller's own.
   *
   * `current_tournament_id()` answers with the caller's pointer and, for a caller who has
   * never chosen, with the desk default - which is somebody else's tournament. Both are
   * the same string here and only one of them is theirs, so the card is drawn from the
   * summary list the caller is actually in and the pointer is used to *find* it. S12
   * narrows the pointer to the caller's own choice; until then this keeps Home from
   * offering to resume a tournament they cannot open.
   */
  const resume = useMemo(
    () => mineRows.find((summary) => summary.id === pointerId) ?? null,
    [mineRows, pointerId],
  );

  /** Everything already on the page, so the panels below cannot repeat it. */
  const shown = useMemo(
    () => new Set([...(resume ? [resume.id] : []), ...mineRows.map((summary) => summary.id)]),
    [resume, mineRows],
  );

  const others = useMemo(
    () => mineRows.filter((summary) => summary.id !== resume?.id).slice(0, 3),
    [mineRows, resume],
  );

  const discoverRows = useMemo(
    () => (discover.data ?? []).filter((summary) => !shown.has(summary.id)).slice(0, 3),
    [discover.data, shown],
  );

  return (
    <PublicShell
      title="Home"
      subtitle="Continue where you left off, or find something else to work on."
      actions={
        <Button size="sm" asChild>
          <Link to="/tournaments/new">New tournament</Link>
        </Button>
      }
    >
      <Panel
        title="Continue"
        right={
          <Link
            to="/me/tournaments"
            className="rounded-sm text-sm font-semibold text-primary-ink underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            My tournaments
          </Link>
        }
      >
        {pointer.isLoading || mine.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading your tournaments…</p>
        ) : resume ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <li className="min-w-0">
              <TournamentCard
                summary={resume}
                actions={
                  <Button size="sm" asChild>
                    <Link to="/tournaments/$tournamentId/desk" params={{ tournamentId: resume.id }}>
                      Open the desk
                    </Link>
                  </Button>
                }
              />
            </li>
          </ul>
        ) : (
          <EmptyState
            title="No working tournament"
            hint="You are not in a tournament yet, so there is nothing to continue. Pick one of your own below, or browse what is on."
            action={
              <Button size="sm" variant="outline" asChild>
                <Link to="/explore">Explore tournaments</Link>
              </Button>
            }
          />
        )}
      </Panel>

      <Panel
        className="mt-3"
        title="Your tournaments"
        right={
          <Link
            to="/me/tournaments"
            className="rounded-sm text-sm font-semibold text-primary-ink underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            See all
          </Link>
        }
      >
        {mine.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading your tournaments…</p>
        ) : mine.isError ? (
          <p className="text-sm text-muted-foreground">
            {mine.error instanceof Error
              ? mine.error.message
              : "The read failed. Try again in a moment."}
          </p>
        ) : others.length === 0 ? (
          <EmptyState
            title={
              mineRows.length === 0 ? "You have not created a tournament" : "Nothing else to show"
            }
            hint={
              mineRows.length === 0
                ? "A tournament owns its days, courts and events. Create one and it becomes yours to run."
                : "The tournament above is the only one you own or help run so far."
            }
            action={
              mineRows.length === 0 ? (
                <Button size="sm" asChild>
                  <Link to="/tournaments/new">New tournament</Link>
                </Button>
              ) : (
                <Button size="sm" variant="outline" asChild>
                  <Link to="/me/tournaments">My tournaments</Link>
                </Button>
              )
            }
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {others.map((summary) => (
              <li key={summary.id} className="min-w-0">
                <TournamentCard
                  summary={summary}
                  actions={
                    isConfigurable(summary.status) ? (
                      <Button size="sm" variant="outline" asChild>
                        <Link
                          to="/tournaments/$tournamentId/settings"
                          params={{ tournamentId: summary.id }}
                        >
                          Setup
                        </Link>
                      </Button>
                    ) : null
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        className="mt-3"
        title="Discover"
        right={
          <Link
            to="/explore"
            className="rounded-sm text-sm font-semibold text-primary-ink underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Explore all
          </Link>
        }
      >
        {discover.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading tournaments…</p>
        ) : discover.isError ? (
          <p className="text-sm text-muted-foreground">
            {discover.error instanceof Error
              ? discover.error.message
              : "The tournament read failed. Try again in a moment."}
          </p>
        ) : discoverRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing else is on Tournova yet. There is no tournament here that you are not already
            in.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {discoverRows.map((summary) => (
              <li key={summary.id} className="min-w-0">
                <TournamentCard summary={summary} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </PublicShell>
  );
}
