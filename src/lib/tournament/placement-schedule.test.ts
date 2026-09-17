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
} from "./data";
import { placementStagesForDay, stagesForDay } from "./data";
import {
  placementMatchLabel,
  placementStageLabel,
  planPlacementDay,
  type PlanPlacementDayInput,
} from "./placement-schedule";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOURNAMENT_ID = "t1";

function tournament(overrides: Partial<Tournament> = {}): Tournament {
  return {
    id: TOURNAMENT_ID,
    name: "Test Open",
    court_count: 2,
    created_at: "2026-09-17T00:00:00Z",
    day_count: 1,
    format: "two_round_placement",
    group_rest_gap_minutes: 20,
    group_slot_minutes: 30,
    is_active: true,
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
    status: "in_progress",
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

function plan(input: Partial<PlanPlacementDayInput> & { stage: "placement" | "knockout" }) {
  const { teams, entrants } = fourTeams();
  return planPlacementDay({
    day: 1,
    tournament: tournament(),
    dayConfig: DAY,
    courts: [court(1), court(2)],
    teams,
    entrants,
    draws: [tierDraw("A")],
    placementMatches: [],
    tierMatches: [],
    categoryOrder: new Map([["cat1", 1]]),
    options: FAST,
    now: DAY_START,
    ...input,
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
    expect(result.movableSlotPayload).toHaveLength(2);
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
    expect(result.movableSlotPayload.map((slot) => slot.match_id)).toEqual(["r1-2"]);
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
          scheduled_time: "2026-09-17T09:00:00.000Z",
        }),
        placementMatch("r1-2", "round1", "e3", "e4", {
          scheduled_time: "2026-09-17T09:30:00.000Z",
        }),
      ],
      now,
      courts: [court(1)],
    });

    const floor = Math.ceil(now / MINUTE) * MINUTE;
    for (const slot of result.movableSlotPayload) {
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
          scheduled_time: "2026-09-17T09:00:00.000Z",
          ended_at: "2026-09-17T09:30:00.000Z",
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
    const { teams, entrants } = fourTeams();
    const result = planPlacementDay({
      day: 1,
      stage: "placement",
      tournament: tournament({ group_slot_minutes: 30, knockout_slot_minutes: 45 }),
      dayConfig: DAY,
      courts: [court(1)],
      teams,
      entrants,
      draws: [],
      placementMatches: [placementMatch("r1-1", "round1", "e1", "e2")],
      tierMatches: [],
      categoryOrder: new Map(),
      options: FAST,
      now: DAY_START,
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
          scheduled_time: "2026-09-17T09:00:00.000Z",
        }),
        tierMatch("k-b", 1, 2, "e3", "e4", {
          status: "reported",
          ended_at: "2026-09-17T09:45:00.000Z",
          court_id: "c2",
          scheduled_time: "2026-09-17T09:00:00.000Z",
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
