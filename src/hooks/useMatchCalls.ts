import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { DeskMatchModel } from "@/lib/tournament/desk";
import type { PlayerReach } from "@/lib/tournament/call-next";

interface CallState {
  players: { id: string; inApp: boolean }[];
  records: { matchId: string; sentAt: string }[];
}

export function useMatchCalls(tournamentId: string | null, enabled: boolean) {
  const client = useQueryClient();
  const key = ["desk-calls", tournamentId];
  const query = useQuery({
    queryKey: key,
    enabled: enabled && !!tournamentId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("desk_call_state", {
        p_tournament_id: tournamentId!,
      });
      if (error) throw error;
      return data as unknown as CallState;
    },
    refetchInterval: 5_000,
  });
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Retain the exact request after an uncertain response. A deliberate changed call gets a new id.
  const pending = useRef<{ signature: string; id: string } | null>(null);
  const busy = useRef(false);
  const send = async (match: DeskMatchModel, message: string) => {
    if (busy.current || !tournamentId || !match.courtId) return false;
    busy.current = true;
    setSending(true);
    setSendError(null);
    const args = {
      p_tournament_id: tournamentId,
      p_kind: match.kind,
      p_match_id: match.id,
      p_court_id: match.courtId,
      p_scheduled_time: match.scheduled,
      p_player_ids: [...match.playerIds].sort(),
      p_message: message,
    };
    const signature = JSON.stringify(args);
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: crypto.randomUUID() };
    try {
      const { data, error } = await supabase.rpc("send_match_call", {
        ...args,
        p_request_id: pending.current.id,
      });
      if (error) throw error;
      pending.current = null;
      void client.invalidateQueries({ queryKey: key });
      return data as { count: number; sentAt: string };
    } catch (error) {
      setSendError(
        error instanceof Error
          ? error.message
          : ((error as { message?: string }).message ??
              "Could not confirm sending. Try again to check the same request."),
      );
      return false;
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  const reach =
    query.data && !query.isError
      ? new Map<string, PlayerReach>(
          query.data.players.map((p) => [p.id, { inApp: p.inApp, sms: false, email: false }]),
        )
      : null;
  const notifiedAtFor = (id: string) => {
    const record = query.data?.records.find((r) => r.matchId === id);
    return record ? Date.parse(record.sentAt) : null;
  };
  return {
    reach,
    notifiedAtFor,
    sending,
    sendError:
      sendError ??
      (query.isError ? "Could not load recipients. Reopen or refresh before sending." : null),
    send,
  };
}
