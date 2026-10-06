import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Page, EmptyState, Panel, Notice } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addTournamentEditor, removeTournamentEditor } from "@/lib/tournament/actions";
import {
  useScopedAccess,
  useScopedAccessLoading,
  useScopedTournament,
  useTournamentEditors,
} from "@/lib/tournament/data";

/**
 * What the page is about, for the page's own metadata.
 *
 * It said "the current tournament" until this pass, which is the vocabulary S12 retired:
 * there is no globally current tournament any more, only the caller's own pointer, and
 * this page is about the tournament the URL names regardless of where that pointer sits.
 * "Current" would be read as "whichever one I am working in", which is a different
 * tournament whenever the two disagree - and a search engine or a link preview only ever
 * sees this string.
 */
const ACCESS_DESCRIPTION = "See who can edit this tournament, and add or remove editors.";

export const Route = createFileRoute("/tournaments/$tournamentId/access")({
  head: () => ({
    meta: [
      { title: "Access | Tournova Tournament Ops" },
      { name: "description", content: ACCESS_DESCRIPTION },
      { property: "og:title", content: "Access | Tournova Tournament Ops" },
      { property: "og:description", content: ACCESS_DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "twitter:card", content: "summary" },
    ],
  }),
  component: AccessPage,
});

/**
 * Who may edit this tournament.
 *
 * This is the Phase 1 stand-in for a full team-management screen, and it is deliberately
 * only that: the owner is shown, the editors are shown, and both can be changed. There is
 * no invitation email, no pending state and no role picker, because access is now a single
 * yes-or-no per tournament rather than four staff roles - the four-role model is gone, and
 * a UI that still offered admin/registrar/scorer/scheduler would be offering choices the
 * database no longer has.
 *
 * The page is limited to whoever owns the tournament (or a platform admin). Editors
 * cannot appoint other editors: an edit right is a right to change the tournament, not a
 * right to decide who else may.
 *
 * The owner is listed alongside the editors even though they are not an editor row, and
 * is drawn differently rather than being removable, because "who can edit this" is one
 * question with one answer set. The database refuses to remove them, and the button is
 * absent rather than disabled so nobody has to find that out by trying.
 */
