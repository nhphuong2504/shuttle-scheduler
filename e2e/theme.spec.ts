import { expect, test, type Page } from "@playwright/test";

import { DENSITY_STORAGE_KEY, type Density } from "../src/lib/design/density";
import { THEME_STORAGE_KEY, type Theme } from "../src/lib/design/theme";

/**
 * Theme switching, in a real browser.
 *
 * The unit tests pin the resolution rule; these pin the things that rule cannot see.
 * Three of them matter more than the rest:
 *
 *   - That the theme is applied by the inline bootstrap script rather than by React.
 *     This is the flicker requirement, and it is invisible to any assertion made after
 *     hydration, because by then React has set the class too and the page looks
 *     identical either way. The only honest test is to stop React from running at all
 *     and check the class is still there.
 *   - That a choice survives a reload and a route change. Both are the same assertion
 *     in spirit but they fail for different reasons: a reload re-runs the bootstrap
 *     script, a route change re-runs the module-scope store and the effect.
 *   - That the two preferences are genuinely independent. The failure this guards
 *     against is not a crash but a coupling - choosing a theme silently resetting the
 *     density, or the Desk's Compact default overwriting the theme.
 *
 * ## Why `seedPreferences` only ever writes
 *
 * There is deliberately no way to clear a preference from the helper. Playwright gives
 * each test a fresh browser context, so storage starts empty and there is nothing to
 * clear - and an init script re-runs on *every* navigation, so a helper that also
 * cleared would erase the choice the test had just made the moment it reloaded. That
 * mistake was made here: it cost three tests, and all three failed in the reassuring
 * direction, looking like a persistence bug in `useTheme` rather than a helper wiping
 * the data. The assumption that storage starts empty is guarded rather than assumed,
 * by the "reports the state it is actually rendering" test, which asserts that no
 * reset control is offered when nothing has been chosen.
 */

/** Seeds preferences before any page script runs, including the bootstrap. */
async function seedPreferences(
  page: Page,
  preferences: { theme?: Theme; density?: Density },
): Promise<void> {
  const { theme, density } = preferences;
  if (theme === undefined && density === undefined) return;

  await page.addInitScript(
    ([themeValue, densityValue, themeKey, densityKey]) => {
      try {
        if (themeValue) localStorage.setItem(themeKey!, themeValue);
        if (densityValue) localStorage.setItem(densityKey!, densityValue);
      } catch {
        // Storage can be unavailable; the test then runs against the default, which
        // its own assertions will notice rather than passing silently.
      }
    },
    [theme ?? null, density ?? null, THEME_STORAGE_KEY, DENSITY_STORAGE_KEY],
  );
}

/** Waits for React to attach handlers, so clicks cannot race hydration. */
async function awaitHydration(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
}

const darkClass = (page: Page) => page.locator("html");

test.describe("the system preference is the default", () => {
  test("follows a dark system setting when nothing has been chosen", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/", { waitUntil: "networkidle" });

    await expect(darkClass(page)).toHaveClass(/\bdark\b/);
  });

  test("follows a light system setting when nothing has been chosen", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/", { waitUntil: "networkidle" });

    await expect(darkClass(page)).not.toHaveClass(/\bdark\b/);
  });

  test("an explicit choice overrides the system in both directions", async ({ page }) => {
    // Light chosen while the system is dark. This is the operator who needs a bright
    // screen in a dim room, and it is the direction a one-sided implementation gets
    // wrong, because defaulting to the system and then "letting dark win" both look
    // correct for the dark case.
    await page.emulateMedia({ colorScheme: "dark" });
    await seedPreferences(page, { theme: "light" });
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(darkClass(page)).not.toHaveClass(/\bdark\b/);

    // Dark chosen while the system is light.
    await page.emulateMedia({ colorScheme: "light" });
    await seedPreferences(page, { theme: "dark" });
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(darkClass(page)).toHaveClass(/\bdark\b/);
  });
});

