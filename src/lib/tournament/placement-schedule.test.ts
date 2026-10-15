import { describe, expect, it } from "vitest";

import type {
  Court,
  PlacementEntrant,
  PlacementMatch,
  Team,
  TierDraw,
  TierDrawMatch,
  Tournament,
  TournamentDay,
  TournamentDayBreak,
} from "./data";
import { placementStagesForDay, stagesForDay } from "./data";
import {
  courtsAddedToDays,
  courtsForDay,
  frozenMatchIdsFor,
  placementMatchLabel,
  placementStageLabel,
  planPlacementSchedule,
  projectSlotsOntoMatches,
  sliceRowsByDay,
  uncoveredScheduledMatches,
  type PlanPlacementScheduleInput,
} from "./placement-schedule";
import { normalizeBreaks, startAfterBreaks } from "@/lib/scheduling";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOURNAMENT_ID = "t1";

function tournament(overrides: Partial<Tournament> = {}): Tournament {
  return {
    id: TOURNAMENT_ID,
    is_demo: false,
    name: "Test Open",
    block_start_on_short_rest: false,
    court_count: 2,
    created_at: "2026-09-17T00:00:00Z",
    day_count: 1,
    ends_on: "2026-09-17",
    format: "two_round_placement",
    group_rest_gap_minutes: 20,
    group_slot_minutes: 30,
    knockout_best_of: 3,
    knockout_games_to: 21,
    knockout_rest_gap_minutes: 30,
    knockout_slot_minutes: 45,
    knockout_win_by: 2,
    max_categories_per_player: 2,
    notes: null,
    organizer_email: null,
    organizer_name: null,
    organizer_phone: null,
    placement_best_of: 1,
    placement_games_to: 21,
    placement_win_by: 2,
    rest_gap_minutes: 30,
    starts_on: "2026-09-17",
    status: "in_progress",
    owner_profile_id: "00000000-0000-0000-0000-0000000000a1",
    registration_opens_at: null,
    registration_closes_at: null,
    venue_address: null,
    venue_name: null,
    venue_timezone: "UTC",
    ...overrides,
  };
}

const DAY: TournamentDay = {
  id: "d1",
  tournament_id: TOURNAMENT_ID,
  day_number: 1,
  date: "2026-09-17",
  start_time: "09:00:00",
  end_time: "18:00:00",
  created_at: "2026-09-17T00:00:00Z",
};

/** 09:00 local on the test day, which is what the window maths uses. */
const DAY_START = new Date("2026-09-17T09:00:00").getTime();
const MINUTE = 60_000;

function court(number: number): Court {
  return {
    id: `c${number}`,
    number,
    status: "available",
    tournament_id: TOURNAMENT_ID,
    created_at: "2026-09-17T00:00:00Z",
  };
}

function team(id: string, player1: string, player2: string | null = null): Team {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    category_id: "cat1",
    player_1_id: player1,
    player_2_id: player2,
    seed: null,
    withdrawn: false,
    created_at: "2026-09-17T00:00:00Z",
  };
}

function entrant(id: string, teamId: string, seed = 1): PlacementEntrant {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    category_id: "cat1",
    team_id: teamId,
    skill_level: "intermediate",
    seed,
    tier: null,
    excluded: false,
    seed_locked_at: null,
    created_at: "2026-09-17T00:00:00Z",
  };
}

function placementMatch(
  id: string,
  stage: "round1" | "round2",
  entrantA: string,
  entrantB: string,
  overrides: Partial<PlacementMatch> = {},
): PlacementMatch {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    category_id: "cat1",
    stage,
    generation_key: id,
    entrant_a_id: entrantA,
    entrant_b_id: entrantB,
    winner_id: null,
    games: [],
    is_makeup: false,
    is_crossover: false,
    prerequisite_ids: [],
    court_id: null,
    scheduled_time: null,
    started_at: null,
    ended_at: null,
    reported_time: null,
    status: "scheduled",
    note: null,
    created_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function tierDraw(tier: string): TierDraw {
  return {
    id: `draw-${tier}`,
    tournament_id: TOURNAMENT_ID,
    category_id: "cat1",
    tier,
    bracket_size: 4,
    entrant_count: 4,
    champion_id: null,
    created_at: "2026-09-17T00:00:00Z",
  };
}

function tierMatch(
  id: string,
  round: number,
  slot: number,
  entrantA: string | null,
  entrantB: string | null,
  overrides: Partial<TierDrawMatch> = {},
): TierDrawMatch {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    draw_id: "draw-A",
    round,
    slot,
    entrant_a_id: entrantA,
    entrant_b_id: entrantB,
    winner_id: null,
    parent_a_id: null,
    parent_b_id: null,
    games: [],
    is_bye: false,
    court_id: null,
    scheduled_time: null,
    started_at: null,
    ended_at: null,
    reported_time: null,
    status: "scheduled",
    note: null,
    created_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

/** Four doubles teams, eight players, so player resolution is observable. */
function fourTeams(): { teams: Team[]; entrants: PlacementEntrant[] } {
  const teams = [
    team("team-1", "p1", "p2"),
    team("team-2", "p3", "p4"),
    team("team-3", "p5", "p6"),
    team("team-4", "p7", "p8"),
  ];
  const entrants = [
    entrant("e1", "team-1", 1),
    entrant("e2", "team-2", 2),
    entrant("e3", "team-3", 3),
    entrant("e4", "team-4", 4),
  ];
  return { teams, entrants };
}

/** The GRASP options tests use, so a plan is deterministic and quick. */
const FAST = { graspRuns: 1, seed: 1 } as const;

/**
 * The planner is whole-tournament now, but most of these cases are about a single
 * day, so this adapts the old per-day shape onto it.
 *
 * `stage` is accepted and ignored: the queue derives a stage from which match table
 * a row came from, so passing it is what the old planner needed, not what the new
 * one does. `courts` became `allCourts`, because a day's courts are now a subset of
 * one pool rather than the whole input.
 */
function plan(
  input: Partial<PlanPlacementScheduleInput> & {
    stage?: "placement" | "knockout";
    dayConfig?: TournamentDay;
    courts?: Court[];
    breaks?: readonly TournamentDayBreak[];
    day?: number;
  },
) {
  const { teams, entrants } = fourTeams();
  const { stage: _stage, dayConfig = DAY, courts = [court(1), court(2)] } = input;
  const { breaks, day, ...rest } = input;
  const dayConfigForPlan: TournamentDay = {
    ...dayConfig,
    day_number: day ?? dayConfig.day_number,
  };
  return planPlacementSchedule({
    tournament: tournament(),
    days: [dayConfigForPlan],
    allCourts: courts,
    breaksByDayId: breaks ? new Map([[dayConfigForPlan.id, breaks]]) : undefined,
    teams,
    entrants,
    draws: [tierDraw("A")],
    placementMatches: [],
    tierMatches: [],
    categoryOrder: new Map([["cat1", 1]]),
    options: FAST,
    now: DAY_START,
    ...rest,
  });
}

// ---------------------------------------------------------------------------
// Stage layout
// ---------------------------------------------------------------------------

describe("placementStagesForDay", () => {
  it("runs placement on day one and the knockouts on the final day", () => {
    expect(placementStagesForDay(1, 2)).toEqual(["placement"]);
    expect(placementStagesForDay(2, 2)).toEqual(["knockout"]);
    expect(placementStagesForDay(1, 3)).toEqual(["placement"]);
    expect(placementStagesForDay(2, 3)).toEqual([]);
    expect(placementStagesForDay(3, 3)).toEqual(["knockout"]);
    expect(placementStagesForDay(1, 1)).toEqual(["placement", "knockout"]);
  });

  it("stays the single source of truth for the legacy layout", () => {
    // `stagesForDay` is now derived from this function, so the two formats cannot
    // disagree about which days carry a stage. `group` is the legacy name for
    // `placement`, and nothing else differs.
    for (const dayCount of [1, 2, 3, 4]) {
      for (let day = 1; day <= dayCount; day++) {
        expect(stagesForDay(day, dayCount)).toEqual(
          placementStagesForDay(day, dayCount).map((stage) =>
            stage === "placement" ? "group" : "knockout",
          ),
        );
      }
    }
  });

  it("labels the stages the way the desk reads them", () => {
    expect(placementStageLabel("placement")).toBe("placement");
    expect(placementStageLabel("knockout")).toBe("knockouts");
  });
});

// ---------------------------------------------------------------------------
// Placement stage planning
// ---------------------------------------------------------------------------

describe("planPlacementDay — placement stage", () => {
  it("places every round with its players resolved through the entrant's team", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e3"),
        placementMatch("r1-2", "round1", "e2", "e4"),
      ],
    });

    expect(result.blocked).toEqual([]);
    expect(result.awaitingTeams).toEqual([]);
    expect(result.slots).toHaveLength(2);
    expect(result.summary.placed).toBe(2);
    // Four players in the batch: two doubles teams.
    expect(result.summary.anchorCount).toBe(0);
    expect(result.placementSlotPayload).toHaveLength(2);
  });

  it("starts a first build at the day window, not at the clock", () => {
    // `now` is deliberately hours after the window opens. Nothing has been played,
    // so the host's chosen start time is authoritative.
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [placementMatch("r1-1", "round1", "e1", "e2")],
      now: DAY_START + 5 * 60 * MINUTE,
    });
    expect(result.slots[0]?.start.getTime()).toBe(DAY_START);
  });

  it("keeps a reported match as an anchor and out of the movable payload", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e3", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:00:00.000Z",
          ended_at: "2026-09-17T09:30:00.000Z",
        }),
        placementMatch("r1-2", "round1", "e2", "e4"),
      ],
    });

    expect(result.fixedMatchIds).toEqual(["r1-1"]);
    expect(result.summary.anchorCount).toBe(1);
    expect(result.summary.placed).toBe(1);
    expect(result.placementSlotPayload.map((slot) => slot.match_id)).toEqual(["r1-2"]);
    // The anchor keeps exactly the time and court it already had.
    const anchor = result.slots.find((slot) => slot.matchId === "r1-1");
    expect(anchor?.start.toISOString()).toBe("2026-09-17T09:00:00.000Z");
    expect(anchor?.courtNumber).toBe(1);
  });

  it("floors a rebuild at the current minute rather than the day start", () => {
    // One match already scheduled means this is a rebuild, so a match must not be
    // replanned into a time that has already passed.
    const { teams, entrants } = fourTeams();
    const now = DAY_START + 2 * 60 * MINUTE + 20_000;
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2", {
          scheduled_time: "2026-09-17T09:00:00",
        }),
        placementMatch("r1-2", "round1", "e3", "e4", {
          scheduled_time: "2026-09-17T09:30:00.000Z",
        }),
      ],
      now,
      courts: [court(1)],
    });

    const floor = Math.ceil(now / MINUTE) * MINUTE;
    for (const slot of result.placementSlotPayload) {
      expect(new Date(slot.scheduled_time).getTime()).toBeGreaterThanOrEqual(floor);
    }
  });

  it("keeps round two after the round one matches that feed it", () => {
    // Round one is decided, which is the only state in which round two can exist
    // at all: the generator refuses to build it until every round-one result is
    // in. So a round-two match is always planned against fixed anchors, and the
    // ordering that matters is enforced through the shared player's rest gap
    // rather than through the round number.
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:00:00",
          ended_at: "2026-09-17T09:30:00",
        }),
        placementMatch("r2-1", "round2", "e1", "e3"),
      ],
      tournament: tournament({ group_rest_gap_minutes: 20 }),
    });

    const round2 = result.slots.find((slot) => slot.matchId === "r2-1");
    expect(result.summary.anchorCount).toBe(1);
    // 09:30 end plus the 20 minute rest gap, and e1 played the anchor.
    expect(round2!.start.getTime()).toBeGreaterThanOrEqual(
      new Date("2026-09-17T09:50:00.000Z").getTime(),
    );
  });

  it("uses the group duration and rest gap for the placement stage", () => {
    // The placement stage reuses the group columns; the knockout columns must not
    // leak into it.
    const result = plan({
      stage: "placement",
      tournament: tournament({ group_slot_minutes: 30, knockout_slot_minutes: 45 }),
      courts: [court(1)],
      draws: [],
      placementMatches: [placementMatch("r1-1", "round1", "e1", "e2")],
    });
    expect(result.slots[0]!.end.getTime() - result.slots[0]!.start.getTime()).toBe(30 * MINUTE);
  });
});

