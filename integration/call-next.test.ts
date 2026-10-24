import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
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

let owner: TestIdentity;
let player: TestIdentity;
let outsider: TestIdentity;
let tournamentId: string;
let args: {
  p_request_id: string;
  p_tournament_id: string;
  p_kind: string;
  p_match_id: string;
  p_court_id: string;
  p_scheduled_time: string;
  p_player_ids: string[];
  p_message: string;
};
let notificationId: string;
let playerIds: string[] = [];

function ok<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

beforeAll(async () => {
  owner = await createIdentity("user", "call-owner");
  player = await createIdentity("user", "call-player");
  outsider = await createIdentity("user", "call-outsider");
  tournamentId = await createOwnedTournament(owner);
  const admin = serviceClient();
  const category = ok(
    await admin.from("categories").select("id").eq("tournament_id", tournamentId).single(),
  )!;
  // Seed a pending request, then exercise the actual approval bridge to link the player.
  const request = ok(
    await admin
      .from("tournament_registrations")
      .insert({ tournament_id: tournamentId, profile_id: player.profileId })
      .select("id")
      .single(),
  )!;
  ok(
    await admin
      .from("tournament_registration_entries")
      .insert({ registration_id: request.id, category_id: category.id }),
  );
  ok(
    await owner.client.rpc("decide_tournament_registration", {
      p_registration_id: request.id,
      p_decision: "approved",
    }),
  );
  const linked = ok(
    await admin.from("players").select("id").eq("profile_id", player.profileId).single(),
  )!;
  const unlinked = ok(
    await admin.from("players").insert({ name: "Call walk-in", gender: "M" }).select("id").single(),
  )!;
  playerIds = [linked.id, unlinked.id];
  ok(
    await admin
      .from("teams")
      .insert({ tournament_id: tournamentId, category_id: category.id, player_1_id: unlinked.id }),
  );
  ok(await owner.client.rpc("sync_placement_entrants", { p_category_id: category.id }));
  const entrants = ok(
    await admin.from("placement_entrants").select("id").eq("tournament_id", tournamentId),
  )!;
  const court = ok(
    await admin
      .from("courts")
      .select("id")
      .eq("tournament_id", tournamentId)
      .order("number")
      .limit(1)
      .single(),
  )!;
  const scheduled = "2020-01-04T16:00:00.000Z";
  const match = ok(
    await admin
      .from("placement_matches")
      .insert({
        tournament_id: tournamentId,
        category_id: category.id,
        stage: "round1",
        generation_key: "r1-call-test",
        entrant_a_id: entrants[0]!.id,
        entrant_b_id: entrants[1]!.id,
        court_id: court.id,
        scheduled_time: scheduled,
      })
      .select("id")
      .single(),
  )!;
  await forceStatus(tournamentId, "in_progress");
  args = {
    p_request_id: randomUUID(),
    p_tournament_id: tournamentId,
    p_kind: "placement",
    p_match_id: match.id,
    p_court_id: court.id,
    p_scheduled_time: scheduled,
    p_player_ids: playerIds,
    p_message: "Please prepare near Court 1.",
  };
});
afterAll(async () => {
  if (tournamentId) await destroyTournaments(tournamentId);
  if (playerIds.length) await serviceClient().from("players").delete().in("id", playerIds);
  for (const identity of [owner, player, outsider]) if (identity) await destroyIdentity(identity);
});

describe.sequential("in-app Call next", () => {
  it("withholds reach and send from participants and anonymous visitors", async () => {
    for (const client of [player.client, outsider.client, anonClient()]) {
      expect(
        (await client.rpc("desk_call_state", { p_tournament_id: tournamentId })).error,
      ).toBeTruthy();
      expect((await client.rpc("send_match_call", args)).error).toBeTruthy();
    }
  });
  it("returns reach booleans only and rejects a stale target", async () => {
    const state = ok(
      await owner.client.rpc("desk_call_state", { p_tournament_id: tournamentId }),
    ) as { players: { id: string; inApp: boolean }[] };
    expect(state.players.find((p) => p.id === playerIds[0])?.inApp).toBe(true);
    expect(state.players.find((p) => p.id === playerIds[1])?.inApp).toBe(false);
    expect(JSON.stringify(state)).not.toContain(player.email);
    for (const patch of [
      { p_scheduled_time: "2020-01-04T17:00:00Z" },
      { p_player_ids: [playerIds[0]!] },
    ]) {
      expect(
        (await owner.client.rpc("send_match_call", { ...args, ...patch })).error?.message,
      ).toMatch(/changed/);
    }
  });
  it("atomically sends only to linked accounts and deduplicates concurrent retries", async () => {
    const results = await Promise.all([
      owner.client.rpc("send_match_call", args),
      owner.client.rpc("send_match_call", args),
    ]);
    for (const result of results) expect((ok(result) as { count: number }).count).toBe(1);
    const mine = ok(await player.client.rpc("my_match_notifications")) as {
      id: string;
      message: string;
      read_at: string | null;
      outdated: boolean;
    }[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ message: args.p_message, read_at: null, outdated: false });
    notificationId = mine[0]!.id;
    expect(ok(await outsider.client.rpc("my_match_notifications"))).toEqual([]);
    expect(ok(await owner.client.rpc("my_match_notifications"))).toEqual([]);
  });
  it("only lets the recipient acknowledge and rate limits a fresh call", async () => {
    ok(await outsider.client.rpc("read_match_notification", { p_id: notificationId }));
    let mine = ok(await player.client.rpc("my_match_notifications")) as {
      read_at: string | null;
    }[];
    expect(mine[0]!.read_at).toBeNull();
    ok(await player.client.rpc("read_match_notification", { p_id: notificationId }));
    mine = ok(await player.client.rpc("my_match_notifications")) as { read_at: string | null }[];
    expect(mine[0]!.read_at).toBeTruthy();
    expect(
      (await owner.client.rpc("send_match_call", { ...args, p_request_id: randomUUID() })).error
        ?.message,
    ).toMatch(/30 seconds/);
  });
  it("marks an old call outdated and refuses calls after the tournament completes", async () => {
    ok(
      await serviceClient()
        .from("placement_matches")
        .update({ status: "in-progress", started_at: args.p_scheduled_time })
        .eq("id", args.p_match_id),
    );
    const mine = ok(await player.client.rpc("my_match_notifications")) as { outdated: boolean }[];
    expect(mine[0]!.outdated).toBe(true);
    await forceStatus(tournamentId, "completed");
    expect(
      (await owner.client.rpc("send_match_call", { ...args, p_request_id: randomUUID() })).error,
    ).toBeTruthy();
  });
});
