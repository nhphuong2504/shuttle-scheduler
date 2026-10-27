import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { normalizeRegistrationState } from "../registration-state";
import { registrationKey, registrationKeys } from "./keys";

/**
 * The registration window as one word, from `tournament_registration_state`.
 *
 * Read separately from the summary even though the summary carries the same word, because
 * the Register panel's gate and its copy must come from the function that
 * `submit_tournament_registration` itself consults. The summary's copy is for a *card* -
 * "can I enter this" at a glance - and a page that offered a form on the strength of a
 * denormalised field in a list read would be one join away from disagreeing with the RPC.
 *
 * Public: the RPC is granted to `anon`, because deciding whether to register is something a
 * person may do before creating an account.
 */
export function useTournamentRegistrationState(tournamentId: string | null | undefined) {
  return useQuery({
    queryKey: registrationKey(registrationKeys.registrationState, tournamentId),
    enabled: !!tournamentId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("tournament_registration_state", {
        p_tournament_id: tournamentId as string,
      });
      if (error) throw new Error(error.message);
      return normalizeRegistrationState(data);
    },
  });
}

/**
 * Sets the registration window: both instants, or both null to switch registration off.
 * "Close now" is `closes = now` with the same `opens`. The database enforces the rules -
 * it must close by 00:00 of the first window date, its opening time is fixed once passed,
 * and it cannot be extended once a schedule exists - and says which one was broken.
 */
export async function setRegistrationWindow(
  tournamentId: string,
  opensAt: string | null,
  closesAt: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("set_registration_window", {
    p_tournament_id: tournamentId,
    p_opens: opensAt as never,
    p_closes: closesAt as never,
  });
  if (error) throw new Error(error.message);
}
