import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  anonClient,
  createIdentity,
  createOwnedTournament,
  createUserIdentity,
  destroyIdentity,
  destroyTournaments,
  expectRefused,
  grantEditor,
  saveCategory,
  type TestIdentity,
} from "./env";

/**
 * The authorization surface, against the real database.
 *
 * WHY THIS CANNOT BE MOCKED
 *
 * Authorization lives in two places a mock cannot reach: RLS policies and the
 * `can_edit_tournament` guard at the top of every RPC. `e2e/fixtures/app-mock.ts` answers
 * requests from a fixture, so every caller looks authorized to it. A broken policy or a
 * dropped guard is therefore invisible to the mocked suite and to the type checker, and
 * only shows up as either an operator locked out mid-tournament or, worse, a viewer who
 * can do more than the UI offers.
 *
 * The two axes are asserted separately, because conflation is the failure mode this
 * redesign exists to remove:
 *
 *   - platform role: `admin` overrides, `user` does not
 *   - tournament access: owner, editor, or neither
 *
 * A platform admin is an override, never an implicit owner or editor, so the admin cases
 * below assert the *predicate* rather than membership: no `tournament_editors` row is ever
 * created for the admin, and the owner list still contains only the owner.
 *
 * Both directions are asserted throughout. A matrix that only proves the permitted call
 * succeeds would pass on a database where every caller can do everything.
 */

const NOT_AUTHORIZED = "Not authorized";

let admin: TestIdentity;
let owner: TestIdentity;
let editor: TestIdentity;
let viewer: TestIdentity;

const identities: TestIdentity[] = [];
const tournamentIds: string[] = [];

let tournamentId = "";
/** A second, unrelated tournament, owned by `viewer`, used to probe cross-tournament access. */
let otherTournamentId = "";

beforeAll(async () => {
  admin = await createIdentity("admin", "authz");
  owner = await createIdentity("user", "authz");
  editor = await createIdentity("user", "authz");
  viewer = await createUserIdentity("authz");
  identities.push(admin, owner, editor, viewer);

  tournamentId = await createOwnedTournament(owner);
  otherTournamentId = await createOwnedTournament(viewer);
  tournamentIds.push(tournamentId, otherTournamentId);

  await grantEditor(tournamentId, editor, owner);
}, 180_000);

afterAll(async () => {
  await destroyTournaments(...tournamentIds);
  for (const identity of identities) await destroyIdentity(identity);
}, 180_000);

