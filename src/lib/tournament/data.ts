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
export type Settings = Database["public"]["Tables"]["tournament_settings"]["Row"];
export type StaffRole = Database["public"]["Tables"]["staff_roles"]["Row"];
export type StaffRoleName = "admin" | "registrar" | "scorer" | "scheduler";

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return (data ?? []) as T;
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
  settings: ["settings"] as const,
  staffRole: ["staff_role"] as const,
  staffRoles: ["staff_roles"] as const,
};

export function useCategories() {
  return useQuery({
    queryKey: keys.categories,
    queryFn: () => must<Category[]>(supabase.from("categories").select("*").order("sort_order")),
  });
}

export function useCourts() {
  return useQuery({
    queryKey: keys.courts,
    queryFn: () => must<Court[]>(supabase.from("courts").select("*").order("number")),
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
        rows.push({ id: p.id, name: p.name, gender: p.gender, created_at: p.created_at ?? undefined });
      }
      return rows;
    },
  });
}

export function useTeams() {
  return useQuery({
    queryKey: keys.teams,
    queryFn: () => must<Team[]>(supabase.from("teams").select("*").order("created_at")),
  });
}

export function usePools() {
  return useQuery({
    queryKey: keys.pools,
    queryFn: () => must<Pool[]>(supabase.from("pools").select("*").order("name")),
  });
}

export function usePoolEntries() {
  return useQuery({
    queryKey: keys.poolEntries,
    queryFn: () => must<PoolEntry[]>(supabase.from("pool_entries").select("*").order("position")),
  });
}

export function usePoolMatches() {
  return useQuery({
    queryKey: keys.poolMatches,
    queryFn: () => must<PoolMatch[]>(supabase.from("pool_matches").select("*").order("round")),
    refetchInterval: 20_000,
  });
}

export function useDraws() {
  return useQuery({
    queryKey: keys.draws,
    queryFn: () => must<Draw[]>(supabase.from("draws").select("*").order("tier")),
  });
}

export function useDrawMatches() {
  return useQuery({
    queryKey: keys.drawMatches,
    queryFn: () => must<DrawMatch[]>(supabase.from("draw_matches").select("*").order("round")),
    refetchInterval: 20_000,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: async () => {
      const rows = await must<Settings[]>(supabase.from("tournament_settings").select("*").limit(1));
      return rows[0] ?? null;
    },
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
