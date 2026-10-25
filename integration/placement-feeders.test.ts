import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { createPlayer, createTeam } from "@/lib/tournament/actions";
import {
  fetchPlacementEntrants,
  fetchPlacementMatches,
  type PlacementMatch,
} from "@/lib/tournament/data";
import {
  generatePlacementRoundOne,
  generatePlacementRoundTwo,
  lockPlacementSeeds,
  syncPlacementEntrants,
} from "@/lib/tournament/placement-actions";
import {
  anonClient,
  createIdentity,
  createOwnedTournament,
  destroyIdentity,
  destroyTournaments,
  forceStatus,
  serviceClient,
  type TestIdentity,
} from "./env";

// Real RPC/trigger coverage. Local Supabase only; integration/setup-guard.ts enforces the target.
let owner: TestIdentity;
let viewer: TestIdentity;
let tournamentId: string;
let categoryId: string;
let r1: PlacementMatch[];
let playerIds: string[] = [];
beforeAll(async () => {
  owner = await createIdentity("user", "feeders-owner");
  viewer = await createIdentity("user", "feeders-viewer");
  const { error } = await supabase.auth.signInWithPassword({
    email: owner.email,
    password: owner.password,
  });
  if (error) throw error;
});
afterEach(async () => {
  await destroyTournaments(tournamentId);
  if (playerIds.length) await serviceClient().from("players").delete().in("id", playerIds);
  playerIds = [];
});
afterAll(async () => {
  await supabase.auth.signOut();
  await destroyIdentity(owner);
  await destroyIdentity(viewer);
});

async function seed(count = 8) {
  tournamentId = await createOwnedTournament(owner);
  const category = await serviceClient()
    .from("categories")
    .select("id")
    .eq("tournament_id", tournamentId)
    .single();
  if (category.error) throw category.error;
  categoryId = category.data.id;
  for (let i = 0; i < count; i++) {
    const id = await createPlayer({ name: `feeder-${i}`, gender: "M" });
    playerIds.push(id);
    await createTeam({ categoryId, player1: id, player2: null });
  }
  await syncPlacementEntrants(categoryId);
  const entrants = await fetchPlacementEntrants(tournamentId);
  await lockPlacementSeeds(categoryId, entrants, () => 0.5);
  await generatePlacementRoundOne(categoryId, await fetchPlacementEntrants(tournamentId));
  await forceStatus(tournamentId, "in_progress");
  r1 = await fetchPlacementMatches(tournamentId);
}
async function open() {
  const result = await owner.client.rpc("open_ready_placement_round_two", {
    p_category_id: categoryId,
  });
  if (result.error) throw result.error;
  return result.data;
}
async function report(match: PlacementMatch, flip = false) {
  const result = await owner.client.rpc("report_placement_result", {
    p_match_id: match.id,
    p_games: [{ a: flip ? 10 : 21, b: flip ? 21 : 10 }],
  });
  if (result.error) throw result.error;
}