// ---------------------------------------------------------------------------
// Prerequisites: the held entrant's sequencing
// ---------------------------------------------------------------------------

describe("planPlacementDay — prerequisites", () => {
  /**
   * The held entrant's two make-up matches are modelled with different players so
   * the ONLY thing forcing them apart is the prerequisite, not a shared player's
   * rest gap. Two courts mean they could otherwise run at the same time.
   */
  function makeupMatches(prerequisite: string[], overrides: Partial<PlacementMatch> = {}) {
    const { teams, entrants } = fourTeams();
    return plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [
        placementMatch("r2-makeup-1", "round2", "e1", "e2"),
        placementMatch("r2-makeup-2", "round2", "e3", "e4", {
          is_makeup: true,
          prerequisite_ids: prerequisite,
          ...overrides,
        }),
      ],
    });
  }

  it("sequences a match after the prerequisite it is waiting on", () => {
    const result = makeupMatches(["r2-makeup-1"]);
    const first = result.slots.find((slot) => slot.matchId === "r2-makeup-1");
    const second = result.slots.find((slot) => slot.matchId === "r2-makeup-2");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Without the prerequisite these would run together on the two courts, so this
    // assertion is what proves `prerequisite_ids` reached the scheduler.
    expect(second!.start.getTime()).toBeGreaterThanOrEqual(first!.end.getTime());
  });

  it("does not deadlock when a prerequisite is not in the batch", () => {
    // A prerequisite that was voided or belongs to another day cannot ever be
    // satisfied. Dropping it keeps one abandoned match from making the whole day
    // unplaceable, which is why `dependsOn` is filtered to the batch.
    const result = makeupMatches(["r2-makeup-1"], {});
    expect(result.blocked).toEqual([]);

    const { teams, entrants } = fourTeams();
    const voided = plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [
        placementMatch("r2-makeup-1", "round2", "e1", "e2", { status: "void" }),
        placementMatch("r2-makeup-2", "round2", "e3", "e4", {
          prerequisite_ids: ["r2-makeup-1"],
        }),
      ],
    });
    expect(voided.blocked).toEqual([]);
    // The void match itself is not schedulable and must not be planned.
    expect(voided.slots.map((slot) => slot.matchId)).toEqual(["r2-makeup-2"]);
  });

  it("reports a genuine deadlock as blocked, not as awaiting teams", () => {
    // A dependency cycle is the one way a match with known players can be
    // genuinely unplaceable. The distinction matters: awaiting-teams is normal and
    // silent, blocked needs the desk.
    const { teams, entrants } = fourTeams();
    const cyclic = plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [
        placementMatch("a", "round2", "e1", "e2", { prerequisite_ids: ["b"] }),
        placementMatch("b", "round2", "e3", "e4", { prerequisite_ids: ["a"] }),
      ],
    });
    expect(cyclic.blocked.sort()).toEqual(["a", "b"]);
    expect(cyclic.awaitingTeams).toEqual([]);
    expect(cyclic.summary.unscheduled).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Knockout stage planning
// ---------------------------------------------------------------------------

describe("planPlacementDay — knockout stage", () => {
  it("drops byes instead of trying to schedule them", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "knockout",
      teams,
      entrants,
      draws: [tierDraw("A")],
      tierMatches: [
        tierMatch("k-1", 1, 1, "e1", null, {
          is_bye: true,
          winner_id: "e1",
          status: "reported",
        }),
        tierMatch("k-2", 1, 2, "e2", "e3"),
      ],
    });

    expect(result.slots.map((slot) => slot.matchId)).toEqual(["k-2"]);
    expect(result.fixedMatchIds).toEqual([]);
    expect(result.summary.placed).toBe(1);
  });

  it("leaves an undecided match out entirely rather than calling it awaiting", () => {
    // A knockout match whose parents have not been played is not a fixture yet.
    // Listing it as awaiting teams would make every future round look like a gap.
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "knockout",
      teams,
      entrants,
      draws: [tierDraw("A")],
      tierMatches: [tierMatch("k-1", 1, 1, "e1", "e2"), tierMatch("k-final", 2, 1, null, null)],
    });

    expect(result.slots.map((slot) => slot.matchId)).toEqual(["k-1"]);
    expect(result.blocked).toEqual([]);
    expect(result.awaitingTeams).toEqual([]);
  });

  it("waits for both feeders plus the knockout rest gap", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "knockout",
      teams,
      entrants,
      draws: [tierDraw("A")],
      tierMatches: [
        tierMatch("k-a", 1, 1, "e1", "e2", {
          status: "reported",
          ended_at: "2026-09-17T09:45:00.000Z",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:00:00",
        }),
        tierMatch("k-b", 1, 2, "e3", "e4", {
          status: "reported",
          ended_at: "2026-09-17T09:45:00.000Z",
          court_id: "c2",
          scheduled_time: "2026-09-17T09:00:00",
        }),
        tierMatch("k-final", 2, 1, "e1", "e3", {
          parent_a_id: "k-a",
          parent_b_id: "k-b",
        }),
      ],
      tournament: tournament({ knockout_rest_gap_minutes: 30, knockout_slot_minutes: 45 }),
    });

    const final = result.slots.find((slot) => slot.matchId === "k-final");
    // 09:45 + 30 minutes rest = 10:15 at the earliest.
    expect(final!.start.getTime()).toBeGreaterThanOrEqual(
      new Date("2026-09-17T10:15:00.000Z").getTime(),
    );
  });

  it("uses the knockout duration for the knockout stage", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "knockout",
      teams,
      entrants,
      draws: [tierDraw("A")],
      tierMatches: [tierMatch("k-1", 1, 1, "e1", "e2")],
      tournament: tournament({ group_slot_minutes: 30, knockout_slot_minutes: 45 }),
    });
    expect(result.slots[0]!.end.getTime() - result.slots[0]!.start.getTime()).toBe(45 * MINUTE);
  });

  it("refuses to plan without courts", () => {
    expect(() => plan({ stage: "placement", courts: [] })).toThrow(/court list/i);
  });
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe("placementMatchLabel", () => {
  const label = (entrantId: string | null) => (entrantId ? `E:${entrantId}` : "TBC");

  it("labels a placement match from its entrants", () => {
    expect(
      placementMatchLabel("r1-1", [placementMatch("r1-1", "round1", "e1", "e2")], [], label),
    ).toBe("E:e1 vs E:e2");
  });

  it("labels a knockout match, including one side still to be decided", () => {
    expect(placementMatchLabel("k-1", [], [tierMatch("k-1", 1, 1, "e1", null)], label)).toBe(
      "E:e1 vs TBC",
    );
  });

  it("falls back to a short id for a match it does not know", () => {
    // Better a short id than an empty cell, which would read as a rendering bug.
    expect(placementMatchLabel("0123456789abcdef", [], [], label)).toBe("01234567");
  });
});

// ---------------------------------------------------------------------------
// Breaks
// ---------------------------------------------------------------------------

function dayBreak(startTime: string, endTime: string): TournamentDayBreak {
  return {
    id: `brk-${startTime}`,
    tournament_id: TOURNAMENT_ID,
    day_id: DAY.id,
    label: null,
    start_time: startTime,
    end_time: endTime,
    created_at: "2026-09-17T00:00:00Z",
  };
}

describe("startAfterBreaks", () => {
  // These work in plain minutes: the helper is unit-agnostic, and round numbers
  // make the arithmetic in the assertions obvious.
  const MIN = 60_000;

  it("leaves a start alone when there is nothing to step over", () => {
    expect(startAfterBreaks(0, 30 * MIN, [])).toBe(0);
  });

  it("moves a match that would straddle a break wholly after it", () => {
    // A match cannot be paused part-way, so 09:00 + 30min against a 09:20-10:00
    // break has to become 10:00 rather than 09:00 with a gap in the middle.
    const breaks = normalizeBreaks([{ start: 9 * 60 * MIN, end: 10 * 60 * MIN }], Infinity);
    expect(startAfterBreaks(9 * 60 * MIN, 30 * MIN, breaks)).toBe(10 * 60 * MIN);
  });

  it("allows a match that ends exactly as a break begins", () => {
    // Touching is not overlapping: play right up to the whistle is fine.
    const breaks = normalizeBreaks([{ start: 10 * 60 * MIN, end: 11 * 60 * MIN }], Infinity);
    expect(startAfterBreaks(9 * 60 * MIN, 60 * MIN, breaks)).toBe(9 * 60 * MIN);
  });

  it("allows a match that starts exactly as a break ends", () => {
    const breaks = normalizeBreaks([{ start: 9 * 60 * MIN, end: 10 * 60 * MIN }], Infinity);
    expect(startAfterBreaks(10 * 60 * MIN, 30 * MIN, breaks)).toBe(10 * 60 * MIN);
  });

  it("steps over back-to-back breaks in one call", () => {
    // Clearing the first break lands exactly on the second, so a single pass
    // would leave the match starting inside it.
    const breaks = normalizeBreaks(
      [
        { start: 9 * 60 * MIN, end: 10 * 60 * MIN },
        { start: 10 * 60 * MIN, end: 11 * 60 * MIN },
      ],
      Infinity,
    );
    expect(startAfterBreaks(9 * 60 * MIN, 30 * MIN, breaks)).toBe(11 * 60 * MIN);
  });
});

