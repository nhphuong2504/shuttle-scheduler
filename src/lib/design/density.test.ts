import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DESK_PATHS,
  defaultDensityFor,
  isDensity,
  parseStoredDensity,
  resolveDensity,
} from "./density";

/**
 * Density precedence.
 *
 * These tests exist because the required behaviour is counter-intuitive to
 * implement: the Desk defaults to Compact, but an operator who chose Comfortable
 * must get Comfortable *on the Desk too*. The naive implementation - writing the
 * default to storage when the Desk mounts - passes a casual manual check and
 * quietly destroys the preference. Encoding the rule here is what stops that
 * regression, since a manual check would have to visit the Desk after choosing
 * Comfortable elsewhere and notice that the choice had been consumed.
 */
describe("density resolution", () => {
  it("prefers an explicit preference over the route default", () => {
    // The single most important assertion in this file: chosen Comfortable, on the
    // Desk, stays Comfortable.
    expect(resolveDensity("comfortable", "/")).toBe("comfortable");
    expect(resolveDensity("compact", "/registration")).toBe("compact");
  });

  it("falls back to the route default only when nothing was chosen", () => {
    expect(resolveDensity(null, "/")).toBe("compact");
    expect(resolveDensity(null, "/matches")).toBe("compact");
    expect(resolveDensity(null, "/registration")).toBe("comfortable");
    expect(resolveDensity(null, "/placement-schedule")).toBe("comfortable");
  });

  it("treats a trailing slash as the same route", () => {
    expect(defaultDensityFor("/matches/")).toBe("compact");
    expect(defaultDensityFor("/")).toBe("compact");
    expect(defaultDensityFor("///")).toBe("compact");
    expect(defaultDensityFor("/draws/")).toBe("comfortable");
  });

  it("defaults unknown routes to comfortable", () => {
    // A route added later inherits the readable default rather than the dense one,
    // so density is only ever tightened deliberately.
    expect(defaultDensityFor("/something-new")).toBe("comfortable");
    expect(defaultDensityFor("/draws")).toBe("comfortable");
  });

  it("treats a degenerate empty pathname as root, not as unknown", () => {
    // `location.pathname` is never empty in practice, so this is purely defensive.
    // Falling through to root keeps `""` and `"/"` from disagreeing about the same
    // page, which would be the more surprising behaviour of the two options.
    expect(defaultDensityFor("")).toBe("compact");
  });

  it("rejects stored values that are not a density", () => {
    expect(parseStoredDensity("compact")).toBe("compact");
    expect(parseStoredDensity("comfortable")).toBe("comfortable");
    // Values from an older build, or hand-edited storage, must not resolve to a
    // density that silently applies.
    expect(parseStoredDensity("cozy")).toBeNull();
    expect(parseStoredDensity("")).toBeNull();
    expect(parseStoredDensity(null)).toBeNull();
    expect(parseStoredDensity(undefined)).toBeNull();
    expect(parseStoredDensity("Compact")).toBeNull();
  });

  it("agrees with isDensity", () => {
    for (const value of ["comfortable", "compact"] as const) {
      expect(isDensity(value)).toBe(true);
    }
    for (const value of ["cozy", "", 0, null, undefined, {}]) {
      expect(isDensity(value)).toBe(false);
    }
  });
});

describe("desk route list", () => {
  it("covers the two dense operational lists", () => {
    expect([...DESK_PATHS].sort()).toEqual(["/", "/matches"]);
  });

  it("every desk path is a real destination", () => {
    // Guards against a route being renamed and leaving the default stranded on a
    // path that no longer exists, which would fail silently - the Desk would just
    // render Comfortable and nothing would report it.
    const navSource = readFileSync(join(process.cwd(), "src/components/app-shell.tsx"), "utf8");
    const reachable = [...navSource.matchAll(/to: "(\/[a-z-]*)"/g)].map((m) => m[1]);
    for (const path of DESK_PATHS) {
      expect(reachable, `${path} is not reachable from the nav`).toContain(path);
    }
  });
});
