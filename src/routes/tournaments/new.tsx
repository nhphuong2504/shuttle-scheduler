import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { PublicShell } from "@/components/app-shell";
import { TournamentWizard } from "@/components/tournament-setup/TournamentWizard";
import { isSetupStep, type SetupStep } from "@/components/tournament-setup/types";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { useSignInRedirect } from "@/hooks/useSignInRedirect";

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
 * ## A visitor is sent to sign in, rather than shown a form they cannot use
 *
 * The database refuses to create a tournament for an anonymous caller, and the sign-up
 * path is open on purpose: anyone may create one and own it. So the gate here is the
 * sign-in page rather than a sentence above a dead form - the same trip the Register
 * button on a tournament makes, carrying this address back and the errand with it, so
 * what the visitor meets is the way in rather than a notice that one exists.
 * `useSignInRedirect` carries the whole of that arrangement, including the two details
 * that are easy to get wrong: it waits for the session to settle, and it makes the trip
 * once.
 */
function NewTournamentPage() {
  const { step: stepParam } = Route.useSearch();
  const navigate = useNavigate();
  const { signedIn } = useSession();

  useSignInRedirect({ notice: "Sign in to create a tournament", intent: "create" });

  const step: SetupStep = stepParam ?? "details";

  /**
   * Nothing while the session is still being read, and nothing once it has been.
   *
   * Both are the same answer for the same reason `WorkspaceRedirect` gives: this is a
   * redirect, and a placeholder would be a surface built to be thrown away. Rendering the
   * wizard's shell here instead is what a caller without a session used to get.
   */
  if (!signedIn) return null;

  const setStep = (next: SetupStep) => {
    void navigate({ to: "/tournaments/new", search: { step: next }, replace: true });
  };

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