describe("normalizeBreaks", () => {
  it("sorts and merges overlapping and touching windows", () => {
    expect(
      normalizeBreaks(
        [
          { start: 300, end: 400 },
          { start: 100, end: 200 },
          { start: 150, end: 250 },
        ],
        Infinity,
      ),
    ).toEqual([
      { start: 100, end: 250 },
      { start: 300, end: 400 },
    ]);
  });

  it("drops windows that cannot be played around", () => {
    // A zero-length or inverted window is a data-entry slip, not a break.
    expect(
      normalizeBreaks(
        [
          { start: 200, end: 200 },
          { start: 400, end: 300 },
        ],
        Infinity,
      ),
    ).toEqual([]);
    expect(normalizeBreaks([{ start: NaN, end: 300 }], Infinity)).toEqual([]);
  });

  it("drops a break that begins after the day is planned to end", () => {
    // Matches may overrun the plan, so a break past the end would only delay work
    // that could have happened.
    expect(normalizeBreaks([{ start: 500, end: 600 }], 500)).toEqual([]);
    expect(normalizeBreaks([{ start: 499, end: 600 }], 500)).toEqual([{ start: 499, end: 600 }]);
  });
});

describe("courtsForDay", () => {
  const all = [court(1), court(2), court(3)];

  it("uses every court when no per-day set is configured", () => {
    // Tournaments created before per-day courts existed have no rows, and the only
    // sensible reading of that is "all courts".
    expect(courtsForDay(all, new Set()).map((c) => c.number)).toEqual([1, 2, 3]);
  });

  it("restricts to the day's own courts when a set is configured", () => {
    expect(courtsForDay(all, new Set(["c1", "c3"])).map((c) => c.number)).toEqual([1, 3]);
  });
});

describe("courtsAddedToDays", () => {
  const days = ["d1", "d2"];

  it("writes nothing for a day that already means every court", () => {
    // No rows is the "every court" shorthand, so a new court is already on that day and
    // writing a row for it would only restate it as an exhaustive list.
    const dayCourtIds = new Map<string, Set<string>>();
    expect(courtsAddedToDays(days, dayCourtIds, ["c4"], 4)).toEqual([]);
  });

  it("adds the new court to a day that was narrowed", () => {
    // The defect this exists for: a day narrowed to 1 and 3 kept playing on 1 and 3 only,
    // so a fourth court existed for every day except the one that had been touched.
    const dayCourtIds = new Map([["d1", new Set(["c1", "c3"])]]);
    expect(courtsAddedToDays(["d1"], dayCourtIds, ["c4"], 4)).toEqual([
      { dayId: "d1", courtIds: ["c1", "c3", "c4"] },
    ]);
  });

  it("restores the shorthand once the union covers the whole pool", () => {
    // A day that ends up on every court should go back to no rows, or the next court
    // added to the venue would leave it narrowed without anyone asking for it.
    const dayCourtIds = new Map([["d1", new Set(["c1", "c2"])]]);
    expect(courtsAddedToDays(["d1"], dayCourtIds, ["c3"], 3)).toEqual([
      { dayId: "d1", courtIds: [] },
    ]);
  });

  it("writes nothing when the pool did not grow", () => {
    const dayCourtIds = new Map([["d1", new Set(["c1"])]]);
    expect(courtsAddedToDays(["d1"], dayCourtIds, [], 4)).toEqual([]);
  });
});

describe("planPlacementDay — the day's own courts", () => {
  /**
   * The route restricts the court list to the day's own set before planning. These
   * prove the planner honours whatever it is handed, which is the boundary that
   * makes a day configured for fewer courts actually schedule on fewer courts.
   */
  it("only places matches on the courts it is given", () => {
    const result = plan({
      stage: "placement",
      courts: [court(3)],
      draws: [],
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2"),
        placementMatch("r1-2", "round1", "e3", "e4"),
      ],
    });

    expect(result.slots).toHaveLength(2);
    expect(result.slots.every((slot) => slot.courtNumber === 3)).toBe(true);
  });

  it("uses the extra courts when the day has them", () => {
    const result = plan({
      stage: "placement",
      courts: [court(1), court(2)],
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2"),
        placementMatch("r1-2", "round1", "e3", "e4"),
      ],
    });

    // Two independent matches on two courts can share a start time; on one court
    // the second would have to wait.
    const starts = new Set(result.slots.map((slot) => slot.start.getTime()));
    expect(starts.size).toBe(1);
  });
});

describe("planPlacementDay — breaks", () => {
  it("steps the placement stage over a day break", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      breaks: [dayBreak("09:20:00", "10:00:00")],
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2"),
        placementMatch("r1-2", "round1", "e3", "e4"),
      ],
    });

    // The 09:00 wave would have run 09:00-09:30, straight through the break.
    expect(result.slots[0]!.start.getTime()).toBe(DAY_START + 60 * MINUTE);
    for (const slot of result.slots) {
      expect(slot.start.getTime()).toBeGreaterThanOrEqual(DAY_START + 60 * MINUTE);
    }
  });

  it("steps the knockout stage over a day break", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "knockout",
      teams,
      entrants,
      draws: [tierDraw("A")],
      breaks: [dayBreak("09:30:00", "11:00:00")],
      tierMatches: [tierMatch("k-1", 1, 1, "e1", "e2")],
    });

    // A 45 minute knockout match starting at 09:00 would end at 09:45, inside the
    // break, so the whole match moves to the far side of it.
    expect(result.slots[0]!.start.getTime()).toBe(DAY_START + 120 * MINUTE);
  });

  it("never places a match across a break", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      breaks: [dayBreak("09:30:00", "09:45:00")],
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2"),
        placementMatch("r1-2", "round1", "e3", "e4"),
      ],
    });

    const breakStart = DAY_START + 30 * MINUTE;
    const breakEnd = DAY_START + 45 * MINUTE;
    for (const slot of result.slots) {
      const overlaps = slot.start.getTime() < breakEnd && slot.end.getTime() > breakStart;
      expect(overlaps).toBe(false);
    }
  });

  it("ignores a break on a day that has none", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      breaks: [],
      placementMatches: [placementMatch("r1-1", "round1", "e1", "e2")],
    });
    expect(result.slots[0]!.start.getTime()).toBe(DAY_START);
  });
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** A day with a bare window, so a test can pin exactly how many matches it holds. */
function queueDay(
  dayNumber: number,
  start: string,
  end: string,
  id = `d${dayNumber}`,
): TournamentDay {
  return {
    id,
    tournament_id: TOURNAMENT_ID,
    day_number: dayNumber,
    date: `2026-09-${String(16 + dayNumber).padStart(2, "0")}`,
    start_time: start,
    end_time: end,
    created_at: "2026-09-17T00:00:00Z",
  };
}

/** `count` doubles teams sharing no players, so no match's rest gap binds another. */
function disjointTeams(count: number): { teams: Team[]; entrants: PlacementEntrant[] } {
  const teams: Team[] = [];
  const entrants: PlacementEntrant[] = [];
  for (let index = 0; index < count; index += 1) {
    teams.push(team(`team-${index + 1}`, `p${index * 2 + 1}`, `p${index * 2 + 2}`));
    entrants.push(entrant(`e${index + 1}`, `team-${index + 1}`, index + 1));
  }
  return { teams, entrants };
}

function scheduleQueue(input: {
  days: TournamentDay[];
  courts?: Court[];
  dayCourtIds?: Map<string, ReadonlySet<string>>;
  placementMatches?: PlacementMatch[];
  tierMatches?: TierDrawMatch[];
  tournament?: Tournament;
  breaksByDayId?: Map<string, readonly TournamentDayBreak[]>;
  teamCount?: number;
}) {
  const { teams, entrants } = disjointTeams(input.teamCount ?? 8);
  return planPlacementSchedule({
    tournament: input.tournament ?? tournament({ day_count: input.days.length }),
    days: input.days,
    allCourts: input.courts ?? [court(1)],
    dayCourtIds: input.dayCourtIds,
    breaksByDayId: input.breaksByDayId,
    teams,
    entrants,
    draws: [tierDraw("A")],
    placementMatches: input.placementMatches ?? [],
    tierMatches: input.tierMatches ?? [],
    categoryOrder: new Map([["cat1", 1]]),
    options: FAST,
    now: DAY_START,
  });
}

