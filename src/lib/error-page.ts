/**
 * The last-resort document.
 *
 * Served when the application itself failed to render - a worker threw before
 * hydration, or an unhandled error reached the edge - so it **cannot reference
 * `src/styles.css`**: the stylesheet is a build artifact that this response does
 * not include, and a crash page that depends on the thing that just crashed is
 * not a crash page.
 *
 * It therefore carries its own copy of the palette, under the same `--color-*`
 * names, so a reader moving between this file and the stylesheet is not
 * re-learning the vocabulary. Nothing keeps the copy in sync automatically, so a
 * palette change in `styles.css` should be mirrored here by hand.
 *
 * The font stack is `system-ui` rather than the app's webfonts: a crash page must
 * not wait on a network font to decide whether it has a layout.
 */
export function renderErrorPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>This page didn't load</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light;
        --color-background: oklch(0.975 0.004 250);
        --color-foreground: oklch(0.255 0.010 255);
        --color-surface: oklch(1 0 0);
        --color-muted-foreground: oklch(0.505 0.009 252);
        --color-border-control: oklch(0.643 0.008 250);
        --color-primary: oklch(0.52 0.16 255);
        --color-primary-foreground: oklch(1 0 0);
      }
      body {
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 0.875rem;
        line-height: 1.25rem;
        background: var(--color-background);
        color: var(--color-foreground);
        display: grid;
        place-items: center;
        min-height: 100vh;
        margin: 0;
        padding: 1.5rem;
      }
      .card { max-width: 28rem; width: 100%; text-align: center; padding: 2rem; }
      h1 { font-size: 1.5rem; line-height: 1.75rem; margin: 0 0 0.5rem; }
      p { color: var(--color-muted-foreground); margin: 0 0 1.5rem; }
      .actions { display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; }
      a, button { padding: 0.5rem 1rem; border-radius: 0.375rem; font: inherit; cursor: pointer; text-decoration: none; border: 1px solid transparent; }
      .primary { background: var(--color-primary); color: var(--color-primary-foreground); }
      .secondary { background: var(--color-surface); color: var(--color-foreground); border-color: var(--color-border-control); }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>This page didn't load</h1>
      <p>Something went wrong on our end. You can try refreshing or head back home.</p>
      <div class="actions">
        <button class="primary" onclick="location.reload()">Try again</button>
        <a class="secondary" href="/">Go home</a>
      </div>
    </div>
  </body>
</html>`;
}
