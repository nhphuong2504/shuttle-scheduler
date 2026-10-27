import { supabase } from "@/integrations/supabase/client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  toRegistrationQueue,
  type RegistrationQueue,
  type ReviewRegistrationRow,
} from "../registration";
import { registrationKey, registrationKeys } from "./keys";

/**
 * The reviewer's queue for one tournament: every request, split into pending work and what
 * has already been decided.
 *
 * Editor-gated at the database, so the read is only issued for a caller who can edit rather
 * than asked and refused. The page passes `{ enabled: access.can_edit }` for that reason, and
 * the shell does the same for the nav badge - so the two share one cache entry and one fetch
 * rather than each making their own.
 */
export function useTournamentRegistrationQueue(
  tournamentId: string | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: registrationKey(registrationKeys.registrationQueue, tournamentId),
    enabled: enabled && !!tournamentId,
    queryFn: () => fetchRegistrationQueue(tournamentId as string),
  });
}

async function fetchRegistrationQueue(tournamentId: string): Promise<RegistrationQueue> {
  const { data, error } = await supabase.rpc("review_tournament_registrations", {
    p_tournament_id: tournamentId,
  });
  if (error) throw new Error(error.message);
  return toRegistrationQueue((data ?? []) as unknown as ReviewRegistrationRow[]);
}

/**
 * How many requests are waiting for a decision, for each of several tournaments.
 *
 * Home asks about every tournament the caller may edit, and a hook cannot be called in a loop,
 * so this is the same read as the queue above issued once per id. It shares the queue's cache
 * key, so a tournament whose queue is already open costs nothing, and the Registrations page
 * and the nav badge see the same answer. The ids passed are the caller's own, so the editor
 * gate on the read is met; an answer that fails reads as zero rather than as an error, since
 * "none waiting" is the safe thing for a summary line to say when it cannot tell.
 */
export function usePendingRegistrationCounts(tournamentIds: readonly string[]) {
  const results = useQueries({
    queries: tournamentIds.map((id) => ({
      queryKey: registrationKey(registrationKeys.registrationQueue, id),
      queryFn: () => fetchRegistrationQueue(id),
    })),
  });
  return useMemo(() => {
    const counts = new Map<string, number>();
    tournamentIds.forEach((id, index) => {
      counts.set(id, results[index]?.data?.pending.length ?? 0);
    });
    return counts;
    // `results` is a new array every render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentIds.join(","), results.map((r) => r.dataUpdatedAt).join(",")]);
}

/** One reviewer decision, and the note that travels with it. */
export interface RegistrationDecisionInput {
  registrationId: string;
  decision: "approved" | "rejected";
  /** Optional for both outcomes; the reason an "approved" needed one is equally real. */
  note?: string | null;
}

/**
 * Approves or declines one waiting request.
 *
 * Approval is the only path that creates competition data - the linked requester's `players`
 * row, the unlinked partner's, and the `teams` entries - so it is editor-gated at the database
 * and it is the one act this page performs that changes what the tournament holds. A decline
 * creates nothing and takes nothing away, which is why the two share one call rather than two:
 * the RPC takes the decision word and does the shape difference, and the client does not
 * pre-judge which branch applies.
 *
 * No client-side gate, on the same reasoning as submission: the RPC re-checks that the caller
 * may edit, that the request is still pending, and that every category it names is not already
 * full - and its refusal names the event that was full, which is the sentence the reviewer
 * needs. A pre-check here could only replace that with a vaguer one, or disagree with it. The
 * note is trimmed to null when blank rather than stored as whitespace.
 */
export async function decideTournamentRegistration(
  input: RegistrationDecisionInput,
): Promise<void> {
  const note = input.note?.trim();
  const { error } = await supabase.rpc("decide_tournament_registration", {
    p_registration_id: input.registrationId,
    p_decision: input.decision,
    // Omitted rather than sent as null: the generated signature is `p_note?: string`, and an
    // absent key is the same to the function as a null one.
    ...(note ? { p_note: note } : {}),
  });
  if (error) throw new Error(error.message);
}
