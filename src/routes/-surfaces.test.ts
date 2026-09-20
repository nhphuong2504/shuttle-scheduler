import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Surface separation, asserted against the route sources.
 *
 * The split between the two tabs is a claim about what each one *renders*, so the honest way to
 * regression-test it is to read the files. These guards fail loudly if a tournament-wide metric
 * creeps back onto the desk, or if the removed capacity analysis reappears in the preview.
 */

const read = (relative: string) => readFileSync(join(__dirname, relative), "utf8");

describe("control desk is strictly day-scoped", () => {
  const desk = read("index.tsx");

  it("never invokes a forecast solver", () => {
    expect(desk).not.toMatch(/estimateFinish|forecastTournament/);
    expect(desk).not.toMatch(/finish-estimate/);
  });

  it("renders no tournament-wide finish or status", () => {
    expect(desk).not.toMatch(/<ScheduledFinish/);
    expect(desk).not.toMatch(/finishStatusLabel|targetFinishMs|estimatedFinishMs/);
    expect(desk).not.toMatch(/projectedFinish/);
  });

  it("consumes no desk-activity feed", () => {
    // A global audit feed has no day field, so it cannot be day-scoped. Operations history is
    // not a day metric, and the panel is removed rather than filtered.
    expect(desk).not.toMatch(/useDeskActivity|desk_activity|DeskActivity/);
  });

  it("derives its board from the selected day", () => {
    expect(desk).toMatch(/resolveSelectedDay/);
    expect(desk).toMatch(/attributeMatchesToDays/);
    expect(desk).toMatch(/dayOperationalCounts/);
    // The court board and court progress read the day's courts, not the venue's.
    expect(desk).toMatch(/courtsForDay/);
    expect(desk).toMatch(/<DayScheduleStatus/);
  });

  it("keeps untimed matches out of every day rather than guessing one", () => {
    expect(desk).toMatch(/attribution\.untimed/);
  });
});

