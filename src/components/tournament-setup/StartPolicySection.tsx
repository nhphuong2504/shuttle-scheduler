import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { SetupSection } from "@/components/tournament-setup/section";
import { normalizeTournamentStatus } from "@/lib/auth/authorization";
import { setTournamentStartPolicy } from "@/lib/tournament/actions";
import { useScopedAccess, useScopedTournament } from "@/lib/tournament/data";
import { cn } from "@/lib/utils";

/**
 * The on-the-day start policy: whether the server refuses to start a match when one of its
 * players has not had their full rest.
 *
 * ## Why it is not a wizard step
 *
 * The wizard's four steps are the tournament's configuration, and the database freezes them
 * from the first match. This switch is a running-event decision - a host turns it on on the
 * second morning, after seeing the desk warn twice - so it has to stay usable while the
 * tournament plays, which is the exact state in which the wizard's configuration is locked.
 * It therefore has its own writer (`set_tournament_start_policy`), saves the moment it is
 * flipped, and is not one of the wizard's steps or part of its save. It is rendered beside the
 * wizard rather than inside it so the two lifecycles cannot be confused.
 *
 * ## Who sees it
 *
 * Only someone who may edit the tournament, read from the same `can_edit` flag the page's
 * other controls use. It is disabled - not hidden - once the tournament is completed, which is
 * the one state the database would refuse as well, and the note says why.
 */
export function StartPolicySection() {
  const tournament = useScopedTournament();
  const canEdit = useScopedAccess().can_edit;
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);

  if (!canEdit || !tournament) return null;

  const enabled = tournament.block_start_on_short_rest;
  const completed = normalizeTournamentStatus(tournament.status) === "completed";

  const set = async (next: boolean) => {
    setSaving(true);
    try {
      await setTournamentStartPolicy(tournament.id, next);
      await qc.invalidateQueries();
      toast.success(
        next ? "Short rest will block a start" : "Short rest will only warn the desk",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the start policy");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SetupSection
      headingId="start-policy"
      title="On the day"
      hint="Whether the server refuses to start a match when a player has not had their full rest."
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <span id="start-policy-label" className="block text-base font-semibold">
            Block starting a match when a player hasn't had their full rest
          </span>
          <p id="start-policy-note" className="mt-1 text-sm text-muted-foreground">
            {enabled
              ? "The system refuses to start the match."
              : "The desk warns, and the moderator can start anyway."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby="start-policy-label"
          aria-describedby="start-policy-note"
          disabled={saving || completed}
          onClick={() => void set(!enabled)}
          className="inline-flex min-h-11 shrink-0 items-center gap-2.5 rounded-lg px-1 font-semibold disabled:opacity-60"
        >
          <span
            aria-hidden="true"
            className={cn(
              "relative inline-block h-[1.875rem] w-[3.25rem] rounded-full transition-colors",
              enabled ? "bg-primary" : "bg-border-control",
            )}
          >
            <span
              className={cn(
                "absolute top-[0.1875rem] size-6 rounded-full bg-white transition-all",
                enabled ? "right-[0.1875rem]" : "left-[0.1875rem]",
              )}
            />
          </span>
          {enabled ? "On" : "Off"}
        </button>
      </div>

      {completed ? (
        <p className="mt-3 text-sm text-muted-foreground">
          This tournament is completed, so the start policy cannot change.
        </p>
      ) : null}
    </SetupSection>
  );
}
