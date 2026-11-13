import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures/app";
import { routes } from "./fixtures/routes";

test("sign-in puts the form first on a small phone and supports keyboard password visibility", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/auth");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: "Sign in to Tournova" })).toBeVisible();
  const submit = main.getByRole("button", { name: "Sign in", exact: true }).last();
  await expect(submit).toBeEnabled();
  const box = await submit.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);
  const password = page.getByLabel("Password", { exact: true });
  await password.fill("sample-password");
  const show = page.getByRole("button", { name: "Show password", exact: true });
  await show.focus();
  await page.keyboard.press("Space");
  await expect(password).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Hide password", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Space");
  await expect(password).toHaveAttribute("type", "password");
  const help = page.getByText("What can I do with an account?", { exact: true });
  await expect(
    page.getByText("Send your entry and follow the decision on your request.", { exact: false }),
  ).toBeHidden();
  await help.click();
  await expect(
    page.getByText("Send your entry and follow the decision on your request.", { exact: false }),
  ).toBeVisible();
  await help.click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
      .violations,
  ).toEqual([]);
});

test("policy pages and operator contact are usable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, heading] of [
    ["/privacy", "Pilot privacy policy"],
    ["/terms", "Pilot terms of use"],
    ["/contact", "Contact and data requests"],
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText(/Version 1\.0\./)).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("Phuong Nguyen");
    await expect(
      page
        .getByRole("navigation", { name: "Site information" })
        .getByRole("link", { name: "Privacy", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
        .violations,
    ).toEqual([]);
  }
  await expect(page.getByRole("link", { name: "support@tournova.app" })).toHaveAttribute(
    "href",
    "mailto:support@tournova.app",
  );
});

test("public headers keep their size while adding scroll depth and respect reduced motion", async ({
  page,
}) => {
  for (const path of ["/privacy", "/"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const header = page.getByRole("banner");
    await expect(header).toHaveAttribute("data-scrolled", "false");
    const initial = await header.boundingBox();
    expect(initial).not.toBeNull();
    await page.evaluate(() => window.scrollTo(0, 240));
    await expect(header).toHaveAttribute("data-scrolled", "true");
    const scrolled = await header.boundingBox();
    expect(scrolled!.y).toBe(0);
    expect(scrolled!.height).toBe(initial!.height);
    const browse = header.getByRole("link", { name: "Browse tournaments", exact: true });
    await browse.hover();
    expect(await browse.evaluate((link) => getComputedStyle(link).textDecorationLine)).toBe("none");
    expect(await browse.evaluate((link) => getComputedStyle(link).backgroundImage)).toBe("none");
    await expect.poll(() => browse.evaluate((link) => getComputedStyle(link).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await browse.focus();
    await expect(browse).toBeFocused();
    expect(await browse.evaluate((link) => getComputedStyle(link).backgroundImage)).toBe("none");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(header).toHaveAttribute("data-scrolled", "false");
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .getByRole("banner")
      .evaluate((header) => getComputedStyle(header).transitionProperty),
  ).toBe("none");
});

test("current public navigation uses a selected surface instead of an underline", async ({
  page,
}) => {
  await page.goto("/explore");
  const browse = page
    .getByRole("banner")
    .getByRole("link", { name: "Browse tournaments", exact: true });
  await expect(browse).toHaveAttribute("aria-current", "page");
  expect(await browse.evaluate((link) => getComputedStyle(link).textDecorationLine)).toBe("none");
  expect(await browse.evaluate((link) => getComputedStyle(link).backgroundColor)).not.toBe(
    "rgba(0, 0, 0, 0)",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await browse.evaluate((link) => getComputedStyle(link).transitionProperty)).toBe("none");
});

test.describe("signed-in header disclosures", () => {
  test.use({ appMock: { preset: "layout", role: "user" } });

  test("closing menus removes interaction immediately and returns focus", async ({ page }) => {
    await page.goto(routes.now);
    const account = page.getByRole("button", { name: "Account", exact: true });
    await account.click();
    await expect(account).toHaveAttribute("aria-expanded", "true");
    const panelId = await account.getAttribute("aria-controls");
    const panel = page.locator(`[id="${panelId}"]`);
    await expect(panel).toBeVisible();
    expect(await panel.evaluate((element) => getComputedStyle(element).animationName)).toBe(
      "header-panel-in",
    );
    await page.screenshot({ path: test.info().outputPath("header-account.png") });
    await page.keyboard.press("Escape");
    await expect(account).toHaveAttribute("aria-expanded", "false");
    await expect(account).toBeFocused();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
    await expect(panel).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await account.click();
    await expect(panel).toBeVisible();
    expect(await panel.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
    await page.keyboard.press("Escape");
    await expect(account).toBeFocused();
    await expect(panel).toHaveCount(0);
    const switcher = page.getByRole("button", { name: "Switch tournament", exact: true });
    await switcher.click();
    await expect(switcher).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(switcher).toHaveAttribute("aria-expanded", "false");
    await expect(switcher).toBeFocused();
  });
});

test("signup waits for adult acknowledgement and sends the terms version", async ({ page }) => {
  await page.goto("/auth");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  const adult = page.getByRole("checkbox", { name: "I am at least 18 years old." });
  await adult.focus();
  await page.keyboard.press("Space");
  await page.getByLabel("Email", { exact: true }).fill("adult@example.test");
  await page.getByLabel("Password", { exact: true }).fill("test-password-123");
  await page.getByRole("button", { name: "Create account", exact: true }).last().click();
  await expect(page.getByRole("alert")).toContainText("agree to the pilot terms");
  await page.getByRole("checkbox", { name: /I agree to the pilot Terms/ }).check();
  let payload: Record<string, unknown> | undefined;
  await page.route("**/auth/v1/signup**", async (route) => {
    payload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: "00000000-0000-0000-0000-000000000123",
          email: "adult@example.test",
          identities: [],
        },
        session: null,
      }),
    });
  });
  await page.getByRole("button", { name: "Create account", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  expect(payload?.data).toEqual({
    pilot_adult_confirmed: true,
    pilot_terms_version: "1.0",
  });
});

test("adult accounts and all-age participation stay distinct on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/auth");
  await expect(
    page.getByText(
      "An account lets you register for a tournament, or run your own. Watching a tournament never needs one.",
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(page.getByText("Accounts 18+", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByText("Accounts 18+", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Players of all ages can take part/)).toBeVisible();
  await expect(page.getByText(/Under 18\? You can still play/)).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  let signupRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/auth/v1/signup")) signupRequests++;
  });
  await page.getByRole("checkbox", { name: /I agree to the pilot Terms/ }).check();
  await page.getByRole("button", { name: "Create account", exact: true }).last().click();
  await expect(page.getByRole("alert")).toContainText("at least 18");
  expect(signupRequests).toBe(0);
  const adult = page.getByRole("checkbox", { name: "I am at least 18 years old." });
  await adult.focus();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
      .violations,
  ).toEqual([]);
  await adult.uncheck();
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  await page.goto("/terms");
  await expect(page.getByText(/Players of all ages may participate/)).toBeVisible();
  await page.goto("/privacy");
  await expect(page.getByText(/this is an account restriction, not a minimum/)).toBeVisible();
});
