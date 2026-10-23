import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { cloneDraft } from "@/components/tournament-setup/clone";
import { saveLocalDraft } from "@/components/tournament-setup/local-draft";
import { EmptyState, Panel, PublicShell } from "@/components/app-shell";
import { TournamentCard } from "@/components/tournament-card";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { useSignInRedirect } from "@/hooks/useSignInRedirect";
import { isConfigurable } from "@/lib/auth/authorization";
import { signInSearch } from "@/lib/routing/redirect";
import { deleteTournament, setCurrentTournament } from "@/lib/tournament/actions";
import {
  fetchTournamentForClone,
  useCurrentTournamentPointer,
  useMyTournaments,
  type TournamentSummary,
} from "@/lib/tournament/data";
import { cn } from "@/lib/utils";

interface MyTournamentsSearch {
  /** Which group is showing. Both are the caller's, and a tournament is in exactly one. */
  tab?: "owned" | "shared";
}

export const Route = createFileRoute("/me/tournaments")({
  validateSearch: (search: Record<string, unknown>): MyTournamentsSearch => {
    const tab = search["tab"];
    return tab === "owned" || tab === "shared" ? { tab } : {};
  },
  head: () => ({
    meta: [
      { title: "My tournaments | Tournova Tournament Ops" },
      {
        name: "description",
        content: "The tournaments you own and the ones you help run.",
      },
      // A page about one person's own tournaments is nobody else's business, so it stays
      // out of an index - which is also why it is the one signed-in-only surface here.
      { name: "robots", content: "noindex" },
      { property: "og:title", content: "My tournaments | Tournova Tournament Ops" },
      { property: "og:description", content: "The tournaments you own and the ones you help run." },
      { property: "og:type", content: "website" },
      { property: "twitter:card", content: "summary" },
    ],
  }),
  component: MyTournamentsPage,
});

/**
 * The caller's own tournaments, in the two groups the relationship actually has.
 *
 * "Owned by me" and "Shared with me" are not two views of one list: they are two different
 * rights. An owner may delete the tournament and decide who else may edit it; an editor may
 * run the event and nothing else. A single list with a badge on each row leaves the reader to
 * work out which rows they can delete, so the split is the page's structure rather than a
 * column in it.
 *
 * The two groups come from the id sets `useMyTournaments` returned, not from the summary's
 * `access_level` word. That word answers a different question - "what is the caller to this
 * row" - and a platform admin who owns a tournament reads `admin`, not `owner`, so a group
 * derived from it would drop an admin's own tournaments out of both tabs.
 *
 * ## What this page took over
 *
 * It is the successor to the tournament list that used to sit at the top of the settings
 * page, and it carries the acts that are about a tournament rather than about its
 * configuration: working in it, and destroying it. Setup is where the four configuration
 * steps live; a row here offers the trip there rather than repeating it.
 */
function MyTournamentsPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { signedIn, isPlatformAdmin } = useSession();
  /**
   * A visitor is sent to sign in rather than told what they are missing.
   *
   * This page is somebody's own work, so there is nothing here for a caller with no session
   * in the way there is something to read on Explore or on a tournament's own page. The
   * sign-in page is where the way in is, and it carries the link to Explore for exactly this
   * visitor - so the trip loses nothing by replacing the sentence this page used to draw.
   *
   * No intent: there is no errand to name beyond coming back here, which the return address
   * already says, and the sign-in page's generic sentence is written for it. A word of its
   * own would be a third member of `SIGN_IN_INTENTS` saying what "you'll go back to the page
   * you were on" says.
   */
  useSignInRedirect({ notice: "Sign in to see your tournaments" });

  const { summaries, ownedIds, isLoading, isError, error } = useMyTournaments();
  const pointer = useCurrentTournamentPointer().data ?? null;
  const [busy, setBusy] = useState(false);

  const group: "owned" | "shared" = tab ?? "owned";
  const rows = summaries.filter((summary) =>
    group === "owned" ? ownedIds.has(summary.id) : !ownedIds.has(summary.id),
  );

  const setGroup = (next: "owned" | "shared") => {
    void navigate({ to: "/me/tournaments", search: { tab: next }, replace: true });
  };

  const refresh = () => qc.invalidateQueries();

  /**
   * Makes a tournament *this person's* working tournament.
   *
   * Available to anyone signed in, and that is not a privilege being handed out: it changes
   * nothing but the caller's own view. It is the successor to the old global "make active",
   * which moved every person's desk at once and left the previous tournament with no way
   * back.
   */
  const workHere = async (summary: TournamentSummary) => {
    setBusy(true);
    try {
      await setCurrentTournament(summary.id);
      await refresh();
      toast.success(`Now working in ${summary.name}`);
      void navigate({ to: "/tournaments/$tournamentId/desk", params: { tournamentId: summary.id } });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not switch tournament");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Starts a new tournament from this one: its venue, organiser and events, a year on.
   *
   * Nothing is created. The answers go into the create flow's browser draft, so the host
   * reads all four steps before the one act that writes.
   */
  const startFrom = async (summary: TournamentSummary) => {
    setBusy(true);
    try {
      const { tournament, categories } = await fetchTournamentForClone(summary.id);
      saveLocalDraft(cloneDraft(tournament, categories));
      void navigate({ to: "/tournaments/new" });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not copy the tournament");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Removes a tournament whatever its status, including the live one.
   *
   * The database cascades every day, court, event, player, entry, match and result, so the
   * confirmation spells that out rather than asking a bare yes/no. Offered to an owner and
   * to a platform admin, and refused by the RPC to anybody else - the button is a
   * convenience, never the gate.
   */
  const remove = async (summary: TournamentSummary) => {
    const confirmed = window.confirm(
      `Delete "${summary.name}"?\n\n` +
        "This permanently removes the tournament and everything it owns — days, " +
        "courts, events, players, entries, matches and results. It cannot be undone.",
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await deleteTournament(summary.id);
      await refresh();
      toast.success(`Deleted ${summary.name}`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not delete the tournament");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Nothing while the session is still being read, and nothing once it has been: the hook
   * above is the redirect, and a placeholder would be a surface built to be thrown away.
   */
  if (!signedIn) return null;

  return (
    <PublicShell
      title="My tournaments"
      subtitle="Tournaments you own or help run."
    >
      <div role="group" aria-label="Which tournaments" className="mb-4 flex flex-wrap gap-1">
        {(
          [
            { id: "owned", label: "Owned by me" },
            { id: "shared", label: "Shared with me" },
          ] as const
        ).map((option) => {
          const selected = option.id === group;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              onClick={() => setGroup(option.id)}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm font-semibold transition-colors",
                selected
                  ? "bg-primary text-primary-foreground shadow-panel"
                  : "border border-hairline bg-surface text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading your tournaments…</p>
      ) : isError ? (
        <Panel title="Could not read your tournaments">
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "The read failed. Try again in a moment."}
          </p>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState
            title={group === "owned" ? "You have not created a tournament" : "Nobody has shared one with you"}
            hint={
              group === "owned"
                ? "A tournament owns its days, courts and events. Create one and it becomes yours to run."
                : "An owner can add you as an editor from their Access page, and the tournament appears here."
            }
            action={
              group === "owned" ? (
                <Button size="sm" asChild>
                  <Link to="/tournaments/new">New tournament</Link>
                </Button>
              ) : (
                <Button size="sm" variant="outline" asChild>
                  <Link to="/explore">Explore tournaments</Link>
                </Button>
              )
            }
          />
        </Panel>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((summary) => {
            const isWorking = pointer === summary.id;
            const canManage = ownedIds.has(summary.id) || isPlatformAdmin;
            return (
              <li key={summary.id} className="min-w-0">
                <TournamentCard
                  summary={summary}
                  footnote={accessNote(summary, ownedIds.has(summary.id), isPlatformAdmin)}
                  actions={
                    <>
                      {isWorking ? (
                        <span className="rounded-full bg-primary/10 px-2.5 py-1 font-score text-sm uppercase tracking-wide text-primary-ink">
                          Working here
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void workHere(summary)}
                        >
                          Work in this one
                        </Button>
                      )}
                      {isConfigurable(summary.status) ? (
                        <Button size="sm" variant="outline" asChild>
                          <Link
                            to="/tournaments/$tournamentId/settings"
                            params={{ tournamentId: summary.id }}
                          >
                            Setup
                          </Link>
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void startFrom(summary)}
                      >
                        Use as template
                      </Button>
                      {canManage ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger-foreground"
                          disabled={busy}
                          onClick={() => void remove(summary)}
                        >
                          Delete
                        </Button>
                      ) : null}
                    </>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </PublicShell>
  );
}

/**
 * The caller's relationship to the row, in words.
 *
 * `access_level` is what the database answered, and the two cases worth stating are the two
 * that change what the page offers: a platform admin acting on a tournament they do not own,
 * and an editor with no ownership. An owner needs no note - the tab already says it.
 */
function accessNote(
  summary: TournamentSummary,
  owned: boolean,
  isPlatformAdmin: boolean,
): string | null {
  if (summary.access_level === "admin" && !owned) return "Platform admin";
  if (!owned) return "You are an editor";
  return null;
}
