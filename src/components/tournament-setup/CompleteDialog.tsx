import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CompletionCheck } from "@/lib/tournament/actions";
import { useEffect, useState } from "react";

/**
 * Completing a tournament, and exactly what is left when it happens.
 *
 * Completing is the one step nobody can take back, so the dialog says what it will close
 * rather than asking "are you sure?". Three cases, from what the database counts:
 *
 *   blocked  a match is on court. A game in progress is real, and Complete locks every
 *            result, so the button is off. The database refuses too, so a second window
 *            cannot get past it.
 *   warn     matches were never played. A tournament may be cut short - weather, withdrawals,
 *            no-shows - so this is allowed, but only once the host has said they understand.
 *   clean    every match is settled. One sentence, one button.
 *
 * The counts are read when the dialog opens, not when the page loaded, because a match may
 * have gone on court since.
 */
export function CompleteDialog({
  open,
  onOpenChange,
  name,
  check,
  loading,
  error,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  check: CompletionCheck | undefined;
  loading: boolean;
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [understood, setUnderstood] = useState(false);

  // A fresh look is a fresh acknowledgement.
  useEffect(() => {
    if (open) setUnderstood(false);
  }, [open]);

  const blocked = (check?.onCourt ?? 0) > 0;
  const unplayed = check?.unplayed ?? 0;
  const warn = !blocked && unplayed > 0;
  const ready = Boolean(check) && !loading && !error && !blocked && (!warn || understood);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Complete {name || "this tournament"}?</DialogTitle>
          <DialogDescription>
            Completing locks every result and closes the tournament. It cannot be undone; only a
            platform admin can repair anything afterwards.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">Checking what is left to play…</p>
        ) : error ? (
          <p role="alert" className="text-sm font-semibold text-danger-foreground">
            Could not check the matches: {error}
          </p>
        ) : blocked && check ? (
          <div
            role="alert"
            className="rounded-xl border border-danger-border bg-danger-surface px-4 py-3"
          >
            <p className="text-base font-semibold text-danger-foreground">
              {check.onCourt} match{check.onCourt === 1 ? " is" : "es are"} still being played
            </p>
            <p className="mt-1 text-sm text-foreground">
              Finish or cancel {check.onCourt === 1 ? "it" : "them"} on the Desk first.
            </p>
          </div>
        ) : warn ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-warn-border bg-warn-surface px-4 py-3">
              <p className="text-base font-semibold text-warn-foreground">
                {unplayed} match{unplayed === 1 ? " has" : "es have"} not been played
              </p>
              <p className="mt-1 text-sm text-foreground">
                {unplayed === 1 ? "It stays" : "They stay"} unplayed.
              </p>
            </div>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 text-base">
              <input
                type="checkbox"
                checked={understood}
                onChange={(event) => setUnderstood(event.target.checked)}
                className="mt-1 size-5 shrink-0 accent-primary"
              />
              <span>
                I understand {unplayed} match{unplayed === 1 ? "" : "es"} will not be played
              </span>
            </label>
          </div>
        ) : check ? (
          <p className="text-base">
            {check.total > 0
              ? `All ${check.total} matches are played.`
              : "No matches were scheduled."}
          </p>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={!ready || busy}>
            {busy ? "Completing…" : "Complete tournament"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
