# Routes

TanStack Start uses **file-based routing**. Every `.tsx` file in this directory
defines a route. Do **not** create `src/pages/`, `src/routes/_app/index.tsx`, or
`app/layout.tsx` — those are Next.js / Remix conventions. The only root layout
is `src/routes/__root.tsx`.

## Conventions

| File | URL |
| --- | --- |
| `index.tsx` | `/` |
| `about.tsx` | `/about` |
| `users/index.tsx` | `/users` |
| `users/$id.tsx` | `/users/:id` (dynamic — bare `$`, no curly braces) |
| `posts/{-$category}.tsx` | `/posts/:category?` (optional segment) |
| `files/$.tsx` | `/files/*` (splat — read via `_splat` param, never `*`) |
| `_layout.tsx` | layout route (renders children via `<Outlet />`) |
| `__root.tsx` | app shell — wraps every page; preserve `<Outlet />` |

`routeTree.gen.ts` is auto-generated. Don't edit it by hand.

## This app's shape

Every operational page lives under the workspace layout,
`src/routes/tournaments/$tournamentId/route.tsx`, which resolves the tournament
from the URL, 404s on an unknown id, and hands the tournament and the caller's
access down by context. A child route therefore takes **no id prefix of its own**:
the directory *is* the prefix, and the page reads the id with `useTournamentId()`.

```
src/routes/
  index.tsx                          /              → redirect (shim; Landing/Home later)
  auth.tsx                           /auth
  tournaments/$tournamentId/
    route.tsx                        layout: tournament + access by context
    desk.tsx                         the Desk
    entries.tsx  settings.tsx  access.tsx
    placement.tsx  knockout.tsx  schedule.tsx
    scores.tsx  pools.tsx  draws.tsx
```

Two things about that list are easy to get wrong:

- **`schedule.tsx` is one route for two views.** It renders the day-by-day planner or
  the placement scheduler depending on `tournament.format`, so a link to "the schedule"
  never has to know which engine the tournament runs. The two views are components in
  `src/components/schedule/`, not routes.
- **The flat files at the top level are redirects, not pages.** `/setup`, `/staff`,
  `/registration`, `/placement`, `/knockout`, `/placement-schedule`, `/schedule` and
  `/matches` were shipped addresses before the workspace move, so each renders
  `<WorkspaceRedirect>` and resolves on the caller's own working tournament. They carry
  no markup and own no data. `/` is the same idea, temporarily, until Landing/Home lands.

A redirect must **not** be a `beforeLoad`. That runs during server rendering too, where
there is no session to read the pointer from — the server would redirect a bookmark to the
*public* default rather than the caller's own tournament, and would make a real Supabase
request from the rendering process, which no browser-level network interception can see.
See `src/components/workspace-redirect.tsx`.
