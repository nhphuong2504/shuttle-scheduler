import { chromium, type FullConfig } from "@playwright/test";

import { installAppMock, mockEscapes } from "./fixtures/app-mock";
import { routes } from "./fixtures/routes";

/**
 * Compile the heavy route graphs before parallel workers start their test budgets.
 * Vite's listening socket only proves that the server is up: the first Schedule HTML
 * request alone can take 43s under concurrent cold transforms. Use one hermetic browser
 * here to prepare both SSR and client modules, then discard its context. Tests still
 * create fresh pages, install their own fixtures and run every assertion themselves.
 */
export default async function prepareRoutes(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("Browser route preparation requires a baseURL.");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL });
    await installAppMock(page, { role: "user" });
    for (const path of [routes.schedule, routes.desk, routes.settings]) {
      console.log(`Preparing browser route: ${path}`);
      await page.goto(path, { waitUntil: "load", timeout: 120_000 });
      await page.waitForLoadState("networkidle", { timeout: 120_000 });
      await page.locator("main h1").first().waitFor({ state: "visible", timeout: 30_000 });
    }
    const escapes = mockEscapes(page);
    if (escapes.length)
      throw new Error(`Unmocked requests during route preparation: ${escapes.join(", ")}`);
  } finally {
    await browser.close();
  }
}