test.describe("the theme is applied before React runs", () => {
  test("the class is already correct with the application bundle blocked", async ({ page }) => {
    // This is the flicker requirement, tested by removing the thing that could hide
    // the answer. The stylesheet still loads, so what is being measured is purely
    // whether the inline script in <head> set the class - which is the difference
    // between a first paint in the chosen theme and a flash of the wrong one.
    await seedPreferences(page, { theme: "dark" });
    await page.route(/\.(js|mjs|tsx|ts)(\?|$)/, (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(darkClass(page)).toHaveClass(/\bdark\b/);
    // Hydration never happens, so this also proves the class did not come from React.
    await expect(page.locator("html")).not.toHaveAttribute("data-hydrated", "true");
  });

  test("the light default also paints without the bundle", async ({ page }) => {
    // The mirror case. Without it, a script that unconditionally added the class would
    // pass the test above.
    await page.emulateMedia({ colorScheme: "light" });
    await seedPreferences(page, { theme: "light" });
    await page.route(/\.(js|mjs|tsx|ts)(\?|$)/, (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(darkClass(page)).not.toHaveClass(/\bdark\b/);
  });

  test("a normal load logs no hydration mismatch", async ({ page }) => {
    // The bootstrap writes to <html> before React runs, which is exactly the shape
    // that produces a hydration warning if `suppressHydrationWarning` is ever dropped
    // from that element. An unavoidable warning would also mask a real one.
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));

    await seedPreferences(page, { theme: "dark" });
    await page.goto("/", { waitUntil: "networkidle" });
    await awaitHydration(page);

    const hydration = problems.filter((text) => /hydrat/i.test(text));
    expect(hydration, `hydration warnings: ${hydration.join(" | ")}`).toEqual([]);
  });
});

test.describe("a choice persists", () => {
  test("survives a reload", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await awaitHydration(page);

    await page
      .getByRole("group", { name: "Colour theme" })
      .getByRole("button", { name: "Dark" })
      .click();
    await expect(darkClass(page)).toHaveClass(/\bdark\b/);

    await page.reload({ waitUntil: "networkidle" });
    await expect(darkClass(page)).toHaveClass(/\bdark\b/);

    const stored = await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY);
    expect(stored).toBe("dark");
  });

  test("survives a full navigation to another route", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await awaitHydration(page);

    await page
      .getByRole("group", { name: "Colour theme" })
      .getByRole("button", { name: "Dark" })
      .click();
    await page.goto("/registration", { waitUntil: "networkidle" });

    await expect(darkClass(page)).toHaveClass(/\bdark\b/);
  });

  test("survives a client-side route change", async ({ page }) => {
    // Distinct from the reload case: nothing re-reads storage here, so this is really
    // asserting that the module-scope store in `useTheme` survives a remount of
    // `AppShell` rather than resetting with the component.
    await page.goto("/", { waitUntil: "networkidle" });
    await awaitHydration(page);

    await page
      .getByRole("group", { name: "Colour theme" })
      .getByRole("button", { name: "Dark" })
      .click();
    await page.getByRole("link", { name: "Registration", exact: true }).click();
    await expect(page).toHaveURL(/\/registration$/);

    await expect(darkClass(page)).toHaveClass(/\bdark\b/);
  });

  test("System returns to following the operating system", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await seedPreferences(page, { theme: "dark" });
    await page.goto("/", { waitUntil: "networkidle" });
    await awaitHydration(page);
    await expect(darkClass(page)).toHaveClass(/\bdark\b/);

    // The reset only appears once a choice exists, so this also pins that.
    await page.getByRole("button", { name: "System" }).click();

    await expect(darkClass(page)).not.toHaveClass(/\bdark\b/);
    const stored = await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY);
    expect(
      stored,
      "returning to the system must remove the choice, not store the system's value",
    ).toBeNull();
  });
});

