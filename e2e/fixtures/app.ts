import { test as base, expect } from "@playwright/test";

import { installAppMock, mockEscapes, type MockRole } from "./app-mock";
import type { DeskMockPreset } from "./desk-mock";

/**
 * The shared test object. Import `test` from here, not from `@playwright/test`.
 *
 * Overriding the `page` fixture is what makes the suite hermetic by default rather than
 * by each spec remembering to opt in. That distinction is the point: the previous
 * arrangement had two specs intercepting the network and eight reaching the hosted
 * project, and nothing in the code stopped a ninth from doing the same. Now a spec cannot
 * accidentally talk to a backend, because it never receives an unmocked page.
 *
 * Per-spec overrides go through the `appMock` option:
 *
 *     test.use({ appMock: { preset: "states", role: "admin" } });
 *
 * A spec that needs to switch mid-file can call `installAppMock(page, ...)` directly.
 * Playwright resolves routes last-registered-first, so a later call wins.
 */

export interface AppMockOptions {
  /** Which match dataset to serve. */
  preset: DeskMockPreset;
  /** The role `current_staff_role` returns. `null` means the signed-out view. */
  role: MockRole;
}

export const test = base.extend<{ appMock: AppMockOptions }>({
  appMock: [{ preset: "layout", role: null }, { option: true }],

  page: async ({ page, appMock }, use) => {
    await installAppMock(page, appMock);

    await use(page);

    /**
     * A Supabase request the mock did not answer is a hole in the fixture, and it is
     * reported as a failure rather than left to surface as an empty list somewhere
     * unrelated. The connection was already aborted, so nothing reached the network -
     * this only makes the gap visible.
     */
    const escapes = mockEscapes(page);
    if (escapes.length > 0) {
      throw new Error(
        `Unmocked Supabase request(s) blocked: ${[...new Set(escapes)].join(", ")}. ` +
          `The reachable surface changed; add these to e2e/fixtures/app-mock.ts.`,
      );
    }
  },
});

export { expect };
