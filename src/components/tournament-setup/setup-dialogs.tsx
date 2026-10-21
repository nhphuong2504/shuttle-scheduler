import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Leaving the setup page with a step that has been edited and not saved.
 *
 * Moving between steps saves on its own, so this only appears when the host leaves the page
 * altogether - My tournaments, the header, another tab of the workspace. It offers the three
 * things a host can mean: keep the edit, drop it, or go back to it. "Save" is first because
 * it is what the page promised ("Saved as you go").
 */
export function UnsavedDialog({
  open,
  busy,
  onSave,
  onDiscard,
  onStay,
}: {
  open: boolean;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onStay: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? null : onStay())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Save your changes?</AlertDialogTitle>
          <AlertDialogDescription>
            This step has changes that are not saved yet. Leaving without saving drops them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <Button variant="ghost" disabled={busy} onClick={onStay}>
            Stay here
          </Button>
          <Button variant="outline" disabled={busy} onClick={onDiscard}>
            Leave without saving
          </Button>
          <Button disabled={busy} onClick={onSave}>
            {busy ? "Saving…" : "Save and leave"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Discarding: the answers while a tournament is being made, or the tournament itself while
 * it is still upcoming. Both are final, so the dialog says which one this is.
 */
export function DiscardDialog({
  open,
  existing,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** Whether a stored tournament is deleted, rather than answers that were never saved. */
  existing: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? null : onCancel())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {existing ? "Discard this tournament?" : "Discard these answers?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {existing
              ? "The tournament and everything configured so far are deleted. This cannot be undone."
              : "Nothing has been created yet. What you typed is cleared from this tab."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <Button variant="outline" disabled={busy} onClick={onCancel}>
            Keep it
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {existing ? "Discard tournament" : "Discard answers"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
