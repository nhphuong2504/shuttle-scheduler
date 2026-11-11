/**
 * Profile identity lifecycle: what happens to a profile when its auth user is deleted.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT
 *
 * The failure it guards against is silent. `profiles.user_id` has no foreign key to
 * `auth.users`, and `link_profile()` refuses to re-point a row that already holds a value
 * (`AND (user_id IS NULL OR user_id = NEW.id)`). So deleting an identity and recreating it
 * with the same email used to leave the row pointing at a dead uuid - and nothing
 * complained, because `current_system_role()` falls back to matching the email. The account
 * kept working, the row stayed wrong, and the INSERT trigger could never repair it.
 *
 * That is the shape of bug a green suite should not be able to hide, which is why the
 * central assertions below read `profiles.user_id` directly. Asserting only that the role
 * resolves would have passed before the fix, because the email fallback was covering for the
 * stale row.
 *
 * The reason this survived the redesign unchanged is that it is the load-bearing property of
 * the rename: ownership now points at `profiles`, not at `auth.users`, precisely so that the
 * recovery runbook can delete and recreate the admin's identity without orphaning a
 * tournament. The sequence below is the runbook, executed.
 */

import { afterAll, describe, expect, it } from "vitest";

import {
  createIdentity,
  createOwnedTournament,
  destroyIdentity,
  destroyTournaments,
  grantEditor,
  serviceClient,
  signInClient,
  type TestIdentity,
} from "./env";

const admin = serviceClient();

/** Reads the profile's linked identity, which is the thing under test. */
async function linkedUserId(email: string): Promise<string | null | undefined> {
  const { data, error } = await admin
    .from("profiles")
    .select("id, user_id, system_role")
    .eq("email", email)
    .maybeSingle();
  if (error) throw new Error(`reading profiles failed: ${error.message}`);
  if (!data) throw new Error(`no profiles row for ${email}; the fixture is not what it claims`);
  return data.user_id;
}

describe("deleting an auth identity leaves its profile re-linkable", () => {
  // `createIdentity` makes the address random, which is what we want: an interrupted run
  // cannot collide with the next one. The address is reused deliberately for the recreation.
  let identity: TestIdentity | undefined;
  const userIdsToDelete: string[] = [];

  afterAll(async () => {
    // Independent guards. A failure on one must not strand the other, and neither may throw
    // out of teardown - that would report as a test failure rather than a cleanup problem.
    for (const userId of userIdsToDelete) {
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    }
    if (identity) {
      await admin
        .from("profiles")
        .delete()
        .eq("id", identity.profileId)
        .then(
          () => undefined,
          () => undefined,
        );
    }
  });

  it("clears the link on delete, keeps the role, and links the replacement", async () => {
    // --- A normally provisioned identity -------------------------------------------------
    // This also serves as the control: it proves the INSERT trigger links at all, so a failure
    // later cannot be mistaken for a broken link rather than a broken unlink.
    const first = await createIdentity("admin", "relink");
    identity = first;
    expect(await linkedUserId(first.email)).toBe(first.userId);

    // --- Delete the identity -------------------------------------------------------------
    const { error: deleteError } = await admin.auth.admin.deleteUser(first.userId);
    if (deleteError) throw new Error(`deleting the identity failed: ${deleteError.message}`);

    // The assertion the trigger exists for. Without `unlink_profile()` this still held the
    // deleted uuid, and no later step could have corrected it.
    expect(await linkedUserId(first.email)).toBeNull();

    // The row itself survives, with its platform role. That is what lets ownership keep
    // pointing at it across the identity being recreated.
    const { data: survived, error: survivedError } = await admin
      .from("profiles")
      .select("id, system_role, current_tournament_id")
      .eq("email", first.email)
      .maybeSingle();
    expect(survivedError).toBeNull();
    expect(survived?.id).toBe(first.profileId);
    expect(survived?.system_role).toBe("admin");
    // The working pointer is cleared with the link: it is the deleted user's context.
    expect(survived?.current_tournament_id).toBeNull();

    // --- Recreate with the same email ----------------------------------------------------
    const password = `itest-relink-second-${Date.now().toString(36)}`;
    const { data: second, error: secondError } = await admin.auth.admin.createUser({
      email: first.email,
      password,
      email_confirm: true,
      user_metadata: { pilot_adult_confirmed: true, pilot_terms_version: "2026-11-11-pilot-draft" },
    });
    if (secondError) throw new Error(`recreating the identity failed: ${secondError.message}`);
    if (!second.user) throw new Error("recreating the identity returned no user");
    userIdsToDelete.push(second.user.id);

    // The replacement links, because the row was cleared rather than left holding a dead uuid.
    expect(await linkedUserId(first.email)).toBe(second.user.id);

    // --- And the replacement can actually act --------------------------------------------
    // A row correctly linked to an identity that cannot sign in is not a working login, and
    // this is the call the session hook branches on.
    const client = await signInClient(first.email, password);
    const { data: role, error: roleError } = await client.rpc("current_system_role");
    if (roleError) throw new Error(`current_system_role failed: ${roleError.message}`);
    expect(role).toBe("admin");
  }, 120_000);
});

/**
 * The same recovery sequence, run against the relationships rather than against the link.
 *
 * The test above asserts `profiles.user_id`, which has no foreign key from `auth.users`.
 * Membership and registration requests did: `tournament_editors` and
 * `tournament_registrations` pointed straight at `auth.users(id) ON DELETE CASCADE`. So
 * deleting an identity took the editor grants and the requests with it - silently, with the
 * person coming back as a stranger and no error anywhere. After the identity canon both key
 * on `profiles.id`, which the delete does not touch.
 *
 * The rows are read directly for that reason. "The access still resolves" would pass on the
 * email fallback even while the row was gone, which is exactly how the old bug hid.
 */
