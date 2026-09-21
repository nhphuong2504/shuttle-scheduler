import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  anonClient,
  createStaffIdentity,
  createUnprivilegedIdentity,
  destroyStaffIdentity,
  expectRefused,
  type TestIdentity,
} from "./env";

/**
 * The authorization surface, against the real database.
 *
 * WHY THIS CANNOT BE MOCKED
 *
 * Authorization here lives in two places that a mock cannot reach: RLS policies and the
 * `has_staff_role` guard at the top of each RPC. `e2e/fixtures/app-mock.ts` answers requests
 * from a fixture, so every caller looks authorized to it. The consequence is that a broken
 * policy or a dropped guard is invisible to the mocked suite and to the type checker, and
 * only shows up as either an operator locked out mid-tournament or, worse, a role that can
 * do more than it should.
 *
 * The role guards asserted below are read from the migrations:
 *
 *   save_tournament_draft / save_tournament_days / activate_tournament   admin
 *   apply_pool_generation / apply_draw_generation                        admin, scheduler
 *   report_pool_result / start_match_safe                                admin, scorer
 *
 * `registrar` is deliberately absent from all of them: the registration desk should not be
 * able to write tournament structure or results, and that absence is the thing worth
 * pinning down, because it is invisible in the UI and easy to widen by accident.
 *
 * Both directions are asserted. A matrix that only proves admins succeed would pass on a
 * database where every role can do everything.
 */

const NOT_AUTHORIZED = "Not authorized";

let admin: TestIdentity;
let scheduler: TestIdentity;
let scorer: TestIdentity;
let registrar: TestIdentity;
let unprivileged: TestIdentity;

const identities: TestIdentity[] = [];

beforeAll(async () => {
  admin = await createStaffIdentity("admin", "authz");
  scheduler = await createStaffIdentity("scheduler", "authz");
  scorer = await createStaffIdentity("scorer", "authz");
  registrar = await createStaffIdentity("registrar", "authz");
  unprivileged = await createUnprivilegedIdentity("authz");
  identities.push(admin, scheduler, scorer, registrar, unprivileged);
}, 120_000);

afterAll(async () => {
  for (const identity of identities) await destroyStaffIdentity(identity);
}, 120_000);

/** Reads the role the application will see, which is what the desked UI branches on. */
async function currentRole(identity: TestIdentity): Promise<string | null> {
  const { data, error } = await identity.client.rpc("current_staff_role");
  if (error) throw new Error(`current_staff_role failed: ${error.message}`);
  return (data as string | null) ?? null;
}

/** Calls an RPC and reports whether the guard let it through. */
async function guardOutcome(
  identity: TestIdentity,
  rpc: string,
  args: Record<string, unknown>,
): Promise<{ refused: boolean; message: string }> {
  const { error } = await identity.client.rpc(rpc as never, args as never);
  if (!error) return { refused: false, message: "" };
  return { refused: error.message.includes(NOT_AUTHORIZED), message: error.message };
}

