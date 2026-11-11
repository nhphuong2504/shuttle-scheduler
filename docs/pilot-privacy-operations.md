# US pilot privacy operations

Owner: Phuong Nguyen. Requests: nhphuong@iastate.edu. These are prelaunch
operating instructions, not a legal opinion or evidence that deployment is approved.

## Release scope and limits

- Adults 18+ may create accounts after acknowledging the current draft Terms and
  Privacy notice. This is self-attestation, not verified age or parental consent.
- No child accounts or child self-service registration. An adult organiser may enter
  a child after arranging appropriate parental authority and notice. Use an adult's
  contact details. The participant request form is for an adult entering themselves;
  it must not be repurposed to link a parent's account to a child's identity.
- Real tournament spectators, including unrelated signed-in users, receive generated
  player labels and no gender through `tournament_players`. Editors/admins receive names
  for operations. Fictional demo tournaments keep names. With no reliable age inventory,
  this applies to all real players, not only presumed children. Participation, UUIDs,
  event categories and schedules remain public; this is not anonymisation.
- Search is limited to players already entered in the target tournament. A newly
  created walk-in is selected immediately; add their entry before leaving the page.
  Do not rebuild a platform-wide directory to recover an unentered walk-in.
- No publishing opt-in or full verifiable parental-consent system is implemented.
  Never describe an organiser's checkbox as legally verified parental consent.
- Existing accounts are not retroactively marked adult or accepted. Before pilot
  access, inventory existing holders, confirm adult eligibility and provide current
  draft policies. Stop child account use and handle it as a privacy request. Automatic
  re-acceptance gating of existing accounts is not included in this phase.

## Before public deployment

The website policies are expressly labelled pilot drafts. Do not remove that label
or represent this checkout as legal clearance. The owner must confirm these facts:

- This contact inbox is monitored; publishing the supplied email/name is intentional.
  The university email does not imply university ownership or endorsement.
- Inspect actual Supabase/Cloudflare regions, access logs, backup expiry, subprocessors
  and contracts. Root configuration was not read out or changed to test hosted systems.
- Set a retention schedule for accounts, registration requests, entrants, audit records,
  backups and this mailbox. Record actual periods before making fixed deletion promises.
  Assign a monthly manual review until retention is automated; keep only justified data.
- Review existing real entries, duplicates and public free text. Aliases cannot redact
  a real name written in tournament titles, descriptions, venue fields or external copies.
- Audit assets/dependency notices, the Tournova name, transactional email templates,
  domain/redirect configuration, abuse controls and provider access. No trademark
  clearance or licence certification has been completed by this implementation.
- Get appropriately qualified help for the remaining COPPA/minor contract/waiver and
  state-law questions if needed. The engineering controls do not resolve those questions.

Apply both new migrations in order with the normal deployment procedure only after
review. The second removes every provisioning exception. No hosted migration or deploy
is authorised merely by a passing local test.

## Requests without an account

1. Monitor the inbox and record a request id, date, requested action and affected
   tournament/player/account. Keep sensitive material out of Git and application logs.
2. Ask only enough to verify the person or their authority. For a child, verify the
   adult's relationship proportionately. Do not routinely request IDs or exact DOB.
3. Assess immediate exposure. Public player labels already restrict name disclosure;
   review public free text, files and external shares too. Do not assume deleting the
   login removes any of them.
4. Find all linked and unlinked player rows, partner/request entries, profile and auth
   records across affected events. Email deduplicates; it does not establish authority.
   Preserve event integrity and other people's records. Evaluate de-identification of
   names/contact details separately from deleting match facts.
5. Use a reviewed, narrowly scoped privileged procedure with an identified target and
   dry-run preview. Never delete a whole tournament just to remove one player's identity.
   Some historical request guards need a specifically reviewed support path; there is
   no general erasure RPC in this phase. Escalate rather than bypassing guards or
   marking a blocked request complete.
6. Record what was changed, what remains and why, relevant deadlines, backup handling
   and the reply. Do not claim all copies disappeared. Retain minimal evidence needed
   to handle the request, with its own justified retention period.

Manual processing is supported through the contact route, but staffing, identity review
and privileged data changes remain the operator's job. Do not promise automatic erasure.

## Accounts and recovery

Acceptance records use server timestamps, contain no IP/email/DOB and are not editable
by a client. Removing an auth identity cascades its acceptance record, but preserves
the existing profile/roster recovery seam. This is not a personal-data erasure mechanism.

New auth identities require the current adult/Terms acknowledgement even through the
Auth admin API. `scripts/create-staff-login.mjs` must not manufacture acceptance or add
a bypass: its account-creation path will be refused without acknowledgement. For an
account recreation, the real adult holder signs up through `/auth` using their verified
email, and the existing profile re-links under its normal safeguards. Verify this
recovery path and email-confirmation settings before rollout. Existing identities can
continue to sign in; access is never granted merely because Terms were accepted.

## Security incident

Owner coordinates response: identify affected services and data; restrict exposure,
revoke compromised access, preserve necessary evidence without copying secrets into
Git; contact providers; determine affected residents and applicable notification rules;
document decisions; repair and verify permissions before restoring access. Do not use
a universal US notification deadline or assume a names-only exposure is harmless.

## Verification

Real local integration must cover missing/false/obsolete acknowledgement, metadata
forgery, client writes to acceptance evidence, cross-user reads, profile recovery,
spectator versus operator names, withdrawn entrants, demo names and cross-tournament
search. Browser tests cover adult-first signup, terms payload, links, keyboard operation,
mobile overflow and axe checks. Full `agent:verify` plus integration is required.
Neither browser transport mocks nor successful builds prove legal compliance.
