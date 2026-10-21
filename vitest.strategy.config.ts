import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Config for the strategy replay comparison only (`npm run bench:strategies`).
 *
 * Like the scheduling-core benchmark it is kept out of `npm test`: it plays several whole
 * tournaments under each strategy and takes minutes, and it writes a report rather than asserting.
 * Scope it with `REPLAY_SEEDS` (how many seeds, default 8) and `REPLAY_EVENTS` (a comma list of
 * event sizes, default `8,8,12,12,8`).
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/lib/tournament/scheduling/*.runner.ts"],
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 60 * 60 * 1000,
    // Sequential: plan timings must not compete with each other for CPU.
    fileParallelism: false,
  },
});
