import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures/app";

test("policy pages and operator contact are usable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, heading] of [
    ["/privacy", "Pilot privacy policy"],
    ["/terms", "Pilot terms of use"],
    ["/contact", "Contact and data requests"],
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
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
  await expect(page.getByRole("link", { name: "nhphuong@iastate.edu" })).toHaveAttribute(
    "href",
    "mailto:nhphuong@iastate.edu",
  );
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
    pilot_terms_version: "2026-11-11-pilot-draft",
  });
});
