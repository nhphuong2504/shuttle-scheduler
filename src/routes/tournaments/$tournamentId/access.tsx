import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Page, EmptyState, Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addTournamentEditor, removeTournamentEditor } from "@/lib/tournament/actions";
import { useScopedAccess, useScopedTournament, useTournamentEditors } from "@/lib/tournament/data";

const ACCESS_DESCRIPTION =
  "See who can edit the current tournament, and add or remove editors.";

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
  const { data: editors, isLoading } = useTournamentEditors(
    access.can_edit ? tournament?.id : null,
  );
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const rows = editors ?? [];
  const canManage = access.can_manage_access;

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

  if (!tournament) {
    return (
      <Page title="Access" subtitle={ACCESS_DESCRIPTION}>
        <EmptyState
          title="No tournament selected"
          hint="Choose or create a tournament on the setup page first."
        />
      </Page>
    );
  }

  return (
    <Page
      title="Access"
      subtitle={`Who can edit ${tournament.name}.`}
    >
      {!canManage ? (
        <div className="mb-4 rounded-lg border border-warn-border bg-warn-surface px-3 py-2 text-xs font-medium text-warn-foreground">
          {/* Said plainly rather than shown as a locked form: an editor who cannot change
              this needs to know who can, and "not authorized" would not tell them. */}
          Only the owner of this tournament can change who may edit it. You can see the
          list below, and ask the owner to make a change.
        </div>
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
                <p className="text-xs text-muted-foreground">
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
            <span className="font-score text-t2 text-muted-foreground">
              {rows.length} {rows.length === 1 ? "person" : "people"}
            </span>
          }
          bodyClassName="p-0"
          {...(canManage ? {} : { className: "lg:col-span-2" })}
        >          {isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="Only the owner can edit"
                hint="Add a colleague's email to let them help run this tournament."
              />
            </div>
          ) : (
            <ul className="divide-y divide-hairline text-sm">
              {rows.map((row) => (
                <li
                  key={row.profile_id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{row.email || "—"}</span>
                    {row.is_owner ? (
                      <span className="inline-flex shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-score text-t4 uppercase tracking-wider text-primary-ink">
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
