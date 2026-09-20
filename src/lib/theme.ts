/**
 * Venue lighting control.
 *
 * A hall is bright daylight in the morning and a dim indoor box at night, and the
 * same desk screen has to stay readable in both. The two palettes are already
 * solved in `styles.css` (`:root` and `.dark`); this is only the switch, plus the
 * `auto` mode that follows the operating system.
 *
 * `auto` is the default so a freshly opened display picks the right palette with
 * nobody touching it. A moderator's explicit pick is remembered per browser, which
 * is what a wall-mounted panel needs: set it once at the venue, never again.
 */
export type ThemeChoice = "auto" | "bright" | "dim";

export const THEME_STORAGE_KEY = "shuttlenet.theme";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "auto" || value === "bright" || value === "dim";
}

/** Resolves `auto` against the OS preference. Safe to call on the server. */
export function resolveTheme(choice: ThemeChoice): "bright" | "dim" {
  if (choice !== "auto") return choice;
  if (typeof window === "undefined" || !window.matchMedia) return "bright";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dim" : "bright";
}

export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveTheme(choice) === "dim");
}

export function readTheme(): ThemeChoice {
  if (typeof window === "undefined") return "auto";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

export function writeTheme(choice: ThemeChoice): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* private mode — the theme just will not persist */
  }
  applyTheme(choice);
}

/**
 * Runs before hydration so the first paint is already the right palette.
 *
 * Inlined as a string rather than imported: a module would load after paint and
 * the room would get a white flash, which in a dim hall is the one failure the
 * low-light theme exists to prevent.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var c=localStorage.getItem(k)||"auto";var d=c==="dim"||(c!=="bright"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",!!d);}catch(e){}})();`;
