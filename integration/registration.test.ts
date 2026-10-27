import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  anonClient,
  createIdentity,
  createOwnedTournament,
  destroyIdentity,
  destroyTournaments,
  expectRefused,
  forceStatus,
  serviceClient,
  type TestIdentity,
} from "./env";

/**
 * Registration against the real backend: submission, withdrawal and the approval
 * bridge.
 *
 * The hermetic Playwright suite cannot see any of this. It intercepts transport, so
 * RLS policies, the definer RPCs, the column privileges and the link guard are all
 * structurally invisible to it - and every property this file asserts is one of those.
 *
 * WHY THE ORDER IS THIS EXACT SEQUENCE
 *
 * A registration request is terminal: `pending -> approved | rejected`, no reverse. So
 * each flow that ends in a decision needs an identity that has not yet spent its one
 * live request. The helpers below make that explicit -- one requester per flow, named
 * after the flow -- rather than sharing one and depending on the order in which tests
 * happen to run. The only ordering that is load-bearing is that submission is exercised
 * before approval, and that the window-state tournament is moved through its lifecycle
 * last, because the lifecycle is the one thing a state cannot be un-told.
 */

const roster = serviceClient();

interface CategoryRow {
  id: string;
  code: string;
  name: string;
  entry_type: string;
  max_entries: number | null;
  active: boolean;
}

/** The tournament's events, read with the service role so a test never depends on a policy. */
async function categoriesOf(tournamentId: string): Promise<CategoryRow[]> {
  const { data, error } = await roster
    .from("categories")
    .select("id, code, name, entry_type, max_entries, active")
    .eq("tournament_id", tournamentId)
    .order("sort_order");
  if (error) throw new Error(`reading categories failed: ${error.message}`);
  return data ?? [];
}

function categoryOf(categories: CategoryRow[], code: string): CategoryRow {
  const found = categories.find((row) => row.code === code);
  if (!found) throw new Error(`the fixture has no ${code} category`);
  return found;
}

/** Writes one event, or switches one off, through the RPC the Setup page uses. */
async function saveCategory(
  identity: TestIdentity,
  tournamentId: string,
  category: Partial<CategoryRow> & { code: string; name: string },
): Promise<void> {
  const { error } = await identity.client.rpc("save_tournament_categories", {
    p_tournament_id: tournamentId,
    p_categories: [
      {
        entry_type: "individual",
        gender: "open",
        sort_order: 1,
        active: true,
        max_entries: null,
        ...category,
      },
    ],
  } as never);
  if (error) throw new Error(`save_tournament_categories failed: ${error.message}`);
}

/** Replaces the basics and the window, through the RPC the Schedule page uses. */
async function saveConfig(
  identity: TestIdentity,
  tournamentId: string,
  window: { opens: string | null; closes: string | null },
): Promise<void> {
  const { error } = await identity.client.rpc("save_tournament_config", {
    p_tournament_id: tournamentId,
    p_payload: {
      name: "registration probe",
      venue_name: "Integration Test Venue",
      venue_timezone: "America/Chicago",
      format: "two_round_placement",
      max_categories_per_player: 3,
      registration_opens_at: window.opens,
      registration_closes_at: window.closes,
    },
  } as never);
  if (error) throw new Error(`save_tournament_config failed: ${error.message}`);
}

function entry(categoryId: string, partner?: { name: string; email: string }) {
  return {
    category_id: categoryId,
    partner_name: partner?.name ?? null,
    partner_email: partner?.email ?? null,
  };
}

async function countPlayers(): Promise<number> {
  const { count, error } = await roster.from("players").select("id", { count: "exact", head: true });
  if (error) throw new Error(`counting players failed: ${error.message}`);
  return count ?? 0;
}

