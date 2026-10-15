import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, it } from "vitest";

import vietNamOpen from "./fixtures/viet-nam-open-field.json";
import {
  DEFAULT_CONFIG,
  STRATEGIES,
  quantile,
  runReplay,
  type FieldSpec,
  type ReplayConfig,
  type ReplayMetrics,
  type StrategyName,
} from "./strategy-replay";

/**
 * Plays the same tournaments under every strategy and writes the comparison.
 *
 * Not a test of correctness (that is `strategy-replay.test.ts`): it asserts nothing and fails only
 * if a replay throws or gets stuck. Run it with `npm run bench:strategies`.
 */

const SEEDS = Number(process.env["REPLAY_SEEDS"] ?? 8);
const EVENTS = (process.env["REPLAY_EVENTS"] ?? DEFAULT_CONFIG.events.join(","))
  .split(",")
  .map((n) => Number(n.trim()));

const COURTS = Number(process.env["REPLAY_COURTS"] ?? DEFAULT_CONFIG.courts);
const DAY_END = process.env["REPLAY_DAY_END"] ?? DEFAULT_CONFIG.dayEnd;
const OUT = process.env["REPLAY_OUT"] ?? "strategy-replay.md";

const avg = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const fmt = (n: number, digits = 1) => n.toFixed(digits);

interface Column {
  label: string;
  /** Lower is better, so the best strategy per row can be marked. */
  pick: (m: ReplayMetrics) => number;
  digits?: number;
  /** Show the worst seed beside the mean. */
  worst?: boolean;
}

const COLUMNS: Column[] = [
  { label: "Overrun past the day-two close (min)", pick: (m) => m.overrunMinutes, worst: true },
  { label: "Last match ends (min after 09:00 day 1)", pick: (m) => m.lastEndMinutes, worst: true },
  { label: "Court idle (min)", pick: (m) => m.courtIdleMinutes },
  { label: "Player wait, total (min)", pick: (m) => m.waitSumMinutes },
  { label: "Player wait, p95 gap (min)", pick: (m) => m.waitP95Minutes, worst: true },
  { label: "Player wait, worst gap (min)", pick: (m) => m.waitMaxMinutes, worst: true },
  { label: "Started after the time FIRST published, mean (min)", pick: (m) => m.delayVsFirstMeanMinutes },
  { label: "Started after the time FIRST published, p95 (min)", pick: (m) => m.delayVsFirstP95Minutes, worst: true },
  { label: "Matches started 30+ min after first published (%)", pick: (m) => m.startedLate30Share * 100, worst: true },
  { label: "Started after the CURRENT published time, p95 (min)", pick: (m) => m.startLatenessP95Minutes, worst: true },
  { label: "Ready to timed, mean (min)", pick: (m) => m.readyToTimedMeanMinutes },
  { label: "Ready to timed, p95 (min)", pick: (m) => m.readyToTimedP95Minutes, worst: true },
  { label: "Published times pushed later (count)", pick: (m) => m.postponements, worst: true },
  { label: "...of which inside the last hour", pick: (m) => m.postponementsWithin60, worst: true },
  { label: "...largest push (min)", pick: (m) => m.postponeMaxMinutes, worst: true },
  { label: "Published times pulled earlier (count)", pick: (m) => m.advancements },
  { label: "Any change inside the last 30 min", pick: (m) => m.changesWithin30, worst: true },
  { label: "Plans the gate would refuse", pick: (m) => m.gateBreaches, worst: true },
  { label: "Gate rejections", pick: (m) => m.gateRejections },
  { label: "Organiser had to step in", pick: (m) => m.manualPresses, worst: true },
  { label: "Plan runs", pick: (m) => m.planRuns, digits: 0 },
  { label: "Plan time, total (ms)", pick: (m) => m.planMsTotal, digits: 0 },
  { label: "Plan time, slowest (ms)", pick: (m) => m.planMsMax, digits: 0, worst: true },
];

function closeMs() {
  return new Date("2026-09-18T18:00:00").getTime();
}

interface Scenario {
  name: string;
  events: number[];
  courts: number;
  days: number;
}

