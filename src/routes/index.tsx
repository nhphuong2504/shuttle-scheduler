import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useMemo } from "react";

import { PublicShell, TournamentStatusPill } from "@/components/app-shell";
import { Landing } from "@/components/landing/landing";
import { ExploreCard, RegisterAction } from "@/components/explore-card";
import { useSession } from "@/hooks/useSession";
import { isConfigurable } from "@/lib/auth/authorization";
import { phaseReminder, tournamentPhase } from "@/lib/tournament/phase";
import {
  useExploreTournaments,
  useMyTournaments,
  usePendingRegistrationCounts,
  type TournamentSummary,
} from "@/lib/tournament/data";
import { countText, shortDays } from "@/lib/tournament/summary-format";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Tournova Tournament Ops" },
      {
        name: "description",
        content:
          "Run a tournament day from one desk: every court, the next match, and a schedule that keeps up when the day runs late.",
      },
      { property: "og:title", content: "Tournova Tournament Ops" },
      {
        property: "og:description",
        content:
          "Run a tournament day from one desk: every court, the next match, and a schedule that keeps up when the day runs late.",
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
 *  - **Landing**, for a visitor: the Desk, the schedule behind it, and the ways in -
 *    run a tournament, browse what is on, or sign in. It lives in `components/landing/`.
 *  - **Home**, for somebody signed in: what needs them now, the tournaments they run or
 *    help run, and what is open to enter. This is a *resume* surface, not a catalogue -
 *    Explore is the catalogue, and it is one link away in both the nav and the page.
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
 * A tournament appears once as a card, under the role the caller holds in it: Running for the
 * ones they own, Helping for the ones they were added to. The attention list above them names a
 * tournament again, but as a *task* ("3 requests are waiting"), which is a different thing to
 * be shown. The strip of tournaments open to enter leaves out every one the caller already
 * runs or helps with.
 */
function HomePage() {
  const { signedIn } = useSession();
  return signedIn ? <SignedInHome /> : <Landing />;
}

/**
 * The signed-in front door: what needs you, then where you take part.
 *
 * The list of tournaments is the second thing on the page, not the first. A person who
 * runs one wants to know whether anything is waiting on them before they want to find the
 * card, so the top of the page is a short list of *tasks*, each with the one action that
 * clears it, and it is absent altogether when there are none.
 *
 * The tasks are derived from reads that already exist and are public to the caller: the
 * summary rows say which tournaments are live and which the caller may edit, and the
 * reviewer's queue says how many requests wait in each. Tasks the caller has as a
 * *participant* - a request decided, a match on a court - need a read across every tournament
 * that does not exist yet, so they are not drawn rather than drawn from a guess.
 */
function SignedInHome() {
  const { session } = useSession();
  const mine = useMyTournaments();
  const openToEnter = useExploreTournaments({ status: "upcoming" });
  const live = useExploreTournaments({ status: "in_progress" });

  const rows = mine.summaries;
  const running = useMemo(() => rows.filter((row) => mine.ownedIds.has(row.id)), [rows, mine.ownedIds]);
  const helping = useMemo(
    () => rows.filter((row) => !mine.ownedIds.has(row.id) && mine.editorIds.has(row.id)),
    [rows, mine.ownedIds, mine.editorIds],
  );
  const operated = useMemo(() => [...running, ...helping], [running, helping]);
  const waiting = usePendingRegistrationCounts(operated.map((row) => row.id));

  const tasks = useMemo(() => {
    const out: HomeTask[] = [];
    for (const row of operated) {
      const role = mine.ownedIds.has(row.id) ? "You run this" : "You help run this";
      const pending = waiting.get(row.id) ?? 0;
      if (pending > 0) {
        out.push({
          key: `requests-${row.id}`,
          kind: "requests",
          mark: String(pending),
          title: `${countText(pending, "registration request", "registration requests")} ${
            pending === 1 ? "is" : "are"
          } waiting for a decision`,
          role,
          where: row.name,
          action: { label: "Review requests", id: row.id, to: "registrations" },
        });
      }
    }
    // The two reminders: a tournament that should have begun with no match started, and one
    // past its last day that nobody has completed. Neither is moved by being shown here.
    for (const row of operated) {
      const phase = tournamentPhase(row);
      const reminder = phaseReminder(phase, row.name);
      if (!reminder) continue;
      out.push({
        key: `reminder-${row.id}`,
        kind: "reminder",
        mark: "!",
        title: reminder,
        role: mine.ownedIds.has(row.id) ? "You run this" : "You help run this",
        where: [shortDays(row.starts_at, row.ends_at), row.venue_name].filter(Boolean).join(", "),
        action:
          phase === "not_started"
            ? { label: "Open the Desk", id: row.id, to: "desk" }
            : { label: "Complete it", id: row.id, to: "settings" },
      });
    }
    for (const row of operated) {
      if (tournamentPhase(row) !== "live") continue;
      out.push({
        key: `live-${row.id}`,
        kind: "live",
        mark: "",
        title: `${row.name} is live`,
        role: mine.ownedIds.has(row.id) ? "You run this" : "You help run this",
        where: [shortDays(row.starts_at, row.ends_at), row.venue_name].filter(Boolean).join(", "),
        action: { label: "Open the Desk", id: row.id, to: "desk" },
      });
    }
    return out;
  }, [operated, mine.ownedIds, waiting]);

  const yours = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const enterable = useMemo(
    () =>
      (openToEnter.data ?? [])
        .filter((row) => row.registration_state === "open" && !yours.has(row.id))
        .slice(0, 3),
    [openToEnter.data, yours],
  );
  const happening = (live.data ?? []).find((row) => !yours.has(row.id)) ?? null;

  const loaded = !mine.isLoading;
  const newAccount = loaded && !mine.isError && rows.length === 0;

  return (
    <PublicShell
      title={newAccount ? "Welcome to Tournova" : "Welcome back"}
      subtitle={
        newAccount
          ? "Your account is ready. Pick what you want to do first; you can do all three, any time."
          : "Here is what needs you, and the tournaments you run."
      }
    >
      {mine.isLoading ? (
        <p className="text-base text-muted-foreground">Loading your tournaments…</p>
      ) : mine.isError ? (
        <div role="alert" className="rounded-xl border border-danger-border bg-danger-surface p-6">
          <h2 className="font-display text-xl font-bold text-danger-foreground">
            Couldn't load your tournaments
          </h2>
          <p className="mt-2 text-base">
            {mine.error instanceof Error && mine.error.message
              ? mine.error.message
              : "Your connection may have dropped. Try again in a moment."}
          </p>
        </div>
      ) : newAccount ? (
        <FirstSteps email={session?.userEmail ?? null} happening={happening} />
      ) : (
        <div className="space-y-9">
          {tasks.length > 0 ? <Attention tasks={tasks} /> : null}

          <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="space-y-9">
              {running.length > 0 ? (
                <HomeGroup heading="Running" rows={running} role="owner" />
              ) : null}
              {helping.length > 0 ? (
                <HomeGroup heading="Helping" rows={helping} role="editor" />
              ) : null}
            </div>

            <aside aria-labelledby="home-open" className="space-y-3">
              <h2 id="home-open" className="font-display text-xl font-bold">
                Open for registration
              </h2>
              {enterable.length === 0 ? (
                <p className="text-base text-muted-foreground">
                  Nothing is open to enter right now.
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {enterable.map((row) => (
                    <li
                      key={row.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-hairline bg-surface px-4 py-3"
                    >
                      <div className="min-w-0">
                        <Link
                          to="/tournaments/$tournamentId/entries"
                          params={{ tournamentId: row.id }}
                          className="block break-words font-display text-base font-bold hover:text-primary-ink"
                        >
                          {row.name}
                        </Link>
                        <p className="break-words text-sm text-muted-foreground">
                          {[shortDays(row.starts_at, row.ends_at), row.venue_name]
                            .filter(Boolean)
                            .join(", ")}
                        </p>
                      </div>
                      <RegisterAction summary={row} signedIn />
                    </li>
                  ))}
                </ul>
              )}
              <Link
                to="/explore"
                className="inline-flex min-h-11 items-center rounded-sm text-sm font-semibold text-primary-ink hover:underline"
              >
                Browse all tournaments →
              </Link>
            </aside>
          </div>
        </div>
      )}
    </PublicShell>
  );
}

interface HomeTask {
  key: string;
  kind: "requests" | "live" | "reminder";
  /** The figure drawn in the tile, for a task that is a count. */
  mark: string;
  title: string;
  role: string;
  where: string;
  action: { label: string; id: string; to: "registrations" | "desk" | "settings" };
}

/**
 * The tasks, one row each, with the one action that clears it.
 *
 * The role label says why a task is the caller's: somebody who runs a tournament and somebody
 * who was added to it are told different things about the same card, and neither is told they
 * run something they only help with.
 */
function Attention({ tasks }: { tasks: HomeTask[] }) {
  return (
    <section aria-labelledby="home-attention">
      <h2
        id="home-attention"
        className="mb-3 flex items-center gap-2.5 font-display text-xl font-bold"
      >
        Needs your attention
        <span className="rounded-full bg-secondary px-2.5 py-0.5 font-body text-sm font-semibold text-muted-foreground tabular-nums">
          {tasks.length}
        </span>
      </h2>
      <ul className="space-y-2.5">
        {tasks.map((task) => (
          <li
            key={task.key}
            className="grid items-center gap-x-4 gap-y-3 rounded-xl border border-hairline bg-surface p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
          >
            <div className="flex items-start gap-4 sm:contents">
              {task.kind === "requests" || task.kind === "reminder" ? (
                <span
                  aria-hidden="true"
                  className="grid size-11 shrink-0 place-items-center rounded-xl bg-warn-surface font-display text-lg font-extrabold text-warn-foreground tabular-nums"
                >
                  {task.mark}
                </span>
              ) : (
                <span
                  aria-hidden="true"
                  className="grid size-11 shrink-0 place-items-center rounded-xl bg-state-live-chip"
                >
                  <span className="size-3 rounded-full bg-state-live-ink" />
                </span>
              )}
              <div className="min-w-0">
                <p className="break-words text-base font-bold">{task.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span className="rounded-full bg-muted px-2.5 py-0.5 text-sm font-semibold text-muted-foreground ring-1 ring-inset ring-hairline">
                    {task.role}
                  </span>
                  <span className="break-words">{task.where}</span>
                </p>
              </div>
            </div>
            {task.action.to === "desk" ? (
              <Link
                to="/tournaments/$tournamentId/desk"
                params={{ tournamentId: task.action.id }}
                className={PRIMARY}
              >
                {task.action.label}
              </Link>
            ) : task.action.to === "settings" ? (
              <Link
                to="/tournaments/$tournamentId/settings"
                params={{ tournamentId: task.action.id }}
                className={PRIMARY}
              >
                {task.action.label}
              </Link>
            ) : (
              <Link
                to="/tournaments/$tournamentId/registrations"
                params={{ tournamentId: task.action.id }}
                className={PRIMARY}
              >
                {task.action.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover";
const OUTLINE =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-border-control px-4 text-sm font-semibold transition-colors hover:bg-muted";

/** One role's tournaments, as cards that lead to the work that role does in them. */
function HomeGroup({
  heading,
  rows,
  role,
}: {
  heading: string;
  rows: TournamentSummary[];
  role: "owner" | "editor";
}) {
  return (
    <section aria-label={heading}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-xl font-bold">
          {heading}{" "}
          <span className="font-body text-sm font-medium text-muted-foreground tabular-nums">
            {rows.length}
          </span>
        </h2>
        {role === "owner" ? (
          <Link
            to="/me/tournaments"
            className="inline-flex min-h-11 items-center rounded-sm text-sm font-semibold text-primary-ink hover:underline"
          >
            See all
          </Link>
        ) : null}
      </div>
      <ul className="grid gap-4 sm:grid-cols-2">
        {rows.map((row) => (
          <li key={row.id} className="min-w-0">
            <HomeCard summary={row} role={role} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function HomeCard({ summary, role }: { summary: TournamentSummary; role: "owner" | "editor" }) {
  const { status } = summary;
  // An owner's unstarted tournament is the one thing here that has a next step of its own -
  // finishing its setup. Everything else is worked from the Desk, and a finished one is read.
  const setup = role === "owner" && isConfigurable(status);
  const meta = [shortDays(summary.starts_at, summary.ends_at), summary.venue_name]
    .filter(Boolean)
    .join(", ");
  return (
    <article className="flex h-full min-w-0 flex-col gap-2.5 rounded-xl border border-hairline bg-surface p-5 shadow-panel">
      <div className="flex">
        <TournamentStatusPill status={status} phase={tournamentPhase(summary)} />
      </div>
      <h3 className="break-words font-display text-xl font-bold leading-tight">
        <Link
          to="/tournaments/$tournamentId/desk"
          params={{ tournamentId: summary.id }}
          className="rounded-sm hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {summary.name}
        </Link>
      </h3>
      {meta ? <p className="break-words text-sm text-muted-foreground">{meta}</p> : null}
      <p className="text-sm text-muted-foreground tabular-nums">
        {countText(summary.entry_count, "entry", "entries")},{" "}
        {countText(summary.category_count, "event", "events")}
      </p>
      <div className="mt-auto flex flex-wrap gap-2 pt-2">
        {status === "completed" ? (
          <Link
            to="/tournaments/$tournamentId/scores"
            params={{ tournamentId: summary.id }}
            className={OUTLINE}
          >
            See results
          </Link>
        ) : setup ? (
          <Link
            to="/tournaments/$tournamentId/settings"
            params={{ tournamentId: summary.id }}
            className={PRIMARY}
          >
            Continue setup
          </Link>
        ) : (
          <>
            <Link
              to="/tournaments/$tournamentId/desk"
              params={{ tournamentId: summary.id }}
              className={PRIMARY}
            >
              Open the Desk
            </Link>
            <Link
              to="/tournaments/$tournamentId/schedule"
              params={{ tournamentId: summary.id }}
              className={OUTLINE}
            >
              Schedule
            </Link>
          </>
        )}
      </div>
    </article>
  );
}

/**
 * What a new account sees: three ways to begin, and something live to look at.
 *
 * An account with no tournament has nothing to resume and nothing waiting on it, so an empty
 * list of tasks and two empty groups would be a page of nothing. It is told, instead, what
 * the account is for - the same three things the sign-in page names - with the way into each.
 * The third has no button because it is not something the caller can start: an organiser adds
 * them, so the useful thing to hand over is the address they were added by.
 */
function FirstSteps({
  email,
  happening,
}: {
  email: string | null;
  happening: TournamentSummary | null;
}) {
  const steps = [
    {
      title: "Find a tournament to play in",
      text: "See who is entered and when and where it plays. Tournaments with registration open are one tap from a request.",
      action: (
        <Link to="/explore" className={`${PRIMARY} w-full gap-2`}>
          Browse tournaments <span aria-hidden="true">→</span>
        </Link>
      ),
    },
    {
      title: "Run your own tournament",
      text: "Set up events, courts and days, take registrations, and build the schedule. You own it, and you can add editors.",
      action: (
        <Link to="/tournaments/new" className={`${OUTLINE} w-full gap-2`}>
          <Plus aria-hidden="true" className="size-4" />
          New tournament
        </Link>
      ),
    },
    {
      title: "Help run someone else's",
      text: "An organiser can add you as an editor, and the tournament then shows up here with a way into its Desk. Share your sign-in email with them.",
      action: email ? (
        <p className="rounded-lg border border-hairline bg-background px-3.5 py-3 text-sm text-muted-foreground">
          Your email: <strong className="break-all text-foreground">{email}</strong>
        </p>
      ) : null,
    },
  ];
  return (
    <div className="space-y-10">
      <ul className="grid gap-4 md:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="min-w-0">
            <article className="flex h-full flex-col gap-3.5 rounded-2xl border border-hairline bg-surface p-6">
              <span
                aria-hidden="true"
                className="grid size-11 place-items-center rounded-xl bg-info-surface font-display text-xl font-extrabold text-info-foreground"
              >
                {index + 1}
              </span>
              <h2 className="font-display text-xl font-bold leading-tight">{step.title}</h2>
              <p className="text-base text-muted-foreground">{step.text}</p>
              <div className="mt-auto flex pt-1">{step.action}</div>
            </article>
          </li>
        ))}
      </ul>

      {happening ? (
        <section aria-labelledby="home-happening">
          <h2
            id="home-happening"
            className="mb-3 flex items-center gap-2.5 font-display text-xl font-bold"
          >
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full bg-foreground ring-4 ring-state-live-chip"
            />
            Happening now
          </h2>
          <div className="max-w-xl">
            <ExploreCard summary={happening} signedIn variant="live" />
          </div>
        </section>
      ) : null}
    </div>
  );
}