describe("registration: submission, withdrawal and the approval bridge", () => {
  let owner: TestIdentity;
  let applicant: TestIdentity;
  let applicant2: TestIdentity;
  let mixedApplicant: TestIdentity;
  let withdrawer: TestIdentity;
  let outsider: TestIdentity;
  let linkedPartner: TestIdentity;

  let tournamentId = "";
  let otherTournamentId = "";
  let noWindowId = "";
  let windowOtherId = "";
  let notReadyId = "";

  let ms: CategoryRow;
  let ws: CategoryRow;
  let md: CategoryRow;
  let md2: CategoryRow;
  let md3: CategoryRow;
  let xd: CategoryRow;
  let xd2: CategoryRow;
  let xb: CategoryRow;
  let otherMs: CategoryRow;

  /** Seeded so a partner email resolves to exactly one unlinked row. */
  const reuseEmail = `itest-reuse-${Date.now().toString(36)}@tournova.test`;
  /** Seeded twice, so a partner email resolves ambiguously and must not be reused. */
  const ambiguousEmail = `itest-ambiguous-${Date.now().toString(36)}@tournova.test`;
  /** The partner on the first approval: an address nobody holds. */
  const freshPartnerEmail = `itest-freshpartner-${Date.now().toString(36)}@tournova.test`;

  const seededPlayerIds: string[] = [];
  const seededEmails = [reuseEmail, ambiguousEmail];
  const tournamentIds: string[] = [];

  beforeAll(async () => {
    owner = await createIdentity("user", "reg-owner");
    applicant = await createIdentity("user", "reg-applicant");
    applicant2 = await createIdentity("user", "reg-applicant2");
    mixedApplicant = await createIdentity("user", "reg-mixed");
    withdrawer = await createIdentity("user", "reg-withdrawer");
    outsider = await createIdentity("user", "reg-outsider");
    linkedPartner = await createIdentity("user", "reg-partner");

    // Days in the future, so the window can legitimately close at or before the derived
    // start - `assert_registration_window` requires it and the default day is in 2020.
    const day = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const days = [{ date: day, startTime: "09:00", endTime: "18:00", courts: [1, 2] }];

    tournamentId = await createOwnedTournament(owner, { days });
    tournamentIds.push(tournamentId);

    // `save_tournament_categories` replaces the whole set, so the default MS is dropped and
    // this list is the tournament's events. It refuses once teams exist, which is why the
    // whole configuration lands here, before the seeded full category below.
    await saveConfig(owner, tournamentId, {
      opens: new Date(Date.now() - 3_600_000).toISOString(),
      closes: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const { error: categoriesError } = await owner.client.rpc("save_tournament_categories", {
      p_tournament_id: tournamentId,
      p_categories: [
        { code: "MS", name: "Men's Singles", entry_type: "individual", gender: "men", sort_order: 1, active: true, max_entries: null },
        { code: "WS", name: "Women's Singles", entry_type: "individual", gender: "women", sort_order: 2, active: true, max_entries: null },
        // Deliberately small and deliberately full: readiness refuses a cap below 2, so a
        // "full" category is one with a cap of 2 and two entries already standing in it.
        { code: "MD", name: "Men's Doubles", entry_type: "pair", gender: "men", sort_order: 3, active: true, max_entries: 2 },
        // The approval bridge's pair categories. Deliberately single-gender: a *mixed* pair
        // needs both players' recorded genders to prove the pair is mixed, and nothing on a
        // registration request can supply them - so `enforce_team_shape` refuses it, and the
        // mixed case below asserts exactly that rather than working around it.
        { code: "MD2", name: "Men's Doubles B", entry_type: "pair", gender: "men", sort_order: 7, active: true, max_entries: null },
        { code: "MD3", name: "Men's Doubles C", entry_type: "pair", gender: "men", sort_order: 8, active: true, max_entries: null },
        { code: "XD", name: "Mixed Doubles", entry_type: "pair", gender: "mixed", sort_order: 4, active: true, max_entries: null },
        { code: "XD2", name: "Mixed Doubles B", entry_type: "pair", gender: "mixed", sort_order: 5, active: true, max_entries: null },
        { code: "XB", name: "Closed Event", entry_type: "individual", gender: "open", sort_order: 6, active: false, max_entries: null },
      ],
    } as never);
    if (categoriesError) throw new Error(`seeding events failed: ${categoriesError.message}`);

    const main = await categoriesOf(tournamentId);
    ms = categoryOf(main, "MS");
    ws = categoryOf(main, "WS");
    md = categoryOf(main, "MD");
    md2 = categoryOf(main, "MD2");
    md3 = categoryOf(main, "MD3");
    xd = categoryOf(main, "XD");
    xd2 = categoryOf(main, "XD2");
    xb = categoryOf(main, "XB");

    // Fill MD to its cap with four seeded players and two teams.
    const fillerIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { data, error } = await roster
        .from("players")
        .insert({ name: `itest-filler-${i}-${Date.now().toString(36)}` })
        .select("id")
        .single();
      if (error) throw new Error(`seeding a filler player failed: ${error.message}`);
      fillerIds.push(data.id);
    }
    seededPlayerIds.push(...fillerIds);
    const { error: fillerTeamError } = await roster.from("teams").insert([
      { category_id: md.id, player_1_id: fillerIds[0], player_2_id: fillerIds[1] },
      { category_id: md.id, player_1_id: fillerIds[2], player_2_id: fillerIds[3] },
    ] as never);
    if (fillerTeamError) throw new Error(`filling the category failed: ${fillerTeamError.message}`);

    // One unlinked row for a reused partner, and two for an ambiguous one.
    const { data: seeded, error: seededError } = await roster
      .from("players")
      .insert([
        { name: "itest-reuse", email: reuseEmail },
        { name: "itest-ambiguous-a", email: ambiguousEmail },
        { name: "itest-ambiguous-b", email: ambiguousEmail },
      ])
      .select("id");
    if (seededError) throw new Error(`seeding partner rows failed: ${seededError.message}`);
    seededPlayerIds.push(...(seeded ?? []).map((row) => row.id));

    otherTournamentId = await createOwnedTournament(owner, { days, name: `itest-other-${Date.now().toString(36)}` });
    tournamentIds.push(otherTournamentId);
    otherMs = categoryOf(await categoriesOf(otherTournamentId), "MS");

    // The window-state fixtures. Each is a tournament whose *state* is one case; the
    // submission is attempted against it to prove the state and the RPC agree.
    noWindowId = await createOwnedTournament(owner, { days, name: `itest-nowindow-${Date.now().toString(36)}` });
    windowOtherId = await createOwnedTournament(owner, { days, name: `itest-window-${Date.now().toString(36)}` });
    notReadyId = await createOwnedTournament(owner, {
      days,
      category: false,
      name: `itest-notready-${Date.now().toString(36)}`,
    });
    tournamentIds.push(noWindowId, windowOtherId, notReadyId);

    // not_ready needs a window, or the window gate would answer first and the readiness
    // gate would never be reached - `assert_registration_not_shut` runs before it.
    await saveConfig(owner, notReadyId, {
      opens: new Date(Date.now() - 3_600_000).toISOString(),
      closes: new Date(Date.now() + 3_600_000).toISOString(),
    });

    // A window that has not opened, on the tournament the state test then closes.
    await saveConfig(owner, windowOtherId, {
      opens: new Date(Date.now() + 3_600_000).toISOString(),
      closes: new Date(Date.now() + 7_200_000).toISOString(),
    });
  }, 300_000);

  afterAll(async () => {
    await destroyTournaments(...tournamentIds);
    // The bridge's player rows have no tournament to cascade from: the requester's row is
    // linked to a profile and the partner's is unlinked, but neither is owned by a
    // tournament. Deleted by the addresses this file chose, before the identities go.
    const emails = [
      applicant.email,
      applicant2.email,
      mixedApplicant.email,
      withdrawer.email,
      outsider.email,
      linkedPartner.email,
      freshPartnerEmail,
      ...seededEmails,
    ];
    await roster.from("players").delete().in("email", emails);
    if (seededPlayerIds.length > 0) await roster.from("players").delete().in("id", seededPlayerIds);
    for (const identity of [
      owner,
      applicant,
      applicant2,
      mixedApplicant,
      withdrawer,
      outsider,
      linkedPartner,
    ]) {
      await destroyIdentity(identity);
    }
  }, 300_000);

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  it("refuses an anonymous visitor at the privilege layer", async () => {
    const error = await expectRefused(() =>
      anonClient().rpc("submit_tournament_registration", {
        p_tournament_id: tournamentId,
        p_entries: [entry(ms.id)],
      } as never),
    );
    expect(error.message.toLowerCase()).toMatch(/permission|denied|not.*exist/);
  });

  it("refuses a request with no entries, and one whose entries are not a list", async () => {
    // The default makes this reachable rather than theoretical: a client that sends only
    // the tournament id is told to choose an event, not handed a bare empty request.
    const empty = await expectRefused(() =>
      applicant.client.rpc("submit_tournament_registration", { p_tournament_id: tournamentId } as never),
    );
    expect(empty.message).toMatch(/at least one event/i);

    const explicit = await expectRefused(() =>
      applicant.client.rpc("submit_tournament_registration", {
        p_tournament_id: tournamentId,
        p_entries: [],
      } as never),
    );
    expect(explicit.message).toMatch(/at least one event/i);

    const notAList = await expectRefused(() =>
      applicant.client.rpc("submit_tournament_registration", {
        p_tournament_id: tournamentId,
        p_entries: { category_id: ms.id },
      } as never),
    );
    expect(notAList.message).toMatch(/at least one event/i);
  });

  it("refuses an unknown event and a repeated one", async () => {
    const unknown = await expectRefused(() =>
      applicant.client.rpc("submit_tournament_registration", {
        p_tournament_id: tournamentId,
        p_entries: [entry(crypto.randomUUID())],
      } as never),
    );
    expect(unknown.message).toMatch(/unknown event/i);

    const repeated = await expectRefused(() =>
      applicant.client.rpc("submit_tournament_registration", {
        p_tournament_id: tournamentId,
        p_entries: [entry(ms.id), entry(ms.id)],
      } as never),
    );
    expect(repeated.message).toMatch(/once/i);
  });

  it("refuses another tournament's event and an event that is switched off", async () => {
    const foreign = await expectRefused(() =>
      applicant.client.rpc("submit_tournament_registration", {
        p_tournament_id: tournamentId,
        p_entries: [entry(otherMs.id)],
      } as never),
    );
    expect(foreign.message).toMatch(/another tournament/i);

    const inactive = await expectRefused(() =>
      applicant.client.rpc("submit_tournament_registration", {
        p_tournament_id: tournamentId,
        p_entries: [entry(xb.id)],
      } as never),
    );
    expect(inactive.message).toMatch(/not open/i);
  });

  it("refuses more events than the tournament allows per player", async () => {
    // The tournament allows 3. Four is the smallest number that exceeds it.
    const error = await expectRefused(() =>
      applicant.client.rpc("submit_tournament_registration", {
        p_tournament_id: tournamentId,
        p_entries: [entry(ms.id), entry(ws.id), entry(xd.id), entry(xd2.id)],
      } as never),
    );
    expect(error.message).toMatch(/at most 3/i);
  });

  it("refuses a doubles entry with a missing partner, and one naming the caller", async () => {
    const missing = await expectRefused(() =>
      applicant.client.rpc("submit_tournament_registration", {
        p_tournament_id: tournamentId,
        p_entries: [entry(xd.id)],
      } as never),
    );
    expect(missing.message).toMatch(/partner name and email/i);

    const selfPartnership = await expectRefused(() =>
      applicant.client.rpc("submit_tournament_registration", {
        p_tournament_id: tournamentId,
        p_entries: [entry(xd.id, { name: "me", email: applicant.email.toUpperCase() })],
      } as never),
    );
    expect(selfPartnership.message).toMatch(/yourself/i);
  });

  it("files a request without creating any competition data, and replaces entries on a retry", async () => {
    const playersBefore = await countPlayers();
    const teamsBefore = await roster
      .from("teams")
      .select("id", { count: "exact", head: true })
      .eq("tournament_id", tournamentId);

    const first = await applicant.client.rpc("submit_tournament_registration", {
      p_tournament_id: tournamentId,
      p_entries: [
        entry(ms.id, { name: "Ignored singles partner", email: "ignored@example.test" }),
        entry(md2.id, { name: "Fresh Partner", email: freshPartnerEmail }),
      ],
    } as never);
    expect(first.error).toBeNull();
    const requestId = first.data as unknown as string;
    expect(requestId).toBeTruthy();

    // The request says what it is for: one row per category, the partner on the pair and
    // nothing on the singles.
    const { data: entries, error: entriesError } = await roster
      .from("tournament_registration_entries")
      .select("category_id, partner_name, partner_email")
      .eq("registration_id", requestId);
    expect(entriesError).toBeNull();
    expect(entries).toHaveLength(2);
    expect(entries?.find((row) => row.category_id === ms.id)).toMatchObject({
      partner_name: null,
      partner_email: null,
    });
    expect(entries?.find((row) => row.category_id === md2.id)).toMatchObject({
      partner_name: "Fresh Partner",
      partner_email: freshPartnerEmail,
    });

    // Submitting creates no player, team or entrant. This is the line the bridge is
    // deliberately on the other side of.
    expect(await countPlayers()).toBe(playersBefore);
    const teamsAfter = await roster
      .from("teams")
      .select("id", { count: "exact", head: true })
      .eq("tournament_id", tournamentId);
    expect(teamsAfter.count).toBe(teamsBefore.count);

    // A refused replacement must roll back both its delete and any partial inserts.
    const refusedRetry = await expectRefused(() =>
      applicant.client.rpc("submit_tournament_registration", {
        p_tournament_id: tournamentId,
        p_entries: [entry(ws.id), entry(crypto.randomUUID())],
      } as never),
    );
    expect(refusedRetry.message).toMatch(/unknown event/i);
    const unchanged = await roster
      .from("tournament_registration_entries")
      .select("category_id, partner_name, partner_email")
      .eq("registration_id", requestId);
    expect(unchanged.error).toBeNull();
    expect(unchanged.data).toHaveLength(2);
    expect(unchanged.data).toEqual(expect.arrayContaining(entries ?? []));

    // A retry on imperfect wifi returns the same request and *replaces* the set, rather
    // than filing a second request or accumulating a second copy of the entries.
    const retry = await applicant.client.rpc("submit_tournament_registration", {
      p_tournament_id: tournamentId,
      p_entries: [entry(ms.id)],
    } as never);
    expect(retry.error).toBeNull();
    expect(retry.data).toBe(requestId);

    const { data: afterRetry } = await roster
      .from("tournament_registration_entries")
      .select("category_id")
      .eq("registration_id", requestId);
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry?.[0]?.category_id).toBe(ms.id);

    // Restore the two entries the approval test below is about.
    const restore = await applicant.client.rpc("submit_tournament_registration", {
      p_tournament_id: tournamentId,
      p_entries: [
        entry(ms.id),
        entry(md2.id, { name: "Fresh Partner", email: freshPartnerEmail }),
      ],
    } as never);
    expect(restore.data).toBe(requestId);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // The window state and the RPC agreeing
  // ---------------------------------------------------------------------------

  it("answers not_offered for a tournament with no window, and refuses the submission", async () => {
    const { data, error } = await outsider.client.rpc("tournament_registration_state", {
      p_tournament_id: noWindowId,
    } as never);
    expect(error).toBeNull();
    expect(data).toBe("not_offered");

    const refused = await expectRefused(() =>
      outsider.client.rpc("submit_tournament_registration", {
        p_tournament_id: noWindowId,
        p_entries: [entry(ms.id)],
      } as never),
    );
    expect(refused.message).toMatch(/not accepting registration/i);
  });

  it("answers not_ready for a tournament that is not configured, and refuses the submission", async () => {
    const { data, error } = await outsider.client.rpc("tournament_registration_state", {
      p_tournament_id: notReadyId,
    } as never);
    expect(error).toBeNull();
    expect(data).toBe("not_ready");

    // The event id belongs to another tournament on purpose: readiness is answered before
    // the entries are looked at, so the refusal can only be the readiness gate.
    const refused = await expectRefused(() =>
      outsider.client.rpc("submit_tournament_registration", {
        p_tournament_id: notReadyId,
        p_entries: [entry(ms.id)],
      } as never),
    );
    expect(refused.message).toMatch(/not accepting registration requests yet/i);
  });

  it("answers opens_soon then closed, and refuses the submission each way", async () => {
    const soon = await outsider.client.rpc("tournament_registration_state", {
      p_tournament_id: windowOtherId,
    } as never);
    expect(soon.error).toBeNull();
    expect(soon.data).toBe("opens_soon");

    const beforeOpen = await expectRefused(() =>
      outsider.client.rpc("submit_tournament_registration", {
        p_tournament_id: windowOtherId,
        p_entries: [entry(otherMs.id)],
      } as never),
    );
    expect(beforeOpen.message).toMatch(/registration opens/i);

    // Move the window into the past. The event's own category is used so the refusal can
    // only be the window.
    await saveConfig(owner, windowOtherId, {
      opens: new Date(Date.now() - 7_200_000).toISOString(),
      closes: new Date(Date.now() - 3_600_000).toISOString(),
    });

    const closed = await outsider.client.rpc("tournament_registration_state", {
      p_tournament_id: windowOtherId,
    } as never);
    expect(closed.data).toBe("closed");

    const afterClose = await expectRefused(() =>
      outsider.client.rpc("submit_tournament_registration", {
        p_tournament_id: windowOtherId,
        p_entries: [entry(otherMs.id)],
      } as never),
    );
    expect(afterClose.message).toMatch(/registration closed/i);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Approval: the bridge
  // ---------------------------------------------------------------------------

  it("refuses a full category and creates nothing at all", async () => {
    // MD holds two of its two entries. The approval has to refuse the *whole* request and
    // name the category - and the requester's player row it would have created first must
    // be rolled back with it.
    const submitted = await applicant2.client.rpc("submit_tournament_registration", {
      p_tournament_id: tournamentId,
      p_entries: [entry(md.id, { name: "Full Partner", email: `itest-full-${Date.now().toString(36)}@tournova.test` })],
    } as never);
    expect(submitted.error).toBeNull();
    const requestId = submitted.data as unknown as string;

    const refused = await expectRefused(() =>
      owner.client.rpc("decide_tournament_registration", {
        p_registration_id: requestId,
        p_decision: "approved",
      } as never),
    );
    expect(refused.message).toMatch(/MD/);
    expect(refused.message).toMatch(/full/i);

    // Nothing was created and the request is still pending: the refusal rolled the whole
    // transaction back, including the player row the bridge had already made.
    const stillPending = await roster
      .from("tournament_registrations")
      .select("status")
      .eq("id", requestId)
      .single();
    expect(stillPending.data?.status).toBe("pending");
    const requesterRows = await roster
      .from("players")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", applicant2.profileId);
    expect(requesterRows.count).toBe(0);
  }, 120_000);

  it("approves into a linked requester, an unlinked partner and the teams", async () => {
    const { data: pending } = await roster
      .from("tournament_registrations")
      .select("id")
      .eq("tournament_id", tournamentId)
      .eq("profile_id", applicant.profileId)
      .eq("status", "pending")
      .single();
    const registrationId = pending?.id ?? "";

    const decided = await owner.client.rpc("decide_tournament_registration", {
      p_registration_id: registrationId,
      p_decision: "approved",
      p_note: "welcome",
    } as never);
    expect(decided.error).toBeNull();

    const registration = await roster
      .from("tournament_registrations")
      .select("status, decision_note, decided_by_profile_id")
      .eq("id", registrationId)
      .single();
    expect(registration.data).toMatchObject({
      status: "approved",
      decision_note: "welcome",
      decided_by_profile_id: owner.profileId,
    });

    // The requester's row is linked to their profile - the only place a link is set.
    const { data: requester } = await roster
      .from("players")
      .select("id, name, email, profile_id")
      .eq("profile_id", applicant.profileId)
      .single();
    expect(requester?.profile_id).toBe(applicant.profileId);
    expect(requester?.email).toBe(applicant.email);

    // The partner's row carries the supplied name and email and no link at all.
    const { data: partner } = await roster
      .from("players")
      .select("id, name, email, profile_id")
      .eq("email", freshPartnerEmail);
    expect(partner).toHaveLength(1);
    expect(partner?.[0]).toMatchObject({ name: "Fresh Partner", profile_id: null });

    const { data: teams } = await roster
      .from("teams")
      .select("category_id, player_1_id, player_2_id")
      .eq("tournament_id", tournamentId)
      .eq("player_1_id", requester?.id ?? "");
    expect(teams?.map((team) => team.category_id).sort()).toEqual([ms.id, md2.id].sort());
    expect(teams?.find((team) => team.category_id === ms.id)?.player_2_id).toBeNull();
    expect(teams?.find((team) => team.category_id === md2.id)?.player_2_id).toBe(partner?.[0]?.id);

    // And the requester gained no management right.
    const editorRow = await roster
      .from("tournament_editors")
      .select("tournament_id")
      .eq("tournament_id", tournamentId)
      .eq("profile_id", applicant.profileId);
    expect(editorRow.data).toEqual([]);
    const refusedWrite = await expectRefused(() =>
      applicant.client.rpc("save_tournament_days", {
        p_tournament_id: tournamentId,
        p_days: [],
      } as never),
    );
    expect(refusedWrite.message).toMatch(/not authorized/i);
  }, 120_000);

  it("lets the requester read their own contact row and nobody uninvolved", async () => {
    const { data: requester } = await roster
      .from("players")
      .select("id")
      .eq("profile_id", applicant.profileId)
      .single();
    const playerId = requester?.id ?? "";

    // The player reads their own row, and the tournament they have entered reads it too -
    // membership comes from the entry, not from a roster grant.
    expect((await applicant.client.from("players").select("id, email").eq("id", playerId)).data).toHaveLength(1);
    expect((await owner.client.from("players").select("id, email").eq("id", playerId)).data).toHaveLength(1);
    // An unrelated signed-in user reads nothing, because they are in no entry of this
    // player's.
    expect((await outsider.client.from("players").select("id, email").eq("id", playerId)).data).toEqual([]);
  }, 120_000);

  it("reuses one unambiguous unlinked partner, and never reuses a linked row", async () => {
    // A partner who holds an account: give them a linked row through their own approved
    // request, so the row the deduplication must refuse to touch actually exists.
    const own = await linkedPartner.client.rpc("submit_tournament_registration", {
      p_tournament_id: tournamentId,
      p_entries: [entry(ms.id)],
    } as never);
    expect(own.error).toBeNull();
    const approved = await owner.client.rpc("decide_tournament_registration", {
      p_registration_id: own.data as unknown as string,
      p_decision: "approved",
    } as never);
    expect(approved.error).toBeNull();
    const { data: linkedRow } = await roster
      .from("players")
      .select("id, profile_id")
      .eq("profile_id", linkedPartner.profileId)
      .single();
    expect(linkedRow?.profile_id).toBe(linkedPartner.profileId);

    // One request that exercises both halves of the deduplication rule: the seeded single
    // unlinked row is reused, and the linked row is not a candidate.
    const submitted = await applicant2.client.rpc("submit_tournament_registration", {
      p_tournament_id: tournamentId,
      p_entries: [
        entry(md2.id, { name: "Reused", email: reuseEmail }),
        entry(md3.id, { name: "Account Holder", email: linkedPartner.email }),
        entry(ws.id),
      ],
    } as never);
    expect(submitted.error).toBeNull();
    const decided = await owner.client.rpc("decide_tournament_registration", {
      p_registration_id: submitted.data as unknown as string,
      p_decision: "approved",
    } as never);
    expect(decided.error).toBeNull();

    const { data: requester } = await roster
      .from("players")
      .select("id")
      .eq("profile_id", applicant2.profileId)
      .single();
    const { data: teams } = await roster
      .from("teams")
      .select("category_id, player_2_id")
      .eq("tournament_id", tournamentId)
      .eq("player_1_id", requester?.id ?? "");

    // The reused row is the seeded one, not a fresh duplicate.
    const { data: reused } = await roster.from("players").select("id").eq("email", reuseEmail);
    expect(reused).toHaveLength(1);
    expect(teams?.find((team) => team.category_id === md2.id)?.player_2_id).toBe(reused?.[0]?.id);

    // The account holder's linked row was left alone, and a fresh unlinked row was made.
    const stillLinked = await roster
      .from("players")
      .select("profile_id")
      .eq("id", linkedRow?.id ?? "")
      .single();
    expect(stillLinked.data?.profile_id).toBe(linkedPartner.profileId);

    const { data: partnerRows } = await roster
      .from("players")
      .select("id, profile_id")
      .eq("email", linkedPartner.email);
    expect(partnerRows).toHaveLength(2);
    const freshRow = partnerRows?.find((row) => row.profile_id === null);
    expect(freshRow).toBeTruthy();
    expect(teams?.find((team) => team.category_id === md3.id)?.player_2_id).toBe(freshRow?.id);

    // And the account holder gains no read of the partner row that carries their address.
    expect((await linkedPartner.client.from("players").select("id, email").eq("id", freshRow?.id ?? "")).data).toEqual([]);
  }, 180_000);

  it("creates a fresh unlinked row rather than guessing between two matches", async () => {
    const submitted = await outsider.client.rpc("submit_tournament_registration", {
      p_tournament_id: tournamentId,
      p_entries: [entry(md2.id, { name: "Ambiguous", email: ambiguousEmail })],
    } as never);
    expect(submitted.error).toBeNull();
    const decided = await owner.client.rpc("decide_tournament_registration", {
      p_registration_id: submitted.data as unknown as string,
      p_decision: "approved",
    } as never);
    expect(decided.error).toBeNull();

    // Two seeded rows already match, so neither may be reused: a third, unlinked row is
    // created. A guess would be exactly the claim the rule exists to prevent.
    const { data: rows } = await roster
      .from("players")
      .select("id, profile_id")
      .eq("email", ambiguousEmail);
    expect(rows).toHaveLength(3);
    expect(rows?.filter((row) => row.profile_id === null)).toHaveLength(3);

    const { data: requester } = await roster
      .from("players")
      .select("id")
      .eq("profile_id", outsider.profileId)
      .single();
    const { data: team } = await roster
      .from("teams")
      .select("player_2_id")
      .eq("tournament_id", tournamentId)
      .eq("category_id", md2.id)
      .eq("player_1_id", requester?.id ?? "")
      .single();
    expect(team?.player_2_id).toBeTruthy();
    expect(rows?.some((row) => row.id === team?.player_2_id)).toBe(true);
  }, 120_000);

  it("refuses a mixed event whose genders are not recorded, and creates nothing", async () => {
    // `enforce_team_shape` is the final word for a mixed pair: it requires both players'
    // recorded genders to prove the pair is genuinely mixed, and nothing a registration
    // request carries can supply them - a partner is a name and an email by design, and a
    // profile has no gender column. So the approval is refused, and the refusal rolls the
    // whole bridge back rather than leaving the requester's player row standing.
    const submitted = await mixedApplicant.client.rpc("submit_tournament_registration", {
      p_tournament_id: tournamentId,
      p_entries: [
        entry(xd.id, {
          name: "Mixed Partner",
          email: `itest-mixed-${Date.now().toString(36)}@tournova.test`,
        }),
      ],
    } as never);
    expect(submitted.error).toBeNull();
    const requestId = submitted.data as unknown as string;

    const refused = await expectRefused(() =>
      owner.client.rpc("decide_tournament_registration", {
        p_registration_id: requestId,
        p_decision: "approved",
      } as never),
    );
    expect(refused.message).toMatch(/genders recorded/i);

    const stillPending = await roster
      .from("tournament_registrations")
      .select("status")
      .eq("id", requestId)
      .single();
    expect(stillPending.data?.status).toBe("pending");
    const requesterRows = await roster
      .from("players")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", mixedApplicant.profileId);
    expect(requesterRows.count).toBe(0);
    const teams = await roster
      .from("teams")
      .select("id", { count: "exact", head: true })
      .eq("category_id", xd.id);
    expect(teams.count).toBe(0);
  }, 120_000);

  it("refuses to decide the same request twice", async () => {
    const { data: approved } = await roster
      .from("tournament_registrations")
      .select("id")
      .eq("profile_id", applicant.profileId)
      .eq("status", "approved")
      .single();

    const again = await expectRefused(() =>
      owner.client.rpc("decide_tournament_registration", {
        p_registration_id: approved?.id ?? "",
        p_decision: "rejected",
      } as never),
    );
    expect(again.message).toMatch(/already been decided/i);
  });

  // ---------------------------------------------------------------------------
  // Withdrawal and re-application
  // ---------------------------------------------------------------------------

  it("refuses to replace an approved request and preserves its entries", async () => {
    const approved = await roster.from("tournament_registrations")
      .select("id").eq("profile_id", applicant.profileId).eq("status", "approved").single();
    expect(approved.error).toBeNull();
    const requestId = approved.data!.id;
    const before = await roster.from("tournament_registration_entries")
      .select("id, category_id, partner_name, partner_email").eq("registration_id", requestId).order("id");
    expect(before.error).toBeNull();
    expect(before.data?.length).toBeGreaterThan(0);
    const refusal = await expectRefused(() => applicant.client.rpc("submit_tournament_registration", {
      p_tournament_id: tournamentId,
      p_entries: [entry(ws.id)],
    } as never));
    expect(refusal.message).toMatch(/already been decided/i);
    const after = await roster.from("tournament_registration_entries")
      .select("id, category_id, partner_name, partner_email").eq("registration_id", requestId).order("id");
    expect(after.error).toBeNull();
    expect(after.data).toEqual(before.data);
  });

  it("withdraws a pending request and its entries, and refuses everybody else", async () => {
    const submitted = await withdrawer.client.rpc("submit_tournament_registration", {
      p_tournament_id: tournamentId,
      p_entries: [entry(ws.id)],
    } as never);
    expect(submitted.error).toBeNull();
    const requestId = submitted.data as unknown as string;

    // Another person's request is not the caller's to delete, even though they are signed
    // in and the request is pending.
    const refused = await expectRefused(() =>
      outsider.client.rpc("withdraw_tournament_registration", { p_registration_id: requestId } as never),
    );
    expect(refused.message).toMatch(/not authorized/i);

    const withdrawn = await withdrawer.client.rpc("withdraw_tournament_registration", {
      p_registration_id: requestId,
    } as never);
    expect(withdrawn.error).toBeNull();

    // The request and its entries are gone, and nothing else was touched: no player row was
    // created, because only an approval creates one.
    const { data: requests } = await roster
      .from("tournament_registrations")
      .select("id")
      .eq("id", requestId);
    expect(requests).toEqual([]);
    const { data: entries } = await roster
      .from("tournament_registration_entries")
      .select("id")
      .eq("registration_id", requestId);
    expect(entries).toEqual([]);
    const requesterRows = await roster
      .from("players")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", withdrawer.profileId);
    expect(requesterRows.count).toBe(0);
  }, 120_000);

  it("makes a rejection re-appliable, and shows the participant what was decided", async () => {
    const first = await withdrawer.client.rpc("submit_tournament_registration", {
      p_tournament_id: tournamentId,
      p_entries: [entry(ws.id)],
    } as never);
    expect(first.error).toBeNull();
    const firstId = first.data as unknown as string;

    const rejected = await owner.client.rpc("decide_tournament_registration", {
      p_registration_id: firstId,
      p_decision: "rejected",
      p_note: "not this time",
    } as never);
    expect(rejected.error).toBeNull();

    // A decided request is terminal, so its own withdrawal is refused too.
    const tooLate = await expectRefused(() =>
      withdrawer.client.rpc("withdraw_tournament_registration", { p_registration_id: firstId } as never),
    );
    expect(tooLate.message).toMatch(/already been decided/i);

    // A rejection leaves the live-request index, so applying again is a *new* request
    // rather than the rejected row handed back.
    const second = await withdrawer.client.rpc("submit_tournament_registration", {
      p_tournament_id: tournamentId,
      p_entries: [entry(ws.id)],
    } as never);
    expect(second.error).toBeNull();
    const secondId = second.data as unknown as string;
    expect(secondId).not.toBe(firstId);

    // The participant's panel reads the live request, not the older rejection.
    const mine = await withdrawer.client.rpc("my_tournament_registration", {
      p_tournament_id: tournamentId,
    } as never);
    expect(mine.error).toBeNull();
    const mineRows = mine.data as unknown as { registration_id: string; status: string; category_code: string }[];
    expect(mineRows).toHaveLength(1);
    expect(mineRows[0]).toMatchObject({ registration_id: secondId, status: "pending", category_code: "WS" });

    // The reviewer's read shows both, and carries the entries' shape.
    const review = await owner.client.rpc("review_tournament_registrations", {
      p_tournament_id: tournamentId,
    } as never);
    expect(review.error).toBeNull();
    const reviewRows = review.data as unknown as {
      registration_id: string;
      status: string;
      profile_id: string;
      category_code: string;
    }[];
    const theirs = reviewRows.filter((row) => row.profile_id === withdrawer.profileId);
    expect(theirs.map((row) => row.status).sort()).toEqual(["pending", "rejected"]);
    expect(theirs.map((row) => row.registration_id)).toEqual(expect.arrayContaining([firstId, secondId]));
    expect(theirs.every((row) => row.category_code === "WS")).toBe(true);
  }, 120_000);

  it("answers started and completed once the lifecycle has moved, and refuses the submission", async () => {
    // Last, because the lifecycle is the one thing this file cannot move back.
    await forceStatus(windowOtherId, "in_progress");
    const started = await outsider.client.rpc("tournament_registration_state", {
      p_tournament_id: windowOtherId,
    } as never);
    expect(started.data).toBe("started");

    await forceStatus(windowOtherId, "completed");
    const completed = await outsider.client.rpc("tournament_registration_state", {
      p_tournament_id: windowOtherId,
    } as never);
    expect(completed.data).toBe("completed");

    const refused = await expectRefused(() =>
      outsider.client.rpc("submit_tournament_registration", {
        p_tournament_id: windowOtherId,
        p_entries: [entry(otherMs.id)],
      } as never),
    );
    expect(refused.message).toMatch(/closed|completed/i);
  }, 120_000);
});