/** From a small club night to a big multi-day open, with the courts scaled to the field. */
const SCENARIOS: Scenario[] = [
  { name: "tiny: 2 events x 8, 3 courts, 1 day", events: [8, 8], courts: 3, days: 1 },
  { name: "small: 3 events, 4 courts, 1 day", events: [8, 8, 12], courts: 4, days: 1 },
  { name: "medium: 5 events, 4 courts, 2 days", events: [8, 8, 12, 12, 8], courts: 4, days: 2 },
  { name: "large: 8 events, 8 courts, 2 days", events: [12, 12, 16, 16, 12, 12, 16, 16], courts: 8, days: 2 },
  { name: "xlarge: 12 events, 10 courts, 3 days", events: [16, 16, 16, 12, 12, 16, 16, 12, 12, 16, 16, 12], courts: 10, days: 3 },
];

const SWEEP_STRATEGIES: StrategyName[] = [
  "place-ready",
  "rebuild",
  "manual-rounds",
  "rebuild-leftshift",
  "gated-leftshift",
  "rolling-horizon",
  "future-days",
];

/**
 * The real entries of the Viet Nam Open (staging): five events of 24, 18, 16, 11 and 24 entrants, three of
 * them doubles, 100 players of whom 30 play in more than one event. Round one, round two (odd fields, the
 * held entrant, make-ups, the crossover) and the draws come from the product's own builders. Seeds are a
 * seeded shuffle; days, courts and match lengths are the assumptions below, because the tournament has no
 * days or courts yet and its configured slots (2/1/5/2 minutes, one court) read as test values.
 */
const VN_FIELD = vietNamOpen as unknown as FieldSpec;
const VN_TIMING = { groupSlot: 20, groupRest: 10, koSlot: 25, koRest: 30 };
const VN_STRATEGIES: StrategyName[] = ["place-ready", "rebuild", "manual-rounds", "gated-rebuild"];
const VN_SCENARIOS: { name: string; courts: number; days: number; timing: typeof VN_TIMING }[] = [
  { name: "6 courts, 2 days", courts: 6, days: 2, timing: VN_TIMING },
  { name: "8 courts, 2 days", courts: 8, days: 2, timing: VN_TIMING },
  { name: "10 courts, 2 days", courts: 10, days: 2, timing: VN_TIMING },
  { name: "8 courts, 1 day", courts: 8, days: 1, timing: VN_TIMING },
  { name: "as configured today: 1 court, 1 day, slots 2/1/5/2 min", courts: 1, days: 1, timing: { groupSlot: 2, groupRest: 1, koSlot: 5, koRest: 2 } },
];

