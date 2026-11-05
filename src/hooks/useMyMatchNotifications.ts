import { useQuery } from "@tanstack/react-query";

import { useSession } from "@/hooks/useSession";
import { supabase } from "@/integrations/supabase/client";

export interface MatchNotification {
  id: string;
  read_at: string | null;
  message: string;
  created_at: string;
  tournament_id: string;
  tournament_name: string;
  court_number: number;
  /** The called match, so a reader's page can mark it as called. */
  match_id: string;
  outdated: boolean;
}

export function myMatchNotificationsKey(userId: string | null | undefined) {
  return ["my-match-notifications", userId] as const;
}

/**
 * The caller's own match calls, shared by the header inbox and My matches.
 *
 * One query key, so the inbox and the page read one cache entry and one poll. Polling also
 * catches up after reconnects.
 */
export function useMyMatchNotifications() {
  const { session } = useSession();
  const query = useQuery({
    queryKey: myMatchNotificationsKey(session?.userId),
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_match_notifications");
      if (error) throw error;
      return data as unknown as MatchNotification[];
    },
    refetchInterval: 5_000,
  });
  return { session, query };
}
