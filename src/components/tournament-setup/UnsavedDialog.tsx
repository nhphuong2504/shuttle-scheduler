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