describe("strategy replay on the Viet Nam Open entries", () => {
  it("compares place-ready and rebuild on the real field", () => {
    const seeds = Number(process.env["REPLAY_SEEDS"] ?? 20);
    const lines: string[] = ["# Strategy replay on the Viet Nam Open entries", ""];
    lines.push(
      `${seeds} seeds per scenario (seed = who wins, who is seeded where, how long each match runs). ` +
        "Placement slot 20 / rest 10, knockout 25 / 30, matches 30 % faster to 60 % slower than the slot.",
      "",
    );
    const measures: { label: string; pick: (m: ReplayMetrics) => number; digits?: number }[] = [
      { label: "Matches played", pick: (m) => m.matches, digits: 0 },
      { label: "Last match ends (h after day-1 start)", pick: (m) => m.lastEndMinutes / 60 },
      { label: "Overrun past the last close (min)", pick: (m) => m.overrunMinutes, digits: 0 },
      { label: "Court idle (min)", pick: (m) => m.courtIdleMinutes, digits: 0 },
      { label: "Player wait, total (min)", pick: (m) => m.waitSumMinutes, digits: 0 },
      { label: "Player wait, p95 gap (min)", pick: (m) => m.waitP95Minutes, digits: 0 },
      { label: "Player wait, worst gap (min)", pick: (m) => m.waitMaxMinutes, digits: 0 },
      { label: "Published times pushed later", pick: (m) => m.postponements, digits: 0 },
      { label: "Changes inside the last 30 min", pick: (m) => m.changesWithin30, digits: 0 },
      { label: "Largest push (min)", pick: (m) => m.postponeMaxMinutes, digits: 0 },
      { label: "Ready, no time, p95 (min)", pick: (m) => m.readyToTimedP95Minutes, digits: 0 },
      { label: "Organiser had to step in", pick: (m) => m.manualPresses },
    ];
    for (const scenario of VN_SCENARIOS) {
      const results = new Map<StrategyName, ReplayMetrics[]>();
      for (const strategy of VN_STRATEGIES) {
        const list: ReplayMetrics[] = [];
        for (let seed = 1; seed <= seeds; seed += 1) {
          const config: ReplayConfig = {
            ...DEFAULT_CONFIG,
            seed,
            courts: scenario.courts,
            dayCount: scenario.days,
            field: VN_FIELD,
            timing: scenario.timing,
            jitterFraction: { min: -0.3, max: 0.6 },
          };
          const metrics = runReplay(strategy, config);
          if (metrics.stuck) throw new Error(`${strategy} stuck: ${scenario.name}, seed ${seed}`);
          list.push(metrics);
        }
        results.set(strategy, list);
      }
      lines.push(`## ${scenario.name}`, "");
      lines.push("| Measure | " + VN_STRATEGIES.join(" | ") + " |");
      lines.push("|---|" + VN_STRATEGIES.map(() => "---:|").join(""));
      for (const m of measures) {
        lines.push(
          `| ${m.label} | ` +
            VN_STRATEGIES.map((s) => fmt(avg((results.get(s) ?? []).map(m.pick)), m.digits ?? 1)).join(" | ") +
            " |",
        );
      }
      // Paired by seed: same tournament, different strategy.
      const pr = results.get("place-ready") ?? [];
      const rb = results.get("rebuild") ?? [];
      const better = (pick: (m: ReplayMetrics) => number) =>
        rb.filter((m, i) => pick(m) < pick(pr[i] as ReplayMetrics)).length;
      lines.push(
        "",
        `Seeds where rebuild beat place-ready (lower is better), out of ${seeds}: ` +
          `finish ${better((m) => m.lastEndMinutes)}, court idle ${better((m) => m.courtIdleMinutes)}, ` +
          `player wait ${better((m) => m.waitSumMinutes)}, p95 wait gap ${better((m) => m.waitP95Minutes)}.`,
        "",
      );
    }
    const report = lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
    const out = join(process.cwd(), ".benchmark", "strategy-replay-viet-nam-open.md");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, report, "utf8");
    console.info(report);
  }, 60 * 60 * 1000);
});

describe("strategy replay across tournament sizes", () => {
  it("compares the strategies from a tiny event to a three-day open", () => {
    const seeds = Math.min(SEEDS, 4);
    const lines: string[] = ["# Strategy replay across tournament lengths", ""];
    lines.push(`${seeds} seeds per scenario; each cell is the mean. Lower is better except where noted.`, "");
    const measures: { label: string; pick: (m: ReplayMetrics) => number; digits?: number }[] = [
      { label: "Matches played", pick: (m) => m.matches, digits: 0 },
      { label: "Last match ends (hours after day-1 start)", pick: (m) => m.lastEndMinutes / 60 },
      { label: "Court idle (min)", pick: (m) => m.courtIdleMinutes, digits: 0 },
      { label: "Player wait, total (min)", pick: (m) => m.waitSumMinutes, digits: 0 },
      { label: "Player wait, p95 gap (min)", pick: (m) => m.waitP95Minutes, digits: 0 },
      { label: "Overrun past the last close (min)", pick: (m) => m.overrunMinutes, digits: 0 },
      { label: "Published times pushed later", pick: (m) => m.postponements, digits: 0 },
      { label: "Changes inside the last 30 min", pick: (m) => m.changesWithin30, digits: 0 },
      { label: "Largest push (min)", pick: (m) => m.postponeMaxMinutes, digits: 0 },
      { label: "Ready, no time, p95 (min)", pick: (m) => m.readyToTimedP95Minutes, digits: 0 },
    ];
    for (const scenario of SCENARIOS) {
      const config = (seed: number): ReplayConfig => ({
        ...DEFAULT_CONFIG,
        seed,
        events: scenario.events,
        courts: scenario.courts,
        dayCount: scenario.days,
      });
      const byStrategy = new Map<StrategyName, ReplayMetrics[]>();
      for (const strategy of SWEEP_STRATEGIES) {
        const list: ReplayMetrics[] = [];
        for (let seed = 1; seed <= seeds; seed += 1) {
          const metrics = runReplay(strategy, config(seed));
          if (metrics.stuck) throw new Error(`${strategy} stuck in ${scenario.name} seed ${seed}`);
          list.push(metrics);
        }
        byStrategy.set(strategy, list);
      }
      lines.push(`## ${scenario.name}`, "");
      lines.push("| Measure | " + SWEEP_STRATEGIES.join(" | ") + " |");
      lines.push("|---|" + SWEEP_STRATEGIES.map(() => "---:|").join(""));
      for (const measure of measures) {
        lines.push(
          `| ${measure.label} | ` +
            SWEEP_STRATEGIES.map((s) => fmt(avg((byStrategy.get(s) ?? []).map(measure.pick)), measure.digits ?? 1)).join(" | ") +
            " |",
        );
      }
      lines.push("");
    }
    const report = lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
    const out = join(process.cwd(), ".benchmark", "strategy-replay-sweep.md");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, report, "utf8");
    console.info(report);
  }, 30 * 60 * 1000);
});

