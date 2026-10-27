import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/useSession";
import {
  registrationEntriesPayload,
  toMyRegistration,
  type MyRegistrationRow,
  type RegistrationEntryInput,
} from "../registration";
import { registrationKey, registrationKeys } from "./keys";

/**
 * The caller's own registration for one tournament, if they have one.
 *
 * Signed-in only: the RPC resolves the caller's profile, so an anonymous request would
 * return nothing anyway, and asking while signed out would be a request whose answer can
 * only be "no".
 */
export function useMyTournamentRegistration(tournamentId: string | null | undefined) {
  const { signedIn } = useSession();
  return useQuery({
    queryKey: registrationKey(registrationKeys.myRegistration, tournamentId),
    enabled: signedIn && !!tournamentId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_tournament_registration", {
        p_tournament_id: tournamentId as string,
      });
      if (error) throw new Error(error.message);
      return toMyRegistration((data ?? []) as unknown as MyRegistrationRow[]);
    },
  });
}

/**
 * Files - or replaces - this caller's registration request for one tournament.
 *
 * No client-side gate, on purpose. The RPC consults the lifecycle, the window, readiness, the
 * per-player event cap, each event's own state and the partner shape inside one transaction,
 * and every refusal carries the sentence the person should read ("That event is not open for
 * registration", "This tournament allows at most 2 event(s) per player"). A pre-check here
 * could only replace one of those with a vaguer one, or disagree with it - so the form is
 * rendered from `tournament_registration_state`, and the refusal is surfaced as it arrives.
 *
 * Idempotent by construction: a retry on bad wifi returns the same request rather than
 * filing a second one, which is the reason the RPC upserts rather than inserts.
 */
export async function submitTournamentRegistration(
  tournamentId: string,
  entries: readonly RegistrationEntryInput[],
): Promise<string> {
  const { data, error } = await supabase.rpc("submit_tournament_registration", {
    p_tournament_id: tournamentId,
    p_entries: registrationEntriesPayload(entries) as never,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("The registration request could not be filed.");
  return data as string;
}

/**
 * Withdraws this caller's own unanswered request.
 *
 * The requester's act and nobody else's - it is not editor-gated, because deleting your own
 * unanswered request is not a decision about the tournament. The RPC refuses another
 * person's request and one that has already been decided, and deletes the request and its
 * entries and nothing else: the approval is the only path that creates an entry, so
 * withdrawing cannot destroy competition data.
 */
export async function withdrawTournamentRegistration(registrationId: string): Promise<void> {
  const { error } = await supabase.rpc("withdraw_tournament_registration", {
    p_registration_id: registrationId,
  });
  if (error) throw new Error(error.message);
}
