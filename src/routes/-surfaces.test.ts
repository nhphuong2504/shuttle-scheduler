import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Surface separation, asserted against the route sources.
 *
 * The split between the two tabs is a claim about what each one *renders*, so the honest way to
 * regression-test it is to read the files. These guards fail loudly if a tournament-wide metric
 * creeps back onto the desk, or if the removed capacity analysis reappears in the preview.
 */

const read = (relativePath: string) => readFileSync(join(__dirname, relativePath), "utf8");

/**
 * Every operational surface moved under the workspace layout, so almost every path in this
 * file gained a prefix. Two helpers rather than one, because the two scheduling views are
 * components now - they share one format-aware route and therefore live outside `routes/`.
 */
const workspacePath = (file: string) => join("tournaments", "$tournamentId", file);
const readWorkspace = (file: string) => read(workspacePath(file));
const readScheduleView = (file: string) =>
  readFileSync(join(__dirname, "..", "components", "schedule", file), "utf8");

describe("control desk is strictly day-scoped", () => {
  const desk = readWorkspace("desk.tsx");

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
  const schedule = readScheduleView("placement-scheduler.tsx");

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
  // The steps themselves moved into the shared wizard when creating and configuring became
  // two addresses for one flow, so what the steps ask for is asserted against the wizard and
  // the settings page is asserted as its host. Reading the page for step contents would now
  // assert the absence of everything, which is how a guard quietly stops measuring.
  const wizard = readFileSync(
    join(__dirname, "../components/tournament-setup/TournamentWizard.tsx"),
    "utf8",
  );
  const setup = readWorkspace("settings.tsx");
  const review = readFileSync(
    join(__dirname, "../components/tournament-setup/ReviewStep.tsx"),
    "utf8",
  );

  it("has four steps and no match-rules step", () => {
    const ids = [...types.matchAll(/\{ id: "([a-z]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(["details", "events", "structure", "review"]);
    expect(types).not.toMatch(/"rules"/);
    expect(wizard).not.toMatch(/RulesStep/);
    expect(review).not.toMatch(/form\.rules/);
  });

  it("is one wizard with two hosts, neither of them owning the steps", () => {
    // Creating and configuring are the same four steps against the same row, so a second
    // copy of them is the drift this asserts against - and the reason the old page's
    // `?draft=` search param is gone: the address names the subject now.
    expect(setup).toMatch(/<TournamentWizard tournamentId=\{tournamentId\}/);
    expect(setup).not.toMatch(/DetailsStep|EventsStep|StructureStep|ReviewStep/);
    const create = read("tournaments/new.tsx");
    expect(create).toMatch(/<TournamentWizard[\s\S]{0,80}tournamentId=\{null\}/);
    expect(create).not.toMatch(/DetailsStep|EventsStep|StructureStep|ReviewStep/);
    // Nothing is written until the last step, so the create page has no id to move its
    // address to: the wizard makes the tournament in one call and sends the caller to its
    // own page, and the answers it holds meanwhile are cleared with it.
    expect(create).not.toMatch(/onCreated/);
    expect(wizard).toMatch(/createTournament\(\{/);
    expect(wizard).toMatch(/clearLocalDraft\(\)/);
    expect(wizard).toMatch(/to: "\/tournaments\/\$tournamentId"/);
  });

  it("asks for the tournament window, and leaves the playing days to the schedule", () => {
    // Setup decides which dates the tournament promises. Which days are played, and the
    // hours and courts of each, are chosen when the schedule is built, inside the window.
    expect(types).toMatch(/startsOn: string/);
    expect(types).toMatch(/endsOn: string/);
    expect(types).not.toMatch(/buildDayRange|MAX_TOURNAMENT_DAYS/);
    expect(review).toMatch(/windowLabel/);
    expect(review).not.toMatch(/courtPoolSize|day\.courts|day\.breaks|form\.days/);
    expect(wizard).not.toMatch(/saveTournamentDays|form\.days/);
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
      expect(wizard).not.toMatch(new RegExp(`${field}:`));
    }
    const schedule = readScheduleView("placement-scheduler.tsx");
    expect(schedule).toMatch(/<MatchFormatCard/);
    expect(schedule).toMatch(/setTournamentCourts/);
  });

  it("still persists the basics it does own", () => {
    expect(wizard).toMatch(/maxCategoriesPerPlayer: form\.maxCategoriesPerPlayer/);
    // The window has its own writer, because its rules (the first date locks once the
    // tournament is in progress; no playing day may fall outside it) belong to it alone.
    expect(wizard).toMatch(/updateTournamentWindow\(id, form\.startsOn, form\.endsOn\)/);
    // And so does the registration window, for the same reason.
    expect(wizard).toMatch(/setRegistrationWindow\(/);
  });
});

/**
 * The Schedule page's settings were a flat list ordered Venue, Match timings, Scoring,
 * Days, Danger zone. Timings and scoring described the same match from two sections
 * that could contradict each other without saying so — a rule suggesting 45 minutes
 * while the duration box a section above held 25 — and the irreversible reset sat in
 * the same list, one stray click from the day fields.
 *
 * The panel is now grouped by what a match is, the venue's court pool has a section of
 * its own with each day narrowing it, and the reset stands on its own.
 */
describe("the schedule settings are grouped by what a match is", () => {
  const schedule = readScheduleView("placement-scheduler.tsx");
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

  it("manages the venue's court pool once, and each day's use of it on the day", () => {
    // The pool used to be grown and shrunk from inside a day card's court block, which
    // read as a per-day action for something that is venue-wide, and a day narrowed to a
    // subset silently ignored every court added afterwards. The pool now has a section of
    // its own; the day rows only narrow it.
    expect(schedule).toMatch(/title="Venue courts"/);
    // Exactly one control offers to add a court, and it is not inside a day row.
    expect(schedule.match(/Add a court/g)).toHaveLength(1);
    expect(schedule).toMatch(/Courts used on day/);
    expect(schedule).not.toMatch(/title="Venue"/);
  });

  it("heads each section with its own summary", () => {
    // The heading row carries the section's own headline number ("8 courts", "2 days",
    // "2 stages"), so the panel can be scanned without reading the controls underneath.
    for (const section of [
      'title="Venue courts"',
      'title="Playing days"',
      'title="Match format"',
    ]) {
      expect(schedule).toMatch(new RegExp(`${section}[\\s\\S]{0,140}summary=`));
    }
  });

  it("gives each day one breaks control, not a disclosure that reveals a second one", () => {
    // The day used to carry a "Breaks (n)" disclosure and, once opened, a second
    // "Add break" button - two clicks for the one action the block exists for. The rows
    // now render in place behind a single "Add break", so an existing break can also be
    // corrected without first adding a row that has to be removed again.
    expect(schedule.match(/Add break/g)).toHaveLength(1);
    expect(schedule).not.toMatch(/openBreaks/);
    expect(schedule).not.toMatch(/breaksPanelId/);
    expect(schedule).toMatch(/breaksDirty\(day\)/);
    // A placeholder is not an accessible name. The row's two time inputs had none at all
    // until the panel scan reached them, and axe failed the whole panel for it.
    expect(schedule).toMatch(/aria-label="Name"/);
    expect(schedule).toMatch(/aria-label="Start"/);
    expect(schedule).toMatch(/aria-label="End"/);
    expect(schedule).toMatch(/Break \$\{index \+ 1\}/);
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
 * Each reset is scoped to the tab that owns what it destroys.
 *
 * Seeding happens on the Placement tab and scheduling on the Schedule tab, and they are
 * separate decisions: a host locks seeds, then builds days. The Schedule tab's reset used
 * to clear the seed order as well, so rebuilding a schedule silently destroyed an order set
 * by hand. It now calls the schedule-only RPC and keeps the seeding; the full stage reset —
 * the one that clears the seed order — lives where the seed order is set.
 */
describe("each reset is scoped to the tab that owns it", () => {
  const schedule = readScheduleView("placement-scheduler.tsx");
  const placement = readWorkspace("placement.tsx");

  it("keeps the schedule reset off the seed order", () => {
    expect(schedule).toMatch(/resetPlacementSchedule/);
    // The stage reset is a different action now, and must not be reachable from here.
    expect(schedule).not.toMatch(/resetPlacementStage/);
    // The copy has to say what survives, because that is the difference the host is
    // choosing between.
    expect(schedule).toMatch(/seed order\s+and any waivers are kept/);
  });

  it("puts the stage reset on the tab that owns the seed order", () => {
    expect(placement).toMatch(/resetPlacementStage/);
    // Edit-rights only, and the confirmation names the seed order it destroys while
    // describing the reset that would keep it — the pair has to be distinguishable from
    // one screen.
    expect(placement).toMatch(/const resetAction = canEdit \? \(/);
    expect(placement).toMatch(/clears the seed order and any waivers/);
    expect(placement).toMatch(/Schedule tab's reset clears the matches/);
  });

  it("puts the reset in the header, not in a panel and not in the event list", () => {
    // One action rather than a section. It used to be a folded panel with a title, a
    // Show/Hide toggle and a paragraph of copy — three affordances around one button,
    // below the events it discards. It is now the page's own header action, and its label
    // stays a single word.
    expect(placement).not.toMatch(/title="Reset"/);
    expect(placement).not.toMatch(/showReset/);
    expect(placement).toMatch(/>\s*Reset\s*</);

    // Passed as the `actions` slot, so it renders with the header rather than in the list.
    const actions = placement.indexOf("actions={resetAction}");
    const reset = placement.indexOf("const resetAction");
    const events = placement.indexOf("{live.map(");
    expect(actions).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(actions);
    expect(actions).toBeLessThan(events);
  });

  it("no longer offers a Scores link, since the header now carries only the reset", () => {
    // The Scores button was this page's other header action. Results are still entered
    // there and the room is still reachable from the nav, so this is a deliberate
    // reduction of the header to one action rather than a dead end.
    expect(placement).not.toMatch(/Enter results in Scores/);
    // With no `Link` in the file, the import has to go too or it is an unused binding.
    expect(placement).not.toMatch(/import \{ Link/);
  });

  it("still carries the destructive hue once the surrounding copy is gone", () => {
    // Stripping the panel removed the paragraph that explained the action, so the variant
    // is what marks it as destructive now. The design system reserves a saturated slot for
    // exactly this. §6.3 is satisfied by the confirmation, which is asserted above.
    expect(placement).toMatch(/variant="destructive"/);
  });

  it("will not discard the seeding while a bracket still depends on it", () => {
    // The seed order is what round one was paired from, so clearing it under a live
    // bracket strands matches that can no longer explain their own pairings. The house
    // rule is therefore "clear the schedule first", and the same refusal is enforced in
    // the RPC — see `20260926010000_placement_stage_reset_gate.sql`.
    expect(placement).toMatch(/stageResetBlockedBy/);
    // Read from the same three tables the Schedule tab's reset clears, so "the schedule is
    // clear" means one thing on both sides.
    expect(placement).toMatch(/useTierDraws/);
    expect(placement).toMatch(/useTierDrawMatches/);
    // The action is unavailable while blocked, and the refusal is still reachable without
    // the panel that used to hold it. It takes two channels because neither works alone:
    // `aria-description` is what an assistive technology reads, and the wrapper's `title`
    // is what a mouse gets, since a disabled button cannot show a tooltip of its own
    // (`Button` sets `disabled:pointer-events-none`). A hidden `sr-only` span would carry
    // it too, but `sr-only` is still laid out — the layout matrix measures it as clipped
    // text on every build, so the description lives on the control instead.
    expect(placement).toMatch(/resetBlocked != null/);
    expect(placement).toMatch(/aria-description=\{resetBlocked \?\? undefined\}/);
    expect(placement).toMatch(/title=\{resetBlocked \?\? undefined\}/);
  });
});

/**
 * The day count used to be decided in setup and frozen at activation, so an event
 * that overran could not be given another day without rebuilding the tournament. The
 * Schedule page now chooses the playing days from the tournament window, guarded so that
 * neither adding nor removing one can strand a match.
 */
describe("playing days can be managed after activation", () => {
  const schedule = readScheduleView("placement-scheduler.tsx");

  it("offers the window's own dates to choose from, with no cap on how many", () => {
    expect(schedule).toMatch(/addTournamentDay/);
    expect(schedule).toMatch(/<PlayingDayPicker/);
    // The window the picker draws is the tournament's own, so a date outside it cannot be
    // typed: the database refuses one for every writer, and the page does not offer it.
    expect(schedule).toMatch(/startsOn=\{String\(tournament\.starts_on\)/);
    expect(schedule).toMatch(/endsOn=\{String\(tournament\.ends_on\)/);
    // And no ceiling: the old limit of seven lived in two constraints and two functions and
    // is gone from all of them.
    expect(schedule).not.toMatch(/tournamentDays\.length < 7|7 is the maximum/);
  });

  it("treats a tournament with no playing days as the ordinary starting state", () => {
    // Choosing the days is part of the one Settings panel, not a page in front of it and not a
    // dead end that sends the host back to setup - the days are chosen here, inside the window.
    expect(schedule).not.toMatch(/Set up a tournament first/);
    expect(schedule).not.toMatch(/Which days do you play\?/);
    expect(schedule).toMatch(/Choose at least one playing day first/);
    expect(schedule).toMatch(/Choose the days you play first/);
  });

  it("says what is missing instead of greying the build out, courts before days", () => {
    // A new tournament has no court rows, so courts are as much a precondition as days are.
    expect(schedule).toMatch(/const buildBlocker =/);
    expect(schedule).toMatch(/Set the courts and choose at least one playing day first/);
    expect(schedule).toMatch(/aria-describedby=\{buildBlocker \? "build-blocker" : undefined\}/);
    // One build button at a time: in the header, or in the bar at the foot while settings are open.
    expect(schedule).toMatch(/\{showSettings \? null : buildButton\}/);
  });

  it("follows one set of hours for every day, and opens a day only to change it", () => {
    expect(schedule).toMatch(/Change for all days/);
    expect(schedule).toMatch(/applyHoursToAll/);
    expect(schedule).toMatch(/Different/);
  });

  it("disables remove rather than letting it fail, when matches are on the day", () => {
    expect(schedule).toMatch(/removeTournamentDay/);
    // A day with matches on it cannot go. The last day can: a tournament may have none.
    expect(schedule).toMatch(/daysWithMatches\.has\(day\.id\)/);
    expect(schedule).not.toMatch(/tournamentDays\.length <= 1/);
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
  const schedule = readScheduleView("placement-scheduler.tsx");
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
    // The stale component value must not reach either the generator or the planner that a build
    // writes from. (The page's read-only dry run, which describes what is on screen, names its
    // input `dryRunEntrants` and writes nothing.)
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

describe("a build shows the plan it just applied", () => {
  const schedule = readScheduleView("placement-scheduler.tsx");
  // Both the projection and the apply that calls it, so the order between them is visible.
  const applyPath = schedule.slice(
    schedule.indexOf("const projectAppliedPlan"),
    schedule.indexOf("const build = async"),
  );

  it("projects the plan into the cache before anything is refetched", () => {
    // The running order is built from the placement and tier match queries. Waiting for
    // a refetch to reveal the write is not a guarantee - `invalidateQueries` resolves
    // even when the refetch it triggers fails - and that leaves the pre-build rows on
    // screen underneath a success toast until the page is reloaded.
    expect(applyPath).toMatch(/projectAppliedPlan\(plan\)/);
    expect(applyPath.indexOf("projectAppliedPlan(plan)")).toBeLessThan(
      applyPath.indexOf("invalidateQueries"),
    );
  });

  it("projects through the same helper for both stages", () => {
    expect(applyPath).toMatch(/projectSlotsOntoMatches\(placement, plan\.placementSlotPayload\)/);
    expect(applyPath).toMatch(/projectSlotsOntoMatches\(tier, plan\.knockoutSlotPayload\)/);
  });
});

/**
 * A bye is a draw condition, and must never be presented as a match status.
 *
 * The generator stores an automatic advance as `status: "reported"` with `is_bye`
 * and a `note` of "Bye", so any surface that renders a plain status pill calls a bye
 * "Completed". One surface had worked around that by passing "walkover" instead,
 * which is a different wrong answer. Both are asserted closed here, because the
 * defect was in the call sites rather than in the vocabulary - and the component
 * tests cannot see a call site.
 */
describe("byes are drawn as draw conditions, not as statuses", () => {
  const scores = readWorkspace("scores.tsx");
  // The tree is drawn by a shared component, so that is where a bye is told from a status.
  const bracketTree = readFileSync(join(__dirname, "../components/knockout-bracket.tsx"), "utf8");
  const draws = readWorkspace("draws.tsx");

  it("never coerces a bye onto a status the schema does have", () => {
    // The original workaround, in the exact form it shipped.
    expect(scores).not.toMatch(/note === "Bye" \? "walkover"/);
    // And the shape it would be rewritten into by a mechanical refactor.
    expect(scores).not.toMatch(/isByeMatch\([^)]*\)\s*\?\s*"walkover"/);
  });

  it("routes every bye through the marker instead of the pill", () => {
    // Both surfaces that can hold a bye: the draw list on the scores page, and the
    // bracket rows on the knockout page. `visibleTier` excludes byes because
    // buildDeskMatches filters them, which is why the scores page needs the guard in
    // its draw list only.
    expect(scores).toMatch(/isByeMatch\(m\)[\s\S]{0,80}<ByeMarker \/>/);
    // A bye returns its own slim card before the status pill is ever reached, so the bye test is
    // pinned to the marker preceding the pill, not to their being adjacent.
    expect(bracketTree).toMatch(/if \(bye\)[\s\S]{0,900}<ByeMarker[\s\S]*<StatusPill/);
  });

  it("tests for a bye through one shared predicate", () => {
    // Three different detections used to coexist - `is_bye` in one place, `note` in
    // another, `status === "bye"` in the schema - so a row carrying only one signal
    // was drawn differently on two pages.
    for (const source of [scores, bracketTree, draws]) {
      expect(source).toMatch(/isByeMatch/);
      expect(source).not.toMatch(/note === "Bye"/);
      expect(source).not.toMatch(/status === "bye"/);
    }
  });
});

/**
 * The live surfaces list the format the tournament runs, and only that one.
 *
 * Both engines' tables live in the same database, and `buildDeskMatches` merges them so
 * one board can carry either format. That merge is wrong for the supported format, whose
 * pools are leftovers: a staging tournament holding 230 already-reported pool matches
 * under 77 placement matches put the finished ones first, buried the placement rounds in
 * the Group stage tab, and counted the pool rows in "Matches shown" and "Completed".
 *
 * The gate belongs in the shared builder rather than in either page — a page filtering
 * its own copy is how the score desk and the board came to disagree in the first place.
 * What is asserted here is the shape that would regress silently: the pages still
 * passing their legacy rows to the builder, or still reading the pool tables directly
 * for the counts and the panels, which the builder's filter cannot reach.
 */
describe("the live surfaces list only the format the tournament runs", () => {
  const desk = readWorkspace("desk.tsx");
  const scores = readWorkspace("scores.tsx");

  it("hands the stored format to the shared row builder", () => {
    for (const source of [desk, scores]) {
      expect(source).toMatch(/buildDeskMatches\(\{[\s\S]{0,120}?format: tournament\?\.format/);
    }
  });

  it("gates the lists read straight from the round-robin tables", () => {
    // `visiblePool` and `visibleDraw` are filtered from `poolMatches`/`drawMatches`
    // directly, and the tab counts, the four tiles and the panels all read them, so the
    // shared builder's filter never sees them.
    expect(scores).toMatch(/const roundRobin = !isSupportedFormat\(tournament\?\.format\)/);
    for (const list of ["visiblePool", "visibleDraw"]) {
      expect(scores).toMatch(new RegExp(`const ${list} = useMemo\\([\\s\\S]{0,160}?roundRobin`));
    }
  });

  it("leaves the desk's overdue-result alert alone", () => {
    // The single destructive treatment the Act-now panel defines, and the one row list
    // that is deliberately not gated: it chases a missing result rather than showing one,
    // so gating it on the format took the destructive tier away from the format this app
    // runs. It is asserted here because the gate is the obvious "consistency" edit.
    expect(desk).not.toMatch(/if \(isSupportedFormat\(tournament\?\.format\)\) return \[\]/);
    expect(desk).toMatch(/const latePools = useMemo/);
  });
});

/**
 * Every file under `src`, so a guard can ask a question about the tree rather than about
 * one file it already knows the name of.
 *
 * Two exclusions, both of which would make the "this name appears once" assertions below
 * vacuous by matching their own subject: `routeTree.gen.ts`, which is generated from the
 * route files and mentions every one of them by path, and the test files themselves, which
 * name the helpers and route paths they are checking.
 */
function sourceFiles(dir: string, root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(child, root));
    else if (!/\.tsx?$/.test(entry.name)) continue;
    else if (entry.name === "routeTree.gen.ts" || /\.test\.tsx?$/.test(entry.name)) continue;
    else found.push(relative(root, child));
  }
  return found;
}

/**
 * The workspace move is a claim about *files*, not only about URLs.
 *
 * The point of moving the Desk rather than copying it is that the desk can only exist in
 * one place; a copy left behind at the old address would keep rendering, keep passing its
 * own tests, and quietly become a second definition of the same page. Asserting the URLs
 * cannot see that, because both copies would answer to different URLs and each URL would
 * work. So this asks the tree directly: which files mention the desk's own day-scoping
 * helpers, what is left at `/`, and how each flat address still resolves.
 */
describe("the desk lives in one file, and `/` is a page of its own", () => {
  // Walked from `src`, not from `routes`: a copy of the desk left in `components/` would
  // still render and still pass its own tests, and a walk of `routes` alone could not see it.
  const src = join(__dirname, "..");
  const files = sourceFiles(src, src);
  /** The one file allowed to define the desk. */
  const deskFile = join("routes", "tournaments", "$tournamentId", "desk.tsx");

  it("keeps every day-scoping helper to the one desk file", () => {
    // `resolveSelectedDay` and `dayOperationalCounts` are the desk's own day scoping - the
    // thing that makes it a desk rather than a tournament page. Their *library* is shared
    // and asserted elsewhere; what must not multiply is the call site. Non-route files are
    // out of scope because they are the library.
    const callers = files.filter(
      (file) =>
        file.startsWith(`routes${sep}`) &&
        /resolveSelectedDay|dayOperationalCounts/.test(
          readFileSync(join(__dirname, "..", file), "utf8"),
        ),
    );
    expect(callers).toEqual([deskFile]);
  });

  it("defines the desk's route in exactly one file", () => {
    // The *definition*, not the path: half a dozen files point at the desk by address (the
    // workspace nav, the tournament card, the layout's own redirect map and My Tournaments'
    // "work in this one"), and those are the tree agreeing on one address - the opposite of a
    // duplicate. What must not multiply is the `createFileRoute` call.
    const definers = files.filter((file) =>
      readFileSync(join(src, file), "utf8").includes(
        'createFileRoute("/tournaments/$tournamentId/desk")',
      ),
    );
    expect(definers).toEqual([deskFile]);
  });

  it("offers the desk to readers, in its read-only form", () => {
    // The read-only row is the operational sections *including the Desk*, derived rather
    // than restated so the two lists cannot drift. The Desk itself withholds the operator's
    // panels from a caller without `can_edit`; the nav split stays on `can_edit`, not on a
    // session, so a signed-in viewer and a visitor meet the same board.
    const shell = readFileSync(join(src, "components", "app-shell.tsx"), "utf8");
    expect(shell).toMatch(/READ_ONLY_SECTIONS = SECTIONS;/);
    expect(shell).toMatch(/homeSection = access\.can_edit \? DESK_PATH : READER_HOME_PATH/);
    const desk = readFileSync(join(src, deskFile), "utf8");
    expect(desk).toMatch(/\{canEdit \? \(\s*<Panel\s+title="Needs action"/);
    expect(shell).toMatch(
      /access\.can_edit \? \[\.\.\.SECTIONS, \.\.\.EDITOR_SECTIONS\][\s\S]{0,40}?READ_ONLY_SECTIONS/,
    );
  });

  it("gives every caller the app's own navigation inside a tournament", () => {
    /**
     * The bar above a tournament is the app's, and it is the same bar `PublicShell` draws.
     *
     * It used to be split by the edit right: a reader got Browse, and an operator got nothing
     * at all in the bar - opening a tournament took Browse, My tournaments and New tournament
     * away from the person running it. Now one component draws the row for both shells, so
     * the two cannot drift, and the tournament's own sections stay a second row under its
     * name. The operator's switcher stays where it was: the section row.
     */
    const shell = readFileSync(join(src, "components", "app-shell.tsx"), "utf8");
    const workspace = shell.slice(
      shell.indexOf("export function WorkspaceShell"),
      shell.indexOf("export function PublicShell"),
    );
    expect(workspace).toMatch(/<PrimaryNav signedIn=\{signedIn\} marked=\{false\} \/>/);
    // In the bar beside the brand, above the title.
    expect(workspace.indexOf("<PrimaryNav")).toBeLessThan(workspace.indexOf("{tournament?.name"));
    // The same component draws the public bar, so there is one row, not two that agree.
    expect(shell.slice(shell.indexOf("export function PublicShell"))).toMatch(
      /<PrimaryNav signedIn=\{signedIn\} marked \/>/,
    );
    // The switcher's place, unchanged: the section row, for a caller who may edit.
    expect(shell).toMatch(/access\.can_edit \? <TournamentSwitcher[\s\S]{0,60}?\/> : null/);
    // The row itself: Browse for everyone, My tournaments and New tournament once signed in.
    expect(shell).toMatch(/\{ label: "Browse tournaments", to: "\/explore" \}/);
    expect(shell).toMatch(/\{ label: "My tournaments", to: "\/me\/tournaments" \}/);
    expect(shell).toMatch(/<Link to="\/tournaments\/new" className=\{NEW_TOURNAMENT_CLASS\}>/);
    // The create door is drawn by the shared row, never written into the workspace header.
    expect(workspace).not.toContain('to="/tournaments/new"');
  });

  it("leaves the temporary shim gone from `/`, not merely shadowed", () => {
    const home = read("index.tsx");
    // S6 replaced the shim with the real surface. A shim left behind - even one whose
    // component no longer renders, or that kept a second `createFileRoute("/")` around -
    // would be a second definition of `/` that the real route shadows silently, which is
    // the failure mode this assertion exists for. So the check reads for the *absence of
    // the shim*, not for the presence of the page: `WorkspaceRedirect` is what `/` used to
    // render, and it must not be here at all.
    expect(home).not.toMatch(/WorkspaceRedirect/);
    expect(home).not.toMatch(/workspace-redirect/);
    // And it is a surface now: the shell that wraps every page outside a tournament, and
    // the two readings of the front door, chosen by the session rather than by a route.
    expect(home).toMatch(/<PublicShell/);
    expect(home).toMatch(/signedIn \? <SignedInHome \/> : <Landing \/>/);
  });

  it("renders `/` as the one route that draws both readings of the front door", () => {
    // One file defines `/`, and only one: a second definition would be a shadowed route.
    const definers = files.filter((file) =>
      readFileSync(join(src, file), "utf8").includes('createFileRoute("/")'),
    );
    expect(definers).toEqual([join("routes", "index.tsx")]);
  });

  it("resolves every flat legacy path on the caller's own pointer", () => {
    // The old addresses are kept because they were shipped, and each resolves on the
    // caller's pointer rather than a fixed tournament - a bookmark must open the
    // referee's own event.
    const sections: [string, string][] = [
      ["setup.tsx", "settings"],
      ["staff.tsx", "access"],
      ["registration.tsx", "entries"],
      ["placement.tsx", "placement"],
      ["knockout.tsx", "knockout"],
      ["placement-schedule.tsx", "schedule"],
      ["matches.tsx", "scores"],
      ["schedule.tsx", "schedule"],
    ];
    for (const [path, section] of sections) {
      const source = read(path);
      expect(source).toMatch(
        new RegExp(`component: \\(\\) => <WorkspaceRedirect section="${section}" />`),
      );
      // No hand-written fallback: a literal `/auth` in one file is how the shared fallback
      // becomes two answers, and S5's single-line flip to `/explore` would then miss it.
      expect(source).not.toMatch(/"\/auth"/);
      // And not a `beforeLoad`. That runs during server rendering too, where there is no
      // session to read the pointer from - the server would answer with the *public*
      // default and redirect a bookmark to somebody else's tournament. It would also make
      // a real Supabase request from the rendering process, which no browser-level
      // interception can see and which the hermetic suite is built to avoid.
      expect(source).not.toMatch(/beforeLoad/);
    }
  });

  it("routes both scheduling surfaces through one format-aware route", () => {
    // One address, chosen by the stored format, so a link to "the schedule" never has to
    // know which engine the tournament runs. Two scoped route files would mean two nav
    // targets and two places to change when the nav moves.
    const route = readWorkspace("schedule.tsx");
    expect(route).toMatch(/isSupportedFormat\(tournament\.format\)/);
    expect(route).toMatch(/<PlacementScheduler \/>/);
    expect(route).toMatch(/<DayPlanner \/>/);

    const definers = files.filter((file) =>
      readFileSync(join(__dirname, "..", file), "utf8").includes(
        'createFileRoute("/tournaments/$tournamentId/schedule")',
      ),
    );
    expect(definers).toEqual([join("routes", "tournaments", "$tournamentId", "schedule.tsx")]);

    // And both old addresses still reach it, neither of them knowing the format.
    for (const legacy of ["schedule.tsx", "placement-schedule.tsx"]) {
      expect(read(legacy)).toMatch(/<WorkspaceRedirect section="schedule" \/>/);
    }
  });
});

/**
 * The chrome is mounted once, by the layout, and a page owns only its own header.
 *
 * While every page rendered its own shell, the header could only state what a page chose
 * to pass it, so nothing in the chrome could name the tournament - a page told the shell
 * its own title and nothing else. Hoisting it to the layout is what makes the name, the
 * lifecycle status and the section nav possible at all, and it is also what stops them
 * being rebuilt on every navigation.
 *
 * These guards are about *where* the shell is rendered, which is the part a component
 * test cannot see: a page that kept its own shell would still render, and the header
 * would then appear twice on that page.
 */
describe("the workspace chrome is mounted once, by the layout", () => {
  // Walked from `src` rather than from `routes`, because the two halves of this claim
  // live in different trees: the shell is a component, and the pages that must not render
  // one are both routes and the two schedule views.
  const src = join(__dirname, "..");
  const files = sourceFiles(src, src);
  // Under the workspace layout, not everywhere below `routes/tournaments`: `new.tsx` is a
  // sibling of `$tournamentId` and inherits no layout, because creating a tournament happens
  // before there is one to be inside.
  const workspaceRoutes = files.filter((file) =>
    file.startsWith(join("routes", "tournaments", "$tournamentId")),
  );
  const views = [
    join("components", "schedule", "day-planner.tsx"),
    join("components", "schedule", "placement-scheduler.tsx"),
  ];
  /** Every workspace file that draws a page's contents, and so owns that page's title row. */
  const workspacePages = workspaceRoutes.filter(
    (file) => !file.endsWith(join("$tournamentId", "route.tsx")),
  );
  /**
   * Every surface outside a tournament workspace, listed rather than derived.
   *
   * These are the pages that are not about one tournament, so no layout above them can know
   * what to put in a header and each one draws the public shell itself. Enumerating them
   * rather than matching "not under the workspace" is what makes a new surface have to be
   * added here - which is the moment the question "which shell does this draw" gets asked.
   *
   * `routes/index.tsx` is on the list since S6: it was S3's shim, absent because it drew no
   * shell, and it is now the front door, which is a page like any other outside a workspace.
   */
  const publicRoutes = [
    // The visitor's reading of `/`, which `routes/index.tsx` renders for a caller with no session.
    join("components", "landing", "landing.tsx"),
    join("routes", "auth.tsx"),
    join("routes", "explore.tsx"),
    join("routes", "index.tsx"),
    join("routes", "me", "tournaments.tsx"),
    join("routes", "tournaments", "new.tsx"),
  ];

  it("renders WorkspaceShell in the layout route and nowhere else", () => {
    const renderers = files.filter((file) =>
      readFileSync(join(src, file), "utf8").includes("<WorkspaceShell"),
    );
    expect(renderers).toEqual([join("routes", "tournaments", "$tournamentId", "route.tsx")]);
  });

  it("renders PageHeader nowhere but the shell file", () => {
    // A page composes `Page`, which is the header over the page's own content. A page
    // reaching for the bare header would render two titles, which is the shape this guard
    // is here to keep out of the tree.
    const headerUsers = files.filter((file) =>
      readFileSync(join(src, file), "utf8").includes("<PageHeader"),
    );
    expect(headerUsers).toEqual([join("components", "app-shell.tsx")]);
  });

  it("leaves no workspace page rendering a shell of its own", () => {
    for (const file of [...workspacePages, ...views]) {
      const source = readFileSync(join(src, file), "utf8");
      expect(source, file).not.toMatch(/<WorkspaceShell|<PublicShell/);
      // `schedule.tsx` is the one exception and it is a delegation: it chooses between
      // the two format views and renders neither a header nor any content of its own.
      if (file === join("routes", "tournaments", "$tournamentId", "schedule.tsx")) continue;
      expect(source, file).toMatch(/<Page\b/);
    }
  });

  it("gives every surface outside a workspace the public shell", () => {
    // The other half of the claim above: outside a workspace there is no layout to draw the
    // chrome, so a page that rendered no shell would be content with no masthead at all.
    const renderers = files.filter((file) =>
      readFileSync(join(src, file), "utf8").includes("<PublicShell"),
    );
    expect(renderers).toEqual(publicRoutes);
  });
});

/**
 * Every shipped link has to resolve at the step that ships it.
 *
 * A `Link` to an address with no route definition compiles, builds and passes every other
 * test - a router only fails at the moment somebody clicks it - so "no shipped link points at
 * a route that does not resolve" is a claim about the *tree*, and this is the file that reads
 * the tree. The addresses come from `routeTree.gen.ts`, which the router generates from the
 * route files: using it rather than a hand-kept list means this cannot disagree with what the
 * router itself believes, and a route that stops existing takes its links down with it here
 * rather than in a browser.
 */
describe("no shipped link points at a route that does not resolve", () => {
  const src = join(__dirname, "..");
  const files = sourceFiles(src, src);
  const tree = readFileSync(join(src, "routeTree.gen.ts"), "utf8");

  /** Every id the router generated, which is every address that resolves. */
  const defined = new Set([...tree.matchAll(/\bid: '([^']*)'/g)].map((match) => match[1]));

  /** Literal link targets - `to="/x"` and `to: "/x"` - with any search or hash stripped. */
  const targets = (source: string): string[] =>
    [...source.matchAll(/\bto:?\s*"(\/[^"]*)"/g)]
      .map((match) => match[1] ?? "")
      .map((path) => path.split(/[?#]/)[0] ?? "");

  it("knows the addresses it is checking against", () => {
    // A vacuous pass is the failure mode of a guard like this - an empty set would make the
    // check below trivially true - so the set itself is asserted first.
    expect(defined.size).toBeGreaterThan(15);
    for (const id of ["/explore", "/me/tournaments", "/tournaments/new", "/auth"]) {
      expect(defined, id).toContain(id);
    }
  });

  it("resolves every literal link target", () => {
    const broken: string[] = [];
    for (const file of files) {
      for (const target of targets(readFileSync(join(src, file), "utf8"))) {
        // `/` is the app's own front door and always exists, shim or Landing.
        if (target === "/") continue;
        if (!defined.has(target)) broken.push(`${file} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("sends a caller with no working tournament to Explore, not to sign-in", () => {
    // S3 shipped the shared fallback as `/auth` because `/explore` did not exist yet, and
    // flipped it in the commit that created the route - one constant, so the callers it had
    // then (the flat paths and S3's `/` shim) were not edited when the destination changed.
    // The shim is gone; the flat paths still read this, and so does the assertion below,
    // which is what keeps the fallback from drifting back to a sign-in form.
    const routing = readFileSync(join(src, "lib", "routing", "workspace-redirect.ts"), "utf8");
    expect(routing).toMatch(/NO_POINTER_FALLBACK = "\/explore"/);
    expect(routing).not.toMatch(/"\/auth"/);
  });
});

/**
 * The working-tournament pointer is written in one place per act.
 *
 * `set_current_tournament` moves *the caller's own* row, so a second writer is not a
 * privilege question - the database enforces whose row it is - but it is the difference
 * between "which tournament I am working in is something I choose, in three known places"
 * and "the pointer is something any page can move as a side effect". The three acts are the
 * create flow (pointing at the tournament it has just made), the tournament card in My
 * Tournaments (the same move from a list) and the workspace switcher (the same move from
 * anywhere inside a tournament).
 *
 * The RPC's own name is a second, narrower claim: it belongs to the action module, so every
 * caller goes through the one function that decides what arguments it takes and what it does
 * with a failure.
 */
describe("the working-tournament pointer is written in one place per act", () => {
  const src = join(__dirname, "..");
  const files = sourceFiles(src, src);

  it("names the RPC only in the action module", () => {
    const namers = files.filter((file) =>
      readFileSync(join(src, file), "utf8").includes('"set_current_tournament"'),
    );
    expect(namers).toEqual([join("lib", "tournament", "actions.ts")]);
  });

  it("calls the action from the three acts that change where you are working", () => {
    const callers = files
      .filter((file) => readFileSync(join(src, file), "utf8").includes("setCurrentTournament("))
      .sort();
    expect(callers).toEqual(
      [
        // The definition itself, which names the function it exports.
        join("lib", "tournament", "actions.ts"),
        // Not the wizard: `create_tournament` points the creator at the new tournament in
        // the same transaction, so creating is not a separate act that needs the call.
        join("components", "tournament-switcher.tsx"),
        join("routes", "me", "tournaments.tsx"),
      ].sort(),
    );
  });
});

/**
 * A reader without the edit right is shown data and navigation, never a control.
 *
 * The read-only treatment is one fact - this caller may not change anything here - but it
 * has to be applied per surface, and the shape it must take is the same everywhere: the
 * control is *removed*, not disabled. A disabled control still says "here is the act you
 * cannot do", which is the opposite of a page that is meant to be read; a viewer and a
 * signed-out visitor get the identical treatment, so the split is on `can_edit` rather
 * than on a session.
 *
 * The layout already derives `readOnly` from `access.can_edit` and the nav withholds the
 * Desk and the three editor sections; these guards cover the pages beneath it, where the
 * controls actually lived. They read the sources because "is this control inside the
 * edit-right branch" is a property of the rendered tree that a component test on one page
 * cannot see across the five.
 */
describe("the read-only workspace removes the operator's controls, rather than disabling them", () => {
  const entries = readWorkspace("entries.tsx");
  const schedule = readScheduleView("placement-scheduler.tsx");
  const dayPlanner = readScheduleView("day-planner.tsx");
  const scores = readWorkspace("scores.tsx");

  it("keeps the entries desk forms inside the edit-right branch", () => {
    // Both forms - the player and the entry - are the desk's, and they render only for
    // a caller who may write. The column that holds them is the conditional, and the
    // grid collapses to one column when it is absent.
    expect(entries).toMatch(
      /cn\("grid grid-cols-1 gap-4", canEdit && "lg:grid-cols-\[340px_1fr\]"\)/,
    );
    expect(entries).toMatch(/Panel title="Add player"/);
    expect(entries).toMatch(/Panel title="Add entry"/);
  });

  it("keeps the per-entry acts inside the edit-right branch", () => {
    // Withdraw / Remove used to render disabled for a viewer; they are now inside the
    // branch, so their absence is the whole statement.
    const withdraw = entries.indexOf("await setTeamWithdrawn");
    expect(withdraw).toBeGreaterThan(-1);
    expect(entries.lastIndexOf("canEdit ? (", withdraw)).toBeGreaterThan(-1);
    // And the old shape - a rendered button merely disabled by the right - is gone from
    // the per-entry act.
    expect(entries).not.toMatch(/variant="ghost"\s+disabled=\{!canEdit\}/);
  });

  it("does not open the schedule settings for a read-only reader", () => {
    // The first-build effect auto-opens the panel on an unbuilt tournament. Without the
    // gate, a viewer met the whole editor panel opened on arrival.
    expect(schedule).toMatch(/if \(!canEdit\) return;/);
    expect(schedule).toMatch(/\{canEdit && showSettings \? \(/);
    // The toggle and the build action are the editor's; a viewer gets no header actions.
    expect(schedule).toMatch(/actions=\{\s*canEdit \? \(/);
    // What is missing before a build instructs an operator, and the bar that builds is the
    // operator's too: both go with the panel.
    expect(schedule).toMatch(/\{canEdit && showSettings \? \(\s*<div className="sticky/);
    expect(schedule).toMatch(
      /actions=\{\s*canEdit \? \(\s*<div className="flex flex-col items-end gap-1">/,
    );
  });

  it("hides the tournament-wide forecast from a read-only reader", () => {
    // Stage progress is planning oversight, not the event's state, so it is withheld
    // rather than shown to a spectator.
    expect(schedule).toMatch(/\{canEdit \? \(\s*<Panel\s+title="Stage progress"/);
  });

  it("gives the day planner a read-only day summary instead of its inputs", () => {
    // The date/start/end fields and the build buttons are the editor's; the read-only
    // branch prints the day's date and window as static text.
    expect(dayPlanner).toMatch(
      /\{canEdit \? \(\s*<>\s*<div className="flex flex-wrap items-end gap-2">/,
    );
    expect(dayPlanner).toMatch(/dayDateLabel\(windowFor\(day\)\.date\)/);
  });

  it("withholds the score dialog's way in, and the dialog with it", () => {
    // Open is the editor's route into scoring. It is absent for a reader in all three
    // row shapes - the shared MatchRow, the round-robin list and the draw list - and the
    // dialog cannot be opened without it.
    expect(scores).toMatch(
      /\{canEdit \? \(\s*<Button size="sm" variant="outline" onClick=\{onOpen\}>/,
    );
    expect(scores).toMatch(/\{!isByeMatch\(m\) && canEdit \? \(/);
    expect(scores).toMatch(/open=\{!!selectedMatch && canEdit\}/);
  });
});

/**
 * No screen reads the roster as a whole.
 *
 * `players` is global, so a screen that selects all of it learns about every tournament but
 * its own, and the number it shows is the platform's rather than the event's - the 384 "Players"
 * on a tournament of fifty. People are read through `tournament_players` (this tournament) or
 * `search_players` (the desk, a name at a time). The view that allowed the other way is no longer
 * granted, so a reintroduced read would fail at runtime for everyone; this catches it earlier.
 */
describe("the player roster is not read as a whole", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
    });

  it("selects neither public_players nor players directly", () => {
    const offenders = walk(join(process.cwd(), "src"))
      .filter((file) => !file.endsWith(join("integrations", "supabase", "types.ts")))
      .filter((file) =>
        /\.from\(\s*["'](public_players|players)["']\s*\)\s*\.select/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => relative(process.cwd(), file));
    expect(offenders).toEqual([]);
  });
});
