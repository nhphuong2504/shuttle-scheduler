import { describe, expect, it } from "vitest";

import type { Category, Team } from "./data";
import {
  capacityText,
  categoryUsage,
  choosableCategories,
  entryTypeLabel,
  registrationEntriesPayload,
  toRegistrationQueue,
  type RegistrationEntryInput,
  type ReviewRegistrationRow,
} from "./registration";

/**
 * The rules a registration form runs on, the payload it sends, and the fold the reviewer's
 * queue reads.
 *
 * All of them are pure, which is the point of them existing here rather than inside a page:
 * the arithmetic that says "2 places left", the JSON the RPC is handed, and the gathering of
 * its row-per-entry answer into one request per person are the things that can be wrong in a
 * way nobody sees until a participant is standing at the desk, and none needs a browser or a
 * database to be checked.
 *
 * What these tests deliberately do not assert is that any of it is *enforced*. It is not:
 * the RPC re-checks the cap, the window and the event's own state inside the transaction
 * that writes the request, and a browser that got one of these wrong produces a refusal
 * rather than an illegal row. These are presentation rules, so they are tested as
 * presentation.
 */

const TOURNAMENT_ID = "t1";

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: "cat1",
    tournament_id: TOURNAMENT_ID,
    code: "MD",
    name: "Men's Doubles",
    sort_order: 1,
    active: true,
    entry_type: "pair",
    gender: "men",
    max_entries: null,
    created_at: "2026-09-29T00:00:00Z",
    ...overrides,
  };
}

function team(categoryId: string, overrides: Partial<Team> = {}): Team {
  return {
    id: `team-${categoryId}-${overrides.id ?? "x"}`,
    tournament_id: TOURNAMENT_ID,
    category_id: categoryId,
    player_1_id: "p1",
    player_2_id: "p2",
    seed: null,
    withdrawn: false,
    created_at: "2026-09-29T00:00:00Z",
    ...overrides,
  };
}

describe("categoryUsage", () => {
  it("counts one event's entries against its own cap", () => {
    const usage = categoryUsage(
      [category({ id: "cat1", max_entries: 4 })],
      [team("cat1", { id: "a" }), team("cat1", { id: "b" }), team("cat1", { id: "c" })],
    );

    expect(usage.get("cat1")).toEqual({ taken: 3, cap: 4, remaining: 1, full: false });
  });

  it("does not count a withdrawn entry", () => {
    // The database's own cap trigger counts `withdrawn = false` rows only. Counting the
    // others would hide an event from the picker while the RPC would still accept an entry
    // for it, which is the one direction of this disagreement that costs somebody a place.
    const usage = categoryUsage(
      [category({ id: "cat1", max_entries: 2 })],
      [
        team("cat1", { id: "a" }),
        team("cat1", { id: "b", withdrawn: true }),
      ],
    );

    expect(usage.get("cat1")).toEqual({ taken: 1, cap: 2, remaining: 1, full: false });
  });

  it("never counts another event's entries", () => {
    const usage = categoryUsage(
      [category({ id: "cat1", max_entries: 8 }), category({ id: "cat2", max_entries: 1 })],
      [team("cat1", { id: "a" }), team("cat2", { id: "b" }), team("cat2", { id: "c" })],
    );

    expect(usage.get("cat1")?.taken).toBe(1);
    expect(usage.get("cat2")).toEqual({ taken: 2, cap: 1, remaining: 0, full: true });
  });

  it("reports an uncapped event as uncapped rather than as full", () => {
    const usage = categoryUsage([category({ max_entries: null })], [team("cat1", { id: "a" })]);

    expect(usage.get("cat1")).toEqual({ taken: 1, cap: null, remaining: null, full: false });
  });

  it("counts an event past its cap as full rather than as negative room", () => {
    // Reachable: lowering a cap below what has already been approved does not delete the
    // approved entries. `remaining` is clamped, so the picker can never print "-1 left".
    const usage = categoryUsage(
      [category({ max_entries: 2 })],
      [team("cat1", { id: "a" }), team("cat1", { id: "b" }), team("cat1", { id: "c" })],
    );

    expect(usage.get("cat1")).toEqual({ taken: 3, cap: 2, remaining: 0, full: true });
  });

  it("reports every event, including the ones with no entries", () => {
    const usage = categoryUsage(
      [category({ id: "cat1" }), category({ id: "cat2" })],
      [team("cat1", { id: "a" })],
    );

    expect([...usage.keys()]).toEqual(["cat1", "cat2"]);
    expect(usage.get("cat2")?.taken).toBe(0);
  });
});

