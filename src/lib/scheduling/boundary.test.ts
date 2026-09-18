/**
 * Architectural guards for the sport-agnostic core.
 *
 * These tests read the source tree rather than calling it. The import boundary is the primary
 * guard: the core must not depend on the tournament domain in either direction, because that is
 * the single property that makes the solvers reusable across sports. The vocabulary scan is a
 * weaker, secondary signal and is deliberately restricted to clearly domain-specific words so it
 * cannot produce false positives on ordinary English.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { assertValidSolution, at } from "./invariant-harness.test-helpers";
import type { SchedulingProblem } from "./domain";
import { getFormatProvider, hasFormatProvider, listFormatProviders, registerFormatProvider } from "../tournament/scheduling/formats";
import { buildPlacementAbcd } from "../tournament/scheduling/formats/placement-abcd";
import { buildRoundRobin } from "../tournament/scheduling/formats/round-robin";
import { buildSingleElimination, standardSeedOrder } from "../tournament/scheduling/formats/single-elimination";
import { DEFAULT_SOLVER_ID, getSolver, greedySolver, hasSolver, listSolvers, registerSolver, solve } from ".";

const CORE_DIR = join(__dirname);
const REPO_ROOT = join(__dirname, "..", "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if ([".ts", ".tsx"].includes(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

/** This file necessarily mentions the domain words it forbids, so it excludes itself. */
const BOUNDARY_TEST = join(CORE_DIR, "boundary.test.ts");

/** Test files may name the domain freely; the guards cover production code. */
function isTestFile(file: string): boolean {
  return (
    file === BOUNDARY_TEST ||
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.endsWith(".test-helpers.ts")
  );
}

function coreSources(): string[] {
  return sourceFiles(CORE_DIR).filter((file) => !isTestFile(file));
}

