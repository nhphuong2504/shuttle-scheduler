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
  await waitForStreaming();
}, 120_000);

afterAll(async () => {
  await destroyStaffIdentity(admin);
}, 120_000);

interface Received {
  table: string;
  eventType: string;
}

/**
 * Waits until the project is actually streaming changes, before any test asserts delivery.
 *
 * WHY THIS IS NEEDED, and why it is not papering over a failure
 *
 * A stack that has just been started is not yet streaming. The first client connection
 * triggers per-tenant bootstrap on the Realtime service - it creates the
 * `realtime.messages` publication and starts its replication stream - and a change published
 * during that window is never delivered. The service logs the bootstrap happening while the
 * first test is already running:
 *
 *     Starting stream replication for slot supabase_realtime_messages_replication_slot_
 *
 * The effect is that the first test to run fails on a cold stack and every later run passes.
 * That was reproduced deliberately, twice: a freshly migrated stack failed on
 * `delivers a roster change`, and the same stack passed on the immediate re-run, while the
 * *second* test in that same cold run passed because the tenant was warm by then.
 *
 * It matters because the failure is indistinguishable from a real one at the assertion, and
 * the assertion's message blames the publication - which, on a rebuilt database, is exactly
 * the silent failure this suite exists to catch. A false report of that specific defect is
 * worse than a slow test, so the precondition is established explicitly instead.
 *
 * The first change after a cold start is expected to be lost, so the probe writes again
 * rather than treating the first quiet period as conclusive. This still fails loudly if
 * changes never arrive: it is a precondition, not a skip, and the suite stays red when
 * delivery is genuinely broken.
 */
async function waitForStreaming(): Promise<void> {
  const seen: string[] = [];

  const channel = admin.client
    .channel(`itest-warmup-${Date.now()}`)
    .on("postgres_changes", { event: "*", schema: "public" }, (payload) => {
      seen.push((payload as { table?: string }).table ?? "unknown");
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
      "The realtime channel never reached SUBSCRIBED while warming up. Realtime is disabled " +
        "on the project, or the websocket endpoint is unreachable.",
    );
  }

  const probe = `itest-warmup-${Date.now().toString(36)}`;
  try {
    // Three attempts: the first write is the one a cold tenant drops, so a single quiet
    // period proves nothing. Three quiet periods in a row is a real failure.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await admin.client.from("players").insert({ name: probe });
      if (error) throw new Error(`the warm-up write failed: ${error.message}`);

      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && seen.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (seen.length > 0) return;
    }

    throw new Error(
      "Realtime never delivered any change, even after warming up. This is not the cold-start " +
        "delay: it means changes are not reaching subscribers at all. Check that the tables the " +
        "app reads are members of the `supabase_realtime` publication - see " +
        "supabase/migrations/20260920000000_realtime_publication_membership.sql.",
    );
  } finally {
    await admin.client.from("players").delete().eq("name", probe);
    await admin.client.removeChannel(channel);
  }
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
      "No postgres_changes event arrived for a `players` insert, and the stream was already " +
        "warm - `waitForStreaming` established that before this test ran, so the cold-start " +
        "delay is not the explanation. The row was written (the insert reported no error), so " +
        "either `public.players` is not a member of the `supabase_realtime` publication - see " +
        "supabase/migrations/20260920000000_realtime_publication_membership.sql - or the " +
        "signed-in session cannot SELECT it, because Realtime authorizes postgres_changes " +
        "through the table's RLS policies.",
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
        "No postgres_changes event arrived for a tournament day write, and the stream was " +
          "already warm. `tournament_days` or `tournaments` is likely not a member of the " +
          "supabase_realtime publication, or the signed-in session cannot SELECT the row.",
      ).toBeGreaterThan(0);
    } finally {
      await admin.client.rpc("delete_tournament_draft", {
        p_tournament_id: tournamentId,
      } as never);
    }
  }, 60_000);
});
