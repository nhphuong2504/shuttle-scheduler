/**
 * Staff identity lifecycle: what happens to a role when its auth user is deleted.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT
 *
 * The failure it guards against is silent. `staff_roles.user_id` has no foreign key to
 * `auth.users`, and `link_staff_role()` refuses to re-point a row that already holds a value
 * (`AND (user_id IS NULL OR user_id = NEW.id)`). So deleting an identity and recreating it
 * with the same email used to leave the role pointing at a dead uuid - and nothing complained,
 * because `current_staff_role()` falls back to matching the email claim. The account kept
 * working, the row stayed wrong, and the INSERT trigger could never repair it.
 *
 * That is the shape of bug a green suite should not be able to hide, which is why the central
 * assertions below read `staff_roles.user_id` directly. Asserting only that the role resolves
 * would have passed before the fix, because the email fallback was covering for the stale row.
 *
 * The sequence is not hypothetical either: recreating staff logins is a step in this
 * repository's own migration, so the trap sat directly on the cutover path.
 */

import { afterAll, describe, expect, it } from "vitest";

import { createStaffIdentity, serviceClient, signInClient } from "./env";

const admin = serviceClient();

/** Reads the role row's linked identity, which is the thing under test. */
async function linkedUserId(email: string): Promise<string | null | undefined> {
  const { data, error } = await admin
    .from("staff_roles")
    .select("user_id")
    .eq("email", email)
    .maybeSingle();
  if (error) throw new Error(`reading staff_roles failed: ${error.message}`);
  if (!data) throw new Error(`no staff_roles row for ${email}; the fixture is not what it claims`);
  return data.user_id;
}

describe("deleting an auth identity leaves its staff role re-linkable", () => {
  // `createStaffIdentity` makes the address random, which is what we want: an interrupted run
  // cannot collide with the next one. The address is reused deliberately for the recreation.
  let identityEmail = "";
  const userIdsToDelete: string[] = [];

  afterAll(async () => {
    // Independent guards. A failure on one must not strand the other, and neither may throw
    // out of teardown - that would report as a test failure rather than a cleanup problem.
    for (const userId of userIdsToDelete) {
      await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    }
    if (identityEmail) {
      await admin
        .from("staff_roles")
        .delete()
        .eq("email", identityEmail)
        .then(
          () => undefined,
          () => undefined,
        );
    }
  });

  it("clears the link on delete, then links the replacement", async () => {
    // --- A normally provisioned identity -------------------------------------------------
    // This also serves as the control: it proves the INSERT trigger links at all, so a failure
    // later cannot be mistaken for a broken link rather than a broken unlink.
    const first = await createStaffIdentity("scorer", "relink");
    identityEmail = first.email;
    userIdsToDelete.push(first.userId);

    expect(await linkedUserId(first.email)).toBe(first.userId);

    // --- Delete the identity -------------------------------------------------------------
    const { error: deleteError } = await admin.auth.admin.deleteUser(first.userId);
    if (deleteError) throw new Error(`deleting the identity failed: ${deleteError.message}`);
    userIdsToDelete.length = 0;

    // The assertion the migration exists for. Before `unlink_staff_role()` this still held the
    // deleted uuid, and no later step could have corrected it.
    expect(await linkedUserId(first.email)).toBeNull();

    // --- Recreate with the same email ----------------------------------------------------
    const password = `itest-relink-second-${Date.now().toString(36)}`;
    const { data: second, error: secondError } = await admin.auth.admin.createUser({
      email: first.email,
      password,
      email_confirm: true,
    });
    if (secondError) throw new Error(`recreating the identity failed: ${secondError.message}`);
    if (!second.user) throw new Error("recreating the identity returned no user");
    userIdsToDelete.push(second.user.id);

    // The replacement links, because the row was cleared rather than left holding a dead uuid.
    expect(await linkedUserId(first.email)).toBe(second.user.id);

    // --- And the replacement can actually act --------------------------------------------
    // A row correctly linked to an identity that cannot sign in is not a working login, and
    // this is the call the desk UI branches on.
    const client = await signInClient(first.email, password);
    const { data: role, error: roleError } = await client.rpc("current_staff_role");
    if (roleError) throw new Error(`current_staff_role failed: ${roleError.message}`);
    expect(role).toBe("scorer");
  }, 120_000);
});
