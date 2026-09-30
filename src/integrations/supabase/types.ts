export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      categories: {
        Row: {
          active: boolean
          code: string
          created_at: string
          entry_type: string
          gender: string
          id: string
          max_entries: number | null
          name: string
          sort_order: number
          tournament_id: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          entry_type: string
          gender?: string
          id?: string
          max_entries?: number | null
          name: string
          sort_order?: number
          tournament_id: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          entry_type?: string
          gender?: string
          id?: string
          max_entries?: number | null
          name?: string
          sort_order?: number
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      courts: {
        Row: {
          created_at: string
          id: string
          number: number
          status: string
          tournament_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          number: number
          status?: string
          tournament_id: string
        }
        Update: {
          created_at?: string
          id?: string
          number?: number
          status?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "courts_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      desk_activity: {
        Row: {
          action: string
          actor_id: string | null
          details: Json
          id: number
          match_id: string
          match_table: string
          occurred_at: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          details?: Json
          id?: never
          match_id: string
          match_table: string
          occurred_at?: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          details?: Json
          id?: never
          match_id?: string
          match_table?: string
          occurred_at?: string
        }
        Relationships: []
      }
      draw_matches: {
        Row: {
          court_id: string | null
          created_at: string
          draw_id: string
          ended_at: string | null
          games: Json
          id: string
          is_bye: boolean
          note: string | null
          parent_a_id: string | null
          parent_b_id: string | null
          reported_time: string | null
          round: number
          scheduled_time: string | null
          slot: number
          started_at: string | null
          status: string
          team_a_id: string | null
          team_b_id: string | null
          tournament_id: string
          winner_id: string | null
        }
        Insert: {
          court_id?: string | null
          created_at?: string
          draw_id: string
          ended_at?: string | null
          games?: Json
          id?: string
          is_bye?: boolean
          note?: string | null
          parent_a_id?: string | null
          parent_b_id?: string | null
          reported_time?: string | null
          round: number
          scheduled_time?: string | null
          slot: number
          started_at?: string | null
          status?: string
          team_a_id?: string | null
          team_b_id?: string | null
          tournament_id: string
          winner_id?: string | null
        }
        Update: {
          court_id?: string | null
          created_at?: string
          draw_id?: string
          ended_at?: string | null
          games?: Json
          id?: string
          is_bye?: boolean
          note?: string | null
          parent_a_id?: string | null
          parent_b_id?: string | null
          reported_time?: string | null
          round?: number
          scheduled_time?: string | null
          slot?: number
          started_at?: string | null
          status?: string
          team_a_id?: string | null
          team_b_id?: string | null
          tournament_id?: string
          winner_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "draw_matches_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draw_matches_draw_id_fkey"
            columns: ["draw_id"]
            isOneToOne: false
            referencedRelation: "draws"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draw_matches_parent_a_id_fkey"
            columns: ["parent_a_id"]
            isOneToOne: false
            referencedRelation: "draw_matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draw_matches_parent_b_id_fkey"
            columns: ["parent_b_id"]
            isOneToOne: false
            referencedRelation: "draw_matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draw_matches_team_a_id_fkey"
            columns: ["team_a_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draw_matches_team_b_id_fkey"
            columns: ["team_b_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draw_matches_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draw_matches_winner_id_fkey"
            columns: ["winner_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      draws: {
        Row: {
          bracket_size: number
          category_id: string
          created_at: string
          entrant_count: number
          id: string
          tier: string
          tournament_id: string
        }
        Insert: {
          bracket_size: number
          category_id: string
          created_at?: string
          entrant_count: number
          id?: string
          tier: string
          tournament_id: string
        }
        Update: {
          bracket_size?: number
          category_id?: string
          created_at?: string
          entrant_count?: number
          id?: string
          tier?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "draws_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draws_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      placement_entrants: {
        Row: {
          category_id: string
          created_at: string
          excluded: boolean
          id: string
          seed: number | null
          seed_locked_at: string | null
          skill_level: string
          team_id: string
          tier: string | null
          tournament_id: string
        }
        Insert: {
          category_id: string
          created_at?: string
          excluded?: boolean
          id?: string
          seed?: number | null
          seed_locked_at?: string | null
          skill_level?: string
          team_id: string
          tier?: string | null
          tournament_id: string
        }
        Update: {
          category_id?: string
          created_at?: string
          excluded?: boolean
          id?: string
          seed?: number | null
          seed_locked_at?: string | null
          skill_level?: string
          team_id?: string
          tier?: string | null
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "placement_entrants_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placement_entrants_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placement_entrants_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      placement_matches: {
        Row: {
          category_id: string
          court_id: string | null
          created_at: string
          ended_at: string | null
          entrant_a_id: string
          entrant_b_id: string
          games: Json
          generation_key: string
          id: string
          is_crossover: boolean
          is_makeup: boolean
          note: string | null
          prerequisite_ids: string[]
          reported_time: string | null
          scheduled_time: string | null
          stage: string
          started_at: string | null
          status: string
          tournament_id: string
          winner_id: string | null
        }
        Insert: {
          category_id: string
          court_id?: string | null
          created_at?: string
          ended_at?: string | null
          entrant_a_id: string
          entrant_b_id: string
          games?: Json
          generation_key: string
          id?: string
          is_crossover?: boolean
          is_makeup?: boolean
          note?: string | null
          prerequisite_ids?: string[]
          reported_time?: string | null
          scheduled_time?: string | null
          stage: string
          started_at?: string | null
          status?: string
          tournament_id: string
          winner_id?: string | null
        }
        Update: {
          category_id?: string
          court_id?: string | null
          created_at?: string
          ended_at?: string | null
          entrant_a_id?: string
          entrant_b_id?: string
          games?: Json
          generation_key?: string
          id?: string
          is_crossover?: boolean
          is_makeup?: boolean
          note?: string | null
          prerequisite_ids?: string[]
          reported_time?: string | null
          scheduled_time?: string | null
          stage?: string
          started_at?: string | null
          status?: string
          tournament_id?: string
          winner_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "placement_matches_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placement_matches_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placement_matches_entrant_a_id_fkey"
            columns: ["entrant_a_id"]
            isOneToOne: false
            referencedRelation: "placement_entrants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placement_matches_entrant_b_id_fkey"
            columns: ["entrant_b_id"]
            isOneToOne: false
            referencedRelation: "placement_entrants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placement_matches_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placement_matches_winner_id_fkey"
            columns: ["winner_id"]
            isOneToOne: false
            referencedRelation: "placement_entrants"
            referencedColumns: ["id"]
          },
        ]
      }
      players: {
        Row: {
          created_at: string
          email: string | null
          gender: string | null
          id: string
          name: string
          phone: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          gender?: string | null
          id?: string
          name: string
          phone?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          gender?: string | null
          id?: string
          name?: string
          phone?: string | null
        }
        Relationships: []
      }
      pool_entries: {
        Row: {
          id: string
          manual_rank_override: number | null
          pool_id: string
          position: number
          team_id: string
          tournament_id: string
        }
        Insert: {
          id?: string
          manual_rank_override?: number | null
          pool_id: string
          position: number
          team_id: string
          tournament_id: string
        }
        Update: {
          id?: string
          manual_rank_override?: number | null
          pool_id?: string
          position?: number
          team_id?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pool_entries_pool_id_fkey"
            columns: ["pool_id"]
            isOneToOne: false
            referencedRelation: "pools"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pool_entries_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pool_entries_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      pool_matches: {
        Row: {
          category_id: string
          court_id: string | null
          created_at: string
          ended_at: string | null
          id: string
          note: string | null
          pool_id: string
          reported_time: string | null
          round: number
          scheduled_time: string | null
          score_a: number | null
          score_b: number | null
          started_at: string | null
          status: string
          team_a_id: string | null
          team_b_id: string | null
          tournament_id: string
          winner_id: string | null
        }
        Insert: {
          category_id: string
          court_id?: string | null
          created_at?: string
          ended_at?: string | null
          id?: string
          note?: string | null
          pool_id: string
          reported_time?: string | null
          round: number
          scheduled_time?: string | null
          score_a?: number | null
          score_b?: number | null
          started_at?: string | null
          status?: string
          team_a_id?: string | null
          team_b_id?: string | null
          tournament_id: string
          winner_id?: string | null
        }
        Update: {
          category_id?: string
          court_id?: string | null
          created_at?: string
          ended_at?: string | null
          id?: string
          note?: string | null
          pool_id?: string
          reported_time?: string | null
          round?: number
          scheduled_time?: string | null
          score_a?: number | null
          score_b?: number | null
          started_at?: string | null
          status?: string
          team_a_id?: string | null
          team_b_id?: string | null
          tournament_id?: string
          winner_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pool_matches_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pool_matches_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pool_matches_pool_id_fkey"
            columns: ["pool_id"]
            isOneToOne: false
            referencedRelation: "pools"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pool_matches_team_a_id_fkey"
            columns: ["team_a_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pool_matches_team_b_id_fkey"
            columns: ["team_b_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pool_matches_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pool_matches_winner_id_fkey"
            columns: ["winner_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      pools: {
        Row: {
          category_id: string
          created_at: string
          id: string
          name: string
          scheduled_end: string | null
          size: number
          tournament_id: string
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          name: string
          scheduled_end?: string | null
          size: number
          tournament_id: string
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          name?: string
          scheduled_end?: string | null
          size?: number
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pools_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pools_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          current_tournament_id: string | null
          email: string
          id: string
          system_role: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          current_tournament_id?: string | null
          email: string
          id?: string
          system_role?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          current_tournament_id?: string | null
          email?: string
          id?: string
          system_role?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_current_tournament_id_fkey"
            columns: ["current_tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          category_id: string
          created_at: string
          id: string
          player_1_id: string
          player_2_id: string | null
          seed: number | null
          tournament_id: string
          withdrawn: boolean
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          player_1_id: string
          player_2_id?: string | null
          seed?: number | null
          tournament_id: string
          withdrawn?: boolean
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          player_1_id?: string
          player_2_id?: string | null
          seed?: number | null
          tournament_id?: string
          withdrawn?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "teams_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_player_1_id_fkey"
            columns: ["player_1_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_player_1_id_fkey"
            columns: ["player_1_id"]
            isOneToOne: false
            referencedRelation: "public_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_player_2_id_fkey"
            columns: ["player_2_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_player_2_id_fkey"
            columns: ["player_2_id"]
            isOneToOne: false
            referencedRelation: "public_players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tier_draw_matches: {
        Row: {
          court_id: string | null
          created_at: string
          draw_id: string
          ended_at: string | null
          entrant_a_id: string | null
          entrant_b_id: string | null
          games: Json
          id: string
          is_bye: boolean
          note: string | null
          parent_a_id: string | null
          parent_b_id: string | null
          reported_time: string | null
          round: number
          scheduled_time: string | null
          slot: number
          started_at: string | null
          status: string
          tournament_id: string
          winner_id: string | null
        }
        Insert: {
          court_id?: string | null
          created_at?: string
          draw_id: string
          ended_at?: string | null
          entrant_a_id?: string | null
          entrant_b_id?: string | null
          games?: Json
          id?: string
          is_bye?: boolean
          note?: string | null
          parent_a_id?: string | null
          parent_b_id?: string | null
          reported_time?: string | null
          round: number
          scheduled_time?: string | null
          slot: number
          started_at?: string | null
          status?: string
          tournament_id: string
          winner_id?: string | null
        }
        Update: {
          court_id?: string | null
          created_at?: string
          draw_id?: string
          ended_at?: string | null
          entrant_a_id?: string | null
          entrant_b_id?: string | null
          games?: Json
          id?: string
          is_bye?: boolean
          note?: string | null
          parent_a_id?: string | null
          parent_b_id?: string | null
          reported_time?: string | null
          round?: number
          scheduled_time?: string | null
          slot?: number
          started_at?: string | null
          status?: string
          tournament_id?: string
          winner_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tier_draw_matches_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tier_draw_matches_draw_id_fkey"
            columns: ["draw_id"]
            isOneToOne: false
            referencedRelation: "tier_draws"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tier_draw_matches_entrant_a_id_fkey"
            columns: ["entrant_a_id"]
            isOneToOne: false
            referencedRelation: "placement_entrants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tier_draw_matches_entrant_b_id_fkey"
            columns: ["entrant_b_id"]
            isOneToOne: false
            referencedRelation: "placement_entrants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tier_draw_matches_parent_a_id_fkey"
            columns: ["parent_a_id"]
            isOneToOne: false
            referencedRelation: "tier_draw_matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tier_draw_matches_parent_b_id_fkey"
            columns: ["parent_b_id"]
            isOneToOne: false
            referencedRelation: "tier_draw_matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tier_draw_matches_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tier_draw_matches_winner_id_fkey"
            columns: ["winner_id"]
            isOneToOne: false
            referencedRelation: "placement_entrants"
            referencedColumns: ["id"]
          },
        ]
      }
      tier_draws: {
        Row: {
          bracket_size: number
          category_id: string
          champion_id: string | null
          created_at: string
          entrant_count: number
          id: string
          tier: string
          tournament_id: string
        }
        Insert: {
          bracket_size: number
          category_id: string
          champion_id?: string | null
          created_at?: string
          entrant_count: number
          id?: string
          tier: string
          tournament_id: string
        }
        Update: {
          bracket_size?: number
          category_id?: string
          champion_id?: string | null
          created_at?: string
          entrant_count?: number
          id?: string
          tier?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tier_draws_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tier_draws_champion_id_fkey"
            columns: ["champion_id"]
            isOneToOne: false
            referencedRelation: "placement_entrants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tier_draws_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_day_breaks: {
        Row: {
          created_at: string
          day_id: string
          end_time: string
          id: string
          label: string | null
          start_time: string
          tournament_id: string
        }
        Insert: {
          created_at?: string
          day_id: string
          end_time: string
          id?: string
          label?: string | null
          start_time: string
          tournament_id: string
        }
        Update: {
          created_at?: string
          day_id?: string
          end_time?: string
          id?: string
          label?: string | null
          start_time?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_day_breaks_day_id_fkey"
            columns: ["day_id"]
            isOneToOne: false
            referencedRelation: "tournament_days"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_day_breaks_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_day_courts: {
        Row: {
          court_id: string
          created_at: string
          day_id: string
          id: string
          tournament_id: string
        }
        Insert: {
          court_id: string
          created_at?: string
          day_id: string
          id?: string
          tournament_id: string
        }
        Update: {
          court_id?: string
          created_at?: string
          day_id?: string
          id?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_day_courts_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_day_courts_day_id_fkey"
            columns: ["day_id"]
            isOneToOne: false
            referencedRelation: "tournament_days"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_day_courts_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_days: {
        Row: {
          created_at: string
          date: string
          day_number: number
          end_time: string
          id: string
          start_time: string
          tournament_id: string
        }
        Insert: {
          created_at?: string
          date: string
          day_number: number
          end_time?: string
          id?: string
          start_time?: string
          tournament_id: string
        }
        Update: {
          created_at?: string
          date?: string
          day_number?: number
          end_time?: string
          id?: string
          start_time?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_days_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_editors: {
        Row: {
          added_by_profile_id: string | null
          created_at: string
          profile_id: string
          tournament_id: string
        }
        Insert: {
          added_by_profile_id?: string | null
          created_at?: string
          profile_id: string
          tournament_id: string
        }
        Update: {
          added_by_profile_id?: string | null
          created_at?: string
          profile_id?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_editors_added_by_profile_id_fkey"
            columns: ["added_by_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_editors_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_editors_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_registrations: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by_profile_id: string | null
          decision_note: string | null
          id: string
          profile_id: string
          status: string
          tournament_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by_profile_id?: string | null
          decision_note?: string | null
          id?: string
          profile_id: string
          status?: string
          tournament_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by_profile_id?: string | null
          decision_note?: string | null
          id?: string
          profile_id?: string
          status?: string
          tournament_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_registrations_decided_by_profile_id_fkey"
            columns: ["decided_by_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_registrations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_registrations_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournaments: {
        Row: {
          court_count: number
          created_at: string
          day_count: number
          format: string
          group_rest_gap_minutes: number
          group_slot_minutes: number
          id: string
          is_active: boolean
          knockout_best_of: number
          knockout_games_to: number
          knockout_rest_gap_minutes: number
          knockout_slot_minutes: number
          knockout_win_by: number
          max_categories_per_player: number
          name: string
          notes: string | null
          organizer_email: string | null
          organizer_name: string | null
          organizer_phone: string | null
          owner_profile_id: string
          placement_best_of: number
          placement_games_to: number
          placement_win_by: number
          registration_closes_at: string | null
          registration_opens_at: string | null
          rest_gap_minutes: number
          status: string
          venue_address: string | null
          venue_name: string | null
          venue_timezone: string
        }
        Insert: {
          court_count?: number
          created_at?: string
          day_count?: number
          format?: string
          group_rest_gap_minutes?: number
          group_slot_minutes?: number
          id?: string
          is_active?: boolean
          knockout_best_of?: number
          knockout_games_to?: number
          knockout_rest_gap_minutes?: number
          knockout_slot_minutes?: number
          knockout_win_by?: number
          max_categories_per_player?: number
          name?: string
          notes?: string | null
          organizer_email?: string | null
          organizer_name?: string | null
          organizer_phone?: string | null
          owner_profile_id: string
          placement_best_of?: number
          placement_games_to?: number
          placement_win_by?: number
          registration_closes_at?: string | null
          registration_opens_at?: string | null
          rest_gap_minutes?: number
          status?: string
          venue_address?: string | null
          venue_name?: string | null
          venue_timezone?: string
        }
        Update: {
          court_count?: number
          created_at?: string
          day_count?: number
          format?: string
          group_rest_gap_minutes?: number
          group_slot_minutes?: number
          id?: string
          is_active?: boolean
          knockout_best_of?: number
          knockout_games_to?: number
          knockout_rest_gap_minutes?: number
          knockout_slot_minutes?: number
          knockout_win_by?: number
          max_categories_per_player?: number
          name?: string
          notes?: string | null
          organizer_email?: string | null
          organizer_name?: string | null
          organizer_phone?: string | null
          owner_profile_id?: string
          placement_best_of?: number
          placement_games_to?: number
          placement_win_by?: number
          registration_closes_at?: string | null
          registration_opens_at?: string | null
          rest_gap_minutes?: number
          status?: string
          venue_address?: string | null
          venue_name?: string | null
          venue_timezone?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournaments_owner_profile_id_fkey"
            columns: ["owner_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      public_players: {
        Row: {
          created_at: string | null
          gender: string | null
          id: string | null
          name: string | null
        }
        Insert: {
          created_at?: string | null
          gender?: string | null
          id?: string | null
          name?: string | null
        }
        Update: {
          created_at?: string | null
          gender?: string | null
          id?: string | null
          name?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      add_tournament_day: {
        Args: {
          p_date: string
          p_end_time?: string
          p_start_time?: string
          p_tournament_id: string
        }
        Returns: string
      }
      add_tournament_editor: {
        Args: { p_email: string; p_tournament_id: string }
        Returns: string
      }
      advance_draw_locked: { Args: { p_draw_id: string }; Returns: undefined }
      advance_tier_draw_locked: {
        Args: { p_draw_id: string }
        Returns: undefined
      }
      apply_day_schedule: {
        Args: {
          p_day: number
          p_pool_ends: Json
          p_slots: Json
          p_stage: string
          p_tournament_id: string
        }
        Returns: undefined
      }
      apply_draw_generation: {
        Args: { p_category_id: string; p_force: boolean; p_payload: Json }
        Returns: undefined
      }
      apply_placement_day_schedule: {
        Args: { p_slots: Json; p_stage: string; p_tournament_id: string }
        Returns: undefined
      }
      apply_placement_generation: {
        Args: { p_category_id: string; p_force?: boolean; p_matches: Json }
        Returns: number
      }
      apply_placement_round_two: {
        Args: { p_category_id: string; p_force?: boolean; p_matches: Json }
        Returns: number
      }
      apply_pool_generation: {
        Args: { p_category_id: string; p_force: boolean; p_payload: Json }
        Returns: undefined
      }
      apply_tier_draws: {
        Args: {
          p_category_id: string
          p_draws: Json
          p_force?: boolean
          p_tiers: Json
        }
        Returns: undefined
      }
      assert_match_eligible: {
        Args: {
          p_allow_push?: boolean
          p_court_id: string
          p_ignore_rest?: boolean
          p_match_id: string
          p_start: string
          p_table: string
        }
        Returns: undefined
      }
      assert_registration_not_shut: {
        Args: { p_now: string; p_tournament_id: string }
        Returns: undefined
      }
      assert_registration_window: {
        Args: { p_tournament_id: string }
        Returns: undefined
      }
      assert_tournament_configurable: {
        Args: { p_tournament_id: string }
        Returns: undefined
      }
      assert_tournament_live: {
        Args: { p_tournament_id: string }
        Returns: undefined
      }
      assert_tournament_writable: {
        Args: { p_tournament_id: string }
        Returns: undefined
      }
      can_edit_tournament: {
        Args: { p_tournament_id: string }
        Returns: boolean
      }
      can_manage_tournament_access: {
        Args: { p_tournament_id: string }
        Returns: boolean
      }
      complete_tournament: {
        Args: { p_tournament_id: string }
        Returns: undefined
      }
      create_tournament: { Args: { p_payload: Json }; Returns: string }
      current_profile_id: { Args: never; Returns: string }
      current_system_role: { Args: never; Returns: string }
      current_tournament_id: { Args: never; Returns: string }
      decide_tournament_registration: {
        Args: { p_decision: string; p_note?: string; p_registration_id: string }
        Returns: undefined
      }
      delete_tournament: {
        Args: { p_tournament_id: string }
        Returns: undefined
      }
      desk_activity_tournament: {
        Args: { p_match_id: string; p_table: string }
        Returns: string
      }
      discard_tournament: {
        Args: { p_tournament_id: string }
        Returns: undefined
      }
      has_any_tournament_edit: { Args: never; Returns: boolean }
      is_platform_admin: { Args: never; Returns: boolean }
      is_tournament_editor: {
        Args: { p_tournament_id: string }
        Returns: boolean
      }
      is_tournament_owner: {
        Args: { p_tournament_id: string }
        Returns: boolean
      }
      list_tournament_editors: {
        Args: { p_tournament_id: string }
        Returns: {
          created_at: string
          email: string
          is_owner: boolean
          profile_id: string
        }[]
      }
      lock_placement_seeds: {
        Args: { p_category_id: string; p_seeds: Json }
        Returns: undefined
      }
      match_tournament: {
        Args: { p_match_id: string; p_table: string }
        Returns: string
      }
      my_tournament_registration: {
        Args: { p_tournament_id: string }
        Returns: {
          created_at: string
          decided_at: string
          decision_note: string
          id: string
          status: string
        }[]
      }
      normalize_email: { Args: { value: string }; Returns: string }
      notes_trim: { Args: { p_value: string }; Returns: string }
      placement_check_games: {
        Args: {
          p_best_of: number
          p_games: Json
          p_games_to: number
          p_win_by: number
        }
        Returns: string
      }
      placement_decided_matches: {
        Args: { p_category_id: string; p_entrant_id: string }
        Returns: number
      }
      placement_occupied_matches: {
        Args: { p_tournament_id: string }
        Returns: {
          court_id: string
          ends_at: string
          match_id: string
          match_table: string
          player_ids: string[]
          starts_at: string
        }[]
      }
      placement_required_matches: {
        Args: { p_category_id: string }
        Returns: number
      }
      remove_tournament_day: {
        Args: { p_day_id: string; p_tournament_id: string }
        Returns: undefined
      }
      remove_tournament_editor: {
        Args: { p_profile_id: string; p_tournament_id: string }
        Returns: undefined
      }
      report_draw_result: {
        Args: { p_games: Json; p_match_id: string }
        Returns: undefined
      }
      report_placement_result: {
        Args: { p_games: Json; p_match_id: string }
        Returns: undefined
      }
      report_pool_result: {
        Args: { p_match_id: string; p_score_a: number; p_score_b: number }
        Returns: undefined
      }
      report_tier_draw_result: {
        Args: { p_games: Json; p_match_id: string }
        Returns: undefined
      }
      reschedule_live_match: {
        Args: {
          p_court_id: string
          p_match_id: string
          p_scheduled_time: string
          p_table: string
        }
        Returns: undefined
      }
      reschedule_placement_match: {
        Args: {
          p_court_id: string
          p_match_id: string
          p_scheduled_time: string
          p_table: string
        }
        Returns: undefined
      }
      reset_and_repair_match: {
        Args: { p_match_id: string; p_table: string }
        Returns: undefined
      }
      reset_match_with_note: {
        Args: { p_match_id: string; p_note: string; p_table: string }
        Returns: undefined
      }
      reset_placement_result: {
        Args: { p_match_id: string }
        Returns: undefined
      }
      reset_placement_schedule: {
        Args: { p_tournament_id: string }
        Returns: Json
      }
      reset_placement_stage: {
        Args: { p_tournament_id: string }
        Returns: Json
      }
      reset_tier_draw_result: {
        Args: { p_match_id: string }
        Returns: undefined
      }
      resolve_match_exception: {
        Args: {
          p_match_id: string
          p_note: string
          p_status: string
          p_table: string
          p_winner_id: string
        }
        Returns: undefined
      }
      review_tournament_registrations: {
        Args: { p_tournament_id: string }
        Returns: {
          created_at: string
          decided_at: string
          decision_note: string
          email: string
          id: string
          profile_id: string
          status: string
        }[]
      }
      save_tournament_categories: {
        Args: { p_categories: Json; p_tournament_id: string }
        Returns: undefined
      }
      save_tournament_config: {
        Args: { p_payload: Json; p_tournament_id: string }
        Returns: undefined
      }
      save_tournament_days: {
        Args: { p_days: Json; p_tournament_id: string }
        Returns: undefined
      }
      set_active_tournament: {
        Args: { p_tournament_id: string }
        Returns: undefined
      }
      set_current_tournament: {
        Args: { p_tournament_id: string }
        Returns: undefined
      }
      set_placement_skill: {
        Args: {
          p_category_id: string
          p_skill_level: string
          p_team_id: string
        }
        Returns: undefined
      }
      set_tournament_courts: {
        Args: { p_count: number; p_tournament_id: string }
        Returns: undefined
      }
      shift_live_schedule_after_match: {
        Args: { p_match_id: string; p_table: string }
        Returns: undefined
      }
      start_match_safe: {
        Args: {
          p_court_id: string
          p_ignore_rest?: boolean
          p_match_id: string
          p_table: string
        }
        Returns: undefined
      }
      start_placement_match: {
        Args: { p_court_id?: string; p_match_id: string }
        Returns: undefined
      }
      start_tier_draw_match: {
        Args: { p_court_id?: string; p_match_id: string }
        Returns: undefined
      }
      start_tournament: {
        Args: { p_tournament_id: string }
        Returns: undefined
      }
      submit_tournament_registration: {
        Args: { p_tournament_id: string }
        Returns: string
      }
      sync_placement_entrants: {
        Args: { p_category_id: string }
        Returns: number
      }
      tournament_access: { Args: { p_tournament_id: string }; Returns: Json }
      tournament_ends_at: { Args: { p_tournament_id: string }; Returns: string }
      tournament_is_ready: {
        Args: { p_tournament_id: string }
        Returns: boolean
      }
      tournament_lifecycle_state: {
        Args: { p_tournament_id: string }
        Returns: string
      }
      tournament_of_category: {
        Args: { p_category_id: string }
        Returns: string
      }
      tournament_of_placement_match: {
        Args: { p_match_id: string }
        Returns: string
      }
      tournament_of_registration: {
        Args: { p_registration_id: string }
        Returns: string
      }
      tournament_of_tier_draw_match: {
        Args: { p_match_id: string }
        Returns: string
      }
      tournament_readiness: { Args: { p_tournament_id: string }; Returns: Json }
      tournament_readiness_checks: {
        Args: { p_tournament_id: string }
        Returns: Json
      }
      tournament_registration_state: {
        Args: { p_tournament_id: string }
        Returns: string
      }
      tournament_starts_at: {
        Args: { p_tournament_id: string }
        Returns: string
      }
      tournament_summary: {
        Args: {
          p_ids?: string[]
          p_limit?: number
          p_offset?: number
          p_query?: string
          p_status?: string
        }
        Returns: {
          access_level: string
          category_count: number
          ends_at: string
          entry_count: number
          id: string
          name: string
          registration_state: string
          starts_at: string
          status: string
          venue_name: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

