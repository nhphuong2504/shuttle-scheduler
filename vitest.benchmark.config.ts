import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Config for the scheduling-core benchmark only.
 *
 * The real suite (`vitest.config.ts`) includes `src/**\/*.test.ts`; this one includes the benchmark
 * runner and nothing else, so the benchmark never runs as part of `npm test`. Scope it further with
 * `BENCH_ONLY`, `BENCH_REPS` and `BENCH_SEEDS` rather than by editing this file.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/lib/scheduling/benchmark/*.runner.ts"],
    // A 75-run GRASP sweep over the large shape is minutes of work by design.
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 30 * 60 * 1000,
    // Sequential: timing samples must not compete with each other for CPU.
    fileParallelism: false,
  },
});
