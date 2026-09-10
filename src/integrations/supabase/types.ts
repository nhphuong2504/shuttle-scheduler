export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      categories: {
        Row: {
          code: string
          created_at: string
          entry_type: string
          id: string
          name: string
          sort_order: number
        }
        Insert: {
          code: string
          created_at?: string
          entry_type: string
          id?: string
          name: string
          sort_order?: number
        }
        Update: {
          code?: string
          created_at?: string
          entry_type?: string
          id?: string
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      courts: {
        Row: {
          created_at: string
          id: string
          number: number
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          number: number
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          number?: number
          status?: string
        }
        Relationships: []
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
        }
        Insert: {
          bracket_size: number
          category_id: string
          created_at?: string
          entrant_count: number
          id?: string
          tier: string
        }
        Update: {
          bracket_size?: number
          category_id?: string
          created_at?: string
          entrant_count?: number
          id?: string
          tier?: string
        }
        Relationships: [
          {
            foreignKeyName: "draws_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
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
        }
        Insert: {
          id?: string
          manual_rank_override?: number | null
          pool_id: string
          position: number
          team_id: string
        }
        Update: {
          id?: string
          manual_rank_override?: number | null
          pool_id?: string
          position?: number
          team_id?: string
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
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          name: string
          scheduled_end?: string | null
          size: number
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          name?: string
          scheduled_end?: string | null
          size?: number
        }
        Relationships: [
          {
            foreignKeyName: "pools_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_roles: {
        Row: {
          created_at: string
          email: string
          id: string
          role: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          role: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          role?: string
          user_id?: string | null
        }
        Relationships: []
      }
      teams: {
        Row: {
          category_id: string
          created_at: string
          id: string
          player_1_id: string
          player_2_id: string | null
          seed: number | null
          withdrawn: boolean
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          player_1_id: string
          player_2_id?: string | null
          seed?: number | null
          withdrawn?: boolean
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          player_1_id?: string
          player_2_id?: string | null
          seed?: number | null
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
            referencedRelation: "player_roster"
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
            foreignKeyName: "teams_player_2_id_fkey"
            columns: ["player_2_id"]
            isOneToOne: false
            referencedRelation: "player_roster"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_player_2_id_fkey"
            columns: ["player_2_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_settings: {
        Row: {
          court_count: number
          created_at: string
          day_1: string
          day_2: string
          day_end_time: string
          day_start_time: string
          group_rest_gap_minutes: number
          group_slot_minutes: number
          id: string
          knockout_rest_gap_minutes: number
          knockout_slot_minutes: number
          name: string
          planning_end_time: string
          rest_gap_minutes: number
          venue_timezone: string
        }
        Insert: {
          court_count?: number
          created_at?: string
          day_1?: string
          day_2?: string
          day_end_time?: string
          day_start_time?: string
          group_rest_gap_minutes?: number
          group_slot_minutes?: number
          id?: string
          knockout_rest_gap_minutes?: number
          knockout_slot_minutes?: number
          name?: string
          planning_end_time?: string
          rest_gap_minutes?: number
          venue_timezone?: string
        }
        Update: {
          court_count?: number
          created_at?: string
          day_1?: string
          day_2?: string
          day_end_time?: string
          day_start_time?: string
          group_rest_gap_minutes?: number
          group_slot_minutes?: number
          id?: string
          knockout_rest_gap_minutes?: number
          knockout_slot_minutes?: number
          name?: string
          planning_end_time?: string
          rest_gap_minutes?: number
          venue_timezone?: string
        }
        Relationships: []
      }
    }
    Views: {
      player_roster: {
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
      advance_draw_locked: { Args: { p_draw_id: string }; Returns: undefined }
      apply_day_schedule: {
        Args: { p_day: number; p_pool_ends: Json; p_slots: Json }
        Returns: undefined
      }
      apply_draw_generation: {
        Args: { p_category_id: string; p_force: boolean; p_payload: Json }
        Returns: undefined
      }
      apply_pool_generation: {
        Args: { p_category_id: string; p_force: boolean; p_payload: Json }
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
      current_staff_role: { Args: never; Returns: string }
      has_staff_role: { Args: { needed: string[] }; Returns: boolean }
      is_invited_email: { Args: { value: string }; Returns: boolean }
      normalize_email: { Args: { value: string }; Returns: string }
      report_draw_result: {
        Args: { p_games: Json; p_match_id: string }
        Returns: undefined
      }
      report_pool_result: {
        Args: { p_match_id: string; p_score_a: number; p_score_b: number }
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
      reset_and_repair_match: {
        Args: { p_match_id: string; p_table: string }
        Returns: undefined
      }
      reset_match_with_note: {
        Args: { p_match_id: string; p_note: string; p_table: string }
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
  public: {
    Enums: {},
  },
} as const