describe("import boundary", () => {
  it("never reaches into the tournament domain", () => {
    const offenders: string[] = [];
    for (const file of coreSources()) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        if (specifier.includes("tournament") || specifier.includes("/routes")) {
          offenders.push(`${relative(REPO_ROOT, file).split(sep).join("/")} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses only Node and intra-package modules", () => {
    const offenders: string[] = [];
    for (const file of [...coreSources(), BOUNDARY_TEST]) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".") && !specifier.startsWith("node:") && specifier !== "vitest") {
          offenders.push(`${relative(REPO_ROOT, file).split(sep).join("/")} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("leaves nothing importing the deleted legacy engine", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(REPO_ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+["']([^"']*scheduler[^"']*)["']/g)) {
        const specifier = match[1]!;
        if (/(^|\/)scheduler(-grasp)?$/.test(specifier) || specifier.endsWith("/scheduler")) {
          offenders.push(`${relative(REPO_ROOT, file).split(sep).join("/")} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("domain vocabulary", () => {
  /**
   * Clearly domain-specific words only. Broad tokens were deliberately left out: "pool" and "set"
   * are ordinary scheduling words, and "est:" would match normal prose.
   *
   * The scan runs over *code with comments stripped*. Illustrating a mechanism with "a knockout
   * side awaiting a winner" is documentation, not a dependency; what must never happen is a
   * sport or bracket concept appearing as an identifier, type or field in the core.
   */
  const FORBIDDEN = [
    "badminton",
    "bracket",
    "category",
    "court",
    "knockout",
    "placement",
    "player",
    "pool",
    "round1",
    "roundRobin",
    "shuttlecock",
    "tier",
    "tournament",
  ];

  /** Removes block and line comments so the scan sees code only. */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .map((line) => {
        const marker = line.indexOf("//");
        if (marker < 0) return line;
        // Keep the part before `//` only when it is not inside a string literal.
        const before = line.slice(0, marker);
        const quotes = (before.match(/["'`]/g) ?? []).length;
        return quotes % 2 === 0 ? before : line;
      })
      .join("\n");
  }

  it("keeps sport and bracket vocabulary out of the core's code", () => {
    const offenders: string[] = [];
    for (const file of coreSources()) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const token of FORBIDDEN) {
        if (new RegExp(`\\b${token}\\b`, "i").test(code)) {
          offenders.push(`${relative(REPO_ROOT, file).split(sep).join("/")} contains "${token}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("solver registry", () => {
  it("exposes every interchangeable strategy plus a default", () => {
    const ids = listSolvers()
      .map((solver) => solver.id)
      .sort();
    expect(ids).toEqual(["grasp", "grasp-hybrid", "greedy"]);
    expect(hasSolver(DEFAULT_SOLVER_ID)).toBe(true);
    for (const id of ids) expect(hasSolver(id)).toBe(true);
  });

  it("throws a named error for an unknown solver id", () => {
    expect(() => getSolver("does-not-exist")).toThrow(/Unknown solver/);
    expect(hasSolver("does-not-exist")).toBe(false);
  });

  it("refuses a duplicate registration rather than silently replacing", () => {
    expect(() => registerSolver(greedySolver)).toThrow(/already registered/);
  });

  it("runs the same problem through either solver without changing the contract", () => {
    const problem = {
      matches: [
        {
          id: "m1",
          participantIds: ["p1"],
          durationMinutes: 30,
          groupKey: "g",
        },
      ],
      resources: [{ id: "r1", order: 1 }],
      horizonStart: 0,
      planningEnd: 8 * 60 * 60_000,
      floor: 0,
    };
    for (const id of ["greedy", "grasp", "grasp-hybrid"]) {
      const solution = solve(problem, id, { seed: 1, runs: 1 });
      expect(solution.assignments.map((assignment) => assignment.matchId)).toEqual(["m1"]);
      expect(solution.unscheduled).toEqual([]);
      expect(solution.diagnostics.solverId).toBe(id);
    }
  });
});

describe("format registry", () => {
  it("lists the three built-in formats in id order", () => {
    expect(listFormatProviders().map((provider) => provider.id)).toEqual([
      "placement-abcd",
      "round-robin",
      "single-elimination",
    ]);
    expect(hasFormatProvider("round-robin")).toBe(true);
    expect(hasFormatProvider("swiss")).toBe(false);
  });

  it("throws a named error for an unknown format id", () => {
    expect(() => getFormatProvider("swiss")).toThrow(/Unknown format provider id/);
  });

  it("refuses a duplicate registration rather than silently replacing", () => {
    expect(() =>
      registerFormatProvider({
        id: "round-robin",
        name: "Duplicate",
        timingKeys: [],
        buildMatches: () => [],
      }),
    ).toThrow(/Duplicate format provider id/);
  });
});

describe("round robin", () => {
  it("pairs every entrant with every other exactly once", () => {
    const matches = buildRoundRobin({ entrants: ["a", "b", "c", "d"], groupKey: "pool-1" });
    const pairs = matches.map((match) => [...match.participantRefs].sort().join("|")).sort();
    expect(pairs).toEqual(["a|b", "a|c", "a|d", "b|c", "b|d", "c|d"]);
    // Every participant plays once per round, and never twice in one round.
    const byRound = new Map<number, string[]>();
    for (const match of matches) {
      const round = Math.floor((match.sequence ?? 0) / 1000);
      const list = byRound.get(round) ?? [];
      list.push(...(match.participantRefs as string[]));
      byRound.set(round, list);
    }    for (const list of byRound.values()) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("gives an odd field a bye and still plays one match per round", () => {
    const matches = buildRoundRobin({ entrants: ["a", "b", "c"], groupKey: "pool-1" });
    expect(matches).toHaveLength(3);
    const rounds = new Set(matches.map((match) => Math.floor((match.sequence ?? 0) / 1000)));
    // Three entrants: each round one sits out, so there are three rounds of one match.
    expect(rounds.size).toBe(3);
  });

  it("returns nothing for fewer than two entrants", () => {
    expect(buildRoundRobin({ entrants: [], groupKey: "p" })).toEqual([]);
    expect(buildRoundRobin({ entrants: ["a"], groupKey: "p" })).toEqual([]);
  });

  it("carries the group key as the completion key", () => {
    for (const match of buildRoundRobin({ entrants: ["a", "b"], groupKey: "pool-7" })) {
      expect(match.groupKey).toBe("pool-7");
      expect(match.completionKey).toBe("pool-7");
    }
  });
});

describe("single elimination", () => {
  it("builds the standard seeding order so the top seeds meet last", () => {
    expect(standardSeedOrder(2)).toEqual([1, 2]);
    expect(standardSeedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(standardSeedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it("gives a bye to the highest seed and never schedules it", () => {
    const matches = buildSingleElimination({
      entrants: ["s1", "s2", "s3"],
      groupKey: "cat",
    });
    const byes = matches.filter((match) => match.bye);
    expect(byes).toHaveLength(1);
    expect(byes[0]!.participantRefs.filter((ref) => ref != null)).toEqual(["s1"]);
    for (const bye of byes) {
      expect(bye.participantRefs.filter((ref) => ref == null)).toHaveLength(1);
    }
  });

  it("emits every round with feeder refs when not limited to round one", () => {
    const matches = buildSingleElimination({
      entrants: ["s1", "s2", "s3", "s4"],
      groupKey: "cat",
    });
    expect(matches).toHaveLength(3);
    const final = matches.find((match) => match.id.endsWith("-r2-m1"));
    expect(final?.dependencyRefs).toEqual(["cat-r1-m1", "cat-r1-m2"]);
  });

  it("limits to round one on request, which is how a live draw grows", () => {
    const matches = buildSingleElimination({
      entrants: ["s1", "s2", "s3", "s4"],
      groupKey: "cat",
      roundOneOnly: true,
    });
    expect(matches).toHaveLength(2);
    expect(matches.every((match) => match.id.includes("-r1-"))).toBe(true);
  });

  it("returns nothing for fewer than two entrants", () => {
    expect(buildSingleElimination({ entrants: ["only"], groupKey: "c" })).toEqual([]);
  });
});

describe("placement abcd", () => {
  it("builds one independent bracket per tier, ordered by tier", () => {
    const matches = buildPlacementAbcd({
      tiers: [
        { tier: "A", entrants: ["a1", "a2"] },
        { tier: "B", entrants: ["b1", "b2"] },
        { tier: "C", entrants: ["c1", "c2"] },
        { tier: "D", entrants: ["d1", "d2"] },
      ],
    });
    expect(matches).toHaveLength(4);
    expect([...new Set(matches.map((match) => match.groupKey))]).toEqual(["A", "B", "C", "D"]);
    // Each tier is its own completion unit and gets a higher phase and soft order.
    expect(matches.map((match) => match.softOrder)).toEqual([0, 1, 2, 3]);
    expect(matches.map((match) => match.phase)).toEqual([0, 1, 2, 3]);
    for (const match of matches) {
      expect(match.id.startsWith(`placement-${match.groupKey}-`)).toBe(true);
    }
  });
});

describe("pure core", () => {
  /**
   * A hand-built problem that names nothing from any sport: resources with an availability window
   * and a capability, a dependency chain, per-match rest and a reported-elsewhere anchor. Greedy,
   * GRASP and a locally-defined third strategy all run it through the same `solve()` contract.
   */
  function syntheticProblem(): SchedulingProblem {
    return {
      matches: [
        {
          id: "base",
          participantIds: ["a", "b"],
          durationMinutes: 30,
          groupKey: "g",
        },
        {
          id: "mid",
          participantIds: ["b", "c"],
          durationMinutes: 45,
          groupKey: "g",
          dependencies: ["base"],
          restAfterMinutes: 20,
        },
        {
          id: "tail",
          participantIds: ["d"],
          durationMinutes: 30,
          groupKey: "g",
          resourceRequirements: ["surface:mat"],
        },
        {
          id: "fixed",
          participantIds: ["e"],
          durationMinutes: 30,
          groupKey: "g",
          fixed: true,
          start: at(660),
          end: at(690),
          resourceId: "r2",
        },
      ],
      resources: [
        { id: "r1", order: 1 },
        { id: "r2", order: 2, availability: [{ start: at(540), end: at(840) }] },
        { id: "r3", order: 3, capabilities: ["surface:mat"] },
      ],
      anchors: [
        {
          id: "reported",
          participantIds: ["a"],
          start: at(550),
          end: at(580),
          restAfterMinutes: 15,
        },
      ],
      horizonStart: at(540),
      planningEnd: at(1020),
      floor: at(540),
      objective: ["makespan", "resourceIdle"],
    };
  }

  it("solves a synthetic problem with both built-in strategies and a third registered one", async () => {
    // A fresh module instance gives this test its own registry, so the third solver cannot leak
    // into the registry assertions above.
    vi.resetModules();
    const core = await import("./solvers");

    const problem = syntheticProblem();
    for (const id of ["greedy", "grasp", "grasp-hybrid"]) {
      const solution = core.solve(problem, id, { runs: 4, seed: 3 });
      assertValidSolution(problem, solution);
      expect(solution.unscheduled).toEqual([]);
    }

    // A third strategy plugs in through the same contract without touching the core.
    const greedy = core.getSolver("greedy");
    const calls: string[] = [];
    core.registerSolver({
      id: "audited-greedy",
      name: "Greedy, audited",
      solve: (inner, options) => {
        calls.push(inner.matches.length.toString());
        const solution = greedy.solve(inner, options);
        return { ...solution, diagnostics: { ...solution.diagnostics, solverId: "audited-greedy" } };
      },
    });

    const solution = core.solve(problem, "audited-greedy");
    expect(calls).toEqual([problem.matches.length.toString()]);
    expect(solution.diagnostics.solverId).toBe("audited-greedy");
    expect(core.listSolvers().map((solver) => solver.id)).toEqual([
      "audited-greedy",
      "grasp",
      "grasp-hybrid",
      "greedy",
    ]);
    assertValidSolution(problem, solution);

    // The fixed match keeps its exact slot, the anchor owns no resource, and rest holds both ways.
    const fixed = solution.assignments.find((assignment) => assignment.matchId === "fixed");
    expect(fixed?.start).toBe(at(660));
    expect(fixed?.resourceId).toBe("r2");
    expect(solution.assignments.some((assignment) => assignment.matchId === "reported")).toBe(false);
    expect(solution.unscheduled).toEqual([]);
  });
});

