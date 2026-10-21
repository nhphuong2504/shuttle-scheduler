import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Category, PlacementEntrant, PlacementMatch } from "./data";
import { pairPlacementRoundOne } from "./placement";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(async () => ({ data: 2, error: null })) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mocks.rpc } }));
import {
  generateMissingStages,
  generatePlacementRoundTwo,
  pendingPlacementGenerationKeys,
} from "./placement-actions";

function fixture(n = 8) {
  const entrants: PlacementEntrant[] = Array.from({ length: n }, (_, i) => ({
    id: `e${i + 1}`,
    seed: i + 1,
    excluded: false,
    category_id: "c",
    team_id: `t${i + 1}`,
    tournament_id: "t",
    created_at: "",
    seed_locked_at: "",
    skill_level: "intermediate",
    tier: null,
  }));
  const matches: PlacementMatch[] = pairPlacementRoundOne(
    entrants.map((e) => ({ id: e.id, seed: e.seed! })),
  ).matches.map((m, i) => ({
    id: m.key,
    category_id: "c",
    generation_key: m.key,
    stage: "round1",
    entrant_a_id: m.entrantAId,
    entrant_b_id: m.entrantBId,
    winner_id: i % 2 === 0 ? m.entrantAId : null,
    status: i % 2 === 0 ? "reported" : "scheduled",
    prerequisite_ids: [],
    tournament_id: "t",
    created_at: "",
    court_id: null,
    scheduled_time: null,
    started_at: null,
    ended_at: null,
    reported_time: null,
    games: [],
    is_makeup: false,
    is_crossover: false,
    note: null,
  }));
  return { entrants, matches, categories: [{ id: "c", code: "MS" }] as Category[], draws: [] };
}
beforeEach(() => mocks.rpc.mockClear());
describe("incremental generation actions", () => {
  it("requests incremental RPC while round one remains open, including when round two already has rows", async () => {
    const input = fixture();
    expect((await generateMissingStages(input)).generated.roundTwo).toBe(2);
    expect(mocks.rpc).toHaveBeenCalledWith("open_ready_placement_round_two", {
      p_category_id: "c",
    });
    input.matches.push({
      ...input.matches[0]!,
      id: "r2-1",
      generation_key: "r2-1",
      stage: "round2",
      winner_id: null,
      status: "scheduled",
    });
    await generateMissingStages(input);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
  it("keeps odd and crossover fields on the full-result gate", async () => {
    for (const n of [5, 6, 7]) {
      const input = fixture(n);
      await expect(generatePlacementRoundTwo("c", input.entrants, input.matches)).rejects.toThrow(
        "every round one result",
      );
      expect(pendingPlacementGenerationKeys(input.entrants, input.matches, [])).toEqual([]);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
