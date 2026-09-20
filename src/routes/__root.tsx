import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";
import { DESK_PATHS, DENSITY_STORAGE_KEY } from "@/lib/design/density";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ShuttleNet | Badminton Tournament Operations" },
      {
        name: "description",
        content:
          "Run a two-day, four-category badminton tournament: pools, draws, scores and court scheduling.",
      },
      { property: "og:title", content: "ShuttleNet | Badminton Tournament Operations" },
      {
        property: "og:description",
        content:
          "Run a two-day, four-category badminton tournament: pools, draws, scores and court scheduling.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap",
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

/**
 * Applies the density before first paint.
 *
 * Without this the attribute is set in an effect, which runs after the browser has
 * already laid out the page. On the Desk - whose default is Compact - that means a
 * visible reflow on every load for anyone who has not chosen a density: rows first
 * render at 44px and then collapse to 32px. The stored preference and the route
 * default are both resolved here so the first paint is already correct.
 *
 * `DESK_PATHS` is injected rather than restated, so the desk-route list still has
 * one definition. This runs before the bundle, so it reads `localStorage` directly
 * instead of importing the module.
 */
const DENSITY_BOOTSTRAP = `
(function () {
  try {
    var stored = localStorage.getItem(${JSON.stringify(DENSITY_STORAGE_KEY)});
    var density =
      stored === "compact" || stored === "comfortable"
        ? stored
        : ${JSON.stringify(DESK_PATHS)}.indexOf(
              location.pathname.replace(/\\/+$/, "") || "/",
            ) !== -1
          ? "compact"
          : "comfortable";
    document.documentElement.dataset.density = density;
  } catch (error) {
    document.documentElement.dataset.density = "comfortable";
  }
})();
`;

function RootShell({ children }: { children: ReactNode }) {
  return (
    // `suppressHydrationWarning` is required, not cosmetic. DENSITY_BOOTSTRAP adds
    // `data-density` to this element before React runs, so the server HTML and the
    // client's expected props genuinely differ. React would otherwise log a
    // hydration mismatch and refuse to patch the attribute - and an unavoidable
    // warning here would hide a real one added later.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: DENSITY_BOOTSTRAP }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // Marks the point at which React has attached its event handlers.
  //
  // The density attribute appears before hydration - deliberately, so there is no
  // reflow - which means "the attribute is already correct" says nothing about
  // whether the page is interactive yet. An interaction test that clicks as soon as
  // the attribute looks right can click a button React has not wired up, and then
  // fail for a reason that has nothing to do with the behaviour it is testing.
  // Published as an attribute rather than a global so it needs no test-only types.
  useEffect(() => {
    document.documentElement.dataset["hydrated"] = "true";
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  );
}
