import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    // `.test.tsx` is included so component-level render tests can opt into jsdom
    // per file with a `@vitest-environment jsdom` docblock, leaving the existing
    // pure-logic suite on the faster node environment.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