function AccessPage() {
  const qc = useQueryClient();
  const tournament = useScopedTournament();
  const access = useScopedAccess();
  const accessLoading = useScopedAccessLoading();
  const { data: editors, isLoading, isError, error } = useTournamentEditors(
    access.can_edit ? tournament?.id : null,
  );
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const rows = editors ?? [];
  const canManage = access.can_manage_access;

  /**
   * The roster read has not answered yet, for any of three reasons.
   *
   * The layout is still resolving the tournament, so there is no id to read with; or the
   * access answer is in flight, so `can_edit` reads false and the read has not been issued
   * yet; or the read itself is in flight. Collapsing them matters because the alternative
   * is the panel's own empty state - which is what the page did before this pass, and what
   * made an owner whose answer was still travelling read "Only the owner can edit".
   */
  const listPending = accessLoading || !tournament || isLoading;

  /**
   * The list was actually read.
   *
   * Separate from `!listPending`, because there are two ways to not be pending and only one
   * of them has an answer: a caller who cannot edit never issues the read, so they are
   * never pending and have no count. Drawing "0 people" for them would be the page asserting
   * that nobody can edit this tournament, which is the one thing it must not say when it
   * has not asked.
   */
  const listRead = access.can_edit && !listPending;

  /**
   * Who the ownership notice is for.
   *
   * A visitor and a viewer are already told by the shell's read-only notice that they
   * cannot change this tournament, and not being its owner is not why - so this sentence
   * is for an editor who can edit the tournament but not decide who else may. `canManage`
   * alone would put it in front of every visitor, and the read has to have settled before
   * it is asserted at all.
   */
  const cannotManage = !accessLoading && access.can_edit && !canManage;

  const add = async () => {
    if (!tournament) return;
    setBusy(true);
    try {
      await addTournamentEditor(tournament.id, email);
      setEmail("");
      toast.success("Editor added");
      void qc.invalidateQueries();
    } catch (error) {
      // The RPC's own refusal is shown verbatim. It knows things this page cannot -
      // whether the address belongs to anybody who has signed in yet, for one - and
      // rewording it here would only hide the fix.
      toast.error(error instanceof Error ? error.message : "Could not add that editor");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profileId: string) => {
    if (!tournament) return;
    setBusy(true);
    try {
      await removeTournamentEditor(tournament.id, profileId);
      toast.success("Editor removed");
      void qc.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove that editor");
    } finally {
      setBusy(false);
    }
  };

  /**
   * There is no "no tournament selected" branch.
   *
   * There used to be, and it was wrong in both directions. `useScopedTournament` answers
   * null only while the layout is still resolving the id, and the layout 404s an id that
   * does not exist - so the branch rendered a "choose or create a tournament on the setup
   * page" empty state for a tournament that was already chosen, to a reader who was
   * already looking at it. The two pages that carried the same copy were the last places
   * still reasoning about a pointer that S12 removed, which is why the sentence pointed at
   * the setup page: nothing else in the workspace needs it.
   *
   * The unresolved frame is not a state with something to say - the header is the shell's,
   * and the list below is empty because it cannot be keyed yet - so the title falls back
   * and the panel says it is reading rather than guessing at a count.
   */
  return (
    <Page
      title="Access"
      subtitle={tournament ? `Who can edit ${tournament.name}.` : ACCESS_DESCRIPTION}
    >
      {cannotManage ? (
        /* Said plainly rather than shown as a locked form: an editor who cannot change
           this needs to know who can, and "not authorized" would not tell them. It is not
           shown while the answer is still travelling, or the sentence would flash in front
           of an owner on every load. */
        <Notice tone="warn">
          Only the owner of this tournament can change who may edit it. You can see the
          list below, and ask the owner to make a change.
        </Notice>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {canManage ? (
          <Panel title="Add an editor">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="editor-email">Email</Label>
                <Input
                  id="editor-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && email && void add()}
                />
                <p className="text-t4 text-muted-foreground">
                  They need an account first. Ask them to sign up, then add the address they
                  used.
                </p>
              </div>
              <Button className="w-full" disabled={busy || !email} onClick={() => void add()}>
                Add editor
              </Button>
            </div>
          </Panel>
        ) : null}
        <Panel
          title="People who can edit"
          right={
            /* No count while it is still reading, and none for a caller who never read it.
               "0 people" would be the panel asserting an answer it has not got, and on
               this page that reads as "nobody can edit this", which is the one thing the
               reader is here to check. */
            listRead ? (
              <span className="font-score text-t2 text-muted-foreground">
                {rows.length} {rows.length === 1 ? "person" : "people"}
              </span>
            ) : null
          }
          bodyClassName="p-0"
          {...(canManage ? {} : { className: "lg:col-span-2" })}
        >
          {listPending ? (
            <p className="p-4 text-t3 text-muted-foreground">Loading the editors…</p>
          ) : isError ? (
            /* A failed read is not an empty list, and §5.3 is the reason this branch exists
               rather than being folded into the one below: "nobody else can edit this" is
               the one sentence this page must never say when it does not know, because the
               reader acts on it by doing nothing. */
            <div className="p-4">
              <Notice tone="warn" className="mb-0">
                {error instanceof Error
                  ? error.message
                  : "The list of editors did not load. Try again in a moment."}
              </Notice>
            </div>
          ) : rows.length === 0 ? (
            /* Two different silences, and the reason the branch is split rather than
               collapsed. An editor always sees the owner, so an empty list means the read
               was never issued - and the answer is that the names are not theirs to read.
               A manager whose list came back empty has simply appointed nobody yet, which
               is the state the page starts in and not a refusal. */
            <div className="p-4">
              {access.can_edit ? (
                <EmptyState
                  title="Only the owner can edit"
                  hint="Add a colleague's email to let them help run this tournament."
                />
              ) : (
                <EmptyState
                  title="Only the people who run it can see this"
                  hint="Ask the owner of this tournament for edit access."
                />
              )}
            </div>
          ) : (
            <ul className="divide-y divide-hairline text-t3">
              {rows.map((row) => (
                <li
                  key={row.profile_id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{row.email || "—"}</span>
                    {row.is_owner ? (
                      <span className="inline-flex shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-score text-sm uppercase tracking-wide text-primary-ink">
                        Owner
                      </span>
                    ) : null}
                  </span>
                  {canManage && !row.is_owner ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void remove(row.profile_id)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </Page>
  );
}
