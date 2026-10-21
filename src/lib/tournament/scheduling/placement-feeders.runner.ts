import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import field from "./fixtures/viet-nam-open-field.json";
import {
  DEFAULT_CONFIG,
  findOverlaps,
  runReplay,
  type FieldSpec,
  type ReplayMetrics,
  type TimelineEntry,
} from "./strategy-replay";

describe("placement release comparison", () => {
  it("compares identical per-match results and durations, without changing the scheduling policy", () => {
    const seeds = Number(process.env["REPLAY_SEEDS"] ?? 5);
    const small: FieldSpec = {
      events: ["MS", "WS"].map((code) => ({
        code,
        entrants: Array.from({ length: 8 }, (_, i) => ({ players: [`${code}-${i}`] })),
      })),
    };
    const lines = [
      "# Fixed placement feeders versus whole-round release",
      "",
      "Paired per-match outcomes and durations; real format builders and planner. Reflow is simulated, not SQL. Times are minutes; finish includes overnight gaps. Changes exclude reflow, as in the existing strategy replay.",
      "",
      "| Field | Courts | Release | Finish mean | Idle mean | Wait total mean | Wait p95 mean | Published postponements mean |",
      "|---|---:|---|---:|---:|---:|---:|---:|",
    ];
    for (const scenario of [
      { name: "2 × 8", field: small, courts: 3 },
      { name: "Viet Nam Open", field: field as FieldSpec, courts: 4 },
      { name: "Viet Nam Open", field: field as FieldSpec, courts: 8 },
    ]) {
      const paired = new Map<string, ReplayMetrics[]>();
      const fingerprints = new Map<number, string>();
      for (const release of ["whole-round", "feeders"] as const) {
        const results: ReplayMetrics[] = [];
        for (let seed = 1; seed <= seeds; seed++) {
          const timeline: TimelineEntry[] = [];
          const result = runReplay(
            "place-ready",
            {
              ...DEFAULT_CONFIG,
              field: scenario.field,
              courts: scenario.courts,
              seed,
              roundTwoRelease: release,
              pairedOutcomes: true,
              timing: { groupSlot: 20, groupRest: 10, koSlot: 25, koRest: 30 },
            },
            timeline,
          );
          expect(result.stuck).toBe(false);
          expect(findOverlaps(timeline)).toEqual([]);
          const fingerprint = JSON.stringify(
            timeline
              .map((m) => [m.id, [...m.players].sort(), Math.round(m.end - m.start)])
              .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          );
          if (release === "whole-round") fingerprints.set(seed, fingerprint);
          else expect(fingerprint).toBe(fingerprints.get(seed));
          results.push(result);
        }
        paired.set(release, results);
        const avg = (pick: (m: ReplayMetrics) => number) =>
          (results.reduce((sum, m) => sum + pick(m), 0) / seeds).toFixed(1);
        lines.push(
          `| ${scenario.name} | ${scenario.courts} | ${release} | ${avg((m) => m.lastEndMinutes)} | ${avg((m) => m.courtIdleMinutes)} | ${avg((m) => m.waitSumMinutes)} | ${avg((m) => m.waitP95Minutes)} | ${avg((m) => m.postponements)} |`,
        );
      }
      expect(paired.get("feeders")!.map((m) => m.matches)).toEqual(
        paired.get("whole-round")!.map((m) => m.matches),
      );
    }
    lines.push(
      "",
      `Seeds per scenario: ${seeds}. No assertion that early release always improves finish or waiting.`,
    );
    mkdirSync(".benchmark", { recursive: true });
    writeFileSync(".benchmark/placement-feeders.md", lines.join("\n"));
    console.log(lines.join("\n"));
  });
});
