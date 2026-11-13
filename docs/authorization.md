# Authorization: current contract and reading map

This is the short current contract. Exact predicate definitions, classified RPC lists,
exceptions and recovery semantics live in the linked detail sections; consult those
before changing the corresponding behavior. Do not derive authority from participation.

## Access and lifecycle

| Question | Contract | Exact details |
| --- | --- | --- |
| Platform identity | `admin` or `user`; admin override does not create tournament membership | [Two axes](reference/authorization.md#1-the-two-axes) |
| Tournament access | Owner/editor may operate; only owner/admin manage editors or delete; everyone else reads | [Predicates](reference/authorization.md#2-the-predicates) |
| Participation | Registration and approval confer no operating rights | [Registration](reference/authorization.md#6-registration) |
| Lifecycle | `upcoming → in_progress → completed`; start follows the first match; completion is explicit | [Lifecycle](reference/authorization.md#3-lifecycle) |
| Mutations | Separate who-may-act and when-valid checks; browser booleans only control rendering | [Classified guards](reference/authorization.md#4-lifecycle-guards-and-the-classified-mutation-list) |

The configurable guard permits upcoming only; live permits in-progress only. Neither
has an admin bypass. Writable permits non-completed events plus named admin repair paths;
it does not make completed events playable or scoreable. Match start has its own guard:
not completed, and no earlier than the venue window. Start/completion locking remains
transactional. Current tournament is a per-profile pointer, never a global active event.

## Read only the details your change needs

- Guard, role, membership or RPC changes: [predicates](reference/authorization.md#2-the-predicates)
  and the entire [guard classification](reference/authorization.md#4-lifecycle-guards-and-the-classified-mutation-list),
  including deliberately unguarded operations and the two asymmetries.
- Submission, withdrawal, approval or capacity: [registration](reference/authorization.md#6-registration).
  The server decides readiness/window/caps and keeps submission/approval atomic. Approval
  is the identity/entry bridge; a rejected request may be filed again.
- Player/contact changes: [players and links](reference/authorization.md#7-players-contact-data-and-the-request-entries).
  Relationships use profile ids, not auth identities. Email deduplicates, never identifies
  or authorizes; partner rows do not become claimed accounts by being named in a request.
- Readiness/configuration: [readiness](reference/authorization.md#5-readiness-and-why-it-must-not-depend-on-participation).
- Direct table writes: [column privileges](reference/authorization.md#8-column-privileges-and-how-status-is-kept-out-of-reach).
  Membership and protected placement writes remain RPC-only; keep explicit grants and RLS.
- Recovery/account recreation: [recovery seam](reference/authorization.md#9-profile-identity-and-the-recovery-seam).
- Notifications: [match calls](reference/authorization.md#12-in-app-match-calls).
- Any policy edit: [change procedure](reference/authorization.md#11-changing-any-of-this)
  and [known debt](reference/authorization.md#10-known-debt), so unresolved gaps are not mistaken for authorization.

Source: `src/lib/auth/authorization.ts`, `src/hooks/useSession.ts`, RPC callers and SQL
migrations. Verify with the full gate plus real local authorization/registration/realtime
integration. Mocked Playwright requests cannot validate backend permissions.

## Pilot privacy defaults

`20261111000000_pilot_privacy.sql` and `20261111010000_pilot_provisioning.sql`
originally added server-recorded adult/Terms acknowledgement on new Auth identities.
`20261113000000_account_age_policy.sql` introduced a teen declaration contract;
`20261113010000_adult_account_policy.sql` supersedes it with adult-only accounts and
`20261113020000_policy_version_one.sql` sets the current Terms version to `1.0`,
with no provisioning bypass. Historical evidence
is preserved, not relabelled as adult assent. Tournament participation remains open
to all ages subject to each event's rules; authorised adult organisers enter minors
with parental permission and adult contact details. Existing identities are not
retroactively marked accepted.
`tournament_players` returns generated labels/no gender for non-operators of real
tournaments, including withdrawn entries; demo names remain fictional. `search_players`
is limited to entries in its specified tournament. These controls do not verify age,
parental authority or anonymity and never grant operating rights. See
[pilot operations](pilot-privacy-operations.md) for existing-account review, data requests,
remaining release work and the acknowledged account-recreation path.

## Existing section links

Old section anchors remain below as reading links. The detailed reference preserves the
original complete content and headings; this overview is not a replacement for exceptions.

<a id="authorization"></a> [Authorization](reference/authorization.md#authorization)

<a id="1-the-two-axes"></a> [1. The two axes](reference/authorization.md#1-the-two-axes)

<a id="platform-role-is-override-not-membership"></a> [Platform role is override, not membership](reference/authorization.md#platform-role-is-override-not-membership)

<a id="tournament-access"></a> [Tournament access](reference/authorization.md#tournament-access)

<a id="registration-never-confers-management"></a> [Registration never confers management](reference/authorization.md#registration-never-confers-management)

<a id="2-the-predicates"></a> [2. The predicates](reference/authorization.md#2-the-predicates)

<a id="the-player-pair-one-read-one-create"></a> [The player pair: one read, one create](reference/authorization.md#the-player-pair-one-read-one-create)

<a id="internal-helpers-are-not-callable"></a> [Internal helpers are not callable](reference/authorization.md#internal-helpers-are-not-callable)

<a id="the-two-axis-contract"></a> [The two-axis contract](reference/authorization.md#the-two-axis-contract)

<a id="3-lifecycle"></a> [3. Lifecycle](reference/authorization.md#3-lifecycle)

<a id="the-window-and-the-playing-days-inside-it"></a> [The window, and the playing days inside it](reference/authorization.md#the-window-and-the-playing-days-inside-it)

<a id="4-lifecycle-guards-and-the-classified-mutation-list"></a> [4. Lifecycle guards, and the classified mutation list](reference/authorization.md#4-lifecycle-guards-and-the-classified-mutation-list)

<a id="upcoming-only--assert_tournament_configurable"></a> [`upcoming` only — `assert_tournament_configurable`](reference/authorization.md#upcoming-only--assert_tournament_configurable)

<a id="in_progress-only--assert_tournament_live"></a> [`in_progress` only — `assert_tournament_live`](reference/authorization.md#in_progress-only--assert_tournament_live)

<a id="starting-a-match--assert_tournament_can_start_match"></a> [Starting a match — `assert_tournament_can_start_match`](reference/authorization.md#starting-a-match--assert_tournament_can_start_match)

<a id="any-state-except-completed--assert_tournament_writable"></a> [Any state except `completed` — `assert_tournament_writable`](reference/authorization.md#any-state-except-completed--assert_tournament_writable)

<a id="two-asymmetries-that-look-like-mistakes-and-are-not"></a> [Two asymmetries that look like mistakes and are not](reference/authorization.md#two-asymmetries-that-look-like-mistakes-and-are-not)

<a id="deliberately-unguarded-by-lifecycle"></a> [Deliberately unguarded by lifecycle](reference/authorization.md#deliberately-unguarded-by-lifecycle)

<a id="5-readiness-and-why-it-must-not-depend-on-participation"></a> [5. Readiness, and why it must not depend on participation](reference/authorization.md#5-readiness-and-why-it-must-not-depend-on-participation)

<a id="6-registration"></a> [6. Registration](reference/authorization.md#6-registration)

<a id="the-window-as-one-word"></a> [The window as one word](reference/authorization.md#the-window-as-one-word)

<a id="submitting"></a> [Submitting](reference/authorization.md#submitting)

<a id="deciding-and-the-identity-bridge"></a> [Deciding, and the identity bridge](reference/authorization.md#deciding-and-the-identity-bridge)

<a id="one-live-request-and-re-application"></a> [One live request, and re-application](reference/authorization.md#one-live-request-and-re-application)

<a id="7-players-contact-data-and-the-request-entries"></a> [7. Players, contact data, and the request entries](reference/authorization.md#7-players-contact-data-and-the-request-entries)

<a id="the-link-and-the-three-mechanisms-that-keep-it"></a> [The link, and the three mechanisms that keep it](reference/authorization.md#the-link-and-the-three-mechanisms-that-keep-it)

<a id="who-may-do-what-to-a-player-row"></a> [Who may do what to a player row](reference/authorization.md#who-may-do-what-to-a-player-row)

<a id="the-request-entries"></a> [The request entries](reference/authorization.md#the-request-entries)

<a id="8-column-privileges-and-how-status-is-kept-out-of-reach"></a> [8. Column privileges, and how `status` is kept out of reach](reference/authorization.md#8-column-privileges-and-how-status-is-kept-out-of-reach)

<a id="9-profile-identity-and-the-recovery-seam"></a> [9. Profile identity, and the recovery seam](reference/authorization.md#9-profile-identity-and-the-recovery-seam)

<a id="10-known-debt"></a> [10. Known debt](reference/authorization.md#10-known-debt)

<a id="11-changing-any-of-this"></a> [11. Changing any of this](reference/authorization.md#11-changing-any-of-this)

<a id="12-in-app-match-calls"></a> [12. In-app match calls](reference/authorization.md#12-in-app-match-calls)