test.describe("the theme actually changes what is painted", () => {
  test("resolves different background tokens in each theme", async ({ page }) => {
    await seedPreferences(page, { theme: "light" });
    await page.goto("/", { waitUntil: "networkidle" });
    const light = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        background: style.getPropertyValue("--background").trim(),
        foreground: style.getPropertyValue("--foreground").trim(),
        colorScheme: style.colorScheme,
      };
    });

    await seedPreferences(page, { theme: "dark" });
    await page.reload({ waitUntil: "networkidle" });
    const dark = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        background: style.getPropertyValue("--background").trim(),
        foreground: style.getPropertyValue("--foreground").trim(),
        colorScheme: style.colorScheme,
      };
    });

    expect(light.background).not.toBe("");
    expect(dark.background).not.toBe("");
    expect(dark.background).not.toBe(light.background);
    expect(dark.foreground).not.toBe(light.foreground);

    // `color-scheme` is what makes the browser's own chrome - scrollbars, native
    // control interiors - follow the theme. Without it a dark page gets light
    // scrollbars, which is the most common way a dark theme reads as unfinished.
    expect(light.colorScheme).toBe("light");
    expect(dark.colorScheme).toBe("dark");
  });

  test("repaints the page surface, not just the custom property", async ({ page }) => {
    // Guards against the class being applied while the tokens that depend on it are
    // not, which a property read alone would not catch.
    await seedPreferences(page, { theme: "light" });
    await page.goto("/", { waitUntil: "networkidle" });
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await seedPreferences(page, { theme: "dark" });
    await page.reload({ waitUntil: "networkidle" });
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    expect(dark).not.toBe(light);
  });
});

test.describe("theme and density do not interfere", () => {
  test("choosing a theme leaves the density alone", async ({ page }) => {
    // The Desk, whose density default is Compact, with a theme chosen on it. If the
    // two shared a storage key or a single store, this is where it would show.
    await page.goto("/", { waitUntil: "networkidle" });
    await awaitHydration(page);
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");

    await page
      .getByRole("group", { name: "Colour theme" })
      .getByRole("button", { name: "Dark" })
      .click();

    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
    const density = await page.evaluate((key) => localStorage.getItem(key), DENSITY_STORAGE_KEY);
    expect(density, "choosing a theme must not write a density preference").toBeNull();
  });

  test("choosing a density leaves the theme alone", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/", { waitUntil: "networkidle" });
    await awaitHydration(page);
    await expect(darkClass(page)).toHaveClass(/\bdark\b/);

    await page
      .getByRole("group", { name: "Text and row density" })
      .getByRole("button", { name: "Comfortable" })
      .click();

    await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");
    await expect(darkClass(page)).toHaveClass(/\bdark\b/);
    const theme = await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY);
    expect(theme, "choosing a density must not write a theme preference").toBeNull();
  });

  test("both choices survive together", async ({ page }) => {
    await page.goto("/registration", { waitUntil: "networkidle" });
    await awaitHydration(page);

    await page
      .getByRole("group", { name: "Colour theme" })
      .getByRole("button", { name: "Dark" })
      .click();
    await page
      .getByRole("group", { name: "Text and row density" })
      .getByRole("button", { name: "Compact" })
      .click();

    await page.reload({ waitUntil: "networkidle" });

    await expect(darkClass(page)).toHaveClass(/\bdark\b/);
    await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  });
});

test.describe("the theme control is operable", () => {
  test("reports the state it is actually rendering", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/", { waitUntil: "networkidle" });
    await awaitHydration(page);

    // Nothing was chosen, but the page is dark, so Dark must read as pressed. A
    // control that showed "System" instead would be describing a state the operator
    // cannot see.
    const dark = page
      .getByRole("group", { name: "Colour theme" })
      .getByRole("button", { name: "Dark" });
    await expect(dark).toHaveAttribute("aria-pressed", "true");
    // And no reset, because there is nothing to reset yet.
    await expect(page.getByRole("button", { name: "System" })).toHaveCount(0);
  });

  test("survives being driven from the keyboard", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await awaitHydration(page);

    const dark = page
      .getByRole("group", { name: "Colour theme" })
      .getByRole("button", { name: "Dark" });
    await dark.focus();
    await page.keyboard.press("Enter");

    await expect(darkClass(page)).toHaveClass(/\bdark\b/);
  });
});
