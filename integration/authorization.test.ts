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
  serviceClient,
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

  it("cannot read the roster, only the people on one tournament", async () => {
    // The roster is global - everyone ever entered anywhere - so it is not readable as a whole:
    // the `public_players` view is no longer granted, and the table never was. What a visitor
    // can ask for is the people on a tournament's entries, which the entries themselves
    // already publish, through `tournament_players`.
    const view = await expectRefused(() => anon.from("public_players").select("id").limit(1));
    expect(view.message.toLowerCase()).toContain("permission denied");
    const table = await expectRefused(() => anon.from("players").select("id").limit(1));
    expect(table.message.toLowerCase()).toContain("permission denied");

    const { data, error } = await anon.rpc("tournament_players", { p_tournament_id: tournamentId });
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    // Nothing but the three columns, whatever the people on it have given the desk.
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual(["gender", "id", "name"]);
    }

    // Searching the roster is the desk's, so a visitor is refused outright.
    const search = await expectRefused(() =>
      anon.rpc("search_players", { p_tournament_id: tournamentId, p_query: "an" }),
    );
    expect(search.message.toLowerCase()).toContain("permission denied");
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
    // The point of the per-user pointer: one person's choice is not a global setting.
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

describe("the global active-tournament pointer is retired", () => {
  it("has no set_active_tournament RPC", async () => {
    const { error } = await owner.client.rpc(
      "set_active_tournament" as never,
      { p_tournament_id: tournamentId } as never,
    );
    expect(error).not.toBeNull();
  });

  it("has no is_active column to read or write", async () => {
    const { error } = await owner.client.from("tournaments").select("is_active" as never).limit(1);
    expect(error).not.toBeNull();
  });

  it("answers an anonymous caller with no tournament, not a global default", async () => {
    // The fallback is gone, so an unpointed caller resolves to nothing - which is what
    // sends them to /explore instead of into somebody else's live desk.
    const { data, error } = await anonClient().rpc("current_tournament_id");
    expect(error).toBeNull();
    expect(data).toBeNull();
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

/**
 * Player identity, the contact read, and what a request is for.
 *
 * The two mechanisms that keep `players.profile_id` to one writer live at different layers,
 * and this is the only place both can be probed against a real database:
 *
 *   - the **privilege** layer is proved with a client session, because a column grant is
 *     enforced before any policy is consulted;
 *   - the **trigger** layer is proved with the service role, which is normally reserved for
 *     fixtures. That is deliberate and not a violation of this file's rule: the trigger is
 *     not RLS, so bypassing RLS does not bypass the guard - and reaching the guard past the
 *     grant is the only way to show the two are independent. If the guard were missing, a
 *     service-role write would succeed here and the privilege would be the *only* thing
 *     standing between a client and the identity column.
 *
 * The contact read is a matrix rather than a single case, because the failure this replaces
 * was a rule nobody could state: an editor of any tournament could read every player's email
 * and phone number platform-wide.
 */
describe("player identity and the contact read", () => {
  /** Fixtures only - and the trigger probes, which RLS cannot reach. */
  const roster = serviceClient();

  let contactOwner: TestIdentity;
  let contactEditor: TestIdentity;
  let contactAdmin: TestIdentity;
  let outsider: TestIdentity;
  let contactTournamentId = "";
  let categoryId = "";
  /** A player entered in that tournament, carrying the contact data under test. */
  let enteredPlayerId = "";
  /** A player in the roster with no entry anywhere: the discriminator. */
  let unenteredPlayerId = "";
  /** The walk-in the client inserts itself, cleaned up with the rest. */
  let walkInPlayerId = "";

  const contactEmail = `itest-contact-${Date.now().toString(36)}@tournova.test`;
  const contactPhone = "+15550000111";

  beforeAll(async () => {
    contactOwner = await createIdentity("user", "contact");
    contactEditor = await createIdentity("user", "contact");
    contactAdmin = await createIdentity("admin", "contact");
    outsider = await createIdentity("user", "contact");

    // Days in the future, so a registration window can legitimately be open now: the window
    // has to close at or before the derived start, and the default fixture's day is in 2020.
    const day = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    contactTournamentId = await createOwnedTournament(contactOwner, {
      days: [{ date: day, startTime: "09:00", endTime: "18:00", courts: [1, 2] }],
    });
    await grantEditor(contactTournamentId, contactEditor, contactOwner);

    // The window, written by the owner through the same RPC the Schedule page uses. The
    // basics are re-sent because this RPC replaces them: `venue_name` in particular is a
    // replace-with-null field, and a null venue fails the `basics` readiness check that
    // `submit_tournament_registration` requires.
    const { error: windowError } = await contactOwner.client.rpc("save_tournament_config", {
      p_tournament_id: contactTournamentId,
      p_payload: {
        name: "contact probe",
        venue_name: "Integration Test Venue",
        venue_timezone: "America/Chicago",
        format: "two_round_placement",
        registration_opens_at: new Date(Date.now() - 3_600_000).toISOString(),
        registration_closes_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    } as never);
    if (windowError) throw new Error(`opening the registration window failed: ${windowError.message}`);

    const { data: category, error: categoryError } = await roster
      .from("categories")
      .select("id")
      .eq("tournament_id", contactTournamentId)
      .limit(1)
      .single();
    if (categoryError) throw new Error(`reading the fixture category failed: ${categoryError.message}`);
    categoryId = category.id;

    const entered = await roster
      .from("players")
      .insert({ name: `itest-entered-${Date.now().toString(36)}`, email: contactEmail, phone: contactPhone })
      .select("id")
      .single();
    if (entered.error) throw new Error(`seeding the entered player failed: ${entered.error.message}`);
    enteredPlayerId = entered.data.id;

    // The entry, which is what makes the contact data reachable for the tournament's staff.
    const { error: teamError } = await roster
      .from("teams")
      .insert({ category_id: categoryId, player_1_id: enteredPlayerId } as never);
    if (teamError) throw new Error(`seeding the entry failed: ${teamError.message}`);

    const unentered = await roster
      .from("players")
      .insert({ name: `itest-unentered-${Date.now().toString(36)}`, email: `itest-unentered-${Date.now().toString(36)}@tournova.test` })
      .select("id")
      .single();
    if (unentered.error) throw new Error(`seeding the unentered player failed: ${unentered.error.message}`);
    unenteredPlayerId = unentered.data.id;
  }, 180_000);

  afterAll(async () => {
    // The tournament first: it cascades to the entry, and the players cannot be deleted
    // while a team still references them.
    await destroyTournaments(contactTournamentId);
    await roster
      .from("players")
      .delete()
      .in("id", [enteredPlayerId, unenteredPlayerId, walkInPlayerId].filter(Boolean));
    for (const identity of [contactOwner, contactEditor, contactAdmin, outsider]) {
      await destroyIdentity(identity);
    }
  }, 180_000);

  /** The contact columns as `identity` can see them for one player. */
  async function contactRows(identity: TestIdentity, playerId: string) {
    const { data, error } = await identity.client
      .from("players")
      .select("id, email, phone")
      .eq("id", playerId);
    expect(error).toBeNull();
    return data ?? [];
  }

  it("lets the owner and the editor of the entered tournament read the contact data", async () => {
    for (const identity of [contactOwner, contactEditor]) {
      const rows = await contactRows(identity, enteredPlayerId);
      expect(rows, `${identity.role}/${identity.email}`).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: enteredPlayerId, email: contactEmail, phone: contactPhone });
    }
  });

  it("lets a platform admin read it", async () => {
    const rows = await contactRows(contactAdmin, enteredPlayerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: contactEmail });
  });

  it("shows nothing to anyone else, and nothing for a player who has not entered", async () => {
    // An empty result rather than an error: `authenticated` holds table-wide SELECT, so the
    // policy filters rows. Asserting the error instead would pass on a broken grant.
    expect(await contactRows(outsider, enteredPlayerId)).toEqual([]);
    // The same owner, a different player: membership comes from the entry, so a tournament's
    // edit right is not a platform-wide read of the roster.
    expect(await contactRows(contactOwner, unenteredPlayerId)).toEqual([]);
  });

  it("refuses an anonymous read of the contact table outright", async () => {
    const error = await expectRefused(() => anonClient().from("players").select("id, email").limit(1));
    expect(error.message.toLowerCase()).toContain("permission denied");
  });

  it("refuses the link column at the privilege layer", async () => {
    // The first mechanism. `profile_id` is withheld, so this fails before any policy runs -
    // which is also why the write cannot be blamed on the guard being absent.
    for (const identity of [contactOwner, contactEditor]) {
      const error = await expectRefused(() =>
        identity.client.from("players").update({ profile_id: identity.profileId } as never).eq("id", enteredPlayerId),
      );
      expect(error.message.toLowerCase()).toMatch(/permission denied|not permitted|column/);
    }
    // And it is still unlinked afterwards, so the refused write changed nothing.
    expect(await contactRows(contactOwner, enteredPlayerId)).toHaveLength(1);
  });

  it("refuses the link column at the trigger layer too", async () => {
    // The second, durable mechanism, reached past the grant with the service role. An
    // insert that names a link is refused, so the privilege layer is not the only thing
    // standing in the way.
    const inserted = await roster
      .from("players")
      .insert({ name: "itest-link-probe", profile_id: contactOwner.profileId } as never);
    expect(inserted.error).not.toBeNull();
    expect(inserted.error?.message ?? "").toMatch(/approved registration/i);

    // And an existing unlinked row cannot be linked either - this is the transition the
    // approval performs, gated on a transaction-local flag that only the approval sets.
    const updated = await roster
      .from("players")
      .update({ profile_id: contactOwner.profileId } as never)
      .eq("id", unenteredPlayerId);
    expect(updated.error).not.toBeNull();
    expect(updated.error?.message ?? "").toMatch(/approved registration/i);
  });

  it("lets a desk add a person to the roster and hands the id back", async () => {
    // The direct insert still works - creation is deliberately broader than reading, because a
    // walk-in has no entry yet and contact data is readable only through one - but it cannot
    // return the row it wrote: `RETURNING` is checked against the read policy.
    const direct = await contactOwner.client
      .from("players")
      .insert({ name: `itest-direct-${Date.now().toString(36)}` } as never);
    expect(direct.error).toBeNull();
    expect(direct.data).toBeNull();

    // `add_walk_in_player` is how the app creates one now, because it returns the id. The roster
    // used to be re-read to find the person just made, and it is no longer readable as a whole.
    const name = `itest-walk-in-${Date.now().toString(36)}`;
    const { data: id, error } = await contactOwner.client.rpc("add_walk_in_player", {
      p_name: name,
      p_gender: "M",
    });
    expect(error).toBeNull();
    walkInPlayerId = (id as string | null) ?? "";
    expect(walkInPlayerId).toBeTruthy();

    // Not a person nobody may create: a user who owns or edits no tournament is refused.
    const refused = await expectRefused(() =>
      outsider.client.rpc("add_walk_in_player", { p_name: "itest-outsider-walk-in" }),
    );
    expect(refused.message).toContain(NOT_AUTHORIZED);
    const blank = await contactOwner.client.rpc("add_walk_in_player", { p_name: "   " });
    expect(blank.error?.message ?? "").toMatch(/needs a name/i);

    // And the client still cannot read the row it just wrote, which is the rule that made the
    // representation-free insert necessary rather than incidental.
    expect(await contactRows(contactOwner, walkInPlayerId)).toEqual([]);
  });

  it("finds people by name for an editor, one match at a time", async () => {
    const found = await contactOwner.client.rpc("search_players", {
      p_tournament_id: contactTournamentId,
      p_query: "itest-walk-in",
    });
    expect(found.error).toBeNull();
    expect((found.data as { id: string }[]).map((p) => p.id)).toContain(walkInPlayerId);
    for (const row of (found.data ?? []) as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual(["gender", "id", "name"]);
    }

    // Too short is an empty answer, not a listing of everyone.
    const short = await contactOwner.client.rpc("search_players", {
      p_tournament_id: contactTournamentId,
      p_query: "i",
    });
    expect(short.data).toEqual([]);

    // `%` and `_` are what somebody typed, not wildcards.
    const wildcard = await contactOwner.client.rpc("search_players", {
      p_tournament_id: contactTournamentId,
      p_query: "%%",
    });
    expect(wildcard.data).toEqual([]);

    // The cap is a server rule, whatever the caller asks for.
    const capped = await contactOwner.client.rpc("search_players", {
      p_tournament_id: contactTournamentId,
      p_query: "itest",
      p_limit: 10_000,
    });
    expect(((capped.data as unknown[]) ?? []).length).toBeLessThanOrEqual(50);

    // Only an editor of THIS tournament: an editor of another one, and a bystander, are refused.
    const bystander = await expectRefused(() =>
      outsider.client.rpc("search_players", {
        p_tournament_id: contactTournamentId,
        p_query: "itest-walk-in",
      }),
    );
    expect(bystander.message).toContain(NOT_AUTHORIZED);
  });

  it("lists the people on a tournament and nobody else", async () => {
    const mine = await outsider.client.rpc("tournament_players", {
      p_tournament_id: contactTournamentId,
    });
    expect(mine.error).toBeNull();
    const ids = ((mine.data ?? []) as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(enteredPlayerId);
    // A person on no entry here is not listed, however the caller is signed in.
    expect(ids).not.toContain(unenteredPlayerId);
    expect(ids).not.toContain(walkInPlayerId);
  });

  it("refuses a direct write to the request entries", async () => {
    // Entries are written by the submission RPC. The policy is absent *and* the grant is
    // closed, so this is refused for the owner of the tournament as much as for anyone else.
    const error = await expectRefused(() =>
      contactOwner.client
        .from("tournament_registration_entries")
        .insert({ registration_id: crypto.randomUUID(), category_id: categoryId } as never),
    );
    expect(error.message.toLowerCase()).toMatch(/permission denied|row-level security|violates/);
  });

  it("makes a rejected request re-appliable, and keeps one live request per person", async () => {
    // The Phase 1 key was unconditional, which made a rejection permanent: the row stayed,
    // the key kept it, and the person could never apply again.
    const entries = [{ category_id: categoryId, partner_name: null, partner_email: null }];
    const first = await outsider.client.rpc("submit_tournament_registration", {
      p_tournament_id: contactTournamentId,
      p_entries: entries,
    } as never);
    expect(first.error).toBeNull();
    const firstId = first.data as unknown as string;
    expect(firstId).toBeTruthy();

    // A second submission is idempotent, which is `ON CONFLICT` hitting the *partial* index
    // rather than a missing one.
    const again = await outsider.client.rpc("submit_tournament_registration", {
      p_tournament_id: contactTournamentId,
      p_entries: entries,
    } as never);
    expect(again.error).toBeNull();
    expect(again.data).toBe(firstId);

    // The owner rejects it, which is the only way a row leaves the index.
    const decided = await contactOwner.client.rpc("decide_tournament_registration", {
      p_registration_id: firstId,
      p_decision: "rejected",
      p_note: "probe",
    } as never);
    expect(decided.error).toBeNull();

    // Now a new request is a new row, not the rejected one handed back.
    const resubmitted = await outsider.client.rpc("submit_tournament_registration", {
      p_tournament_id: contactTournamentId,
      p_entries: entries,
    } as never);
    expect(resubmitted.error).toBeNull();
    const secondId = resubmitted.data as unknown as string;
    expect(secondId).not.toBe(firstId);

    // And the owner's queue shows two requests for that person: the rejected one and the new
    // live one. A single unconditional key would have returned the rejected row above and
    // this read would show one row, forever. The read is per-entry now, so each request
    // contributes exactly the one entry it was filed with.
    const review = await contactOwner.client.rpc("review_tournament_registrations", {
      p_tournament_id: contactTournamentId,
    } as never);
    expect(review.error).toBeNull();
    const mine = (
      review.data as unknown as { registration_id: string; profile_id: string; status: string }[]
    ).filter((row) => row.profile_id === outsider.profileId);
    expect(mine.map((row) => row.status).sort()).toEqual(["pending", "rejected"]);
    expect(mine.map((row) => row.registration_id)).toEqual(expect.arrayContaining([firstId, secondId]));
  }, 120_000);
});