/** Reads the platform role the application will see. */
async function currentRole(identity: TestIdentity): Promise<string | null> {
  const { data, error } = await identity.client.rpc("current_system_role");
  if (error) throw new Error(`current_system_role failed: ${error.message}`);
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

/** Saves the tournament's basics, which needs both authorization and `upcoming`. */
function saveBasics(identity: TestIdentity, id: string) {
  return guardOutcome(identity, "save_tournament_config", {
    p_tournament_id: id,
    p_payload: { name: "authorization probe" },
  });
}

describe("an unauthenticated visitor", () => {
  const anon = anonClient();

  it("cannot resolve a platform role", async () => {
    // `current_system_role()` is granted to `authenticated` only - the session hook never
    // calls it without a session - so an anonymous caller is refused before it can learn
    // anything.
    const { data, error } = await anon.rpc("current_system_role");
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it("reads public tournament data", async () => {
    // Public read is first class, not accidental: the anonymous landing case and the
    // read-only desk depend on it.
    const { data, error } = await anon
      .from("tournaments")
      .select("id, status")
      .eq("id", tournamentId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("reads the anonymous roster projection and not the contact columns", async () => {
    // `public_players` is a definer projection over id/name/gender. The base table is
    // revoked from anon, so the naive roster query cannot leak emails and phone numbers
    // that ship in the client bundle's reach.
    const { data: projected, error: projectedError } = await anon
      .from("public_players")
      .select("id, name")
      .limit(1);
    expect(projectedError).toBeNull();
    expect(Array.isArray(projected)).toBe(true);

    const error = await expectRefused(() => anon.from("players").select("id").limit(1));
    expect(error.message.toLowerCase()).toContain("permission denied");
  });

  it("reads no profiles", async () => {
    // Unlike the retired staff table, `profiles` has no anon policy at all, so every row
    // stays out even though the request itself succeeds.
    const { data, error } = await anon.from("profiles").select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("cannot submit a registration request", async () => {
    const error = await expectRefused(() =>
      anon.rpc("submit_tournament_registration", { p_tournament_id: tournamentId } as never),
    );
    expect(error.message).toMatch(/sign in|permission denied/i);
  });

  it("cannot write its way into the editor list", async () => {
    const error = await expectRefused(() =>
      anon
        .from("tournament_editors")
        // The real column, so the refusal is the assertion. Naming a column that no longer
        // exists would still raise, and the test would pass without testing anything.
        .insert({ tournament_id: tournamentId, profile_id: owner.profileId } as never),
    );
    expect(error.message.toLowerCase()).toMatch(/permission denied|row-level security|not permitted/);
  });
});

describe("an authenticated user with no tournament access", () => {
  it("has the ordinary platform role", async () => {
    expect(await currentRole(viewer)).toBe("user");
  });

  it("sees an all-false access answer for someone else's tournament", async () => {
    const { data, error } = await viewer.client.rpc("tournament_access", {
      p_tournament_id: tournamentId,
    } as never);
    expect(error).toBeNull();
    expect(data).toMatchObject({
      is_platform_admin: false,
      is_owner: false,
      is_editor: false,
      can_edit: false,
      can_manage_access: false,
    });
  });

  it("cannot edit a tournament it has no access to", async () => {
    const outcome = await saveBasics(viewer, tournamentId);
    expect(outcome.refused).toBe(true);
  });

  it("cannot add itself as an editor", async () => {
    const error = await expectRefused(() =>
      viewer.client.rpc("add_tournament_editor", {
        p_tournament_id: tournamentId,
        p_email: viewer.email,
      } as never),
    );
    expect(error.message).toContain(NOT_AUTHORIZED);
  });

  it("can edit the tournament it owns while staying a viewer of another", async () => {
    // Access is a property of the pair, not of the person: the same signed-in session is
    // an owner on one tournament and nothing on the next.
    const own = await saveBasics(viewer, otherTournamentId);
    expect(own.refused).toBe(false);

    const other = await saveBasics(viewer, tournamentId);
    expect(other.refused).toBe(true);
  });
});

describe("the owner", () => {
  it("can edit its own tournament and manage its access", async () => {
    const { data, error } = await owner.client.rpc("tournament_access", {
      p_tournament_id: tournamentId,
    } as never);
    expect(error).toBeNull();
    expect(data).toMatchObject({ is_owner: true, can_edit: true, can_manage_access: true });
  });

  it("becomes its own working tournament on creation", async () => {
    const { data, error } = await owner.client.rpc("current_tournament_id");
    expect(error).toBeNull();
    expect(data).toBe(tournamentId);
  });

  it("cannot reassign ownership with a direct column write", async () => {
    // `owner_profile_id` is withheld from the column grant, so this fails at the privilege
    // layer - before any policy is consulted, and without a trigger to disable.
    const error = await expectRefused(() =>
      owner.client
        .from("tournaments")
        .update({ owner_profile_id: editor.profileId } as never)
        .eq("id", tournamentId),
    );
    expect(error.message.toLowerCase()).toMatch(/permission denied|not permitted|column/);
  });

  it("can still write the columns the setup surface owns", async () => {
    const { error } = await owner.client
      .from("tournaments")
      .update({ name: "renamed by the owner", group_slot_minutes: 22 } as never)
      .eq("id", tournamentId);
    expect(error).toBeNull();
  });
});

describe("an editor", () => {
  it("can edit but cannot manage access", async () => {
    const outcome = await saveBasics(editor, tournamentId);
    expect(outcome.refused).toBe(false);

    const access = await editor.client.rpc("tournament_access", {
      p_tournament_id: tournamentId,
    } as never);
    expect(access.error).toBeNull();
    expect(access.data).toMatchObject({ is_editor: true, can_edit: true, can_manage_access: false });
  });

  it("cannot add or remove editors", async () => {
    const add = await expectRefused(() =>
      editor.client.rpc("add_tournament_editor", {
        p_tournament_id: tournamentId,
        p_email: viewer.email,
      } as never),
    );
    expect(add.message).toContain(NOT_AUTHORIZED);
  });

  it("cannot delete the tournament", async () => {
    const outcome = await guardOutcome(editor, "delete_tournament", {
      p_tournament_id: tournamentId,
    });
    expect(outcome.refused).toBe(true);
  });

  it("cannot insert its own editor row", async () => {
    // Membership is RPC-only: the write grant is closed, so the refusal happens at the
    // privilege layer rather than depending on the policy - and an editor therefore cannot
    // widen the set it belongs to, or re-add itself after the owner removes it.
    const error = await expectRefused(() =>
      editor.client
        .from("tournament_editors")
        .insert({ tournament_id: tournamentId, profile_id: editor.profileId } as never),
    );
    expect(error.message.toLowerCase()).toMatch(/permission denied|row-level security/);
  });
});

describe("a platform admin", () => {
  it("overrides authorization without being made an editor", async () => {
    const { data, error } = await admin.client.rpc("tournament_access", {
      p_tournament_id: tournamentId,
    } as never);
    expect(error).toBeNull();
    expect(data).toMatchObject({
      is_platform_admin: true,
      // Override, not membership: the admin is neither owner nor editor.
      is_owner: false,
      is_editor: false,
      can_edit: true,
      can_manage_access: true,
    });

    const { data: editors, error: editorError } = await admin.client.rpc(
      "list_tournament_editors",
      { p_tournament_id: tournamentId } as never,
    );
    expect(editorError).toBeNull();
    const rows = editors as unknown as { email: string; is_owner: boolean }[];
    // The admin does not appear, because it was never added.
    expect(rows.some((row) => row.email === admin.email)).toBe(false);
  });

  it("can edit someone else's tournament", async () => {
    const outcome = await saveBasics(admin, tournamentId);
    expect(outcome.refused).toBe(false);
  });
});

describe("nobody can promote themselves", () => {
  it("updates nothing in its own profile", async () => {
    // The profiles write policy is platform-admin only. An UPDATE whose `USING` clause
    // matches no row does not raise - it affects zero rows - so the assertion has to be
    // the absence of an affected row and the unchanged role, not `expectRefused`.
    const { data, error } = await viewer.client
      .from("profiles")
      .update({ system_role: "admin" } as never)
      .eq("id", viewer.profileId)
      .select("system_role");
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(await currentRole(viewer)).toBe("user");
  });

  it("updates nothing in another user's profile", async () => {
    const { data, error } = await viewer.client
      .from("profiles")
      .update({ system_role: "admin" } as never)
      .eq("id", owner.profileId)
      .select("system_role");
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(await currentRole(owner)).toBe("user");
  });

  it("reads only its own profile row", async () => {
    const { data, error } = await viewer.client.from("profiles").select("id, email");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.id).toBe(viewer.profileId);
  });
});

describe("the working tournament is per user", () => {
  it("switching it changes nobody else's pointer", async () => {
    // The point of `current_tournament_id` replacing `is_active` as the working context:
    // one person's choice is not a global setting.
    const before = (await editor.client.rpc("current_tournament_id")).data;

    const { error: switchError } = await owner.client.rpc("set_current_tournament", {
      p_tournament_id: otherTournamentId,
    } as never);
    expect(switchError).toBeNull();

    const { data: ownerNow } = await owner.client.rpc("current_tournament_id");
    expect(ownerNow).toBe(otherTournamentId);

    // The editor never chose anything, and the owner switching did not choose for it.
    const after = (await editor.client.rpc("current_tournament_id")).data;
    expect(after).toBe(before);
  });

  it("selecting any publicly readable tournament is not a privilege", async () => {
    const { error } = await viewer.client.rpc("set_current_tournament", {
      p_tournament_id: tournamentId,
    } as never);
    expect(error).toBeNull();
  });
});

describe("the retired staff vocabulary is gone", () => {
  it("has no current_staff_role RPC", async () => {
    const { error } = await owner.client.rpc("current_staff_role" as never);
    expect(error).not.toBeNull();
  });

  it("has no has_staff_role RPC", async () => {
    const { error } = await owner.client.rpc("has_staff_role" as never, { needed: [] } as never);
    expect(error).not.toBeNull();
  });

  it("has no staff_roles relation", async () => {
    const { error } = await owner.client.from("staff_roles" as never).select("id").limit(1);
    expect(error).not.toBeNull();
  });
});

describe("category writers", () => {
  it("refuse a viewer and admit an editor", async () => {
    const refused = await guardOutcome(viewer, "save_tournament_categories", {
      p_tournament_id: tournamentId,
      p_categories: [],
    });
    expect(refused.refused).toBe(true);

    // The editor's call writes the same single event back, so the fixture is unchanged.
    await saveCategory(editor, tournamentId);
  });
});

/**
 * The roster round-trip, by profile id.
 *
 * The sharpest instance of the ambiguity the identity canon removed. `add_tournament_editor`
 * resolves an email to a profile and returns its id; `remove_tournament_editor` takes that id
 * back; `list_tournament_editors` reports it. That chain used to carry a `profiles.user_id`
 * end to end - an auth uid travelling under the name of a person - and passing the wrong one
 * fails *silently*: the DELETE matches no row, reports success, and the colleague keeps a
 * right the operator believes they removed. So both halves are asserted, and the access is
 * read back afterwards rather than inferred from the roster.
 *
 * A tournament and identities of its own, so removing a member here cannot disturb the
 * shared fixture the blocks above rely on.
 */
describe("the editor roster round-trips a profile id", () => {
  let rosterOwner: TestIdentity;
  let colleague: TestIdentity;
  let rosterTournamentId = "";

  beforeAll(async () => {
    rosterOwner = await createIdentity("user", "roster");
    colleague = await createIdentity("user", "roster");
    rosterTournamentId = await createOwnedTournament(rosterOwner);
  }, 180_000);

  afterAll(async () => {
    await destroyTournaments(rosterTournamentId);
    await destroyIdentity(colleague);
    await destroyIdentity(rosterOwner);
  }, 180_000);

  it("adds, lists and removes the same profile id", async () => {
    const added = await rosterOwner.client.rpc("add_tournament_editor", {
      p_tournament_id: rosterTournamentId,
      p_email: colleague.email,
    } as never);
    expect(added.error).toBeNull();
    // The id it returns is a profile id, which is the same value the roster reports.
    expect(added.data).toBe(colleague.profileId);

    const { data: roster, error: rosterError } = await rosterOwner.client.rpc(
      "list_tournament_editors",
      { p_tournament_id: rosterTournamentId } as never,
    );
    expect(rosterError).toBeNull();
    const rows = roster as unknown as { profile_id: string; is_owner: boolean }[];
    // The owner's row carries a profile id too: ownership is a fact about a person, and the
    // column is named for one.
    expect(rows).toContainEqual(
      expect.objectContaining({ profile_id: rosterOwner.profileId, is_owner: true }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ profile_id: colleague.profileId, is_owner: false }),
    );

    // An editor cannot dismiss itself - access management is the owner's.
    await expectRefused(() =>
      colleague.client.rpc("remove_tournament_editor", {
        p_tournament_id: rosterTournamentId,
        p_profile_id: colleague.profileId,
      } as never),
    );

    const removed = await rosterOwner.client.rpc("remove_tournament_editor", {
      p_tournament_id: rosterTournamentId,
      p_profile_id: colleague.profileId,
    } as never);
    expect(removed.error).toBeNull();

    const { data: after } = await rosterOwner.client.rpc("list_tournament_editors", {
      p_tournament_id: rosterTournamentId,
    } as never);
    expect(
      (after as unknown as { profile_id: string }[]).some(
        (row) => row.profile_id === colleague.profileId,
      ),
    ).toBe(false);

    // The assertion a wrong id would pass: the row has to actually be gone, and the
    // colleague's own read of their access has to agree.
    const { data: access, error: accessError } = await colleague.client.rpc("tournament_access", {
      p_tournament_id: rosterTournamentId,
    } as never);
    expect(accessError).toBeNull();
    expect(access).toMatchObject({ is_editor: false, can_edit: false });
  }, 120_000);
});
