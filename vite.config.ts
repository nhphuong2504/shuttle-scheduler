import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv, mergeConfig, type PluginOption, type UserConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

/**
 * The build definition, stated explicitly rather than delegated to a wrapper.
 *
 * This previously called `defineConfig` from `@lovable.dev/vite-tanstack-config`, which
 * assembled the plugins below behind one import. That wrapper also carried Lovable's
 * sandbox machinery - a dev-server bridge, an HMR gate, an assets proxy, build error
 * diagnostics and sandbox port/validation rules - none of which this project uses. Owning
 * the config means the build is reproducible outside the Lovable environment, and the
 * plugin set is reviewable in one place.
 *
 * Three behaviours are load-bearing and must not be lost in future edits:
 *
 *   1. `server: { entry: "server" }` redirects TanStack Start's bundled entry to
 *      `src/server.ts`, which is the SSR error wrapper. Without it that file is dead code
 *      and catastrophic SSR errors render as h3's opaque JSON instead of the error page.
 *
 *   2. The `import.meta.env.*` defines. The Supabase client reads its configuration with
 *      bracket notation (`import.meta.env["VITE_SUPABASE_URL"]`), so the values are
 *      injected as literal defines rather than left to Vite's default `import.meta.env`
 *      object. Dropping this makes a production build fail its own missing-variable check.
 *
 *   3. The dev server port. `playwright.config.ts` waits on 8080, so changing it breaks
 *      `npm run test:e2e` with a timeout rather than a useful error.
 */
export default defineConfig(async ({ command, mode }): Promise<UserConfig> => {
  const isDevBuild = command === "build" && mode === "development";

  const define: Record<string, string> = {};
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), "VITE_"))) {
    define[`import.meta.env.${key}`] = JSON.stringify(value);
  }

  const plugins: PluginOption[] = [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      // Importing a server-only module from client code is an error, not a warning: it is
      // the import that would ship server logic into the browser bundle.
      importProtection: {
        behavior: "error",
        client: { files: ["**/server/**"], specifiers: ["server-only"] },
      },
      server: { entry: "server" },
    }),
  ];

  // Nitro is build-only. In `serve`, Vite owns the request lifecycle and adding a second
  // server runtime would compete with it.
  if (command === "build") {
    const { nitro } = await import("nitro/vite");
    // The Cloudflare Workers target. Stated rather than inferred: without it a build can
    // silently fall back to a Node target, which this project does not deploy.
    //
    // Inside a Lovable sandbox the publish artifact has to land in `dist/` - that is where
    // the connected pipeline reads it from, and `dist` is git-ignored for exactly that
    // reason. Nitro's own default is `.output/`, so a build here would succeed and publish
    // nothing. The wrapper set these directories only in its sandbox branch, which is why
    // dropping it silently changed the artifact path rather than the artifact.
    //
    // This is transitional: it exists so the branch stays deployable through Lovable until
    // the cutover. Removing it is part of the decommission, together with `.lovable/`.
    const inLovableSandbox =
      process.env["LOVABLE_SANDBOX"] === "1" ||
      Boolean(process.env["DEV_SERVER__PROJECT_PATH"]);

    plugins.push(
      nitro(
        inLovableSandbox
          ? {
              preset: "cloudflare-module",
              output: { dir: "dist", serverDir: "dist/server", publicDir: "dist/client" },
              cloudflare: { nodeCompat: true, deployConfig: true },
            }
          : { defaultPreset: "cloudflare-module" },
      ),
    );
  }

  plugins.push(viteReact());

  return mergeConfig(
    {
      define,
      ...(isDevBuild
        ? {
            environments: {
              client: { define: { "process.env.NODE_ENV": JSON.stringify("development") } },
            },
            esbuild: { keepNames: true },
          }
        : {}),
      // The design tokens in styles.css are authored for this transformer. Changing it
      // changes the emitted cascade and therefore the rendered page.
      css: { transformer: "lightningcss" },
      resolve: {
        // The `@` alias is duplicated by tsconfig `paths` above; kept explicit so a
        // missing tsconfig still resolves imports.
        alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
        dedupe: [
          "react",
          "react-dom",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
          "@tanstack/react-query",
          "@tanstack/query-core",
        ],
      },
      optimizeDeps: {
        include: [
          "react",
          "react-dom",
          "react-dom/client",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
        ],
        ignoreOutdatedRequests: true,
      },
      plugins,
    },
    { server: { host: "::", port: 8080 } },
  );
});
