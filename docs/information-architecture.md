# Information architecture

The URL scheme, the shells, and the flows between them. Phase 2 gave every operational
surface its final, tournament-scoped address and added the public and participant surfaces
around it; this is the map of that shape, so a link, a redirect or a nav entry is written
against the scheme rather than against a path somebody remembered.

Authorization is a separate question and lives in [`authorization.md`](authorization.md).
This document is about *where* a thing is, not *who* may see it — although the two meet at one
point, so that point is stated below.

## 1. Who the addresses are for

Three audiences, and the address says which one it belongs to:

- **Anyone** (visitor or signed in) — the front door, Explore, a tournament's public page.
- **An operator** (owner or editor of one tournament) — the Desk and the other scoped
  surfaces, all under that tournament's id.
- **A participant** (any signed-in person) — the Register panel on a tournament's page, and
  their own request's status. Participation grants nothing else.

## 2. The address scheme

### Public, non-scoped

| Address | Surface |
| --- | --- |
| `/` | Landing for a visitor (the Desk, the schedule behind it, and the ways in: run a tournament, browse, sign in); Home for a signed-in caller (their tournaments, a Continue card for their working pointer, a discover strip) |
| `/explore` | Every tournament, searchable over name, venue and event, with a status filter |
| `/me/tournaments` | The caller's own: **Owned by me** and **Shared with me**. A visitor is sent to `/auth` first, as on the create flow |
| `/tournaments/new` | The create flow — the same four-step wizard Setup hosts, held in the browser until the last step creates the tournament in one call. A visitor is sent to `/auth` first, carrying this address back and the `create` errand, rather than being shown a form whose submit the database would refuse |
| `/auth` | Sign in / sign up. Accepts a validated `redirect` search param and returns there |
| `/tournaments/$tournamentId/` | One tournament's participant page: the card, and the Register panel. Reached from **Register** on an Explore card — which is the one action on that card that leads here rather than into the read-only workspace — and from the public-nav sweeps. Explore's reading trip opens a card in the read-only workspace instead (see `readerHomeFor` below), so a visitor who only came to read never sees this page |

These are the only addresses that can be reached without naming a tournament. Each draws
`PublicShell`, because there is no tournament for a header to describe. `/tournaments/new` is a
sibling of `$tournamentId`, not a child, precisely because creating a tournament happens before
there is one to be inside.

Two of them are gated before they draw anything, because both are somebody's own work:
`/me/tournaments`, and the create flow at `/tournaments/new` — which the database refuses outright
for an anonymous caller. A caller with no session arriving at either is sent to `/auth` with the
address they came from, rather than shown a sentence about a page they cannot use, and the two are
one arrangement ([`useSignInRedirect`](../src/hooks/useSignInRedirect.ts)) rather than two that
agree.

