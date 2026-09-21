import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createStaffIdentity, destroyStaffIdentity, type TestIdentity } from "./env";

/**
 * Realtime delivery.
 *
 * WHY THIS IS THE HIGHEST-VALUE TEST IN THE SUITE
 *
 * The desk subscribes to `postgres_changes` on the whole `public` schema and, on any event,
 * invalidates every query. It renders a `Live` badge from the channel's subscribe callback.
 *
 * That badge reports the websocket, not the data. If a table is not a member of the
 * `supabase_realtime` publication the websocket still subscribes successfully and simply
 * never fires - so the desk shows `Live` while results entered on one court never appear on
 * another, and an operator's only recourse is to reload by hand mid-tournament. No mocked
 * test can see this, because the transport is the thing being mocked, and no type check can
 * see it, because publication membership is not part of the schema types.
 *
 * The subscription is deliberately unfiltered, exactly as `useRealtimeRefresh` writes it.
 * A filtered subscription would still pass while a table was missing from the publication,
 * because the filter would mask the absence for every other table too.
 *
 * NOTE ON SCOPE: this asserts live delivery for tables that can be written without a fully
 * built tournament. Per-table membership for the remaining nineteen is checked by
 * `scripts/parity-dump.sql`, whose `publication_table` rows enumerate the publication
 * directly - the PostgREST surface does not expose `pg_publication_tables`, and adding a
 * diagnostic function to the schema for the sake of a test would be a worse trade.
 */

let admin: TestIdentity;

beforeAll(async () => {
  admin = await createStaffIdentity("admin", "rt");
}, 120_000);

afterAll(async () => {
  await destroyStaffIdentity(admin);
}, 120_000);

interface Received {
  table: string;
  eventType: string;
}

/**
 * Runs `act` while subscribed, and resolves with every event seen.
 *
 * The subscription is established before `act` runs and torn down after, so an event fired
 * during setup cannot be counted as delivery.
 */
async function collectEvents(act: () => Promise<void>, settleMs = 4_000): Promise<Received[]> {
  const seen: Received[] = [];

  const channel = admin.client
    .channel(`itest-ops-live-${Date.now()}`)
    .on("postgres_changes", { event: "*", schema: "public" }, (payload) => {
      seen.push({
        table: (payload as { table?: string }).table ?? "unknown",
        eventType: (payload as { eventType?: string }).eventType ?? "unknown",
      });
    });

  const subscribed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve(true);
      }
    });
  });

  if (!subscribed) {
    throw new Error(
      "The realtime channel never reached SUBSCRIBED. Realtime is disabled on the project, " +
        "or the websocket endpoint is unreachable.",
    );
  }

  await act();

  // Waits for the quiet period rather than a fixed sleep: delivery is asynchronous, and a
  // single flush can arrive after the write returns.
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  await admin.client.removeChannel(channel);

  return seen;
}

describe("realtime delivery", () => {
  it("delivers a roster change to a signed-in staff session", async () => {
    const name = `itest-realtime-${Date.now().toString(36)}`;

    const events = await collectEvents(async () => {
      const { error } = await admin.client.from("players").insert({ name });
      if (error) throw new Error(`inserting the player failed: ${error.message}`);
    });

    const playerEvents = events.filter((e) => e.table === "players");
    expect(
      playerEvents.length,
      "No postgres_changes event arrived for a `players` insert. If the row was written but " +
        "no event followed, `public.players` is almost certainly missing from the " +
        "`supabase_realtime` publication - see " +
        "supabase/migrations/20260920000000_realtime_publication_membership.sql.",
    ).toBeGreaterThan(0);

    // Cleanup after the assertion, so a failing assertion still leaves the evidence in place.
    await admin.client.from("players").delete().eq("name", name);
  }, 60_000);

  it("delivers tournament day changes to a signed-in staff session", async () => {
    // A second table family: structure changes are what the organiser's Schedule tab watches,
    // and they are a different code path from the desk's match refresh.
    const { data: tournamentId, error: createError } = await admin.client.rpc(
      "create_tournament_draft",
      { p_payload: { name: `itest-realtime-${Date.now().toString(36)}` } } as never,
    );
    if (createError) throw new Error(`creating the draft failed: ${createError.message}`);

    try {
      const events = await collectEvents(async () => {
        const { error } = await admin.client.rpc("save_tournament_days", {
          p_tournament_id: tournamentId,
          p_days: [
            {
              date: "2026-11-07",
              start_time: "09:00",
              end_time: "18:00",
              courts: [1, 2],
              breaks: [],
            },
          ],
        } as never);
        if (error) throw new Error(`saving days failed: ${error.message}`);
      });

      const structureEvents = events.filter(
        (e) => e.table === "tournament_days" || e.table === "tournaments",
      );
      expect(
        structureEvents.length,
        "No postgres_changes event arrived for a tournament day write. `tournament_days` or " +
          "`tournaments` is likely missing from the supabase_realtime publication.",
      ).toBeGreaterThan(0);
    } finally {
      await admin.client.rpc("delete_tournament_draft", {
        p_tournament_id: tournamentId,
      } as never);
    }
  }, 60_000);
});