describe("an unauthenticated visitor", () => {
  const anon = anonClient();

  it("resolves no staff role", async () => {
    const { data, error } = await anon.rpc("current_staff_role");
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("holds no role", async () => {
    const { data, error } = await anon.rpc("has_staff_role", {
      needed: ["admin", "scheduler", "scorer", "registrar"] as never,
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  it("cannot read the player roster", async () => {
    // `REVOKE SELECT ON public.players FROM anon`. Without it, the roster - names, emails
    // and phone numbers - is readable by anyone who has the publishable key, which ships
    // in the client bundle.
    const error = await expectRefused(() => anon.from("players").select("id").limit(1));
    expect(error.message.toLowerCase()).toContain("permission denied");
  });

  it("cannot read staff roles", async () => {
    const error = await expectRefused(() => anon.from("staff_roles").select("id").limit(1));
    expect(error.message.toLowerCase()).toContain("permission denied");
  });
});

describe("a signed-in user with no staff role", () => {
  it("is authenticated but holds no role", async () => {
    // The distinction this suite exists to protect: a valid session is not an authorization.
    expect(await currentRole(unprivileged)).toBeNull();
  });

  it("sees no staff rows", async () => {
    const { data, error } = await unprivileged.client.from("staff_roles").select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("cannot generate pools", async () => {
    const outcome = await guardOutcome(unprivileged, "apply_pool_generation", {
      p_category_id: randomUUID(),
      p_force: false,
      p_payload: [],
    });
    expect(outcome.refused).toBe(true);
  });
});

describe("role resolution", () => {
  it.each([
    ["admin", () => admin],
    ["scheduler", () => scheduler],
    ["scorer", () => scorer],
    ["registrar", () => registrar],
  ])("resolves %s from its own signed-in session", async (expected, pick) => {
    expect(await currentRole(pick())).toBe(expected);
  });
});

describe("the registrar cannot write structure or results", () => {
  it("cannot save tournament basics", async () => {
    const outcome = await guardOutcome(registrar, "save_tournament_draft", {
      p_tournament_id: randomUUID(),
      p_payload: { name: "should not be written" },
    });
    expect(outcome.refused).toBe(true);
  });

  it("cannot generate pools", async () => {
    const outcome = await guardOutcome(registrar, "apply_pool_generation", {
      p_category_id: randomUUID(),
      p_force: false,
      p_payload: [],
    });
    expect(outcome.refused).toBe(true);
  });

  it("cannot report a result", async () => {
    const outcome = await guardOutcome(registrar, "report_pool_result", {
      p_match_id: randomUUID(),
      p_score_a: 21,
      p_score_b: 10,
    });
    expect(outcome.refused).toBe(true);
  });
});

describe("the scheduler can plan but not score", () => {
  it("is allowed through the pool generation guard", async () => {
    // The role guard is the first statement in the function, so a permitted role falls
    // through to the body and fails on the missing category instead. Asserting on the
    // *absence* of the refusal is what distinguishes "allowed" from "allowed and then
    // failed for an unrelated reason".
    const outcome = await guardOutcome(scheduler, "apply_pool_generation", {
      p_category_id: randomUUID(),
      p_force: false,
      p_payload: [],
    });
    expect(outcome.message).not.toContain(NOT_AUTHORIZED);
  });

  it("cannot report a result", async () => {
    const outcome = await guardOutcome(scheduler, "report_pool_result", {
      p_match_id: randomUUID(),
      p_score_a: 21,
      p_score_b: 10,
    });
    expect(outcome.refused).toBe(true);
  });
});

describe("the scorer can score but not plan", () => {
  it("is allowed through the result guard", async () => {
    const outcome = await guardOutcome(scorer, "report_pool_result", {
      p_match_id: randomUUID(),
      p_score_a: 21,
      p_score_b: 10,
    });
    expect(outcome.message).not.toContain(NOT_AUTHORIZED);
  });

  it("cannot generate pools", async () => {
    const outcome = await guardOutcome(scorer, "apply_pool_generation", {
      p_category_id: randomUUID(),
      p_force: false,
      p_payload: [],
    });
    expect(outcome.refused).toBe(true);
  });
});

describe("the admin", () => {
  it("is allowed through the draft guard", async () => {
    const outcome = await guardOutcome(admin, "save_tournament_draft", {
      p_tournament_id: randomUUID(),
      p_payload: { name: "guard probe" },
    });
    expect(outcome.message).not.toContain(NOT_AUTHORIZED);
  });

  it("is allowed through the result guard", async () => {
    const outcome = await guardOutcome(admin, "report_pool_result", {
      p_match_id: randomUUID(),
      p_score_a: 21,
      p_score_b: 10,
    });
    expect(outcome.message).not.toContain(NOT_AUTHORIZED);
  });
});
