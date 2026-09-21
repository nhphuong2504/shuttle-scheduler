import { describe, expect, it } from "vitest";

import { DENSITY_STORAGE_KEY, isDensity, parseStoredDensity, resolveDensity } from "./density";
import * as themeModule from "./theme";
import {
  DARK_CLASS,
  isTheme,
  parseStoredTheme,
  resolveTheme,
  SYSTEM_DARK_QUERY,
  THEME_STORAGE_KEY,
} from "./theme";

/**
 * Theme precedence, and the separation from density.
 *
 * The required behaviour is easy to get subtly wrong in the same way density was:
 * the fallback is the operating system's setting, which changes while the page is
 * open, so the obvious implementation - write the system's current value to storage
 * on first load - converts "I have not chosen" into "I chose whatever the system
 * happened to be", and the operator can never get back to following it. These tests
 * pin the rule at the pure-function level, where it is cheap to check exhaustively.
 */
describe("theme resolution", () => {
  it("prefers an explicit choice over the system", () => {
    // Both directions matter and they fail differently. The first is the operator who
    // wants light in a dim hall; the second is the operator who wants dark in a bright
    // one. A one-directional precedence rule passes half of this and looks correct.
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("falls back to the system only when nothing was chosen", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
  });

  it("rejects stored values that are not a theme", () => {
    expect(parseStoredTheme("light")).toBe("light");
    expect(parseStoredTheme("dark")).toBe("dark");
    // Values from an older build, a future build, or hand-edited storage must not
    // resolve to a theme that silently applies.
    expect(parseStoredTheme("Dim")).toBeNull();
    expect(parseStoredTheme("system")).toBeNull();
    expect(parseStoredTheme("")).toBeNull();
    expect(parseStoredTheme(null)).toBeNull();
    expect(parseStoredTheme(undefined)).toBeNull();
  });

  it("never treats 'system' as a stored choice", () => {
    // The absence of a stored value already means "follow the system", so a literal
    // "system" would be a second way to say the same thing. Supporting it would mean
    // two states that must be kept in agreement, and the pre-hydration script would
    // have to know about both.
    expect(isTheme("system")).toBe(false);
  });

  it("agrees with isTheme", () => {
    for (const value of ["light", "dark"] as const) {
      expect(isTheme(value)).toBe(true);
    }
    for (const value of ["system", "", 0, null, undefined, {}]) {
      expect(isTheme(value)).toBe(false);
    }
  });
});

describe("theme has no route default, and that is the design", () => {
  it("resolves from exactly two inputs", () => {
    // Arity is asserted deliberately. The design is that a route has no say in the
    // theme, because lighting is a property of the room rather than of the page, so
    // the thing to prevent is a third parameter being added - which is how a
    // route-shaped default would come back in without anyone deciding to add one.
    expect(resolveTheme.length).toBe(2);
  });

  it("exports nothing route-shaped to resolve a default with", () => {
    // The negative assertion is the point: density exports `defaultDensityFor(pathname)`
    // and theme must not grow the equivalent. Checked on the module rather than by
    // reading the source, so the documentation of this decision cannot trip it.
    expect("defaultThemeFor" in themeModule).toBe(false);
    expect("THEME_PATHS" in themeModule).toBe(false);
  });
});

describe("theme and density are independent preferences", () => {
  it("stores them under different keys", () => {
    // The whole separation rests on this. One shared key would make choosing a theme
    // overwrite a density, and the symptom would look like a density bug.
    expect(THEME_STORAGE_KEY).not.toBe(DENSITY_STORAGE_KEY);
    expect(THEME_STORAGE_KEY).toBe("tournova.theme");
    expect(DENSITY_STORAGE_KEY).toBe("tournova.density");
  });

  it("gives each preference only the inputs it needs", () => {
    // Symmetric guard to the arity check above: density must not consult the system
    // colour scheme, and theme must not consult the route. Each takes exactly the two
    // arguments its own question requires - no more.
    expect(resolveDensity.length).toBe(2);
    expect(resolveTheme.length).toBe(2);
  });

  it("cannot produce a value the other axis would accept", () => {
    // A cross-contamination bug would most likely show up as one preference's value
    // landing in the other's storage key and being accepted by its parser, so that is
    // what is checked. Note this is the *parsers* and not the resolvers: a resolver
    // takes an already-parsed value and trusts it, so asking it to reject a foreign
    // string would be testing a contract it does not have.
    for (const theme of ["light", "dark"] as const) {
      expect(parseStoredDensity(theme)).toBeNull();
      expect(isDensity(theme)).toBe(false);
    }
    for (const density of ["comfortable", "compact"] as const) {
      expect(parseStoredTheme(density)).toBeNull();
      expect(isTheme(density)).toBe(false);
    }
  });
});

describe("theme switch contract", () => {
  it("keys the dark tokens off a class the stylesheet declares", () => {
    expect(DARK_CLASS).toBe("dark");
  });

  it("asks about the system in the query the bootstrap script also uses", () => {
    // The script is injected with this literal rather than restating it, so this pins
    // the value both sides depend on.
    expect(SYSTEM_DARK_QUERY).toBe("(prefers-color-scheme: dark)");
  });
});
