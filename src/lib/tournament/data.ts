import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type Category = Database["public"]["Tables"]["categories"]["Row"];
export type Court = Database["public"]["Tables"]["courts"]["Row"];
export type DeskActivity = Database["public"]["Tables"]["desk_activity"]["Row"];
export type Player = {
  id: string;
  name: string;
  gender: string | null;
  email?: string | null;
  phone?: string | null;
  created_at?: string | undefined;
};
export type Team = Database["public"]["Tables"]["teams"]["Row"];
export type Pool = Database["public"]["Tables"]["pools"]["Row"];
export type PoolEntry = Database["public"]["Tables"]["pool_entries"]["Row"];
export type PoolMatch = Database["public"]["Tables"]["pool_matches"]["Row"];
export type Draw = Database["public"]["Tables"]["draws"]["Row"];
export type DrawMatch = Database["public"]["Tables"]["draw_matches"]["Row"];
export type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
export type TournamentDay = Database["public"]["Tables"]["tournament_days"]["Row"];
export type StaffRole = Database["public"]["Tables"]["staff_roles"]["Row"];
export type StaffRoleName = "admin" | "registrar" | "scorer" | "scheduler";

export type StageName = "group" | "knockout";

async function must<T>(
  p: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return (data ?? []) as T;
}

/**
 * Every tournament-scoped query key ends with the tournament id, so switching
 * the active tournament invalidates the whole cache slice at once.
 */
export function scopedKey(base: readonly unknown[], tournamentId: string | null | undefined) {
  return [...base, tournamentId ?? null];
}

export const keys = {
  categories: ["categories"] as const,
  courts: ["courts"] as const,
  deskActivity: ["desk_activity"] as const,
  players: ["players"] as const,
  teams: ["teams"] as const,
  pools: ["pools"] as const,
  poolEntries: ["pool_entries"] as const,
  poolMatches: ["pool_matches"] as const,
  draws: ["draws"] as const,
  drawMatches: ["draw_matches"] as const,
  activeTournament: ["active_tournament"] as const,
  tournamentDays: ["tournament_days"] as const,
  staffRole: ["staff_role"] as const,
  staffRoles: ["staff_roles"] as const,
};

/** The tournament the desk is currently operating on. */
export function useActiveTournament() {
  return useQuery({
    queryKey: keys.activeTournament,
    staleTime: 60_000,
    queryFn: async () => {
      const rows = await must<Tournament[]>(
        supabase.from("tournaments").select("*").eq("is_active", true).limit(1),
      );
      return rows[0] ?? null;
    },
  });
}

/**
 * Shared scope handle. Every scoped hook subscribes to the same query, so this
 * costs one request regardless of how many hooks call it.
 */
export function useActiveTournamentId(): string | null {
  const { data } = useActiveTournament();
  return data?.id ?? null;
}

export function useTournamentDays() {
  const tournamentId = useActiveTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.tournamentDays, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<TournamentDay[]>(
        supabase
          .from("tournament_days")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("day_number"),
      ),
  });
}

/** The active tournament plus its ordered days, which is what the UI mostly wants. */
export function useTournamentScope() {
  const tournamentQuery = useActiveTournament();
  const daysQuery = useTournamentDays();
  return {
    tournament: tournamentQuery.data ?? null,
    days: daysQuery.data ?? [],
    loading: tournamentQuery.isLoading || daysQuery.isLoading,
  };
}

/**
 * Groups open on day 1 and knockouts close on the final day. A single-day
 * tournament runs both stages on that day.
 */
export function stagesForDay(dayNumber: number, dayCount: number): StageName[] {
  const stages: StageName[] = [];
  if (dayNumber === 1) stages.push("group");
  if (dayNumber === dayCount && !stages.includes("knockout")) stages.push("knockout");
  return stages;
}

export function useCategories() {
  const tournamentId = useActiveTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.categories, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<Category[]>(
        supabase
          .from("categories")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("sort_order"),
      ),
  });
}

export function useCourts() {
  const tournamentId = useActiveTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.courts, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<Court[]>(
        supabase
          .from("courts")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("number"),
      ),
  });
}

