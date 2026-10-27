import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures/app";
import { installAppMock } from "./fixtures/app-mock";
import { routes } from "./fixtures/routes";
import { deskFixture } from "./fixtures/desk-mock";

/**
 * The Scores page's event panels read in the standard order, MS -> WS -> MD -> WD -> XD.
 *
 * The panels are built by walking the matches, so they used to appear in the order their
 * events' *first match* was scheduled - a fact about the draw, not about the tournament. This
 * routes five events in reverse configured order and schedules them in the opposite order too,
 * so both of the wrong answers (configured order, and first-match order) put XD first.
 */

const CODES = ["XD", "WD", "MD", "WS", "MS"] as const;

async function fiveEventsFixture(page: Page) {
  await installAppMock(page, { preset: "layout", role: "user" });
  const fixture = deskFixture("layout", "user");
  // `tables` is an untyped row map, so the tournament row is narrowed here rather than by
  // indexing into `unknown`.
  const tournament = fixture.tables["tournaments"]?.[0] as { id: string } | undefined;
  if (!tournament) throw new Error("the layout fixture must serve one tournament");

  const categories = CODES.map((code, index) => ({
    id: `cat-${code}`,
    tournament_id: tournament.id,
    code,
    name: code,
    entry_type: code.endsWith("S") ? "individual" : "pair",
    sort_order: index + 1,
    active: true,
    max_entries: null,
    gender: "open",
    created_at: "2026-01-01T00:00:00.000Z",
  }));

  const entrants = categories.flatMap((category) =>
    [1, 2].map((seed) => ({
      id: `entrant-${category.code}-${seed}`,
      tournament_id: category.tournament_id,
      category_id: category.id,
      team_id: `team-${category.code}-${seed}`,
      seed,
      seed_locked_at: null,
      excluded: false,
      skill_level: "B",
      tier: null,
      created_at: "2026-01-01T00:00:00.000Z",
    })),
  );

  // Scheduled in the reverse of the standard order: XD first, MS last. Anything that groups by
  // when the matches play would therefore list XD at the top.
  const start = new Date();
  start.setHours(9, 0, 0, 0);
  const matches = categories.map((category, index) => ({
    id: `match-${category.code}`,
    tournament_id: category.tournament_id,
    category_id: category.id,
    stage: "round1",
    generation_key: "r1-1",
    entrant_a_id: `entrant-${category.code}-1`,
    entrant_b_id: `entrant-${category.code}-2`,
    winner_id: null,
    games: [],
    is_makeup: false,
    is_crossover: false,
    prerequisite_ids: [],
    court_id: null,
    scheduled_time: new Date(start.getTime() + index * 30 * 60_000).toISOString(),
    started_at: null,
    ended_at: null,
    reported_time: null,
    status: "scheduled",
    note: null,
    created_at: "2026-01-01T00:00:00.000Z",
  }));

  for (const [table, rows] of [
    ["categories", categories],
    ["placement_entrants", entrants],
    ["placement_matches", matches],
    ["tier_draws", []],
    ["tier_draw_matches", []],
  ] as const) {
    await page.route(`**/rest/v1/${table}?*`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) }),
    );
  }
}

test.describe("Scores, event order", () => {
  test("lists the placement panels MS, WS, MD, WD, XD whatever the configured or scheduled order", async ({
    page,
  }) => {
    await fiveEventsFixture(page);
    await page.goto(routes.scores, { waitUntil: "networkidle" });

    const panels = page.locator("section", { has: page.getByRole("heading", { name: / Placement$/ }) });
    await expect(panels).toHaveCount(5);
    await expect(panels.locator("h2")).toHaveText([
      "MS Placement",
      "WS Placement",
      "MD Placement",
      "WD Placement",
      "XD Placement",
    ]);
  });

  test("keeps the filter chips in the same order as the panels", async ({ page }) => {
    await fiveEventsFixture(page);
    await page.goto(routes.scores, { waitUntil: "networkidle" });

    const filter = page.getByRole("group", { name: "Filter by event" });
    await expect(filter.getByRole("button")).toHaveText(["All events", "MS", "WS", "MD", "WD", "XD"]);
  });
});
