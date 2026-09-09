import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type Category = Database["public"]["Tables"]["categories"]["Row"];
export type Court = Database["public"]["Tables"]["courts"]["Row"];
export type Player = Database["public"]["Tables"]["players"]["Row"];
export type Team = Database["public"]["Tables"]["teams"]["Row"];
export type Pool = Database["public"]["Tables"]["pools"]["Row"];
export type PoolEntry = Database["public"]["Tables"]["pool_entries"]["Row"];
export type PoolMatch = Database["public"]["Tables"]["pool_matches"]["Row"];
export type Draw = Database["public"]["Tables"]["draws"]["Row"];
export type DrawMatch = Database["public"]["Tables"]["draw_matches"]["Row"];
export type Settings = Database["public"]["Tables"]["tournament_settings"]["Row"];

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return (data ?? []) as T;
}

export const keys = {
  categories: ["categories"] as const,
  courts: ["courts"] as const,
  players: ["players"] as const,
  teams: ["teams"] as const,
  pools: ["pools"] as const,
  poolEntries: ["pool_entries"] as const,
  poolMatches: ["pool_matches"] as const,
  draws: ["draws"] as const,
  drawMatches: ["draw_matches"] as const,
  settings: ["settings"] as const,
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

export function usePlayers() {
  return useQuery({
    queryKey: keys.players,
    queryFn: () => must<Player[]>(supabase.from("players").select("*").order("name")),
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

/** Convenience: player names for a team, in display order. */
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