describe("planPlacementSchedule — one queue across days", () => {
  it("defers what will not fit into the next day instead of overrunning", () => {
    // One court, a one hour window and 30 minute slots hold exactly two matches.
    // The other three are not blocked: they belong to day two.
    const matches = [1, 2, 3, 4, 5].map((n) =>
      placementMatch(`r1-${n}`, "round1", `e${n * 2 - 1}`, `e${n * 2}`),
    );
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "10:00:00"), queueDay(2, "09:00:00", "10:00:00")],
      placementMatches: matches,
      teamCount: 10,
    });

    expect(result.slots).toHaveLength(5);
    expect(result.blocked).toEqual([]);

    const byDay = new Map<number, number>();
    for (const slot of result.slots) {
      byDay.set(slot.start.getDate(), (byDay.get(slot.start.getDate()) ?? 0) + 1);
    }
    expect(byDay.get(17)).toBe(2);
    expect(byDay.get(18)).toBe(3);
    expect(result.days.find((fill) => fill.day === 1)!.placed).toBe(2);
    expect(result.days.find((fill) => fill.day === 2)!.placed).toBe(3);
  });

  it("reports lateness only, so an incomplete but on-time plan is not an overrun", () => {
    // Two placement matches waiting on each other can never be placed. Nothing is placed late,
    // so there is no lateness; the incompleteness stays in the unscheduled list on its own.
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "18:00:00")],
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2", { prerequisite_ids: ["r2-1"] }),
        placementMatch("r2-1", "round2", "e3", "e4", { prerequisite_ids: ["r1-1"] }),
      ],
      teamCount: 4,
    });

    expect(result.slots).toEqual([]);
    expect([...result.blocked].sort()).toEqual(["r1-1", "r2-1"]);
    expect(result.summary.unscheduled).toBe(2);
    expect(result.summary.overrunMinutes).toBe(0);
    expect(result.summary.overrun).toBe(false);
    expect(result.blockedReason).toMatch(/waiting on each other/);
  });

  it("lets the last day overrun, because there is nothing after it", () => {
    const matches = [1, 2, 3].map((n) =>
      placementMatch(`r1-${n}`, "round1", `e${n * 2 - 1}`, `e${n * 2}`),
    );
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "09:30:00")],
      placementMatches: matches,
      teamCount: 6,
    });

    expect(result.slots).toHaveLength(3);
    expect(result.blocked).toEqual([]);
    expect(result.days[0]!.overrunMinutes).toBeGreaterThan(0);
    expect(result.summary.overrun).toBe(true);
  });

  it("holds the tail of one stage and the head of the next on the same day", () => {
    // Day one can take a single placement match; day two takes the second one and
    // then the knockout, which is the shape the whole change exists to allow.
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "09:30:00"), queueDay(2, "09:00:00", "18:00:00")],
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2"),
        placementMatch("r2-1", "round2", "e3", "e4"),
      ],
      tierMatches: [tierMatch("k-1", 1, 1, "e5", "e6")],
      teamCount: 6,
    });

    const onDay = (day: number) => result.slots.filter((slot) => slot.start.getDate() === day);
    const placementIds = new Set(["r1-1", "r2-1"]);

    const dayTwo = onDay(18);
    expect(dayTwo.some((slot) => placementIds.has(slot.matchId))).toBe(true);
    expect(dayTwo.some((slot) => slot.matchId === "k-1")).toBe(true);
    // Day one is still placement only: the barrier held.
    expect(onDay(17).every((slot) => placementIds.has(slot.matchId))).toBe(true);
    expect(onDay(17).some((slot) => slot.matchId === "k-1")).toBe(false);
  });

  it("never starts a knockout before the last placement match it follows", () => {
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "09:30:00"), queueDay(2, "09:00:00", "18:00:00")],
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2"),
        placementMatch("r2-1", "round2", "e3", "e4"),
      ],
      tierMatches: [tierMatch("k-1", 1, 1, "e5", "e6")],
      teamCount: 6,
    });

    const knockout = result.slots.find((slot) => slot.matchId === "k-1")!;
    const lastPlacement = result.slots
      .filter((slot) => slot.matchId !== "k-1")
      .reduce((acc, slot) => (slot.end.getTime() > acc ? slot.end.getTime() : acc), 0);
    expect(knockout.start.getTime()).toBeGreaterThanOrEqual(lastPlacement);
  });

  it("gives each stage its own duration when both share a court", () => {
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "18:00:00")],
      placementMatches: [placementMatch("r1-1", "round1", "e1", "e2")],
      tierMatches: [tierMatch("k-1", 1, 1, "e3", "e4")],
      teamCount: 4,
    });

    const placement = result.slots.find((slot) => slot.matchId === "r1-1")!;
    const knockout = result.slots.find((slot) => slot.matchId === "k-1")!;
    expect(placement.end.getTime() - placement.start.getTime()).toBe(30 * MINUTE);
    expect(knockout.end.getTime() - knockout.start.getTime()).toBe(45 * MINUTE);
    // One court, so the 30 minute match cannot sit on top of the 45 minute one.
    expect(placement.end.getTime()).toBeLessThanOrEqual(knockout.start.getTime());
  });

  it("schedules each day on the courts that day has switched on", () => {
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "09:30:00"), queueDay(2, "09:00:00", "18:00:00")],
      courts: [court(1), court(2)],
      dayCourtIds: new Map([
        ["d1", new Set(["c1"])],
        ["d2", new Set(["c2"])],
      ]),
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2"),
        placementMatch("r1-2", "round1", "e3", "e4"),
      ],
      teamCount: 4,
    });

    for (const slot of result.slots) {
      const expected = slot.start.getDate() === 17 ? 1 : 2;
      expect(slot.courtNumber).toBe(expected);
    }
  });

  it("places a match that depends on one the previous day already placed", () => {
    // A dependency is only knowable to a run if the run was handed it as an anchor:
    // `isEligible` fails a dependency missing from `scheduledEnd` instead of
    // deferring it. The make-up form of the placement format depends on other
    // round-two matches, so a round two spanning a day boundary puts a dependency on
    // the far side of it. Before the carry, the dependent was never eligible: it
    // deadlocked, and since one stuck placement match also stops the knockout pass,
    // a single unresolved prerequisite refused the entire build.
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "09:30:00"), queueDay(2, "09:00:00", "18:00:00")],
      placementMatches: [
        placementMatch("r2-a", "round2", "e1", "e2"),
        placementMatch("r2-b", "round2", "e3", "e4"),
        placementMatch("r2-makeup", "round2", "e1", "e3", {
          is_makeup: true,
          prerequisite_ids: ["r2-a", "r2-b"],
        }),
      ],
      teamCount: 4,
    });

    expect(result.blocked).toEqual([]);
    expect(result.slots.map((slot) => slot.matchId).sort()).toEqual(["r2-a", "r2-b", "r2-makeup"]);

    const byId = new Map(result.slots.map((slot) => [slot.matchId, slot]));
    const makeup = byId.get("r2-makeup")!;
    // Day one takes exactly one of the two feeders — which one is the scheduler's
    // choice — so the make-up's dependency on it crosses the boundary, and the
    // make-up itself can only be placed on day two.
    const feeders = [byId.get("r2-a")!, byId.get("r2-b")!];
    expect(feeders.filter((slot) => slot.start.getDate() === 17)).toHaveLength(1);
    expect(makeup.start.getDate()).toBe(18);
    // And both dependencies hold, including the one on the earlier day.
    for (const feeder of feeders) {
      expect(makeup.start.getTime()).toBeGreaterThanOrEqual(feeder.end.getTime());
    }
  });

  it("keeps the rest gap across a day boundary", () => {
    // The player window a carried slot leaves behind has to survive the carry for
    // the same reason its end time does. Day two opens ten minutes after day one's
    // only match ends, which is inside the pair's 20 minute gap, so the carried
    // window — not the day's own floor — is what has to push the second match out.
    const dayTwoOpen = new Date("2026-09-18T00:00:00").getTime();
    const result = scheduleQueue({
      days: [queueDay(1, "23:20:00", "23:59:00"), queueDay(2, "00:00:00", "18:00:00")],
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2"),
        placementMatch("r1-2", "round1", "e1", "e2"),
      ],
      teamCount: 4,
    });

    const byId = new Map(result.slots.map((slot) => [slot.matchId, slot]));
    const a = byId.get("r1-1")!;
    const b = byId.get("r1-2")!;
    const [first, second] = a.start.getTime() <= b.start.getTime() ? [a, b] : [b, a];
    // The boundary really was crossed, and the gap is what set the start.
    expect(second.start.getTime()).toBeGreaterThan(dayTwoOpen);
    expect(second.start.getTime()).toBe(first.end.getTime() + 20 * MINUTE);
  });

  it("does not list a carried slot twice, nor write it twice", () => {
    // The carry hands earlier days' slots to later runs as anchors, and a run
    // returns its anchors in `slots`. They are already recorded, so echoing them
    // back would duplicate the match in the plan and write it twice, and a rebuild
    // would appear to move a match it never touched.
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "09:30:00"), queueDay(2, "09:00:00", "18:00:00")],
      placementMatches: [
        placementMatch("r2-a", "round2", "e1", "e2"),
        placementMatch("r2-b", "round2", "e3", "e4"),
        placementMatch("r2-makeup", "round2", "e1", "e3", {
          is_makeup: true,
          prerequisite_ids: ["r2-a", "r2-b"],
        }),
      ],
      teamCount: 4,
    });

    const slotIds = result.slots.map((slot) => slot.matchId);
    expect(new Set(slotIds).size).toBe(slotIds.length);
    const written = result.placementSlotPayload.map((slot) => slot.match_id);
    expect(new Set(written).size).toBe(written.length);
    expect(written.sort()).toEqual(["r2-a", "r2-b", "r2-makeup"]);
  });

  it("names the placement cause before the knockouts held behind it", () => {
    // A cycle in the placement stage cannot drain, so the knockout is held behind it.
    // The knockouts are the symptom, and a message that led with them would send the
    // desk to the wrong stage.
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "18:00:00")],
      placementMatches: [
        placementMatch("a", "round2", "e1", "e2", { prerequisite_ids: ["b"] }),
        placementMatch("b", "round2", "e3", "e4", { prerequisite_ids: ["a"] }),
      ],
      tierMatches: [tierMatch("k-1", 1, 1, "e5", "e6")],
      teamCount: 6,
    });

    expect([...result.blocked].sort()).toEqual(["a", "b", "k-1"]);
    expect(result.blockedReason).toMatch(/waiting on each other/);
    expect(result.blockedReason).toMatch(/held behind the placement stage/);
    // The cause comes first.
    expect(result.blockedReason!.indexOf("waiting on each other")).toBeLessThan(
      result.blockedReason!.indexOf("held behind"),
    );
  });

  it("leaves a knockout whose bracket is undecided out of the plan entirely", () => {
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "18:00:00")],
      placementMatches: [placementMatch("r1-1", "round1", "e1", "e2")],
      // Round two of a bracket is only created once round one is decided, so this is
      // the shape of a row that must not be treated as a match yet.
      tierMatches: [tierMatch("k-2", 2, 1, null, null)],
      teamCount: 4,
    });

    expect(result.slots.map((slot) => slot.matchId)).toEqual(["r1-1"]);
    expect(result.blocked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Anchors reported before their slot
// ---------------------------------------------------------------------------

describe("planPlacementSchedule — anchors reported ahead of their slot", () => {
  /**
   * A walkover, or a round played ahead of schedule, is reported before the time
   * the match was given. The finish then precedes the planned start. Reading the
   * finish literally would make the match end before it began, and the scheduler
   * rejects the whole batch rather than the one row, so one early report used to
   * stop every later stage from being scheduled at all.
   */
  it("keeps a match reported before its slot on the slot it was given", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e3", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:30:00.000Z",
          ended_at: "2026-09-17T08:00:00.000Z",
        }),
        placementMatch("r1-2", "round1", "e2", "e4"),
      ],
    });

    expect(result.blocked).toEqual([]);
    expect(result.summary.anchorCount).toBe(1);
    expect(result.placementSlotPayload.map((slot) => slot.match_id)).toEqual(["r1-2"]);

    // The planned slot is kept whole, so the court is still held until it is due
    // and cannot be handed to another match in the meantime.
    const anchor = result.slots.find((slot) => slot.matchId === "r1-1");
    expect(anchor?.start.toISOString()).toBe("2026-09-17T09:30:00.000Z");
    expect(anchor?.end.toISOString()).toBe("2026-09-17T10:00:00.000Z");
  });

  it("infers one slot from the finish when the match was never given a time", () => {
    // Nothing to anchor to: the row has no court and no scheduled time, which is
    // the shape of a match reported before it was ever laid out.
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2", {
          status: "reported",
          ended_at: "2026-09-17T09:30:00.000Z",
        }),
      ],
    });

    expect(result.blocked).toEqual([]);
    expect(result.summary.anchorCount).toBe(1);
  });

  it("still uses the real finish when the match ran past its slot", () => {
    // The ordinary case must not change: a match that overran is anchored at when
    // it actually finished, because that is what the following round waits for. A
    // movable match is included so the stage actually runs and reports its slots.
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e3", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:00:00.000Z",
          ended_at: "2026-09-17T09:40:00.000Z",
        }),
        placementMatch("r1-2", "round1", "e2", "e4"),
      ],
    });

    const anchor = result.slots.find((slot) => slot.matchId === "r1-1");
    expect(anchor?.start.toISOString()).toBe("2026-09-17T09:00:00.000Z");
    expect(anchor?.end.toISOString()).toBe("2026-09-17T09:40:00.000Z");
  });
});

