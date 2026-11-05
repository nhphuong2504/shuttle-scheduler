/**
 * The real planner, replayed on Viet Nam Open 2026's second morning.
 *
 * The fixture is the tournament as the desk saw it at three instants, rebuilt from the exported
 * `desk_activity` (analysis/viet-nam-open-2026): every row's status, court and published time as
 * they stood then. Each instant pins one failure of automatic placement that the desk only ever
 * saw as a "Ready to place" pool:
 *
 *   - 12:12:35, the XD draws had just been built. Every pass threw `unknown-dependency`, because two
 *     make-up matches carried to day two still named their day-one prerequisites as dependencies.
 *     Nothing was placed for eleven minutes, and the moderator started XD Draw C from the pool -
 *     which took a player from a published match and stalled court 2 for 99 minutes.
 *   - 12:23:24, the pass that finally ran. Its five placements are the ones the desk activity
 *     recorded, so this instant pins that the replay is the real planner on the real state.
 *   - 12:30:52, the MS draws. An overdue match on court 2, blocked by a busy player, was dropped
 *     from the plan, so the planner put MS Draw A round 1 on court 2; the server, which still
 *     counted the overdue match there, refused every retry and the match never got a time.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planPlacementSchedule } from "../placement-schedule";
import snapshotsJson from "./fixtures/viet-nam-open-day2-snapshots.json";

/**
 * The planner reads a day's window ("09:00") in the process's own zone, as the organiser's
 * browser does, and this is a Chicago tournament replayed at Chicago instants. Pinned here
 * because the replay only means anything in the venue's zone: on CI's UTC runner the same
 * windows open five hours later and the 12:12 pass has no day left to place into.
 */
const VENUE_TZ = "America/Chicago";
let previousTz: string | undefined;
beforeAll(() => {
  previousTz = process.env["TZ"];
  process.env["TZ"] = VENUE_TZ;
});
afterAll(() => {
  if (previousTz === undefined) delete process.env["TZ"];
  else process.env["TZ"] = previousTz;
});

type Row = Record<string, unknown> & {
  id: string;
  status: string;
  court_id: string | null;
  scheduled_time: string | null;
};
interface Snapshot {
  now: string;
  placementMatches: Row[];
  draws: (Record<string, unknown> & { id: string; category_id: string; tier: string })[];
  tierMatches: (Row & { draw_id: string; round: number; slot: number; is_bye?: boolean })[];
}
const fixture = snapshotsJson as unknown as {
  tournament: Record<string, unknown> & { group_slot_minutes: number; knockout_slot_minutes: number };
  days: { id: string }[];
  courts: { id: string; number: number }[];
  categories: { id: string; code: string; sort_order: number }[];
  teams: unknown[];
  entrants: unknown[];
  snapshots: Record<"crash" | "realPlacement" | "courtHold", Snapshot>;
};

const MINUTE = 60_000;
const courtNumber = new Map(fixture.courts.map((court) => [court.id, court.number]));
const categoryCode = new Map(fixture.categories.map((category) => [category.id, category.code]));

function plan(snapshot: Snapshot) {
  return planPlacementSchedule({
    mode: "place-ready",
    tournament: fixture.tournament,
    days: fixture.days,
    allCourts: fixture.courts,
    dayCourtIds: new Map(),
    breaksByDayId: new Map(fixture.days.map((day) => [day.id, []])),
    teams: fixture.teams,
    entrants: fixture.entrants,
    draws: snapshot.draws,
    placementMatches: snapshot.placementMatches,
    tierMatches: snapshot.tierMatches,
    categoryOrder: new Map(fixture.categories.map((category) => [category.id, category.sort_order])),
    now: new Date(snapshot.now).getTime(),
  } as never);
}