describe("incremental placement RPCs", () => {
  it.each([5, 6, 7])("leaves the %i-entrant adaptive format untouched", async (n) => {
    await seed(n);
    for (const m of r1) await report(m);
    expect(await open()).toBe(0);
    expect((await fetchPlacementMatches(tournamentId)).filter((m) => m.stage === "round2")).toEqual(
      [],
    );
  });

  it("does not adopt or change an existing batch-generated round two", async () => {
    await seed();
    for (const m of r1) await report(m);
    await generatePlacementRoundTwo(
      categoryId,
      await fetchPlacementEntrants(tournamentId),
      await fetchPlacementMatches(tournamentId),
      true,
    );
    const before = await fetchPlacementMatches(tournamentId);
    expect(await open()).toBe(0);
    expect(await fetchPlacementMatches(tournamentId)).toEqual(before);
  });

  it("does not materialize slots from a void source", async () => {
    await seed();
    const update = await serviceClient()
      .from("placement_matches")
      .update({ status: "void" })
      .eq("id", r1[0]!.id);
    if (update.error) throw update.error;
    expect(await open()).toBe(0);
  });

  it("opens only decided feeders, is idempotent under concurrent calls, and preserves existing times", async () => {
    await seed();
    expect(await open()).toBe(0);
    await report(r1[0]!);
    expect(await open()).toBe(0);
    await report(r1[2]!);
    const counts = await Promise.all([open(), open()]);
    expect(counts.sort()).toEqual([0, 2]);
    let children = (await fetchPlacementMatches(tournamentId)).filter((m) => m.stage === "round2");
    expect(children.map((m) => m.generation_key).sort()).toEqual(["r2-1", "r2-3"]);
    expect(
      children.every(
        (m) => m.prerequisite_ids.includes(r1[0]!.id) && m.prerequisite_ids.includes(r1[2]!.id),
      ),
    ).toBe(true);
    const published = "2099-01-04T10:00:00+00:00";
    const updated = await serviceClient()
      .from("placement_matches")
      .update({ scheduled_time: published })
      .eq("id", children[0]!.id);
    if (updated.error) throw updated.error;
    await report(r1[1]!);
    await report(r1[3]!);
    expect(await open()).toBe(2);
    children = (await fetchPlacementMatches(tournamentId)).filter((m) => m.stage === "round2");
    expect(children).toHaveLength(4);
    expect(new Date(children.find((m) => m.scheduled_time)!.scheduled_time!).toISOString()).toBe(
      new Date(published).toISOString(),
    );
  });

  it("retracts only unplayed dependents and refuses a correction once one starts", async () => {
    await seed();
    for (const m of r1) await report(m);
    expect(await open()).toBe(4);
    const before = (await fetchPlacementMatches(tournamentId)).filter((m) => m.stage === "round2");
    await report(r1[0]!, true);
    const remaining = (await fetchPlacementMatches(tournamentId)).filter(
      (m) => m.stage === "round2",
    );
    expect(remaining.map((m) => m.id).sort()).toEqual(
      before
        .filter((m) => !m.prerequisite_ids.includes(r1[0]!.id))
        .map((m) => m.id)
        .sort(),
    );
    expect(await open()).toBe(2);
    const child = (await fetchPlacementMatches(tournamentId)).find(
      (m) => m.stage === "round2" && m.prerequisite_ids.includes(r1[0]!.id),
    )!;
    const started = await serviceClient()
      .from("placement_matches")
      .update({ status: "in-progress", started_at: new Date().toISOString() })
      .eq("id", child.id);
    if (started.error) throw started.error;
    const correction = await owner.client.rpc("report_placement_result", {
      p_match_id: r1[0]!.id,
      p_games: [{ a: 21, b: 10 }],
    });
    expect(correction.error?.message).toContain("already started");
    const reset = await owner.client.rpc("reset_placement_result", { p_match_id: r1[0]!.id });
    expect(reset.error?.message).toContain("already started");
    // An unrelated source is still editable, despite the other round-two match being on court.
    await report(r1[1]!, true);
  });

  it("refuses viewers/anonymous callers and client writes to source definitions", async () => {
    await seed();
    for (const client of [viewer.client, anonClient()]) {
      const result = await client.rpc("open_ready_placement_round_two", {
        p_category_id: categoryId,
      });
      expect(result.error).not.toBeNull();
    }
    const write = await owner.client
      .from("placement_round_two_slots")
      .insert({
        category_id: categoryId,
        generation_key: "fake",
        source_a_id: r1[0]!.id,
        source_b_id: r1[1]!.id,
        outcome: "winner",
      });
    expect(write.error).not.toBeNull();
    expect(
      (await owner.client.from("placement_matches").delete().eq("id", r1[0]!.id)).error,
    ).not.toBeNull();
    expect(
      (
        await owner.client
          .from("placement_matches")
          .update({ category_id: categoryId })
          .eq("id", r1[0]!.id)
      ).error,
    ).not.toBeNull();
    await forceStatus(tournamentId, "completed");
    const result = await owner.client.rpc("open_ready_placement_round_two", {
      p_category_id: categoryId,
    });
    expect(result.error).not.toBeNull();
  });

  it("serializes starting a child against correcting its source", async () => {
    await seed();
    await report(r1[0]!);
    await report(r1[2]!);
    await open();
    const child = (await fetchPlacementMatches(tournamentId)).find(
      (m) => m.generation_key === "r2-1",
    )!;
    const court = await serviceClient()
      .from("courts")
      .select("id")
      .eq("tournament_id", tournamentId)
      .limit(1)
      .single();
    if (court.error) throw court.error;
    // A match starts only where it is placed (`20261025000000_start_only_placed_matches.sql`), so
    // the child is given that court and a time first; the race is the start against the correction.
    const placed = await serviceClient()
      .from("placement_matches")
      .update({ court_id: court.data.id, scheduled_time: new Date().toISOString() })
      .eq("id", child.id);
    if (placed.error) throw placed.error;
    const [start, correction] = await Promise.all([
      owner.client.rpc("start_placement_match", {
        p_match_id: child.id,
        p_court_id: court.data.id,
      }),
      owner.client.rpc("report_placement_result", {
        p_match_id: r1[0]!.id,
        p_games: [{ a: 10, b: 21 }],
      }),
    ]);
    expect([start, correction].filter((r) => r.error === null)).toHaveLength(1);
    const after = await fetchPlacementMatches(tournamentId);
    const onCourt = after.find((m) => m.id === child.id);
    if (onCourt) {
      expect(onCourt.status).toBe("in-progress");
      expect(after.find((m) => m.id === r1[0]!.id)?.winner_id).toBe(child.entrant_a_id);
    } else {
      expect(after.find((m) => m.id === r1[0]!.id)?.winner_id).toBe(r1[0]!.entrant_b_id);
    }
  });
});
