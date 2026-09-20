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
import { DARK_CLASS, SYSTEM_DARK_QUERY, THEME_STORAGE_KEY } from "@/lib/design/theme";

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
      // Declares that both schemes are supported, so the browser paints its own
      // chrome - the canvas behind the page, scrollbars, native form controls - in
      // the right scheme from the first frame rather than after the stylesheet
      // resolves. The per-theme `color-scheme` declarations in styles.css then pin it
      // once the class is known. Without this, a dark-preferring browser can show a
      // white flash before any of our CSS applies.
      { name: "color-scheme", content: "light dark" },
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
    // The pre-paint script is rendered as a real inline element in RootShell rather than
    // declared here, and that placement is deliberate: the theme spec proves the `dark`
    // class arrives with the application bundle blocked, which only holds for a script
    // that is in the document before React hydrates. A second, theme-only boot script was
    // merged in from the Lovable branch and is deliberately not reinstated - it would
    // duplicate a decision APPEARANCE_BOOTSTRAP already makes, and the two would disagree
    // about what a stored value means.
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

/**
 * Applies density and theme before first paint.
 *
 * Without this both are set in an effect, which runs after the browser has already
 * laid out the page, so every load shows the wrong appearance first. For density on
 * the Desk - whose default is Compact - that is a visible reflow, rows first
 * rendering at 44px and then collapsing to 32px. For theme it is worse: a dark
 * preference would flash a full-brightness light page on every navigation, which in
 * a dim venue is exactly the thing dark mode exists to prevent.
 *
 * The two preferences are read here in separate `try` blocks on purpose. They are
 * independent settings, and a failure in one must not silently reset the other -
 * sharing a block would mean a `localStorage` throw while reading density also
 * discarded a theme choice that had been read successfully.
 *
 * `DESK_PATHS` is injected rather than restated, so the desk-route list still has
 * one definition, and the stored-value literals are injected from the same modules
 * the runtime uses so the script cannot drift from `parseStoredDensity` and
 * `parseStoredTheme`. This runs before the bundle, so it reads `localStorage`
 * directly instead of importing those modules.
 */
const APPEARANCE_BOOTSTRAP = `
(function () {
  var root = document.documentElement;

  try {
    var stored = localStorage.getItem(${JSON.stringify(DENSITY_STORAGE_KEY)});
    root.dataset.density =
      stored === "compact" || stored === "comfortable"
        ? stored
        : ${JSON.stringify(DESK_PATHS)}.indexOf(
              location.pathname.replace(/\\/+$/, "") || "/",
            ) !== -1
          ? "compact"
          : "comfortable";
  } catch (error) {
    root.dataset.density = "comfortable";
  }

  try {
    var theme = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (theme !== "light" && theme !== "dark") {
      theme =
        window.matchMedia &&
        window.matchMedia(${JSON.stringify(SYSTEM_DARK_QUERY)}).matches
          ? "dark"
          : "light";
    }
    root.classList.toggle(${JSON.stringify(DARK_CLASS)}, theme === "dark");
  } catch (error) {
    // Blocked storage or a throwing matchMedia leaves no class, which resolves to the
    // light tokens the stylesheet already assumes. Deliberately no else-branch: there
    // is nothing to correct, only a default to fall back to.
  }
})();
`;

function RootShell({ children }: { children: ReactNode }) {
  return (
    // `suppressHydrationWarning` is required, not cosmetic. APPEARANCE_BOOTSTRAP adds
    // `data-density` and the `dark` class to this element before React runs, so the
    // server HTML and the client's expected props genuinely differ. React would
    // otherwise log a hydration mismatch and refuse to patch them - and an
    // unavoidable warning here would hide a real one added later.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOTSTRAP }} />
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
  // The density attribute and the theme class both appear before hydration -
  // deliberately, so there is no reflow or flash - which means "the appearance is
  // already correct" says nothing about whether the page is interactive yet. An
  // interaction test that clicks as soon as the attribute looks right can click a
  // button React has not wired up, and then fail for a reason that has nothing to do
  // with the behaviour it is testing.
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