describe("membership and participation outlive the identity", () => {
  let owner: TestIdentity;
  let editor: TestIdentity;
  let tournamentId = "";
  /** Identities created mid-test by the recreations, so teardown can find them. */
  const replacementUserIds: string[] = [];

  afterAll(async () => {
    // Independently guarded: a failure on one must not strand the others, and none may throw
    // out of teardown, which would report as a test failure rather than a cleanup problem.
    for (const userId of replacementUserIds) {
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    }
    await destroyTournaments(tournamentId);
    await destroyIdentity(editor);
    await destroyIdentity(owner);
  }, 180_000);

  it("keeps the tournament, the editor row and the request, and regains the access", async () => {
    owner = await createIdentity("user", "canon-owner");
    editor = await createIdentity("user", "canon-editor");
    tournamentId = await createOwnedTournament(owner);
    await grantEditor(tournamentId, editor, owner);

    // A pending request. Service role, because the client has SELECT only on this table and
    // the guard keeps the payload's profile when there is no JWT - which is the fixture arm
    // the guard's `IS NOT NULL` check exists for.
    const { error: requestError } = await admin.from("tournament_registrations").insert({
      tournament_id: tournamentId,
      profile_id: editor.profileId,
    });
    if (requestError) throw new Error(`seeding the request failed: ${requestError.message}`);

    // --- Delete the editor's identity -----------------------------------------------------
    const { error: deleteError } = await admin.auth.admin.deleteUser(editor.userId);
    if (deleteError) throw new Error(`deleting the editor failed: ${deleteError.message}`);

    // The link is cleared and the person survives, which is the whole reason `profiles` is
    // the durable row.
    expect(await linkedUserId(editor.email)).toBeNull();

    // The two rows the old schema lost. There is no auth-user foreign key left for the delete
    // to cascade to, so both are still here - and still naming the person.
    const { data: memberRow, error: memberError } = await admin
      .from("tournament_editors")
      .select("profile_id")
      .eq("tournament_id", tournamentId)
      .eq("profile_id", editor.profileId)
      .maybeSingle();
    expect(memberError).toBeNull();
    expect(memberRow?.profile_id).toBe(editor.profileId);

    const { data: requestRow, error: requestReadError } = await admin
      .from("tournament_registrations")
      .select("profile_id, status")
      .eq("tournament_id", tournamentId)
      .eq("profile_id", editor.profileId)
      .maybeSingle();
    expect(requestReadError).toBeNull();
    expect(requestRow?.profile_id).toBe(editor.profileId);
    expect(requestRow?.status).toBe("pending");

    // --- Recreate it, and take back the same access with no re-grant ----------------------
    const password = `itest-canon-${Date.now().toString(36)}`;
    const { data: replacement, error: recreateError } = await admin.auth.admin.createUser({
      email: editor.email,
      password,
      email_confirm: true,
      user_metadata: { pilot_adult_confirmed: true, pilot_terms_version: "2026-11-11-pilot-draft" },
    });
    if (recreateError) throw new Error(`recreating the editor failed: ${recreateError.message}`);
    if (!replacement.user) throw new Error("recreating the editor returned no user");
    replacementUserIds.push(replacement.user.id);

    expect(await linkedUserId(editor.email)).toBe(replacement.user.id);

    const client = await signInClient(editor.email, password);
    const { data: access, error: accessError } = await client.rpc("tournament_access", {
      p_tournament_id: tournamentId,
    } as never);
    if (accessError) throw new Error(`tournament_access failed: ${accessError.message}`);
    expect(access).toMatchObject({ is_editor: true, can_edit: true, is_owner: false });

    // --- And the owner keeps the tournament across its own recreation ---------------------
    // Ownership is already held on a profile; this is the control that proves the sequence
    // above is testing membership rather than a broken teardown.
    const ownerPassword = `itest-canon-owner-${Date.now().toString(36)}`;
    const { error: ownerDeleteError } = await admin.auth.admin.deleteUser(owner.userId);
    if (ownerDeleteError) throw new Error(`deleting the owner failed: ${ownerDeleteError.message}`);

    const { data: ownedTournament, error: ownedError } = await admin
      .from("tournaments")
      .select("owner_profile_id")
      .eq("id", tournamentId)
      .maybeSingle();
    expect(ownedError).toBeNull();
    expect(ownedTournament?.owner_profile_id).toBe(owner.profileId);

    const { data: ownerReplacement, error: ownerRecreateError } =
      await admin.auth.admin.createUser({
        email: owner.email,
        password: ownerPassword,
        email_confirm: true,
        user_metadata: { pilot_adult_confirmed: true, pilot_terms_version: "2026-11-11-pilot-draft" },
      });
    if (ownerRecreateError) {
      throw new Error(`recreating the owner failed: ${ownerRecreateError.message}`);
    }
    if (!ownerReplacement.user) throw new Error("recreating the owner returned no user");
    replacementUserIds.push(ownerReplacement.user.id);

    const ownerClient = await signInClient(owner.email, ownerPassword);
    const { data: ownerAccess, error: ownerAccessError } = await ownerClient.rpc("tournament_access", {
      p_tournament_id: tournamentId,
    } as never);
    if (ownerAccessError) throw new Error(`tournament_access failed: ${ownerAccessError.message}`);
    expect(ownerAccess).toMatchObject({ is_owner: true, can_edit: true, can_manage_access: true });
  }, 180_000);
});
