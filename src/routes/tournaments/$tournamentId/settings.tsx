import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { Page } from "@/components/app-shell";
import { TournamentWizard } from "@/components/tournament-setup/TournamentWizard";
import {
  SETUP_STEPS,
  isSetupStep,
  setupStepIndex,
  type SetupStep,
} from "@/components/tournament-setup/types";
import { Button } from "@/components/ui/button";
import { useScopedTournament } from "@/lib/tournament/data";

interface SetupSearch {
  /** Which step of the wizard to show. */
  step?: SetupStep;
}

export const Route = createFileRoute("/tournaments/$tournamentId/settings")({
  validateSearch: (search: Record<string, unknown>): SetupSearch => {
    const result: SetupSearch = {};
    if (isSetupStep(search["step"])) result.step = search["step"];
    return result;
  },
  head: () => ({
    meta: [
      { title: "Tournament setup | Tournova Tournament Ops" },
      {
        name: "description",
        content:
          "Configure a badminton tournament: basics, dates, events and competition structure, then start it.",
      },
      { property: "og:title", content: "Tournament setup | Tournova Tournament Ops" },
      {
        property: "og:description",
        content:
          "Configure a badminton tournament: basics, dates, events and competition structure, then start it.",
      },
      { property: "og:type", content: "website" },
      { property: "twitter:card", content: "summary" },
    ],
  }),
  component: SettingsPage,
});

/**
 * One tournament's configuration.
 *
 * It used to be three pages in one - the tournament list, the create flow, and this
 * tournament's own settings - because there was nowhere else for the first two to live. S5
 * gives each of them its own address: `/me/tournaments` browses and manages, `/tournaments/new`
 * creates, and this configures the tournament the URL names.
 *
 * The separation is not tidiness. A list is about *which* tournament, and a settings page is
 * about *this* one, so while they shared a page the route's `$tournamentId` had to be
 * ignored - the wizard took its subject from a `?draft=` search param instead, because the id
 * in the address was only ever the page's host. Now the address is the subject: the layout
 * above already resolved it, 404s an unknown one, and published the row this reads for its
 * title. There is no "not found" branch here because a page that cannot be about anything
 * never renders.
 *
 * The wizard itself is shared with the create flow, which is the other half of the same
 * claim: creating and configuring are the same four steps against the same row.
 */
function SettingsPage() {
  const { tournamentId } = Route.useParams();
  const { step: stepParam } = Route.useSearch();
  const navigate = useNavigate();
  const tournament = useScopedTournament();

  const step: SetupStep = stepParam ?? "details";
  const index = setupStepIndex(step);

  /**
   * The step lives in the URL so a refresh returns to the same step, and so the position can
   * be linked. It is `replace` rather than `push`: a wizard is one task, and six history
   * entries for four steps makes the browser's back button mean "undo my last step" when
   * what a host wants from it is "leave this page".
   */
  const setStep = (next: SetupStep) => {
    void navigate({
      to: "/tournaments/$tournamentId/settings",
      params: { tournamentId },
      search: { step: next },
      replace: true,
    });
  };

  return (
    <Page
      title="Setup"
      subtitle="Name, dates, events and format. Each step is saved as you go."
      actions={
        <Button size="sm" variant="ghost" asChild>
          <Link to="/me/tournaments">← My tournaments</Link>
        </Button>
      }
    >
      <TournamentWizard tournamentId={tournamentId} step={step} onStepChange={setStep} />
    </Page>
  );
}
