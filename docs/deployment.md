# Deployment

Where the app is served, what serves it, and the two settings whose absence is silent. The
build-time backend check that guards deployment is
[`scripts/verify-build-target.mjs`](../scripts/verify-build-target.mjs); this file explains the
shape it is checking.

## The addresses

| Address | Serves | Why it exists |
| --- | --- | --- |
| `https://tournova.app` | The application | Canonical. This is the `site_url` Supabase auth uses |
| `https://www.tournova.app` | A 301 to the canonical host | A typed address and an old link; kept as an alias rather than a second site |
| `https://tournova-ops.nhphuong2504.workers.dev` | The application | The address the app first shipped on. Links and bookmarks name it, so it is kept |

The first and third are the same Worker; the second is not.

## Two Workers

**`tournova-ops`** is the application, built from this repository (`npm run build` then
`wrangler deploy`, or `npm run deploy`). Its routes are declared in
[`vite.config.ts`](../vite.config.ts), which is the only place either setting is written down.

**`tournova-www-redirect`** is the alias redirect, in
[`workers/www-redirect/`](../workers/www-redirect/), deployed with
`npm run deploy:www-redirect`. It is deliberately not part of the application build: see its
source for why a zone Redirect Rule and the application Worker were both unavailable.

## Two settings whose absence is silent

Both are asserted by `verify-build-target.mjs`, and both earn that because each fails invisibly.

- **`routes` decides whether the app is on the domain at all.** A Worker with no route deploys
  cleanly, answers on its `workers.dev` address, and looks entirely healthy — it has just
  stopped being served where people go. Nothing in the build output says so.
- **`workers_dev` decides whether the original address survives.** Wrangler *disables* it by
  default the moment any route is declared, so adding the custom domain silently retired the
  URL the app shipped on — and the URL Supabase's redirect allow-list named. It is opted back in
  explicitly.

A third is checked for the same reason: the Worker's **name**. Nitro derives it from the git
remote, which resolves to the pre-existing production Worker, so a bare deploy would publish
over it. The name is pinned in `vite.config.ts`.

## Supabase authentication redirects

The build bakes the Supabase URL and publishable key in, so a Worker compiled against one
project cannot be repointed later. What is *not* baked in is where auth may return to: that
lives on the project, and it is the half that a new domain changes.

Two project settings have to agree with the addresses above, or confirmation and recovery
emails land somewhere unexpected:

- **`site_url`** — `https://tournova.app`. The fallback when a requested redirect is refused.
- **`uri_allow_list`** — every address the app is served on, including `www`. GoTrue matches a
  requested `redirect_to` against this list and falls back to `site_url` when it does not match,
  so a missing entry is a silent redirect elsewhere rather than an error.

The client asks to return to its own origin: `src/routes/auth.tsx` passes
`emailRedirectTo: ${window.location.origin}/`. Since `www` redirects before any JavaScript runs,
that is always the canonical host or the `workers.dev` address — both listed.

Set them with the Management API (no database password needed), then read them back:

```sh
curl -X PATCH "https://api.supabase.com/v1/projects/<ref>/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{"site_url":"https://tournova.app","uri_allow_list":"https://tournova.app/**,https://www.tournova.app/**,https://tournova-ops.nhphuong2504.workers.dev/**"}'
```

**A redirect that was never delivered cannot be read back from either API.** Nothing in
`config/auth` or the public GoTrue `/auth/v1/settings` records where a *sent* link points, so the
only proof that a confirmation email lands on the canonical host is a real sign-up. Treat the
config above as the mechanism and a sign-up as the evidence.

## The token, and what it cannot do

Deployment uses an account-scoped API token. It can publish Workers and attach custom domains
through `wrangler deploy` — but it **cannot** touch zone redirect rules, DNS records or
account-level rulesets; every one of those answers `403 10000 Authentication error`. That is the
reason the alias is a Worker. Granting `Workers Routes: Edit` and zone Redirect Rules would allow
the zone-native alternative, which needs no second deployable.