describe("planPlacementSchedule — a played match never fails the batch", () => {
  /**
   * Two matches that were both played ahead of schedule can be modelled as
   * overlapping, because a reported match keeps its whole planned slot as the window
   * it occupied. The later one then "starts before its dependency ends" on paper,
   * even though it really started after the dependency had finished.
   *
   * That is history, not a scheduling error, and it must not be judged as one: the
   * whole point of a rebuild is to place what is LEFT after results are in, so
   * refusing the batch here made a partly played event unschedulable — the build
   * threw and every remaining knockout stayed without a court or a time.
   */
  it("plans around an anchor whose planned slot outlasts its real finish", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [
        // Feeder: played early, so its planned slot runs on past its real finish.
        placementMatch("r1-1", "round1", "e1", "e3", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:00:00.000Z",
          ended_at: "2026-09-17T08:50:00.000Z",
        }),
        // Its dependent, also played early: it starts inside the feeder's modelled
        // slot, which is what used to invalidate every GRASP run.
        placementMatch("r2-1", "round2", "e1", "e3", {
          status: "reported",
          court_id: "c2",
          scheduled_time: "2026-09-17T09:15:00.000Z",
          ended_at: "2026-09-17T09:10:00.000Z",
          prerequisite_ids: ["r1-1"],
        }),
        // Something still to play, so the stage actually runs a schedule.
        placementMatch("r1-2", "round1", "e2", "e4"),
      ],
    });

    expect(result.blocked).toEqual([]);
    expect(result.placementSlotPayload.map((slot) => slot.match_id)).toEqual(["r1-2"]);
    expect(result.summary.anchorCount).toBe(2);
  });

  /**
   * The mirror image of the case above, and the one the live data hit: two matches
   * played back to back on ONE court, both reported well inside a slot.
   *
   * Stretching each of them to a whole slot made them overlap on their own resource.
   * The problem validator refuses two fixed matches sharing a resource at overlapping
   * times, and it is right to — that is a double booking — but the overlap was an
   * artefact of the stretch, so a partly played event whose play was simply quick
   * became unschedulable and the build threw before it placed anything at all.
   */
  it("does not turn a quick pair on one court into a resource conflict", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e3", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:00:00.000Z",
          started_at: "2026-09-17T09:00:00.000Z",
          ended_at: "2026-09-17T09:00:40.000Z",
        }),
        // Same court, forty seconds later: inside one slot of the match above.
        placementMatch("r1-2", "round1", "e2", "e4", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:01:00.000Z",
          started_at: "2026-09-17T09:01:00.000Z",
          ended_at: "2026-09-17T09:01:35.000Z",
        }),
        // Something still to play, so the stage actually runs a schedule.
        placementMatch("r2-1", "round2", "e1", "e2", { prerequisite_ids: ["r1-1"] }),
      ],
    });

    expect(result.blocked).toEqual([]);
    expect(result.summary.anchorCount).toBe(2);
    expect(result.placementSlotPayload.map((slot) => slot.match_id)).toEqual(["r2-1"]);
  });
});

// ---------------------------------------------------------------------------
// The two stages sharing one day
// ---------------------------------------------------------------------------

const NOON = new Date("2026-09-17T12:00:00").getTime();

describe("planPlacementSchedule — the two stages sharing a day", () => {
  /**
   * A rebuild happens while the day is already under way. Every placement match is
   * reported, so the barrier is open and the knockouts are the only thing left to
   * place.
   *
   * The knockout pass used to plan from the day's opening time rather than from the
   * clock, so a 12:00 rebuild on a day that opened at 09:00 handed matches a 09:00
   * start. The desk reads a start time that has gone by as "ready now" and sends a
   * player out for a slot that never existed.
   */
  it("never plans a knockout in the past when the day is rebuilt mid-play", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "knockout",
      teams,
      entrants,
      now: NOON,
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:00:00",
          ended_at: "2026-09-17T09:30:00",
        }),
      ],
      tierMatches: [tierMatch("k-1", 1, 1, "e3", "e4")],
    });

    const knockout = result.slots.find((slot) => slot.matchId === "k-1");
    expect(knockout).toBeDefined();
    expect(knockout!.start.getTime()).toBeGreaterThanOrEqual(NOON);
  });

  /**
   * A placement match that overran its slot still holds its court. The knockout pass
   * used to drop every reported placement anchor, so a knockout could be placed on
   * that court at that time: two matches, one court, one player in both.
   */
  it("keeps the knockouts off a court a played placement match still holds", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "knockout",
      teams,
      entrants,
      courts: [court(1)],
      now: new Date("2026-09-17T09:20:00").getTime(),
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e2", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:00:00",
          // Ran twenty minutes long, so the court is not really free until 09:50.
          ended_at: "2026-09-17T09:50:00",
        }),
      ],
      tierMatches: [tierMatch("k-1", 1, 1, "e3", "e4")],
    });

    const knockout = result.slots.find((slot) => slot.matchId === "k-1");
    expect(knockout).toBeDefined();
    expect(knockout!.start.getTime()).toBeGreaterThanOrEqual(
      new Date("2026-09-17T09:50:00").getTime(),
    );
  });

  /**
   * Rest is what those anchors are really protecting, so a match whose player is
   * still resting cannot be pulled forward onto another court either.
   */
  it("holds a knockout until the players a placement match used have had their rest", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "knockout",
      teams,
      entrants,
      now: new Date("2026-09-17T09:40:00").getTime(),
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e3", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:00:00",
          ended_at: "2026-09-17T09:40:00",
        }),
      ],
      // e1 and e3 played it, so e1's rest gap binds this one.
      tierMatches: [tierMatch("k-1", 1, 1, "e1", "e2")],
    });

    const knockout = result.slots.find((slot) => slot.matchId === "k-1");
    expect(knockout).toBeDefined();
    // Knockout rest gap is 30 minutes, measured from the placement finish.
    expect(knockout!.start.getTime()).toBeGreaterThanOrEqual(
      new Date("2026-09-17T10:10:00").getTime(),
    );
  });

  /**
   * Courts get switched off part way through an event. A match already played on one
   * of them is still history: it must not refuse the whole build, and it still holds
   * its players' rest.
   */
  it("plans around a played match on a court the day no longer plays on", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "knockout",
      teams,
      entrants,
      // Court two only: the match below was played on court one.
      courts: [court(2)],
      now: new Date("2026-09-17T09:40:00").getTime(),
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e3", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:00:00",
          ended_at: "2026-09-17T09:40:00",
        }),
      ],
      tierMatches: [tierMatch("k-1", 1, 1, "e1", "e2")],
    });

    expect(result.blocked).toEqual([]);
    const knockout = result.slots.find((slot) => slot.matchId === "k-1");
    expect(knockout).toBeDefined();
    expect(knockout!.courtNumber).toBe(2);
    expect(knockout!.start.getTime()).toBeGreaterThanOrEqual(
      new Date("2026-09-17T10:10:00").getTime(),
    );
  });

  /**
   * A match reported before it was ever laid out on a court has a real finish and no
   * court. It is an anchor for its players and nothing else, and it must not make the
   * scheduler refuse the batch for naming a court it never had.
   */
  it("accepts a played match that was never given a court", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "placement",
      teams,
      entrants,
      now: new Date("2026-09-17T09:40:00").getTime(),
      placementMatches: [
        placementMatch("r1-1", "round1", "e1", "e3", {
          status: "walkover",
          ended_at: "2026-09-17T09:30:00",
        }),
        // Something still to play, so the placement stage actually runs.
        placementMatch("r1-2", "round1", "e2", "e4"),
      ],
    });

    expect(result.blocked).toEqual([]);
    expect(result.summary.anchorCount).toBe(1);
    expect(result.placementSlotPayload.map((slot) => slot.match_id)).toEqual(["r1-2"]);
  });

  /**
   * Both stages can be placed on one day, and the knockout pass is handed the day's
   * placement slots as anchors so the two cannot collide. Those anchors are echoes of
   * slots the placement pass has already recorded, so they must not be recorded a
   * second time: one match in the plan twice means the preview lists it twice, the
   * write sends it twice, and a rebuild looks like it moved a match it never touched.
   */
  it("records a match once even though both stages are placed on the same day", () => {
    const { teams, entrants } = fourTeams();
    const result = plan({
      stage: "knockout",
      teams,
      entrants,
      now: NOON,
      // Still to play, so the placement pass runs and places it.
      placementMatches: [placementMatch("r2-1", "round2", "e1", "e2")],
      tierMatches: [tierMatch("k-1", 1, 1, "e3", "e4")],
    });

    const ids = result.slots.map((slot) => slot.matchId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.placementSlotPayload.map((slot) => slot.match_id)).toEqual(["r2-1"]);
    expect(result.knockoutSlotPayload.map((slot) => slot.match_id)).toEqual(["k-1"]);
  });
});

// ---------------------------------------------------------------------------
// Slicing a running order by day
// ---------------------------------------------------------------------------