describe("strategy replay comparison", () => {
  it("plays every strategy on the same tournaments and writes the report", () => {
    const results = new Map<StrategyName, ReplayMetrics[]>();
    for (const strategy of STRATEGIES) results.set(strategy, []);

    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const config: ReplayConfig = { ...DEFAULT_CONFIG, seed, events: EVENTS, courts: COURTS, dayEnd: DAY_END };
      for (const strategy of STRATEGIES) {
        const metrics = runReplay(strategy, config);
        if (metrics.stuck) throw new Error(`${strategy} got stuck on seed ${seed}`);
        results.get(strategy)?.push(metrics);
      }
    }

    const lines: string[] = [];
    lines.push("# Strategy replay");
    lines.push("");
    lines.push(
      `${SEEDS} seeds, events of ${EVENTS.join(", ")} entrants, ${COURTS} courts, two days 09:00-${DAY_END.slice(0, 5)}. ` +
        "Each cell is the mean over seeds" +
        " (and the worst seed where marked). Lower is better in every row; the best mean in a row is **bold**.",
    );
    lines.push("");
    lines.push("| Measure | " + STRATEGIES.join(" | ") + " |");
    lines.push("|---|" + STRATEGIES.map(() => "---:|").join(""));
    for (const column of COLUMNS) {
      const means = STRATEGIES.map((s) => avg((results.get(s) ?? []).map(column.pick)));
      const best = Math.min(...means);
      const cells = STRATEGIES.map((s, i) => {
        const values = (results.get(s) ?? []).map(column.pick);
        const digits = column.digits ?? 1;
        const text =
          column.worst === true
            ? `${fmt(means[i] as number, digits)} (worst ${fmt(Math.max(...values), digits)})`
            : fmt(means[i] as number, digits);
        return (means[i] as number) === best && means.some((m) => m !== best) ? `**${text}**` : text;
      });
      lines.push(`| ${column.label} | ${cells.join(" | ")} |`);
    }
    lines.push("");
    lines.push("## Per-seed last match end (minutes after 09:00 on day one)");
    lines.push("");
    lines.push("| Seed | " + STRATEGIES.join(" | ") + " |");
    lines.push("|---|" + STRATEGIES.map(() => "---:|").join(""));
    for (let i = 0; i < SEEDS; i += 1) {
      lines.push(
        `| ${i + 1} | ` +
          STRATEGIES.map((s) => fmt(results.get(s)?.[i]?.lastEndMinutes ?? 0)).join(" | ") +
          " |",
      );
    }
    lines.push("");
    lines.push(
      `p95 of the per-seed finish gap between place-ready and rebuild: ` +
        fmt(
          quantile(
            (results.get("place-ready") ?? []).map(
              (m, i) => (m.finishMs - (results.get("rebuild")?.[i]?.finishMs ?? 0)) / 60000,
            ),
            0.95,
          ),
        ) +
        " min (positive means place-ready finished later).",
    );

    const report = lines.join("\n") + "\n";
    const out = join(process.cwd(), ".benchmark", OUT);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, report, "utf8");
    console.info(report);
  });
});
