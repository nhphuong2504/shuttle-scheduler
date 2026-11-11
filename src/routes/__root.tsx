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
import { supabase } from "@/integrations/supabase/client";
import { bindQueryCacheToUser } from "@/lib/auth/session-cache";

import appCss from "../styles.css?url";

/**
 * Bumped whenever the mark's artwork changes. Bump it again for the next recolour.
 *
 * A browser keeps a site's favicon in its own store, keyed by the icon's URL, and it does not
 * revalidate it the way it does every other asset - `Cache-Control: must-revalidate` on the SVG
 * changes nothing. The file has been recoloured twice since it first shipped (violet, then
 * cobalt, now navy) while this URL stayed `/brand/tournova-mark.svg`, so tabs that had loaded
 * the earlier mark kept showing it. Changing the URL is the only way to make them ask again.
 */
const MARK_ICON_VERSION = "3";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="font-numeral text-8xl font-extrabold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
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
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
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
      // Tells the browser to paint its own chrome - the canvas behind the page,
      // scrollbars, native form controls - light from the first frame, before the
      // stylesheet resolves. Light is the app's only theme; styles.css pins the same
      // value once it loads.
      { name: "color-scheme", content: "light" },
      { title: "Tournova | Badminton Tournament Operations" },
      {
        name: "description",
        content:
          "Run a two-day, four-category badminton tournament: pools, draws, scores and court scheduling.",
      },
      { property: "og:title", content: "Tournova | Badminton Tournament Operations" },
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
      {
        rel: "preload",
        href: "/fonts/roboto-condensed-latin-wght.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400..700&family=JetBrains+Mono:wght@500;700&display=swap",
      },
      {
        rel: "icon",
        href: `/brand/tournova-mark.svg?v=${MARK_ICON_VERSION}`,
        type: "image/svg+xml",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
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
  // A test that clicks as soon as the markup looks right can click a button React has
  // not wired up, and then fail for a reason that has nothing to do with the behaviour
  // it is testing. Published as an attribute rather than a global so it needs no
  // test-only types.
  useEffect(() => {
    document.documentElement.dataset["hydrated"] = "true";
  }, []);

  // The cache holds one user's answers: a sign-out or sign-in empties it, so the operator's
  // access cannot outlive the session that earned it.
  useEffect(() => bindQueryCacheToUser(queryClient, supabase.auth), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      <Toaster richColors position="top-right" />
    </QueryClientProvider>
  );
}