describe("sliceRowsByDay", () => {
  /** A row is anything with a start, so the slice helper is testable without a match. */
  const row = (id: string, at: string) => ({ id, start: new Date(at) });
  const startOf = (r: { start: Date }) => r.start;

  it("keeps every day, including one with nothing on it", () => {
    // The reason this view exists: a two-day tournament shows two days, so the
    // second is visible before anything has been placed on it.
    const slices = sliceRowsByDay(
      [row("a", "2026-09-17T09:00:00")],
      [queueDay(1, "09:00:00", "18:00:00"), queueDay(2, "09:00:00", "18:00:00")],
      startOf,
    );

    expect(slices.map((slice) => slice.day.day_number)).toEqual([1, 2]);
    expect(slices[0]!.rows.map((r) => r.id)).toEqual(["a"]);
    expect(slices[1]!.rows).toEqual([]);
  });

  it("puts a row that runs past midnight on the day that opened", () => {
    // Day one closes at 23:59 and day two opens at 00:00, so a row on either side of
    // midnight is what a calendar-date grouping would split wrongly. Bucketing by
    // "which day had already opened" is what keeps it on the right one, and this is
    // the shape the live two-day event actually has.
    const slices = sliceRowsByDay(
      [row("late", "2026-09-17T23:50:00"), row("early", "2026-09-18T00:10:00")],
      [queueDay(1, "23:36:00", "23:59:00"), queueDay(2, "00:00:00", "01:30:00")],
      startOf,
    );

    expect(slices[0]!.rows.map((r) => r.id)).toEqual(["late"]);
    expect(slices[1]!.rows.map((r) => r.id)).toEqual(["early"]);
  });

  it("keeps a row that overruns the last day on that last day", () => {
    // The last day is allowed to overrun its closing time, so a row starting after
    // `end_time` — here past midnight, on the next calendar date — still belongs to
    // the day it is the tail of. This is the case that would fall off the end of the
    // schedule if rows were matched to a day by calendar date.
    const slices = sliceRowsByDay(
      [row("overrun", "2026-09-19T00:20:00")],
      [queueDay(1, "09:00:00", "18:00:00"), queueDay(2, "09:00:00", "23:30:00")],
      startOf,
    );

    expect(slices[0]!.rows).toEqual([]);
    expect(slices[1]!.rows.map((r) => r.id)).toEqual(["overrun"]);
  });

  it("attributes a row from before opening to the first day", () => {
    // A match reported early is a real row with a real time; showing it on the first
    // day beats dropping it from a schedule it is part of.
    const slices = sliceRowsByDay(
      [row("early", "2026-09-17T08:40:00")],
      [queueDay(1, "09:00:00", "18:00:00"), queueDay(2, "09:00:00", "18:00:00")],
      startOf,
    );

    expect(slices[0]!.rows.map((r) => r.id)).toEqual(["early"]);
  });

  it("orders days by day number, not by the order they were given", () => {
    const slices = sliceRowsByDay(
      [],
      [queueDay(2, "09:00:00", "18:00:00"), queueDay(1, "09:00:00", "18:00:00")],
      startOf,
    );

    expect(slices.map((slice) => slice.day.day_number)).toEqual([1, 2]);
  });

  it("preserves the given order of rows inside a day", () => {
    // The caller hands rows over sorted by time, so each slice has to come back
    // sorted by time. A slice that re-ordered them would put the running order out
    // of order.
    const slices = sliceRowsByDay(
      [
        row("first", "2026-09-17T09:00:00"),
        row("second", "2026-09-17T10:00:00"),
        row("third", "2026-09-17T11:00:00"),
      ],
      [queueDay(1, "09:00:00", "18:00:00")],
      startOf,
    );

    expect(slices[0]!.rows.map((r) => r.id)).toEqual(["first", "second", "third"]);
  });

  it("returns nothing for a tournament with no days", () => {
    expect(sliceRowsByDay([row("a", "2026-09-17T09:00:00")], [], startOf)).toEqual([]);
  });

  /** A day with a chosen date, so the two orders can be pulled apart on purpose. */
  const dayAt = (dayNumber: number, date: string): TournamentDay => ({
    ...queueDay(dayNumber, "09:00:00", "18:00:00"),
    date,
  });

  it("files a row by the day it falls in even when the dates are out of order", () => {
    // The scan takes the *last* window start at or before the row, which is only
    // correct while the windows ascend. Day 2 is dated before day 1 here, so walking
    // by `day_number` would make the scan read descending starts and file both rows
    // under day 2 — the whole of day 1 would vanish. Sorting by window start first
    // keeps each row on the day it actually falls in, and `day_number` only breaks
    // ties, so the slices still come back in the order the app labels them.
    const slices = sliceRowsByDay(
      [row("onDayTwo", "2026-09-20T10:00:00"), row("onDayOne", "2026-09-21T10:00:00")],
      [dayAt(1, "2026-09-21"), dayAt(2, "2026-09-20")],
      startOf,
    );

    // Chronological, so the earlier-dated day comes back first despite its number.
    expect(slices.map((slice) => slice.day.day_number)).toEqual([2, 1]);
    expect(slices[0]!.rows.map((r) => r.id)).toEqual(["onDayTwo"]);
    expect(slices[1]!.rows.map((r) => r.id)).toEqual(["onDayOne"]);
  });

  it("leaves a gap between days alone", () => {
    // Days need not be consecutive: the tournament simply has no capacity in between,
    // and a row on the far side of the gap still belongs to the day that opened.
    const slices = sliceRowsByDay(
      [row("first", "2026-09-20T10:00:00"), row("later", "2026-09-25T10:00:00")],
      [dayAt(1, "2026-09-20"), dayAt(2, "2026-09-25")],
      startOf,
    );

    expect(slices.map((slice) => slice.day.day_number)).toEqual([1, 2]);
    expect(slices[0]!.rows.map((r) => r.id)).toEqual(["first"]);
    expect(slices[1]!.rows.map((r) => r.id)).toEqual(["later"]);
  });
});

// ---------------------------------------------------------------------------
// Completeness: a plan that would strand an already-scheduled match
// ---------------------------------------------------------------------------

/**
 * The writer clears every `scheduled` row of a stage and re-sets only what the
 * payload names, so a row left out of the payload loses its court and time.
 *
 * These cases exist because that failure used to surface only as the database
 * guard's "Placement rebuild left assigned matches without a court or time", which
 * names neither the match nor the cause. The cause is a planner input that never
 * loaded: with no teams or no entrants, every match resolves to "waiting for its
 * players", so `blocked` stays empty and the payload comes out silent.
 */
describe("uncoveredScheduledMatches", () => {
  const withMatches = (
    placementMatches: PlacementMatch[],
    overrides: Partial<PlanPlacementScheduleInput> = {},
  ) => plan({ placementMatches, ...overrides });

  it("reports a scheduled row the payload does not cover", () => {
    const matches = [
      placementMatch("m1", "round1", "e1", "e2"),
      placementMatch("m2", "round1", "e3", "e4"),
    ];
    const result = withMatches(matches);

    // Both rows are placable, so the plan covers them and the writer may proceed.
    expect(uncoveredScheduledMatches(result)).toEqual({ placement: [], knockout: [] });
    expect(result.placementScheduledIds.sort()).toEqual(["m1", "m2"]);
  });

  it("flags every row when the team list has not loaded", () => {
    const matches = [
      placementMatch("m1", "round1", "e1", "e2"),
      placementMatch("m2", "round1", "e3", "e4"),
    ];
    const result = withMatches(matches, { teams: [] });

    // The whole point: nothing is `blocked`, so the old guard in
    // `applyPlacementSchedulePlan` would have let this payload through.
    expect(result.blocked).toEqual([]);
    expect(result.awaitingTeams.sort()).toEqual(["m1", "m2"]);
    expect(result.placementSlotPayload).toEqual([]);
    expect(uncoveredScheduledMatches(result).placement.sort()).toEqual(["m1", "m2"]);
  });

  it("flags every row when the entrant list has not loaded", () => {
    const matches = [placementMatch("m1", "round1", "e1", "e2")];
    const result = withMatches(matches, { entrants: [] });

    expect(result.blocked).toEqual([]);
    expect(uncoveredScheduledMatches(result).placement).toEqual(["m1"]);
  });

  it("does not count rows the writer never clears", () => {
    const matches = [
      // Already decided and played: an anchor, cleared by nobody.
      placementMatch("done", "round1", "e1", "e2", {
        status: "reported",
        scheduled_time: "2026-09-17T09:00:00Z",
        winner_id: "e1",
      }),
      // Voided by the desk.
      placementMatch("void", "round1", "e3", "e4", { status: "void" }),
      placementMatch("live", "round1", "e1", "e3"),
    ];
    const result = withMatches(matches);

    expect(result.placementScheduledIds).toEqual(["live"]);
    expect(uncoveredScheduledMatches(result)).toEqual({ placement: [], knockout: [] });
  });

  it("keeps the two stages separate", () => {
    // A knockout bye is excluded by the RPC, so it is excluded here too: counting it
    // would refuse a plan the writer would have accepted.
    const knockout = tierMatch("k1", 1, 1, null, null, { is_bye: true });
    const result = withMatches([], { tierMatches: [knockout] });

    expect(result.knockoutScheduledIds).toEqual([]);
    expect(uncoveredScheduledMatches(result)).toEqual({ placement: [], knockout: [] });
  });

  it("ignores a knockout slot still waiting on a feeder", () => {
    // The whole bracket exists from the draw. A slot with an undecided side has no court or
    // time to lose, so the writer's completeness check must not count it.
    const waiting = tierMatch("k1", 2, 1, "e1", null, { status: "scheduled" });
    const empty = tierMatch("k2", 3, 1, null, null, { status: "scheduled" });
    const result = withMatches([], { tierMatches: [waiting, empty] });

    expect(result.knockoutScheduledIds).toEqual([]);
    expect(uncoveredScheduledMatches(result).knockout).toEqual([]);
  });

  it("reports a knockout fixture with two entrants that the planner could not place", () => {
    // Entrants named but not resolvable to players: ready on paper, unplaced in practice,
    // and the writer must refuse rather than strip it of a court it never had.
    const knockout = tierMatch("k1", 1, 1, "ghost-a", "ghost-b", { status: "scheduled" });
    const result = withMatches([], { tierMatches: [knockout] });

    expect(result.knockoutScheduledIds).toEqual(["k1"]);
    expect(uncoveredScheduledMatches(result).knockout).toEqual(["k1"]);
  });
});

// ---------------------------------------------------------------------------
// Projecting an applied plan onto the cached rows
// ---------------------------------------------------------------------------

/**
 * The page shows the running order from the query cache, so after a build it has to
 * reflect the plan the writer just accepted rather than wait for a refetch that may
 * never land. These cases pin the projection to what the RPC actually does: it clears
 * every scheduled row of the stage and then re-sets exactly the payload's ids.
 */
describe("projectSlotsOntoMatches", () => {
  const slot = (matchId: string, at: string, court: string) => ({
    match_id: matchId,
    scheduled_time: at,
    court_id: court,
  });

  it("fills in the rows the payload names", () => {
    const rows = projectSlotsOntoMatches(
      [placementMatch("m1", "round1", "e1", "e2"), placementMatch("m2", "round1", "e3", "e4")],
      [slot("m1", "2026-09-17T09:00:00Z", "c1"), slot("m2", "2026-09-17T09:20:00Z", "c2")],
    );

    expect(rows.map((row) => [row.id, row.scheduled_time, row.court_id])).toEqual([
      ["m1", "2026-09-17T09:00:00Z", "c1"],
      ["m2", "2026-09-17T09:20:00Z", "c2"],
    ]);
  });

  it("empties a scheduled row the payload leaves out, the way the writer does", () => {
    // The RPC clears the stage before it re-sets it, so a row the payload omits is a row
    // that has just lost its court and time. Showing the old time would be the lie.
    const rows = projectSlotsOntoMatches(
      [
        placementMatch("m1", "round1", "e1", "e2", {
          scheduled_time: "2026-09-17T08:00:00Z",
          court_id: "c9",
        }),
      ],
      [],
    );

    expect(rows[0]?.scheduled_time).toBeNull();
    expect(rows[0]?.court_id).toBeNull();
  });

  it("never moves an anchor", () => {
    // Reported, started and void rows are outside the writer's WHERE clause.
    const anchors = [
      placementMatch("done", "round1", "e1", "e2", {
        status: "reported",
        scheduled_time: "2026-09-17T09:00:00Z",
        court_id: "c1",
      }),
      placementMatch("void", "round1", "e3", "e4", { status: "void", court_id: null }),
    ];
    const rows = projectSlotsOntoMatches(anchors, [slot("done", "2026-09-17T11:00:00Z", "c4")]);

    expect(rows.map((row) => row.scheduled_time)).toEqual(["2026-09-17T09:00:00Z", null]);
    expect(rows[0]?.court_id).toBe("c1");
  });

  it("leaves a bye alone, because the writer's clear skips them", () => {
    const bye = tierMatch("k1", 1, 1, null, null, { is_bye: true, court_id: null });
    const rows = projectSlotsOntoMatches([bye], []);

    expect(rows[0]).toEqual(bye);
  });

  it("projects the knockout payload onto the tier rows", () => {
    const rows = projectSlotsOntoMatches(
      [tierMatch("k1", 1, 1, "e1", "e2")],
      [slot("k1", "2026-09-17T10:00:00Z", "c3")],
    );

    expect(rows[0]?.scheduled_time).toBe("2026-09-17T10:00:00Z");
    expect(rows[0]?.court_id).toBe("c3");
  });
});

