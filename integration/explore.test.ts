import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  anonClient,
  createIdentity,
  createOwnedTournament,
  destroyIdentity,
  destroyTournaments,
  expectRefused,
  type TestIdentity,
} from "./env";

/**
 * The public tournament list, against the real database.
 *
 * `explore_tournaments` and `explore_tournament_counts` are granted to `anon`, and everything
 * they filter, sort and count is computed by the database, which a fixture cannot reproduce:
 * the order of a page, the size of the whole result, and the refusal of a word outside the
 * vocabulary are only true if the real function says so.
 *
 * Every assertion is scoped to a search term that only this file's tournaments contain, so the
 * suite is correct whatever else the project holds.
 */

const tag = `xplr${Date.now().toString(36)}`;

let owner: TestIdentity;
const tournamentIds: string[] = [];
const names = [`${tag} delta`, `${tag} alpha`, `${tag} charlie`, `${tag} bravo`];

beforeAll(async () => {
  owner = await createIdentity("user", "explore");
  // Four tournaments across the three statuses: two upcoming, one in progress, one completed.
  const specs = [
    { name: names[0] as string, status: "upcoming" },
    { name: names[1] as string, status: "upcoming" },
    { name: names[2] as string, status: "in_progress" },
    { name: names[3] as string, status: "completed" },
  ] as const;
  for (const spec of specs) tournamentIds.push(await createOwnedTournament(owner, spec));
}, 180_000);

afterAll(async () => {
  await destroyTournaments(...tournamentIds);
  await destroyIdentity(owner);
}, 180_000);

async function page(args: Record<string, unknown>) {
  const { data, error } = await anonClient().rpc("explore_tournaments", {
    p_query: tag,
    ...args,
  } as never);
  if (error) throw new Error(`explore_tournaments failed: ${error.message}`);
  return data as unknown as { name: string; status: string; total_count: number }[];
}

describe("explore_tournaments, called anonymously", () => {
  it("answers a visitor with no session", async () => {
    const rows = await page({ p_limit: 50 });
    expect(rows.map((row) => row.name).sort()).toEqual([...names].sort());
  });

  it("reports the size of the whole result beside a page of it", async () => {
    const rows = await page({ p_limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.total_count).toBe(4);
  });

  it("pages add up: nothing repeated, nothing skipped", async () => {
    const first = await page({ p_limit: 2, p_offset: 0, p_sort: "name" });
    const second = await page({ p_limit: 2, p_offset: 2, p_sort: "name" });
    const seen = [...first, ...second].map((row) => row.name);
    expect(new Set(seen).size).toBe(4);
    expect(seen).toEqual([`${tag} alpha`, `${tag} bravo`, `${tag} charlie`, `${tag} delta`]);
  });

  it("filters by status", async () => {
    const rows = await page({ p_status: "upcoming", p_limit: 50 });
    expect(rows.every((row) => row.status === "upcoming")).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("puts live and upcoming events ahead of finished ones when sorted soonest", async () => {
    const rows = await page({ p_sort: "soonest", p_limit: 50 });
    expect(rows.at(-1)?.status).toBe("completed");
  });

  it("keeps a page size inside its limit however large the request", async () => {
    const rows = await page({ p_limit: 100000 });
    expect(rows.length).toBeLessThanOrEqual(50);
  });

  it("refuses a word outside the vocabulary rather than answering everything", async () => {
    for (const bad of [{ p_status: "draft" }, { p_sort: "random" }, { p_range: "decade" }]) {
      const error = await expectRefused(() => anonClient().rpc("explore_tournaments", bad as never));
      // The function's own refusal, not a missing function or a typo that also throws.
      expect(error.message).toMatch(/^Unknown /);
    }
  });

  it("leaves out a tournament whose registration is not open when asked for open ones", async () => {
    // None of the four has a registration window, so none can be `open`.
    const rows = await page({ p_registration_open: true, p_limit: 50 });
    expect(rows).toHaveLength(0);
  });
});

describe("explore_tournament_counts, called anonymously", () => {
  it("counts every status, with a zero where nothing matches", async () => {
    const { data, error } = await anonClient().rpc("explore_tournament_counts", {
      p_query: tag,
    } as never);
    if (error) throw new Error(error.message);
    const counts = Object.fromEntries(
      (data as unknown as { status: string; total: number }[]).map((row) => [row.status, row.total]),
    );
    expect(counts).toEqual({ in_progress: 1, upcoming: 2, completed: 1 });
  });

  it("refuses an unknown date window", async () => {
    const error = await expectRefused(() =>
      anonClient().rpc("explore_tournament_counts", { p_range: "decade" } as never),
    );
    expect(error.message).toMatch(/^Unknown range/);
  });
});
