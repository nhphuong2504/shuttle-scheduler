import { createFileRoute, Link, useLocation, useNavigate } from "@tanstack/react-router";

import { Panel, PublicShell } from "@/components/app-shell";
import { TournamentWizard } from "@/components/tournament-setup/TournamentWizard";
import {
  SETUP_STEPS,
  isSetupStep,
  setupStepIndex,
  type SetupStep,
} from "@/components/tournament-setup/types";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { signInSearch } from "@/lib/routing/redirect";

interface NewTournamentSearch {
  /** Which step of the wizard to show. */
  step?: SetupStep;
}

export const Route = createFileRoute("/tournaments/new")({
  validateSearch: (search: Record<string, unknown>): NewTournamentSearch => {
    const result: NewTournamentSearch = {};
    if (isSetupStep(search["step"])) result.step = search["step"];
    return result;
  },
  head: () => ({
    meta: [
      { title: "New tournament | Tournova Tournament Ops" },
      {
        name: "description",
        content:
          "Create a badminton tournament: name, dates, events and competition structure, then start it.",
      },
      { property: "og:title", content: "New tournament | Tournova Tournament Ops" },
      {
        property: "og:description",
        content:
          "Create a badminton tournament: name, dates, events and competition structure, then start it.",
      },
      { property: "og:type", content: "website" },
      { property: "twitter:card", content: "summary" },
    ],
  }),
  component: NewTournamentPage,
});

/**
 * Creating a tournament.
 *
 * It has its own address rather than living inside one because it is the one flow that
 * *precedes* having a tournament: before the first save there is no id to put in a URL, so
 * hosting it under a tournament meant the id in the address was a host for the wizard's
 * form rather than the subject of the page. Here the wizard's subject is nothing, which is
 * exactly what it is.
 *
 * ## Nothing exists until the last step
 *
 * The four steps keep their answers in the page (and in the browser's session storage, so a
 * reload does not lose them), and "Create tournament" on the last step makes the tournament
 * in one call and sends the caller to its own page. Until then there is no row, no id and no
 * public trace: a tournament is created complete or not at all.
 *
 * ## Signed in, or told why not
 *
 * The database refuses to create a tournament for an anonymous caller, and the sign-up
 * path is open on purpose: anyone may create one and own it. So the gate here is a
 * sentence rather than a form. It is a page-level check rather than a route guard because
 * the session lives in the browser and this app renders on the server first; a
 * `beforeLoad` guard would decide during server rendering, where there is never a session,
 * and would send every signed-in caller to the sign-in page on their first paint.
 */
function NewTournamentPage() {
  const { step: stepParam } = Route.useSearch();
  const navigate = useNavigate();
  const { signedIn } = useSession();
  /**
   * This page's address, which includes the wizard step.
   *
   * So somebody who signs in from the third step of the wizard comes back to the third step
   * rather than to the first.
   */
  const href = useLocation({ select: (location) => location.href });

  const step: SetupStep = stepParam ?? "details";
  const index = setupStepIndex(step);

  const setStep = (next: SetupStep) => {
    void navigate({ to: "/tournaments/new", search: { step: next }, replace: true });
  };

  if (!signedIn) {
    return (
      <PublicShell
        title="New tournament"
        subtitle="Sign in to create and run a tournament."
        actions={
          <Button size="sm" asChild>
            <Link to="/auth" search={signInSearch(href)}>
              Sign in
            </Link>
          </Button>
        }
      >
        <Panel title="Sign in first">
          <p className="mb-3 text-sm text-muted-foreground">
            Anyone with an account can create a tournament and own it. Sign in, or create an
            account, to get started.
          </p>
          <Button size="sm" asChild>
            <Link to="/auth" search={signInSearch(href)}>
              Sign in
            </Link>
          </Button>
        </Panel>
      </PublicShell>
    );
  }

  return (
    <PublicShell
      title="New tournament"
      subtitle="Four short steps. Nothing is created until the last one, and your answers stay on this device if you leave."
      actions={
        <Button size="sm" variant="ghost" asChild>
          <Link to="/me/tournaments">← My tournaments</Link>
        </Button>
      }
    >
      <TournamentWizard tournamentId={null} step={step} onStepChange={setStep} />
    </PublicShell>
  );
}
