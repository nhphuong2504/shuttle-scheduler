import { afterAll, describe, expect, it } from "vitest";
import {
  anonClient,
  serviceClient,
  signInClient,
  createIdentity,
  createOwnedTournament,
  destroyIdentity,
  destroyTournaments,
} from "./env";
import { PILOT_TERMS_VERSION, pilotSignupMetadata } from "../src/lib/legal/policy";

const admin = serviceClient();
const userIds: string[] = [];
const profileEmails: string[] = [];
const tag = `pilot-${Date.now().toString(36)}`;
const password = `test-${tag}-only-local`;

afterAll(async () => {
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  if (profileEmails.length) await admin.from("profiles").delete().in("email", profileEmails);
});

describe("pilot policy acceptance, enforced by the real Auth insert", () => {
  it("rejects missing, false and obsolete acknowledgements without creating a profile", async () => {
    const invalid = [
      {},
      { ...pilotSignupMetadata(), pilot_adult_confirmed: false },
      { ...pilotSignupMetadata(), pilot_terms_version: "old" },
    ];
    for (const [index, metadata] of invalid.entries()) {
      const email = `${tag}-invalid-${index}@tournova.test`;
      profileEmails.push(email);
      const result = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: metadata,
      });
      if (result.data.user) userIds.push(result.data.user.id);
      expect(result.error).not.toBeNull();
      expect(result.data.user).toBeNull();
      const profile = await admin.from("profiles").select("id").eq("email", email);
      expect(profile.error).toBeNull();
      expect(profile.data).toEqual([]);
    }
  });

  it("does not trust a provisioning flag in user-editable metadata on public signup", async () => {
    const email = `${tag}-forged@tournova.test`;
    profileEmails.push(email);
    const result = await anonClient().auth.signUp({
      email,
      password,
      options: { data: { pilot_provisioned: true, app_metadata: { pilot_provisioned: true } } },
    });
    if (result.data.user) userIds.push(result.data.user.id);
    expect(result.error).not.toBeNull();
    expect(result.data.user).toBeNull();
    const profile = await admin.from("profiles").select("id").eq("email", email);
    expect(profile.error).toBeNull();
    expect(profile.data).toEqual([]);
  });

  it("has no privileged app-metadata exception for missing acknowledgement", async () => {
    const email = `${tag}-no-exception@tournova.test`;
    profileEmails.push(email);
    const result = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { pilot_provisioned: true },
    });
    if (result.data.user) userIds.push(result.data.user.id);
    expect(result.error).not.toBeNull();
    expect(result.data.user).toBeNull();
  });

  it("records server time and version, scopes reads and rejects client edits", async () => {
    const email = `${tag}-accepted@tournova.test`;
    profileEmails.push(email);
    const started = Date.now();
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { ...pilotSignupMetadata(), accepted_at: "1900-01-01" },
    });
    expect(created.error).toBeNull();
    const userId = created.data.user!.id;
    userIds.push(userId);
    const client = await signInClient(email, password);
    const row = await client.from("account_policy_acceptances").select("*").single();
    expect(row.error).toBeNull();
    expect(row.data).toMatchObject({
      user_id: userId,
      terms_version: PILOT_TERMS_VERSION,
      adult_confirmed: true,
    });
    expect(Date.parse(row.data!.accepted_at)).toBeGreaterThanOrEqual(started - 1000);
    expect(Date.parse(row.data!.accepted_at)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(
      (await anonClient().from("account_policy_acceptances").select("*")).error,
    ).not.toBeNull();
    const edited = await client
      .from("account_policy_acceptances")
      .update({ terms_version: "forged" })
      .eq("user_id", userId);
    expect(edited.error).not.toBeNull();
    const inserted = await client
      .from("account_policy_acceptances")
      .insert({
        user_id: crypto.randomUUID(),
        terms_version: PILOT_TERMS_VERSION,
        adult_confirmed: true,
      });
    expect(inserted.error).not.toBeNull();
    expect(
      (await client.from("account_policy_acceptances").delete().eq("user_id", userId)).error,
    ).not.toBeNull();
    expect(
      (
        await client.auth.updateUser({
          data: { pilot_terms_version: "changed", pilot_adult_confirmed: false },
        })
      ).error,
    ).toBeNull();
    const retained = await client.from("account_policy_acceptances").select("*").single();
    expect(retained.data).toEqual(row.data);

    const otherEmail = `${tag}-other-adult@tournova.test`;
    profileEmails.push(otherEmail);
    const other = await admin.auth.admin.createUser({
      email: otherEmail,
      password,
      email_confirm: true,
      user_metadata: pilotSignupMetadata(),
    });
    expect(other.error).toBeNull();
    userIds.push(other.data.user!.id);
    const otherClient = await signInClient(otherEmail, password);
    const privateRead = await otherClient
      .from("account_policy_acceptances")
      .select("*")
      .eq("user_id", userId);
    expect(privateRead.error).toBeNull();
    expect(privateRead.data).toEqual([]);
  });
});

it("masks real names including withdrawn entries and scopes searches, while retaining fictional demo names", async () => {
  const owner = await createIdentity("user", "pilot-visibility");
  const tournaments: string[] = [];
  const players: string[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const tournamentId = await createOwnedTournament(owner);
      tournaments.push(tournamentId);
      const category = await admin
        .from("categories")
        .select("id")
        .eq("tournament_id", tournamentId)
        .eq("code", "MS")
        .eq("entry_type", "individual")
        .limit(1)
        .single();
      expect(category.error).toBeNull();
      const player = await admin
        .from("players")
        .insert({
          name: `${tag}-private-${index}`,
          email: `${tag}-contact-${index}@tournova.test`,
          gender: "M",
        })
        .select("id")
        .single();
      expect(player.error).toBeNull();
      players.push(player.data!.id);
      expect(
        (
          await admin
            .from("teams")
            .insert({
              category_id: category.data!.id,
              player_1_id: player.data!.id,
              withdrawn: index === 0,
            } as never)
        ).error,
      ).toBeNull();
    }
    const tournamentId = tournaments[0]!;
    const publicRead = await anonClient().rpc("tournament_players", {
      p_tournament_id: tournamentId,
    });
    expect(publicRead.error).toBeNull();
    expect(publicRead.data).toEqual([
      { id: players[0], name: `Player ${players[0]!.slice(0, 8)}`, gender: null },
    ]);
    const search = await owner.client.rpc("search_players", {
      p_tournament_id: tournamentId,
      p_query: tag,
    });
    expect(search.error).toBeNull();
    expect(search.data?.map((row) => row.id)).toEqual([players[0]]);
    expect(
      (await admin.from("tournaments").update({ is_demo: true }).eq("id", tournamentId)).error,
    ).toBeNull();
    const demo = await anonClient().rpc("tournament_players", { p_tournament_id: tournamentId });
    expect(demo.error).toBeNull();
    expect(demo.data?.[0]?.name).toBe(`${tag}-private-0`);
  } finally {
    await destroyTournaments(...tournaments);
    if (players.length) await admin.from("players").delete().in("id", players);
    await destroyIdentity(owner);
  }
});
