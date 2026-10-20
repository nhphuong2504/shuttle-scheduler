import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A held-back feature is off unless the build says otherwise, so a production build that sets
 * nothing never shows Call next. The browser suite turns it on, which is why this is checked
 * here rather than there.
 */
describe("feature flags", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps Call next off when nothing sets it", async () => {
    vi.stubEnv("VITE_FEATURE_NOTIFY_PLAYERS", "");
    const { NOTIFY_PLAYERS_ENABLED } = await import("./feature-flags");
    expect(NOTIFY_PLAYERS_ENABLED).toBe(false);
  });

  it("turns Call next on only for exactly \"1\"", async () => {
    vi.stubEnv("VITE_FEATURE_NOTIFY_PLAYERS", "1");
    expect((await import("./feature-flags")).NOTIFY_PLAYERS_ENABLED).toBe(true);
    vi.resetModules();
    vi.stubEnv("VITE_FEATURE_NOTIFY_PLAYERS", "true");
    expect((await import("./feature-flags")).NOTIFY_PLAYERS_ENABLED).toBe(false);
  });
});