describe("schedule tab owns tournament-wide planning", () => {
  const schedule = read("placement-schedule.tsx");

  it("measures the scheduled finish against the official close", () => {
    expect(schedule).toMatch(/officialCloseMs/);
    expect(schedule).toMatch(/scheduledFinishMs/);
    expect(schedule).toMatch(/<ScheduledFinish/);
    expect(schedule).toMatch(/closeMs=\{officialCloseMs\}/);
  });

  it("carries no finish forecast", () => {
    // There is no estimator any more. The only finish this page reports is the latest end among
    // matches that already have a time, measured against the official close.
    expect(schedule).not.toMatch(/estimateFinish|forecastTournament|FinishEstimate/);
  });

  it("does not reintroduce the removed capacity analysis", () => {
    expect(schedule).not.toMatch(/remainingUtilization/);
  });

  it("renders stage progress through the format-agnostic list", () => {
    expect(schedule).toMatch(/<StageProgressList/);
    expect(schedule).not.toMatch(/Round 1|Round 2/);
  });

  it("previews per-day changes from the plan's own diff", () => {
    expect(schedule).toMatch(/previewDayChanges/);
    expect(schedule).toMatch(/plan\.diff\.changes/);
  });

  it("waits for every planner input before it will build", () => {
    // A build reads the team, entrant, court, event, day and match lists. Planning from
    // one that has not loaded makes every match look like it is still waiting for its
    // players, which produces an empty payload that the database rejects as a half-built
    // day. The button and both handlers have to consult the same readiness flag.
    expect(schedule).toMatch(/planInputsPending/);
    expect(schedule).toMatch(/planInputsReady/);
    expect(schedule).toMatch(/!planInputsReady/);
    expect(schedule).toMatch(/Still loading \$\{planInputsPending\.join/);
    // Readiness has to come from the queries' own pending state, not from a list being
    // empty: an empty team list is a real (if broken) state, a pending one is not.
    for (const flag of [
      "courtsPending",
      "categoriesPending",
      "entrantsPending",
      "teamsPending",
      "placementMatchesPending",
      "drawsPending",
      "tierMatchesPending",
      "dayCourtsPending",
      "dayBreaksPending",
    ]) {
      expect(schedule).toMatch(new RegExp(flag));
    }
  });
});

describe("the setup wizard asks only for what activation needs", () => {
  const types = readFileSync(join(__dirname, "../components/tournament-setup/types.ts"), "utf8");
  const setup = read("setup.tsx");
  const review = readFileSync(
    join(__dirname, "../components/tournament-setup/ReviewStep.tsx"),
    "utf8",
  );

  it("has five steps and no match-rules step", () => {
    const ids = [...types.matchAll(/\{ id: "([a-z]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(["basics", "days", "events", "structure", "review"]);
    expect(types).not.toMatch(/"rules"/);
    expect(setup).not.toMatch(/RulesStep/);
    expect(review).not.toMatch(/form\.rules/);
  });

  it("describes the days step as a date range", () => {
    // Setup decides which dates run, not the hours or the courts each one plays on.
    expect(types).toMatch(/export function buildDayRange\(/);
    expect(review).toMatch(/dateRangeLabel/);
    expect(review).not.toMatch(/courtPoolSize|day\.courts|day\.breaks/);
  });

  it("leaves scoring, durations and rest gaps to the schedule page", () => {
    // The draft is created with usable defaults; omitting these keys is what stops
    // the wizard from overwriting timings that the desk has since changed.
    for (const field of [
      "placementGamesTo",
      "knockoutGamesTo",
      "groupSlotMinutes",
      "knockoutSlotMinutes",
      "groupRestGapMinutes",
      "knockoutRestGapMinutes",
    ]) {
      expect(setup).not.toMatch(new RegExp(`${field}:`));
    }
    const schedule = read("placement-schedule.tsx");
    expect(schedule).toMatch(/<StageScoring/);
    expect(schedule).toMatch(/setTournamentCourts/);
  });

  it("still persists the basics it does own", () => {
    expect(setup).toMatch(/maxCategoriesPerPlayer: form\.maxCategoriesPerPlayer/);
    expect(setup).toMatch(/saveTournamentDays\(id, form\.days\)/);
  });
});

describe("the schedule writer refuses a plan that would strand a match", () => {
  const writer = readFileSync(join(__dirname, "../lib/tournament/placement-schedule.ts"), "utf8");

  it("checks payload coverage before it calls the writer RPC", () => {
    expect(writer).toMatch(/uncoveredScheduledMatches\(plan\)/);
    // The check must come before the RPC loop, or the day is cleared for nothing.
    expect(writer.indexOf("uncoveredScheduledMatches(plan)")).toBeLessThan(
      writer.indexOf('supabase.rpc("apply_placement_day_schedule"'),
    );
  });
});

describe("a build reads its rows from the network, not the query cache", () => {
  const schedule = read("placement-schedule.tsx");
  const data = readFileSync(join(__dirname, "../lib/tournament/data.ts"), "utf8");
  const snapshot = schedule.slice(
    schedule.indexOf("const freshSchedulingData"),
    schedule.indexOf("const computePlan"),
  );

  it("awaits the placement rows rather than reading cached ones", () => {
    // `refetchQueries` can resolve against a fetch that was already in flight — one
    // issued before this build's own generation committed — and a following
    // `getQueryData` would then plan from an empty match list while the database held
    // the freshly generated rows. That is what produced the half-built day, so the
    // snapshot must return fetched data.
    expect(snapshot).not.toMatch(/getQueryData/);
    expect(snapshot).not.toMatch(/refetchQueries/);
    expect(snapshot).toMatch(/fetchPlacementMatches\(/);
    expect(snapshot).toMatch(/fetchTierDrawMatches\(/);
    expect(snapshot).toMatch(/fetchTierDraws\(/);
  });

  it("refreshes the seeds it is about to generate from", () => {
    // Generation reads entrant seeds. A seed lock that has not reached the cache would
    // make every event look unseeded and quietly build nothing.
    expect(snapshot).toMatch(/fetchPlacementEntrants\(/);
    expect(schedule).toMatch(/entrants: before\.entrants/);
    expect(schedule).toMatch(/entrants: fresh\.entrants/);
    // The stale component value must not reach either the generator or the planner.
    expect(schedule).not.toMatch(/entrants: entrants \?\? \[\]/);
  });

  it("shares one definition between the hooks and the build path", () => {
    for (const name of [
      "fetchPlacementEntrants",
      "fetchPlacementMatches",
      "fetchTierDraws",
      "fetchTierDrawMatches",
    ]) {
      expect(data).toMatch(new RegExp(`export function ${name}\\(`));
      // Each hook must delegate, so the two cannot drift apart.
      expect(data).toMatch(new RegExp(`queryFn: \\(\\) => ${name}\\(`));
    }
  });
});
