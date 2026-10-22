import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";

import { CompleteDialog } from "@/components/tournament-setup/CompleteDialog";
import { completeTournament, fetchCompletionCheck } from "@/lib/tournament/actions";

/**
 * Completing a tournament, from wherever the button lives.
 *
 * Two places offer it - the wizard's last step and the workspace's next-step card - and both
 * must count what is left to play at the moment of asking, not when the page loaded. So the
 * dialog, its fresh completion check and the act itself live here once. `dialog` is the
 * element to render; `open` is what the button calls.
 */
export function useCompleteTournament(tournamentId: string | null, name: string) {
  const queryClient = useQueryClient();
  const [completing, setCompleting] = useState(false);
  const [busy, setBusy] = useState(false);

  const completion = useQuery({
    queryKey: ["completion-check", tournamentId],
    queryFn: () => fetchCompletionCheck(tournamentId as string),
    enabled: completing && !!tournamentId,
    // Counted fresh every time: a match may have gone on court since the page loaded.
    staleTime: 0,
    gcTime: 0,
  });

  const confirm = async () => {
    if (!tournamentId) return;
    setBusy(true);
    try {
      await completeTournament(tournamentId);
      setCompleting(false);
      await queryClient.invalidateQueries();
      toast.success("Tournament completed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not complete the tournament");
    } finally {
      setBusy(false);
    }
  };

  const dialog: ReactNode = (
    <CompleteDialog
      open={completing}
      onOpenChange={setCompleting}
      name={name}
      check={completion.data}
      loading={completing && completion.isPending}
      error={completion.error instanceof Error ? completion.error.message : null}
      busy={busy}
      onConfirm={() => void confirm()}
    />
  );

  return { open: () => setCompleting(true), busy, dialog };
}