describe("choosableCategories", () => {
  it("offers the events that are switched on and not full", () => {
    const categories = [
      category({ id: "open", max_entries: 4 }),
      category({ id: "full", max_entries: 1 }),
      category({ id: "off", active: false }),
    ];
    const usage = categoryUsage(categories, [
      team("open", { id: "a" }),
      team("full", { id: "b" }),
    ]);

    expect(choosableCategories(categories, usage).map((c) => c.id)).toEqual(["open"]);
  });

  it("keeps the host's own order", () => {
    // The stored order is the order the host arranged the events in and the order the
    // operator's page lists them in. A picker that sorted its own list would be a second
    // answer to "what order are these in".
    const categories = [
      category({ id: "second", sort_order: 2 }),
      category({ id: "first", sort_order: 1 }),
    ];
    expect(choosableCategories(categories, categoryUsage(categories, [])).map((c) => c.id)).toEqual(
      ["second", "first"],
    );
  });

  it("offers an uncapped event however many entries it holds", () => {
    const categories = [category({ id: "cat1", max_entries: null })];
    const usage = categoryUsage(categories, [team("cat1", { id: "a" }), team("cat1", { id: "b" })]);

    expect(choosableCategories(categories, usage)).toHaveLength(1);
  });
});

describe("registrationEntriesPayload", () => {
  it("sends the event and omits a partner that was never filled in", () => {
    // Omitted rather than sent blank. The RPC treats an absent key and a blank one the same
    // way, so this is the shape that says what the person actually entered - and it is the
    // one a test can assert without counting whitespace.
    expect(registrationEntriesPayload([{ categoryId: "cat1" }])).toEqual([{ category_id: "cat1" }]);
  });

  it("trims a partner's name and email", () => {
    const entries: RegistrationEntryInput[] = [
      { categoryId: "cat1", partnerName: "  Mei Ling  ", partnerEmail: " mei@example.test " },
    ];

    expect(registrationEntriesPayload(entries)).toEqual([
      { category_id: "cat1", partner_name: "Mei Ling", partner_email: "mei@example.test" },
    ]);
  });

  it("treats a whitespace-only partner as one that was not given", () => {
    // "   " in a required field is a field the person did not fill in. Sending it would put
    // the RPC's refusal one round trip away from a form that already knew.
    const entries: RegistrationEntryInput[] = [
      { categoryId: "cat1", partnerName: " ", partnerEmail: "\t" },
    ];

    expect(registrationEntriesPayload(entries)).toEqual([{ category_id: "cat1" }]);
  });

  it("keeps one entry per event, in the order they were given", () => {
    const entries: RegistrationEntryInput[] = [
      { categoryId: "cat2", partnerName: "Wei", partnerEmail: "wei@example.test" },
      { categoryId: "cat1" },
    ];

    expect(registrationEntriesPayload(entries)).toEqual([
      { category_id: "cat2", partner_name: "Wei", partner_email: "wei@example.test" },
      { category_id: "cat1" },
    ]);
  });

  it("is an empty array for an empty selection, which the RPC refuses by name", () => {
    // The RPC's own first check. It is asserted here because the payload must not invent an
    // entry to satisfy it - the refusal is the correct answer to "I chose nothing".
    expect(registrationEntriesPayload([])).toEqual([]);
  });
});

function reviewRow(overrides: Partial<ReviewRegistrationRow> = {}): ReviewRegistrationRow {
  return {
    registration_id: "r1",
    profile_id: "prof1",
    email: "req@example.test",
    status: "pending",
    decided_at: null,
    decision_note: null,
    created_at: "2026-09-29T00:00:00Z",
    entry_id: null,
    category_id: null,
    category_code: null,
    category_name: null,
    entry_type: null,
    partner_name: null,
    partner_email: null,
    player_id: null,
    partner_player_id: null,
    ...overrides,
  };
}

describe("entryTypeLabel", () => {
  it("says the two words from the stored entry type", () => {
    expect(entryTypeLabel("pair")).toBe("Doubles");
    expect(entryTypeLabel("single")).toBe("Singles");
  });

  it("reads a missing type as singles rather than as blank", () => {
    // The safe direction, and the honest one: an event with no stored type is a Phase 1 row,
    // and the format it was created under was singles-or-pair with singles the default.
    expect(entryTypeLabel(null)).toBe("Singles");
    expect(entryTypeLabel(undefined)).toBe("Singles");
  });
});