export function useDeskActivity(enabled = true) {
  return useQuery({
    queryKey: keys.deskActivity,
    enabled,
    queryFn: () =>
      must<DeskActivity[]>(
        supabase
          .from("desk_activity")
          .select("*")
          .order("occurred_at", { ascending: false })
          .limit(12),
      ),
  });
}

export function usePlayers() {
  return useQuery({
    queryKey: keys.players,
    queryFn: async () => {
      const full = await supabase.from("players").select("*").order("name");
      if (!full.error && full.data) return full.data as Player[];
      const { data, error } = await supabase.from("player_roster").select("*").order("name");
      if (error) throw new Error(error.message);
      const rows: Player[] = [];
      for (const p of data ?? []) {
        if (!p.id || !p.name) continue;
        rows.push({
          id: p.id,
          name: p.name,
          gender: p.gender,
          created_at: p.created_at ?? undefined,
        });
      }
      return rows;
    },
  });
}

export function useTeams() {
  const tournamentId = useActiveTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.teams, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<Team[]>(
        supabase
          .from("teams")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("created_at"),
      ),
  });
}

export function usePools() {
  const tournamentId = useActiveTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.pools, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<Pool[]>(
        supabase
          .from("pools")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("name"),
      ),
  });
}

export function usePoolEntries() {
  const tournamentId = useActiveTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.poolEntries, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<PoolEntry[]>(
        supabase
          .from("pool_entries")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("position"),
      ),
  });
}

export function usePoolMatches() {
  const tournamentId = useActiveTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.poolMatches, tournamentId),
    enabled: !!tournamentId,
    refetchInterval: 20_000,
    queryFn: () =>
      must<PoolMatch[]>(
        supabase
          .from("pool_matches")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("round"),
      ),
  });
}

export function useDraws() {
  const tournamentId = useActiveTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.draws, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<Draw[]>(
        supabase
          .from("draws")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("tier"),
      ),
  });
}

export function useDrawMatches() {
  const tournamentId = useActiveTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.drawMatches, tournamentId),
    enabled: !!tournamentId,
    refetchInterval: 20_000,
    queryFn: () =>
      must<DrawMatch[]>(
        supabase
          .from("draw_matches")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("round"),
      ),
  });
}

export function useStaffRoles() {
  return useQuery({
    queryKey: keys.staffRoles,
    queryFn: () => must<StaffRole[]>(supabase.from("staff_roles").select("*").order("email")),
  });
}

export function useRealtimeRefresh() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"connecting" | "live" | "offline" | "error">(
    typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "connecting",
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => Date.now());
  useEffect(() => {
    const onOffline = () => setStatus("offline");
    const onOnline = () => setStatus("connecting");
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    const channel = supabase
      .channel("ops-live")
      .on("postgres_changes", { event: "*", schema: "public" }, () => {
        setLastUpdatedAt(Date.now());
        void qc.invalidateQueries();
      })
      .subscribe((next) => {
        if (!navigator.onLine) setStatus("offline");
        else if (next === "SUBSCRIBED") {
          setStatus("live");
          setLastUpdatedAt(Date.now());
        } else if (next === "CHANNEL_ERROR" || next === "TIMED_OUT") setStatus("error");
        else if (next === "CLOSED") setStatus("connecting");
      });
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      void supabase.removeChannel(channel);
    };
  }, [qc]);
  return { status, lastUpdatedAt };
}

export function teamLabel(team: Team | undefined, players: Map<string, Player>): string {
  if (!team) return "TBC";
  const a = players.get(team.player_1_id)?.name ?? "Unknown";
  const b = team.player_2_id ? players.get(team.player_2_id)?.name : null;
  return b ? `${a} / ${b}` : a;
}

export function teamPlayerIds(team: Team | undefined): string[] {
  if (!team) return [];
  return team.player_2_id ? [team.player_1_id, team.player_2_id] : [team.player_1_id];
}

export function indexBy<T extends { id: string }>(rows: T[] | undefined): Map<string, T> {
  return new Map((rows ?? []).map((r) => [r.id, r]));
}