// ---------------------------------------------------------------------------
// Near-term freeze
// ---------------------------------------------------------------------------

/**
 * A rebuild used to reconsider everything, so a match the desk was about to be called for could be
 * handed a new time or a new court by a rebuild that had not been asked to change it. The freeze is
 * the smallest guarantee that stops it: whatever is next on each court stays put.
 *
 * `frozenMatchIds` is deliberately not `fixedMatchIds`. A frozen row is still `scheduled` — the desk
 * has not played it — so the writer must still place it and the preview must still show it. Treating
 * the two as one set is the trap these tests exist to catch: the payload would drop the row, and
 * `applyPlacementSchedulePlan` would refuse the whole build.
 */
describe("planPlacementSchedule — near-term freeze", () => {
  /** A committed row: still `scheduled`, but already on a court at a time. */
  const committed = (
    id: string,
    entrantA: string,
    entrantB: string,
    courtId: string,
    time: string,
  ) =>
    placementMatch(id, "round1", entrantA, entrantB, {
      status: "scheduled",
      court_id: courtId,
      // Stored as an instant, the way a row comes back from the database. The diff compares the
      // current time as a string, so a hand-written local-looking literal would read as a move.
      scheduled_time: new Date(time).toISOString(),
    });

  it("pins the next committed match on each court and leaves it in the payload", () => {
    const result = plan({
      placementMatches: [
        committed("late", "e1", "e2", "c2", "2026-09-17T14:00:00"),
        placementMatch("free", "round1", "e3", "e4"),
      ],
    });

    // Frozen for the solver, but not decided history, so the two sets disagree.
    expect(result.frozenMatchIds).toEqual(["late"]);
    expect(result.fixedMatchIds).toEqual([]);
    expect(result.summary.anchorCount).toBe(0);

    // The row is still `scheduled`, so the writer must still name it or the RPC fails the build.
    expect(result.placementSlotPayload.map((slot) => slot.match_id).sort()).toEqual([
      "free",
      "late",
    ]);
    expect(uncoveredScheduledMatches(result)).toEqual({ placement: [], knockout: [] });

    const pinned = result.slots.find((slot) => slot.matchId === "late");
    expect(pinned?.start.toISOString()).toBe(new Date("2026-09-17T14:00:00").toISOString());
    expect(pinned?.courtNumber).toBe(2);
  });

  it("reports a frozen match in the rebuild preview as unchanged rather than dropping it", () => {
    const result = plan({
      placementMatches: [
        committed("late", "e1", "e2", "c2", "2026-09-17T14:00:00"),
        placementMatch("free", "round1", "e3", "e4"),
      ],
    });

    const change = result.diff.changes.find((entry) => entry.matchId === "late");
    expect(change?.kind).toBe("unchanged");
    // Counted as placed, not as an anchor: the preview must not under-count the rebuild.
    expect(result.diff.placedCount).toBe(result.diff.changes.length);
    expect(result.diff.changes.map((entry) => entry.matchId).sort()).toEqual(["free", "late"]);
  });

  it("releases a match the day has already passed and keeps one exactly at the floor", () => {
    // `now` is 09:00, so the planner's floor is the next whole minute, also 09:00. A pin one
    // minute earlier is a time the desk cannot act on any more, so it is released and the solver
    // pulls it forward; one exactly at the floor is still the match about to be called and is kept.
    const result = plan({
      placementMatches: [
        committed("passed", "e1", "e2", "c1", "2026-09-17T08:59:00"),
        committed("kept", "e3", "e4", "c2", "2026-09-17T09:00:00"),
      ],
    });

    expect(result.frozenMatchIds).toEqual(["kept"]);
    const kept = result.slots.find((slot) => slot.matchId === "kept");
    expect(kept?.start.toISOString()).toBe(new Date("2026-09-17T09:00:00").toISOString());
    // The released row is still placed, at the floor rather than at its stale time.
    const passed = result.slots.find((slot) => slot.matchId === "passed");
    expect(passed?.start.getTime()).toBeGreaterThanOrEqual(DAY_START);
  });

  it("freezes only the earliest committed match on a court, not the whole queue", () => {
    const result = plan({
      placementMatches: [
        committed("first", "e1", "e2", "c1", "2026-09-17T10:00:00"),
        committed("second", "e3", "e4", "c1", "2026-09-17T11:00:00"),
      ],
    });

    // One per court, which is the whole guarantee. `second` is still the solver's to move.
    expect(result.frozenMatchIds).toEqual(["first"]);
    expect(result.fixedMatchIds).toEqual([]);
  });

  it("freezes a longer window only when one is asked for", () => {
    const matches = [
      committed("first", "e1", "e2", "c1", "2026-09-17T10:00:00"),
      committed("second", "e3", "e4", "c2", "2026-09-17T10:30:00"),
    ];

    // Default 0: one match per court.
    expect(plan({ placementMatches: matches }).frozenMatchIds).toEqual(["first", "second"]);

    // Two rows on one court, 90 minutes apart, with a 2-hour horizon from 09:00: both are inside.
    const wide = plan({
      placementMatches: [
        committed("first", "e1", "e2", "c1", "2026-09-17T10:00:00"),
        committed("second", "e3", "e4", "c1", "2026-09-17T11:30:00"),
      ],
      freezeHorizonMinutes: 180,
    });
    expect(wide.frozenMatchIds).toEqual(["first", "second"]);
  });

  it("leaves a row movable when the day does not play its court", () => {
    // Pinning it would make it an anchor with no slot of its own, so the payload would drop a
    // `scheduled` row and `applyPlacementSchedulePlan` would refuse the build. Re-placing it on a
    // court the day does play is the only answer that keeps the write whole.
    const result = plan({
      courts: [court(1)],
      placementMatches: [
        committed("elsewhere", "e1", "e2", "c2", "2026-09-17T10:00:00"),
        placementMatch("free", "round1", "e3", "e4"),
      ],
    });

    expect(result.frozenMatchIds).toEqual([]);
    expect(uncoveredScheduledMatches(result)).toEqual({ placement: [], knockout: [] });
  });

  it("leaves a row movable when a reported match has overrun into its window", () => {
    // Two fixed matches overlapping on one court is a physical impossibility the problem validator
    // rejects outright, so the pin has to give way rather than the build.
    const result = plan({
      placementMatches: [
        placementMatch("played", "round1", "e1", "e2", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T09:00:00",
          ended_at: "2026-09-17T11:00:00",
        }),
        committed("clash", "e3", "e4", "c1", "2026-09-17T10:00:00"),
      ],
    });

    expect(result.frozenMatchIds).toEqual([]);
    expect(result.fixedMatchIds).toEqual(["played"]);
  });

  it("freezes a knockout row too, and keeps it in the knockout payload", () => {
    const result = plan({
      placementMatches: [],
      tierMatches: [
        tierMatch("k1", 1, 1, "e1", "e2", {
          status: "scheduled",
          court_id: "c1",
          scheduled_time: "2026-09-17T15:00:00",
        }),
      ],
    });

    expect(result.frozenMatchIds).toEqual(["k1"]);
    expect(result.knockoutSlotPayload.map((slot) => slot.match_id)).toEqual(["k1"]);
    expect(uncoveredScheduledMatches(result)).toEqual({ placement: [], knockout: [] });
  });

  it("does not move a frozen match to make room for a better finish", () => {
    // The point of the freeze over an objective term: it is a guarantee, not a preference. A
    // strongly preferred placement elsewhere cannot buy the pinned slot.
    const result = plan({
      placementMatches: [
        committed("pinned", "e1", "e2", "c1", "2026-09-17T17:00:00"),
        placementMatch("free", "round1", "e3", "e4"),
      ],
    });

    const pinned = result.slots.find((slot) => slot.matchId === "pinned");
    expect(pinned?.start.toISOString()).toBe(new Date("2026-09-17T17:00:00").toISOString());
    expect(pinned?.courtNumber).toBe(1);
  });
});