describe("capacityText", () => {
  it("says how many entries an uncapped event holds rather than 'unlimited'", () => {
    expect(capacityText({ taken: 3, cap: null, remaining: null, full: false })).toBe(
      "3 entries so far",
    );
  });

  it("says both numbers when a cap exists and there is room", () => {
    expect(capacityText({ taken: 2, cap: 5, remaining: 3, full: false })).toBe(
      "2 of 5 taken, 3 places left",
    );
  });

  it("says a full event is full rather than showing zero places", () => {
    expect(capacityText({ taken: 5, cap: 5, remaining: 0, full: true })).toBe(
      "Full, 5 of 5 taken",
    );
  });

  it("uses the singular for one place", () => {
    expect(capacityText({ taken: 4, cap: 5, remaining: 1, full: false })).toBe(
      "4 of 5 taken, 1 place left",
    );
  });

  it("is empty for an event it has no usage for", () => {
    // A caller that has not loaded the events must render nothing rather than a wrong number.
    expect(capacityText(undefined)).toBe("");
  });
});

describe("toRegistrationQueue", () => {
  it("gathers a request's entries from the row-per-entry answer", () => {
    const queue = toRegistrationQueue([
      reviewRow({
        entry_id: "e1",
        category_id: "cat1",
        category_code: "MD",
        category_name: "Men's Doubles",
        entry_type: "pair",
        partner_name: "Wei",
        partner_email: "wei@example.test",
      }),
      reviewRow({
        entry_id: "e2",
        category_id: "cat2",
        category_code: "XD",
        category_name: "Mixed Doubles",
        entry_type: "pair",
        partner_name: "Sam",
        partner_email: "sam@example.test",
      }),
    ]);

    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0]?.id).toBe("r1");
    expect(queue.pending[0]?.entries.map((entry) => entry.entryId)).toEqual(["e1", "e2"]);
    expect(queue.pending[0]?.entries[0]?.categoryName).toBe("Men's Doubles");
    expect(queue.pending[0]?.email).toBe("req@example.test");
  });

  it("splits what is waiting from what already has a decision", () => {
    const queue = toRegistrationQueue([
      reviewRow({ registration_id: "r1", status: "pending", entry_id: "e1" }),
      reviewRow({
        registration_id: "r2",
        status: "approved",
        decided_at: "2026-09-29T02:00:00Z",
        decision_note: "See you Saturday.",
        entry_id: "e2",
      }),
      reviewRow({
        registration_id: "r3",
        status: "rejected",
        decided_at: "2026-09-29T03:00:00Z",
        entry_id: "e3",
      }),
    ]);

    expect(queue.pending.map((request) => request.id)).toEqual(["r1"]);
    expect(queue.decided.map((request) => request.id)).toEqual(["r2", "r3"]);
    expect(queue.decided[0]?.decisionNote).toBe("See you Saturday.");
  });

  it("keeps the RPC's order rather than sorting", () => {
    // The RPC orders newest request first. Working a queue means working it in the order it
    // arrived, so the fold must not reorder what it was handed.
    const queue = toRegistrationQueue([
      reviewRow({ registration_id: "newest", created_at: "2026-09-29T09:00:00Z", entry_id: "e1" }),
      reviewRow({ registration_id: "oldest", created_at: "2026-09-29T01:00:00Z", entry_id: "e2" }),
    ]);

    expect(queue.pending.map((request) => request.id)).toEqual(["newest", "oldest"]);
  });

  it("keeps a request that named no events instead of dropping it", () => {
    // A row whose entry columns are all null is still a real request. Dropping it would hide
    // a participant from the queue and let the request sit unnoticed.
    const queue = toRegistrationQueue([reviewRow({ entry_id: null, category_id: null })]);

    expect(queue.pending).toHaveLength(1);
    expect(queue.pending[0]?.entries).toEqual([]);
  });

  it("reads an unrecognised status as pending rather than as a decision", () => {
    // The one wrong direction is showing a request as decided when the database decided
    // nothing, so an unknown word must land in the queue rather than out of it.
    const queue = toRegistrationQueue([reviewRow({ status: "escalated", entry_id: "e1" })]);

    expect(queue.pending).toHaveLength(1);
    expect(queue.decided).toHaveLength(0);
  });

  it("does not merge two requests that asked for the same event", () => {
    const queue = toRegistrationQueue([
      reviewRow({ registration_id: "r1", entry_id: "e1", category_id: "cat1" }),
      reviewRow({ registration_id: "r2", entry_id: "e2", category_id: "cat1" }),
    ]);

    expect(queue.pending.map((request) => request.id)).toEqual(["r1", "r2"]);
    expect(queue.pending[0]?.entries).toHaveLength(1);
    expect(queue.pending[1]?.entries).toHaveLength(1);
  });

  it("is an empty queue for an empty answer", () => {
    expect(toRegistrationQueue([])).toEqual({ pending: [], decided: [] });
  });
});
