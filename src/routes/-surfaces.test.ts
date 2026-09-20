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

  it("has four steps and no match-rules step", () => {
    const ids = [...types.matchAll(/\{ id: "([a-z]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(["details", "events", "structure", "review"]);
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
    expect(schedule).toMatch(/<MatchFormatCard/);
    expect(schedule).toMatch(/setTournamentCourts/);
  });

  it("still persists the basics it does own", () => {
    expect(setup).toMatch(/maxCategoriesPerPlayer: form\.maxCategoriesPerPlayer/);
    expect(setup).toMatch(/saveTournamentDays\(id, form\.days\)/);
  });
});

/**
 * The Schedule page's settings were a flat list ordered Venue, Match timings, Scoring,
 * Days, Danger zone. Timings and scoring described the same match from two sections
 * that could contradict each other without saying so — a rule suggesting 45 minutes
 * while the duration box a section above held 25 — and the irreversible reset sat in
 * the same list, one stray click from the day fields.
 *
 * The panel is now grouped by what a match is, the courts live where they are chosen,
 * and the reset stands on its own.
 */
describe("the schedule settings are grouped by what a match is", () => {
  const schedule = read("placement-schedule.tsx");
  const format = readFileSync(join(__dirname, "../components/match-format.tsx"), "utf8");

  it("edits scoring, match length and rest in one card per stage", () => {
    expect(format).toMatch(/Match length/);
    expect(format).toMatch(/Rest before the next match/);
    // Editing them together is the point: it is what lets the card reconcile a rule
    // against the duration it finds instead of leaving the two to disagree quietly.
    expect(format).toMatch(/suggestedSlotMinutes/);
    expect(format).toMatch(/usually needs about/);
  });

  it("folds the raw scoring numbers behind a toggle", () => {
    expect(format).toMatch(/showCustom/);
    expect(format).toMatch(/SCORING_PRESETS/);
  });

  it("keeps the venue's courts inside each day instead of a section of its own", () => {
    expect(schedule).not.toMatch(/title="Venue"/);
    expect(schedule).not.toMatch(/venue-courts/);
    expect(schedule).toMatch(/Courts this day/);
    expect(schedule).toMatch(/Add a court/);
  });

  it("will not let a day be left with no courts", () => {
    // The last selected court is disabled rather than rejected after the click, and
    // shrinking the venue refuses to orphan a day that plays only on the removed ones.
    expect(schedule).toMatch(/lastOn/);
    expect(schedule).toMatch(/only plays on the courts you are removing/);
  });

  it("saves a day's window when the field is left, not only at a build", () => {
    expect(schedule).toMatch(/commitDayWindow/);
    expect(schedule).toMatch(/onBlur=\{\(\) => void commitDayWindow\(day\)\}/);
  });

  it("stands the irreversible reset outside the settings list", () => {
    expect(schedule).not.toMatch(/title="Danger zone"/);
    expect(schedule).toMatch(/title="Reset"/);
    // Folded away on first paint, so it cannot be hit on the way past.
    expect(schedule).toMatch(/showDanger/);
  });
});

/**
 * The day count used to be decided in setup and frozen at activation, so an event
 * that overran could not be given another day without rebuilding the tournament. The
 * Schedule page now adds and removes days, guarded so that neither can strand a match.
 */
describe("playing days can be managed after activation", () => {
  const schedule = read("placement-schedule.tsx");

  it("offers an add-day control that stops at the seven-day cap", () => {
    expect(schedule).toMatch(/addTournamentDay/);
    expect(schedule).toMatch(/Add day/);
    expect(schedule).toMatch(/tournamentDays\.length < 7/);
  });

  it("suggests the day after the last, since overrunning is the common case", () => {
    expect(schedule).toMatch(/suggestedNewDayDate/);
    // Built from the day's own YYYY-MM-DD: a bare `new Date(dateString)` is read as
    // UTC midnight and lands a day early west of Greenwich.
    expect(schedule).toMatch(/T00:00:00/);
    expect(schedule).not.toMatch(/new Date\(last\.date\)/);
  });

  it("disables remove rather than letting it fail, at both refusals", () => {
    expect(schedule).toMatch(/removeTournamentDay/);
    // The last day cannot go, and a day with matches on it cannot go.
    expect(schedule).toMatch(/tournamentDays\.length <= 1/);
    expect(schedule).toMatch(/daysWithMatches\.has\(day\.id\)/);
  });

  it("disables remove using the same attribution the running order is built from", () => {
    // Not a second rule: whatever the host sees filed under a day is what decides
    // whether that day can be removed.
    expect(schedule).toMatch(/sliceRowsByDay\(rows, tournamentDays/);
    expect(schedule).toMatch(/daySlices\.filter\(\(slice\) => slice\.rows\.length > 0\)/);
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