Reading a tournament begins where [`readerHomeFor`](../src/lib/tournament/reader-home.ts) says:
`…/entries` while the tournament is upcoming, because there are no scores yet and the question is
who is playing, and `…/scores` once it is in progress or completed, because a reader comes to find
a match and its result. It reads the stored status, not the clock, so the server and the browser
agree. A card in `/explore` and the workspace logo both link there (see [The shells](#3-the-shells)).

### Tournament-scoped

Everything below lives under `/tournaments/$tournamentId/`, and the layout route
(`route.tsx`) resolves the id once, 404s an unknown one, resolves the caller's access, and
mounts `WorkspaceShell` around the child page.

| Address | Surface | Audience |
| --- | --- | --- |
| `…/desk` | The Desk: one day, every court, live. Read-only board for a caller without `can_edit` | Operator (full), anyone (read-only) |
| `…/entries` | Who is in the tournament, and the walk-in roster | Operator |
| `…/registrations` | The queue of requests awaiting a decision, with a nav badge when work is waiting | Editor |
| `…/placement` | Seeding and the placement stage | Operator |
| `…/knockout` | The tier-draw brackets | Operator |
| `…/schedule` | Tournament-wide planning. One address for both engines: the route reads `tournament.format` and renders the placement scheduler or the day planner | Organiser |
| `…/scores` | Result entry | Operator |
| `…/settings` | Setting up a tournament that exists, hosted in the shared wizard: every step while it is upcoming, and only what can still change once it has started | Editor |
| `…/access` | Who else may operate this tournament | Editor |
| `…/pools`, `…/draws` | The legacy round-robin brackets, reachable by URL while a legacy tournament is read | Viewer |

The split between the Desk and the Schedule tab is a product rule, not a layout preference
(see [`../AGENTS.md`](../AGENTS.md)): the Desk is day-scoped and shows no tournament-wide
forecast, and the Schedule tab owns tournament-wide planning and is never rendered on the Desk.

### The flat legacy paths

Eight addresses shipped in Phase 1 without a tournament in them. They are bookmarks, so they
are kept — but each is a redirect rather than a page, and each resolves *on the caller's own
pointer* rather than on a fixed tournament:

| Legacy | Resolves to |
| --- | --- |
| `/setup` | `…/settings` |
| `/staff` | `…/access` |
| `/registration` | `…/entries` |
| `/placement` | `…/placement` |
| `/knockout` | `…/knockout` |
| `/schedule`, `/placement-schedule` | `…/schedule` |
| `/matches` | `…/scores` |

Each names a *section* from `lib/routing/workspace-redirect.ts` rather than a path, so the
workspace URL shape is written in one place. A redirect is a client-side component, not a
`beforeLoad`: a load-time redirect would run during server rendering, where there is no session
to read the pointer from, and would send a bookmark to whichever tournament the server's
request happened to resolve.

### No pointer

A caller with no working tournament — anonymous, or signed in and not yet choosing — resolves
every flat path to `/explore` through the one constant `NO_POINTER_FALLBACK`. It shipped as
`/auth` and flipped to `/explore` in the commit that created the route, which is why no caller
was edited when the destination changed. Someone with nothing to resume is better shown what
there is to work on than a sign-in form.

`/` is not a reader of that constant: it is a surface, and it renders its own two readings.

## 3. The shells

Two shells, and which one a page draws is decided by whether it is about one tournament.

- **`WorkspaceShell`** — mounted once, by the layout route. It draws the tournament header
  (name, lifecycle status, the section nav, and — for a caller who may edit — the workspace
  switcher) and the caller's access-aware actions. No page below it renders a shell of its own;
  a page composes `Page`, which puts a title row over the page's own content.
- **`PublicShell`** — drawn by each of the five public routes above, since no layout knows what
  to put in a header outside a tournament. It carries the public nav, which is one entry
  (**Browse tournaments**, at `/explore`): a bar a signed-out visitor reads should not be a
  list of the caller's own work, and what is left does not change with the session, so the row
  does not move once the session settles. `/me/tournaments` and `/tournaments/new` stay
  reachable from the pages that link them.

For a caller who may edit, `WorkspaceShell` also draws the **Next step** card
([`next-step.ts`](../src/lib/tournament/next-step.ts)) above the organiser pages - Registrations,
Entries, Placement, Schedule, Setup, Access - and never on the Desk, Scores, Knockout or the
participant page. It names the one step the order of work says is next, and points; it moves nothing.
Its last rung, **Complete tournament**, is answered by what has been played rather than by the
calendar: `tournament_completion_check` reports every match across the stages as settled, and the
card offers the act then. A tournament that finishes early is offered it early, and one whose last
day has gone with matches still unplayed is not - it can still be completed from Setup, where the
dialog says how many matches would stay unplayed.

The workspace nav is split by the edit right, not by the session. A caller who may edit gets
the operational six (`desk`, `entries`, `placement`, `knockout`, `schedule`, `scores`) plus the
three editor entries (`registrations`, `settings`, `access`). The editor entries are gated on
`can_edit`, because a nav entry that leads to a page saying no is a worse answer than not
offering the trip; the pages themselves still refuse, since the nav is presentation.

A read-only reader — a signed-in viewer or an anonymous visitor — gets the six operational
sections, **the Desk included, in a read-only form**. For a caller without `can_edit` the Desk
shows the day picker and the court board, and withholds every control that starts, scores or
moves a match; a court tile opens the match to read, not to run. The list is the operational one itself
rather than a restated copy, so a section added later is offered to everyone reading the
tournament by default. It is sorted into the reader's order - Scores, Schedule, Knockout, Entries,
Placement, Desk - because on a phone the row scrolls and the operator's order pushed the two
sections a reader came for off the screen; a section without a reader rank keeps its place after
the ranked ones. A read-only workspace opens where `readerHomeFor` says (the logo points there for
a reader, and at the Desk for an operator), and the tournament's participant page at
`/tournaments/$tournamentId/` is not part of that experience.

The header's own line — brand, then the tournament's name and status — carries one more entry
for a reader, and it follows the same split as the section nav. An operator gets the workspace
switcher beside the tournament name, because the tournaments they may work in are a list they hold and
moving between them is their own act. A reader gets **Browse tournaments** at `/explore`, in
the position `PublicShell` puts its public nav: immediately after the brand. It is the entry a
card came in by, and a reader who left the list should find the way back where they left it.
There is no create-tournament button in either case: starting a tournament is an operator's
act, and a header that offers no way to change this one should not offer a way to begin
another.

Both shells include a **Notifications** inbox in the signed-in account header,
available without a new address. It lists
only the caller's own match calls and links to the tournament's read-only Desk. Receiving
a call does not change the workspace nav or grant operator access. The participant can
read a call and mark it as read without choosing a working tournament.

## 4. The flows

### Finding a tournament

```mermaid
flowchart LR
  visitor["Visitor"] --> landing["/" ]
  landing --> explore["/explore"]
  explore --> card["/tournaments/:id/entries (upcoming)<br/>or /scores (in progress, completed)"]
  card --> sections["the read-only six:<br/>scores, schedule, knockout,<br/>entries, placement, desk"]
```

The participant page at `/tournaments/:id/` — the card and the Register panel — is no longer one
of the *reading* steps. Explore sends a card to the read-only workspace so the browse surface opens
on the event's state rather than on a form. It is still the destination of **Register**, which is
the one action on the card that means "I want to enter" rather than "I want to look": a signed-in
caller lands on the form, and a visitor is sent to sign in first, carrying this page as the place
to come back to.

Explore is the only search surface, and it renders one shape per row — `tournament_summary`,
which computes the status, the derived start and end, the registration state, the entry counts
and the caller's access level in the database rather than in the browser. The tournament card
on `/` and the create flow's list read the same function, so the three cannot disagree about
what a tournament is.

### Creating one

`/tournaments/new` hosts the same four-step wizard that Setup hosts
([`src/components/tournament-setup`](../src/components/tournament-setup)), against a tournament
that does not exist yet. Nothing is written until the last step: the answers live in the page
and in the browser's session storage, so a reload keeps them, and "Create tournament" makes the
tournament whole in one call, points the caller's working pointer at it, clears the stored
answers and goes to `…/registrations` (registration on) or `…/entries`, the
roster work that comes first, rather than to the participant page it just made. There is no draft row, so there is nothing for a
refresh to resume and no half-made tournament for anyone else to find. There is one wizard with
two hosts, and neither host owns the steps.

A visitor never sees the wizard. The address is the one operational surface a session is
required for *before* there is a tournament to hold a right in, so a caller with no session is
sent to `/auth` on arrival, with the router's `replace` so Back does not bounce through it
again. The trip carries this address as the return and `create` as the errand, which is what
lets the sign-in page say where the caller ends up — the same mechanism the Register button
uses, with a word of its own; see
[`src/lib/routing/redirect.ts`](../src/lib/routing/redirect.ts). The decision is made in the
page, once the session has settled, rather than in a `beforeLoad` guard: the session lives in
the browser and this app renders on the server first, so a load-time guard would read every
caller as signed out.

A new tournament can also start from a finished one: **Use as template** on a card in My
Tournaments writes a draft ([`clone.ts`](../src/components/tournament-setup/clone.ts)) into the same
browser storage the wizard already reads, and opens `/tournaments/new`. It keeps the venue,
organiser, events and caps, moves the name and dates a year on, and leaves the registration window
to its defaults. Players, entries, courts and the schedule are not copied, and nothing is created
until the last step, as for any other new tournament.

When a tournament is completed, Setup's Review step shows a wrap-up
([`WrapUp.tsx`](../src/components/tournament-setup/WrapUp.tsx)): the champions, a count of what was
played, a link to the results, and a CSV of every match
([`results-export.ts`](../src/lib/tournament/results-export.ts)).

### Working in one

The working tournament is per user: `profiles.current_tournament_id`, written by
`set_current_tournament`, and the workspace switcher moves it. There are exactly three acts
that write it — creating a tournament, choosing one from My Tournaments, and the switcher — and
they all go through the one action module.

There is no global active tournament. Phase 1's `is_active` pointer and its
`set_active_tournament` verb were retired, and many tournaments may be `upcoming` or
`in_progress` at once.

### Signing in

`/auth` accepts a `redirect` search param, validated to a local path, and returns there after
sign-in or sign-up. Every sign-in affordance on a page that needs a session carries the page's
own address as that param, so a person who signs in from a Register button lands on the
tournament they were reading rather than on the front door.

### Registering as a participant

```mermaid
flowchart TD
  open["Register panel on /tournaments/:id/"] --> state{"tournament_registration_state"}
  state -->|"open"| submit["submit_tournament_registration(id, entries)"]
  state -->|"not_offered / opens_soon / closed / started / completed / not_ready"| words["The state, in words"]
  submit --> pending["pending request, with its entries"]
  pending -->|"requester, while pending"| withdraw["withdraw_tournament_registration(id)"]
  pending -->|"editor"| decide["decide_tournament_registration(id, decision, note)"]
  decide -->|"approved"| entrant["players + teams created"]
  decide -->|"rejected"| rejected["terminal; a new request may be filed"]
```

A request names one or more categories, and a pair entry names a partner by name and email. The
Register button and its copy read `tournament_registration_state`, which computes the window in
the same order and from the same predicates the RPC uses, so the button and the RPC cannot
disagree. The RPC re-checks everything anyway — the read is a read.

### Deciding a request

`/tournaments/:id/registrations` is the editor's queue: the pending requests with their entries,
approve or reject with a note, and the capacity shown as it will be at approval. Approving runs
the identity bridge in one transaction — the requester's player row is linked (or created), each
named partner is matched to an unlinked row or created, the caps are turned into a sentence, and
the `teams` rows are written. Being approved grants no management right.

The operator surface that lists who is *already* in the tournament is `/tournaments/:id/entries`,
which is a different page. The two names are deliberate: "Registrations" is the queue of
requests, "Entries" is the roster.

## 5. The rules that hold across the scheme

- **One definition per address.** The Desk exists in exactly one file; `/` is defined by
  `routes/index.tsx` alone; the two scheduling views share one format-aware route rather than
  two nav targets.
- **A shipped link resolves.** Every literal `to=` target is checked against the router's own
  generated route ids, so a link to an address with no route fails the unit suite rather than a
  click.
- **Nothing global decides where you are.** No default tournament, no server-side pointer read,
  no redirect that happens before the session is known.

## 6. Changing any of this

The URL scheme is asserted in [`src/routes/-surfaces.test.ts`](../src/routes/-surfaces.test.ts)
— the shells each page draws, the flat paths' redirects, the single definition of the Desk and
of `/`, and the `NO_POINTER_FALLBACK` constant. A new address means that file, the workspace nav
in [`src/components/app-shell.tsx`](../src/components/app-shell.tsx), and this document, in the
same change.