describe("frozenMatchIdsFor", () => {
  const at = (time: string) => new Date(time).getTime();

  it("picks the earliest row on each court and ignores rows with no court or no time", () => {
    expect(
      frozenMatchIdsFor({
        committed: [
          { id: "a", courtNumber: 1, start: at("2026-09-17T10:00:00") },
          { id: "b", courtNumber: 1, start: at("2026-09-17T09:00:00") },
          { id: "c", courtNumber: 2, start: at("2026-09-17T12:00:00") },
          { id: "d", courtNumber: null, start: at("2026-09-17T09:00:00") },
          { id: "e", courtNumber: 3, start: null },
        ],
        now: at("2026-09-17T09:00:00"),
      }),
    ).toEqual(["b", "c"]);
  });

  it("breaks a tie on the court by id, so the choice is canonical", () => {
    expect(
      frozenMatchIdsFor({
        committed: [
          { id: "z", courtNumber: 1, start: at("2026-09-17T10:00:00") },
          { id: "a", courtNumber: 1, start: at("2026-09-17T10:00:00") },
        ],
        now: 0,
      }),
    ).toEqual(["a"]);
  });

  it("extends to a window when one is asked for, and never shrinks below one per court", () => {
    const committed = [
      { id: "next", courtNumber: 1, start: at("2026-09-17T10:00:00") },
      { id: "later", courtNumber: 1, start: at("2026-09-17T11:00:00") },
      { id: "dayEnd", courtNumber: 2, start: at("2026-09-17T18:00:00") },
    ];
    const now = at("2026-09-17T09:00:00");

    // A zero horizon is exactly the per-court guarantee.
    expect(frozenMatchIdsFor({ committed, now })).toEqual(["dayEnd", "next"]);
    // One hour from 09:00 does not reach either follower.
    expect(frozenMatchIdsFor({ committed, now, horizonMinutes: 60 })).toEqual(["dayEnd", "next"]);
    // Two hours reaches the 11:00 follower but not the 18:00 one.
    expect(frozenMatchIdsFor({ committed, now, horizonMinutes: 120 })).toEqual([
      "dayEnd",
      "later",
      "next",
    ]);
    // A negative horizon is read as zero rather than un-freezing the per-court pin.
    expect(frozenMatchIdsFor({ committed, now, horizonMinutes: -60 })).toEqual(["dayEnd", "next"]);
  });

  it("returns nothing when there is nothing committed", () => {
    expect(frozenMatchIdsFor({ committed: [], now: 0 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyFreeze — a pin has to be a legal time
// ---------------------------------------------------------------------------

/**
 * `applyFreeze` pins the next committed match on each court only when its current time is still
 * legal: at or after the planner's floor, outside the day's breaks, inside a non-final day's close,
 * and with its rest honoured against decided history and against the other pins. A time that fails
 * any of those is not a time the solver would have chosen, so the row is left movable and re-placed
 * rather than preserved.
 *
 * A frozen item is `fixed: true` in the problem, and the validators exempt a fixed match from the
 * floor, the hard end, breaks and rest — an exemption for decided history. The freeze must therefore
 * make that claim honestly, or a stale pin would ride through the run as if it were a result.
 */
describe("applyFreeze — a pin has to be a legal time", () => {
  /** Still `scheduled`, but already on a court at a time, which is what the freeze reads. */
  const committed = (id: string, entrantA: string, entrantB: string, courtId: string, time: string) =>
    placementMatch(id, "round1", entrantA, entrantB, {
      status: "scheduled",
      court_id: courtId,
      scheduled_time: new Date(time).toISOString(),
    });

  it("releases a committed match whose time is already in the past", () => {
    // 08:00 is an hour before the day opens and before the planner's `now`, so it is not a time
    // the desk can act on. It is left movable and the solver puts it back at the floor.
    const result = plan({
      placementMatches: [
        committed("past", "e1", "e2", "c1", "2026-09-17T08:00:00"),
        placementMatch("free", "round1", "e3", "e4"),
      ],
    });

    expect(result.frozenMatchIds).toEqual([]);
    const released = result.slots.find((slot) => slot.matchId === "past");
    expect(released?.start.getTime()).toBeGreaterThanOrEqual(DAY_START);
  });

  it("releases a committed match that now sits inside a day break", () => {
    // The row is committed at 10:15, which the 10:00-11:00 break now covers. The freeze does not
    // keep it there: left movable, the day runner steps it wholly past the break.
    const result = plan({
      breaks: [dayBreak("10:00:00", "11:00:00")],
      placementMatches: [
        committed("inbreak", "e1", "e2", "c1", "2026-09-17T10:15:00"),
        placementMatch("free", "round1", "e3", "e4"),
      ],
    });

    expect(result.frozenMatchIds).toEqual([]);
    const released = result.slots.find((slot) => slot.matchId === "inbreak");
    // Either side of the break is fine; inside it is not, and a released row is placed at the
    // earliest slot rather than kept at the time the break now covers.
    const breakStart = new Date("2026-09-17T10:00:00").getTime();
    const breakEnd = new Date("2026-09-17T11:00:00").getTime();
    expect(
      released!.end.getTime() <= breakStart || released!.start.getTime() >= breakEnd,
    ).toBe(true);
  });

  it("releases a committed match that would straddle a break", () => {
    // 09:50-10:20 crosses the 10:00 break rather than sitting wholly inside it. Overlap is what
    // matters: a match cannot be paused part-way, so the pin must step wholly to one side.
    const result = plan({
      breaks: [dayBreak("10:00:00", "11:00:00")],
      placementMatches: [
        committed("straddle", "e1", "e2", "c1", "2026-09-17T09:50:00"),
        placementMatch("free", "round1", "e3", "e4"),
      ],
    });

    expect(result.frozenMatchIds).toEqual([]);
    const released = result.slots.find((slot) => slot.matchId === "straddle")!;
    const breakStart = new Date("2026-09-17T10:00:00").getTime();
    const breakEnd = new Date("2026-09-17T11:00:00").getTime();
    expect(
      released.end.getTime() <= breakStart || released.start.getTime() >= breakEnd,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyFreeze — closing time and the player conflicts
// ---------------------------------------------------------------------------

/**
 * The rest of the legality claim: a pin must not finish after a non-final day's close, must not
 * break rest with decided history, and must not fight another pin over a shared player. The last is
 * the reflow's held pair — two still-`scheduled` rows that share a player and overlap on different
 * courts — which the per-court freeze would otherwise pin together and preserve.
 */
describe("applyFreeze — closing time and the player conflicts", () => {
  const committed = (
    id: string,
    entrantA: string,
    entrantB: string,
    courtId: string,
    time: string,
  ) =>
    placementMatch(id, "round1", entrantA, entrantB, {
      status: "scheduled",
      court_id: courtId,
      scheduled_time: new Date(time).toISOString(),
    });

  it("still pins a legal row, so the ordinary case is unchanged", () => {
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "18:00:00")],
      courts: [court(1)],
      placementMatches: [committed("next", "e1", "e2", "c1", "2026-09-17T10:00:00")],
    });

    expect(result.frozenMatchIds).toEqual(["next"]);
    const pinned = result.slots.find((slot) => slot.matchId === "next");
    expect(pinned?.start.toISOString()).toBe(new Date("2026-09-17T10:00:00").toISOString());
    expect(pinned?.courtNumber).toBe(1);
  });

  it("releases a pin that would finish after a non-final day's close", () => {
    // 17:45 + a 30 minute slot ends 18:15, past the 18:00 close. Day two is still to come, so the
    // spill has somewhere to go and the pin is not a time the day can honour.
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "18:00:00"), queueDay(2, "09:00:00", "18:00:00")],
      courts: [court(1)],
      placementMatches: [
        committed("late", "e1", "e2", "c1", "2026-09-17T17:45:00"),
        placementMatch("free", "round1", "e3", "e4"),
      ],
    });

    expect(result.frozenMatchIds).toEqual([]);
  });

  it("keeps a pin that would finish after the final day's close, which may overrun", () => {
    // The same 18:15 finish, on the last day that has courts. The last day is where a long plan is
    // allowed to overrun, so there is nothing to fix and the pin stands.
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "18:00:00"), queueDay(2, "09:00:00", "18:00:00")],
      courts: [court(1)],
      placementMatches: [committed("late", "e1", "e2", "c1", "2026-09-18T17:45:00")],
    });

    expect(result.frozenMatchIds).toEqual(["late"]);
    const pinned = result.slots.find((slot) => slot.matchId === "late");
    expect(pinned?.start.toISOString()).toBe(new Date("2026-09-18T17:45:00").toISOString());
  });

  it("releases a pin that breaks rest with a decided match on another court", () => {
    // `played` is reported and ended at 10:30; `next` is committed at 10:40 and shares a player, and
    // the placement gap is 20 minutes. The row is not a legal pin, so the solver pushes it out.
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "18:00:00")],
      courts: [court(1), court(2)],
      placementMatches: [
        placementMatch("played", "round1", "e1", "e2", {
          status: "reported",
          court_id: "c1",
          scheduled_time: "2026-09-17T10:00:00",
          ended_at: "2026-09-17T10:30:00",
        }),
        committed("next", "e1", "e3", "c2", "2026-09-17T10:40:00"),
      ],
    });

    expect(result.frozenMatchIds).toEqual([]);
    const decided = result.slots.find((slot) => slot.matchId === "played")!;
    const released = result.slots.find((slot) => slot.matchId === "next")!;
    // Re-placed clear of the decided row by the placement rest gap, on whichever side fits.
    const gap = Math.max(
      decided.start.getTime() - released.end.getTime(),
      released.start.getTime() - decided.end.getTime(),
    );
    expect(gap).toBeGreaterThanOrEqual(20 * MINUTE);
  });

  it("keeps only the earlier of two pins that share a player across courts", () => {
    // The reflow's held pair: `early` on court 1 at 10:00 and `later` on court 2 at 10:15 share a
    // player. Each is the next committed row on its own court, so the per-court freeze would pin
    // both and keep the overlap. Processing earliest-first drops the later one instead.
    const result = scheduleQueue({
      days: [queueDay(1, "09:00:00", "18:00:00")],
      courts: [court(1), court(2)],
      placementMatches: [
        committed("early", "e1", "e2", "c1", "2026-09-17T10:00:00"),
        committed("later", "e1", "e3", "c2", "2026-09-17T10:15:00"),
      ],
    });

    expect(result.frozenMatchIds).toEqual(["early"]);
    const pinned = result.slots.find((slot) => slot.matchId === "early")!;
    const released = result.slots.find((slot) => slot.matchId === "later")!;
    expect(released).toBeDefined();
    // Re-placed clear of the pinned row by the placement rest gap, on whichever side fits.
    const gap = Math.max(
      pinned.start.getTime() - released.end.getTime(),
      released.start.getTime() - pinned.end.getTime(),
    );
    expect(gap).toBeGreaterThanOrEqual(20 * MINUTE);
  });
});

// ---------------------------------------------------------------------------
// A fixed knockout on another event's court
// ---------------------------------------------------------------------------

/**
 * Two events share one day and one court pool. `cat1` has already reached its knockouts, so one of
 * its rows is a committed `scheduled` knockout that the freeze pins on court 1; `cat2` still has
 * placement work to place. Pass A (placement) and pass B (knockout) are separate solver runs, and
 * the placement pass did not see the other stage's fixed work, so it was free to hand court 1 at
 * 09:00 to `cat2`'s placement match. Pass B then held both as fixed on that same court, which the
 * problem validator refuses as a double booking — the whole plan was rejected before a single match
 * was placed.
 */
describe("planPlacementSchedule — a fixed knockout on another event's court", () => {
  /** cat1's knockout (optional) plus cat2's still-pending placement match, on two events. */
  function twoEvents(knockout?: { courtId: string; time: string }) {
    const teams = [
      team("team-a1", "p1", "p2"),
      team("team-a2", "p3", "p4"),
      { ...team("team-b1", "p5", "p6"), category_id: "cat2" },
      { ...team("team-b2", "p7", "p8"), category_id: "cat2" },
    ];
    const entrants = [
      entrant("ea1", "team-a1", 1),
      entrant("ea2", "team-a2", 2),
      { ...entrant("eb1", "team-b1", 1), category_id: "cat2" },
      { ...entrant("eb2", "team-b2", 2), category_id: "cat2" },
    ];
    return plan({
      teams,
      entrants,
      categoryOrder: new Map([
        ["cat1", 1],
        ["cat2", 2],
      ]),
      draws: [tierDraw("A")],
      placementMatches: [placementMatch("b1", "round1", "eb1", "eb2", { category_id: "cat2" })],
      tierMatches: knockout
        ? [
            tierMatch("k-1", 1, 1, "ea1", "ea2", {
              status: "scheduled",
              court_id: knockout.courtId,
              // Stored as an instant, the way a row comes back from the database.
              scheduled_time: new Date(knockout.time).toISOString(),
            }),
          ]
        : [],
    });
  }

  it("places the pending placement match without colliding with the pinned knockout", () => {
    const result = twoEvents({ courtId: "c1", time: "2026-09-17T09:00:00" });

    expect(result.blocked).toEqual([]);
    const placement = result.slots.find((slot) => slot.matchId === "b1");
    const knockout = result.slots.find((slot) => slot.matchId === "k-1");
    expect(placement).toBeDefined();
    expect(knockout).toBeDefined();
    // The knockout holds court 1 from 09:00, so nothing may be laid on top of it there.
    const collides =
      placement!.courtNumber === knockout!.courtNumber &&
      placement!.start < knockout!.end &&
      knockout!.start < placement!.end;
    expect(collides).toBe(false);
  });

  it("control: with no fixed knockout the plan is exactly as before", () => {
    const result = twoEvents();

    expect(result.blocked).toEqual([]);
    const placement = result.slots.find((slot) => slot.matchId === "b1");
    // Nothing is holding a court, so the placement match keeps the earliest slot it always had.
    expect(placement?.courtNumber).toBe(1);
    expect(placement?.start.toISOString()).toBe(new Date("2026-09-17T09:00:00").toISOString());
  });
});
