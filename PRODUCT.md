# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Organisers** of court-based match tournaments of any size: a club night on a few courts, a
  company or community event, up to multi-day tournaments with many courts and events.
  They plan the whole tournament in the weeks before, then need the day to stay under
  control.
- **Moderators** who run every court for one playing day from a single desk, often on
  imperfect venue wifi.
- **Players and spectators** who want to know where they play next, what is on court now,
  and where their registration stands, usually on a phone at the venue.

Organisers and players matter equally to the public landing page.

## Product Purpose

Tournova turns a chaotic, unpredictable tournament into one the organiser controls and
where everyone knows what happens next. Success is a day that runs on time in the
organiser's eyes and is legible to every player and spectator.

## Sport scope

Badminton is where the product started and what its rules engine was built around, but
Tournova is positioned as sport-neutral: any tournament played as timed matches across
several courts (racket sports such as pickleball, table tennis or tennis are the likely
neighbours; the outer boundary is undecided). Public surfaces name no specific sport, and
their visual language must not depend on one sport's equipment or court markings, so
widening support later needs no redesign. Configurable scoring (points per game, win-by,
games per match) already covers rally-scored games; set-based scoring such as tennis is
not supported today and must not be claimed.

## Positioning

The schedule keeps up with reality: when a match runs late, the rest of the day reflows
while still protecting player rest, and every screen (desk, players, spectators) sees the
same live state. Planning (Schedule) and running the day (Desk) are separate views for
separate jobs.

## Operating Context

- Organiser plans on **Schedule**: registration, requests, draws, play days, courts.
- Moderator runs the day on **Desk**: every court, the next match, scores, delays.
- Participants register from the tournament page, choose events, name a partner, and
  read their own request status (Awaiting decision, Approved, Not accepted, with the
  organisers' note). Approval grants no operating rights.
- The court board is public; anyone can follow without an account.
- Editors are added under Access.

## Capabilities and Constraints

- Free: anyone can create a tournament.
- Formats and rules are defined in `docs/tournament-format.md`; landing claims must match it.
- Terminology on screen: Desk, Schedule, court board, events, draws, play days. Prefer
  sport-neutral words (court, match, game, player) on public surfaces.
- English-only interface today.
- The landing page claims only real behaviour: its reflow and rest wording must stay in
  step with the product when either changes.

## Evidence on Hand

None beyond the product itself: no named customer tournaments, photos, testimonials,
usage numbers or press. Future work must not invent any of these. Demonstration data
(synthetic courts, players, timings) is allowed when it reflects real product behaviour.

## Product Principles

1. Control for the organiser, clarity for everyone else.
2. Show the product working rather than describing it.
3. One job per view: forecasts stay with the organiser, operational noise stays on Desk.
4. Built for the venue: phones, poor wifi, people in a hurry.
5. Never claim what the product does not do.

## Accessibility & Inclusion

Accessibility checks are required on every surface (see `docs/design-principles.md`).
