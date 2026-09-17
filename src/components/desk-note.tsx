import { useState } from "react";
import { toast } from "sonner";

import { Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveTournamentNotes } from "@/lib/tournament/actions";

/** Matches the constraint on `tournaments.notes`. */
const NOTES_MAX_LENGTH = 2000;

/**
 * The tournament's note on the desk.
 *
 * Deliberately open to every role, not just admins: the point of the note is that
 * everyone working the event can read it. Only an admin gets the edit control,
 * because writing it goes through an admin-gated RPC.
 *
 * The note is editable at any status, which is why this does not go through the
 * draft wizard's save path — that refuses anything that is not a Draft, and a note
 * is exactly the thing that needs changing mid-event.
 */
export function DeskNote({
  tournamentId,
  notes,
  isAdmin,
  onSaved,
}: {
  tournamentId: string;
  notes: string | null;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");
  const [busy, setBusy] = useState(false);

  const trimmed = notes?.trim() ?? "";

  // Nothing to show and no way to add one: stay out of the way.
  if (!trimmed && !isAdmin) return null;

  const openEditor = () => {
    setDraft(notes ?? "");
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      await saveTournamentNotes(tournamentId, draft);
      onSaved();
      setEditing(false);
      toast.success("Note updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the note");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Panel
        title="Note"
        right={
          isAdmin ? (
            <Button size="sm" variant="ghost" onClick={openEditor}>
              {trimmed ? "Edit" : "Add a note"}
            </Button>
          ) : undefined
        }
      >
        {trimmed ? (
          <p className="whitespace-pre-wrap text-sm text-foreground">{trimmed}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No note for this event yet. Add one to tell everyone something useful — parking, warm-up
            times, a late change to the running order.
          </p>
        )}
      </Panel>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Note</DialogTitle>
            <DialogDescription>
              Shown to everyone using the desk. You can change it at any time, including while the
              event is running.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="desk-note">A note about the event</Label>
            <Textarea
              id="desk-note"
              value={draft}
              rows={5}
              maxLength={NOTES_MAX_LENGTH}
              placeholder="Parking is behind the hall. Warm-up courts open at 08:00."
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-muted-foreground">Clear the box to remove the note.</p>
              <span className="shrink-0 font-score text-[11px] text-muted-foreground">
                {draft.length}/{NOTES_MAX_LENGTH}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save note"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