/** `XD Draw C r1 s1 · Court 6 · 12:52`, in the venue's time, to the minute. */
function describeSlots(
  snapshot: Snapshot,
  slots: readonly { match_id: string; court_id: string; scheduled_time: string }[],
): string[] {
  const draws = new Map(snapshot.draws.map((draw) => [draw.id, draw]));
  const label = (id: string) => {
    const tier = snapshot.tierMatches.find((match) => match.id === id);
    if (!tier) return id;
    const draw = draws.get(tier.draw_id)!;
    return `${categoryCode.get(draw.category_id)} Draw ${draw.tier} r${tier.round} s${tier.slot}`;
  };
  return slots
    .map((slot) => {
      const time = new Date(slot.scheduled_time).toLocaleTimeString("en-GB", {
        timeZone: "America/Chicago",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `${label(slot.match_id)} · Court ${courtNumber.get(slot.court_id)} · ${time}`;
    })
    .sort();
}

/**
 * The server's own court rule (`place_ready_matches` against `placement_occupied_matches`): a new
 * slot may not overlap any row already holding that court, overdue or not.
 */
function courtClashes(
  snapshot: Snapshot,
  slots: readonly { match_id: string; court_id: string; scheduled_time: string }[],
  slotMinutesFor: (id: string) => number,
): string[] {
  const held = [...snapshot.placementMatches, ...snapshot.tierMatches].filter(
    (row) => row.status === "scheduled" && row.court_id && row.scheduled_time,
  );
  return slots.flatMap((slot) => {
    const start = new Date(slot.scheduled_time).getTime();
    const end = start + slotMinutesFor(slot.match_id) * MINUTE;
    return held
      .filter((row) => row.court_id === slot.court_id && row.id !== slot.match_id)
      .filter((row) => {
        const rowStart = new Date(row.scheduled_time!).getTime();
        return start < rowStart + slotMinutesFor(row.id) * MINUTE && rowStart < end;
      })
      .map((row) => `${slot.match_id} overlaps ${row.id}`);
  });
}

function slotMinutesIn(snapshot: Snapshot) {
  const tierIds = new Set(snapshot.tierMatches.map((match) => match.id));
  return (id: string) =>
    tierIds.has(id)
      ? fixture.tournament.knockout_slot_minutes
      : fixture.tournament.group_slot_minutes;
}

describe("Viet Nam Open 2026, day two: automatic placement on the real state", () => {
  it("places the new XD draws at 12:12 instead of failing on day one's prerequisites", () => {
    const snapshot = fixture.snapshots.crash;
    const result = plan(snapshot);

    expect(result.unplaced).toEqual([]);
    // Draw C was placed after Ly Van's published 12:21 match, so it would never have sat in the
    // pool to be started by hand at 12:14.
    expect(describeSlots(snapshot, result.knockoutNewPayload)).toContain(
      "XD Draw C r1 s1 · Court 6 · 12:53",
    );
    expect(describeSlots(snapshot, result.knockoutNewPayload)).toHaveLength(6);
  });

  it("reproduces the placement the desk recorded at 12:23", () => {
    const snapshot = fixture.snapshots.realPlacement;
    const result = plan(snapshot);

    // The desk recorded 13:23:03 (three of them), 13:22:55 and 13:09:32. Starts are now chosen on
    // whole minutes (section 33), so each is the recorded time rounded up, on the same court.
    expect(describeSlots(snapshot, result.knockoutNewPayload)).toEqual([
      "XD Draw A r1 s1 · Court 2 · 13:24",
      "XD Draw A r1 s2 · Court 4 · 13:24",
      "XD Draw B r1 s2 · Court 1 · 13:23",
      "XD Draw D r1 s1 · Court 3 · 13:24",
      "XD Draw D r1 s2 · Court 5 · 13:10",
    ]);
    for (const slot of result.knockoutNewPayload) {
      expect(Date.parse(slot.scheduled_time as string) % 60_000).toBe(0);
    }
  });

  it("does not plan onto a court an overdue match still holds", () => {
    const snapshot = fixture.snapshots.courtHold;
    const result = plan(snapshot);

    const slots = describeSlots(snapshot, result.knockoutNewPayload);
    expect(slots.some((slot) => slot.startsWith("MS Draw A r1 s2 ·"))).toBe(true);
    expect(slots).not.toContain("MS Draw A r1 s2 · Court 2 · 12:31");
  });

  it("never sends the server a slot it would refuse as court_busy", () => {
    for (const snapshot of Object.values(fixture.snapshots)) {
      const result = plan(snapshot);
      const slots = [...result.placementNewPayload, ...result.knockoutNewPayload];
      expect(courtClashes(snapshot, slots, slotMinutesIn(snapshot))).toEqual([]);
    }
  });
});
