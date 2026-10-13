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
    // The worker name is stated rather than left to Nitro's default, and this is
    // load-bearing rather than cosmetic.
    //
    // Nitro derives the name from the git remote - `generateWorkerName` in
    // nitro/dist/_presets.mjs reads `origin` and produces `nhphuong2504-shuttle-scheduler`,
    // which was the EXISTING production Worker's name. A bare `wrangler deploy` from a
    // build of this branch would therefore have published over the live worker. That is
    // the exact outcome the migration was meant to avoid, and it needed no mistake to
    // happen: it is what the default does.
    //
    // Setting it here is what makes "a new, separately named Worker" true rather than
    // aspirational. It also pins the name against a future remote rename, which would
    // otherwise silently retarget the deployment.
    //
    // This only governs the name Nitro writes into the generated wrangler.json. The other
    // Worker is not read, renamed or modified by a build.
    plugins.push(
      nitro({
        defaultPreset: "cloudflare-module",
        cloudflare: {
          nodeCompat: true,
          deployConfig: true,
          wrangler: {
            name: "tournova-ops",
            /**
             * The production address, declared here for the same reason the name above is.
             *
             * A custom domain is a property of the deployment, and the dashboard is not a
             * record of one: attached by hand, it survives every rebuild while nothing in
             * the repository explains where the address comes from, and a re-created Worker
             * (or a second environment) comes up without it. Stating it here makes the
             * address reviewable, reproducible, and impossible to lose by rebuilding.
             *
             * `workers_dev: true` is deliberate rather than leftover. Wrangler disables the
             * `*.workers.dev` address by default as soon as a `routes` entry exists, which
             * would silently retire the URL the app shipped on - and the URL Supabase's
             * redirect allow-list named. Both addresses serve the same Worker; the
             * allow-list names both, so neither is a dead end.
             */
            workers_dev: true,
            routes: [{ pattern: "tournova.app", custom_domain: true }],
          },
        },
      }),
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
