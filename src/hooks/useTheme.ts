/**
 * Theme state, shared across routes and persisted.
 *
 * Follows the module-scope store pattern used by `useSession`, and for the same
 * reason: each route renders its own `AppShell`, so a per-component `useState`
 * would reset the control on navigation.
 *
 * The store has two inputs: the stored choice, and the operating system's colour
 * scheme as a fallback. The fallback is not knowable from storage - the page does
 * not control it and it can change while the page is open - so the store tracks the
 * system preference alongside the stored choice, and subscribes to
 * `prefers-color-scheme` so a window that moves from a bright desk to a dim room is
 * followed live. Only while no explicit choice exists, because the resolution rule
 * still puts the operator first.
 *
 * Writability is asymmetric on purpose: `setTheme` records an explicit choice and
 * nothing else writes. In particular, the system preference must never be written to
 * storage - doing so would convert "I have not chosen" into "I chose what the
 * operating system happened to be at the time", and the operator could never get back
 * to following the system. That was already the rule; it is now load-bearing, because
 * the appearance control no longer offers a way to undo it, so a value written here
 * by anything other than the operator's own press would outlive every attempt to
 * change it.
 */
import { useEffect, useSyncExternalStore } from "react";

import {
  DARK_CLASS,
  parseStoredTheme,
  resolveTheme,
  SYSTEM_DARK_QUERY,
  THEME_STORAGE_KEY,
  type Theme,
} from "@/lib/design/theme";

let stored: Theme | null = null;
let systemPrefersDark = false;
let hydrated = false;
let mediaQuery: MediaQueryList | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function readSystemPreference(): boolean {
  try {
    return globalThis.matchMedia?.(SYSTEM_DARK_QUERY).matches ?? false;
  } catch {
    // Older browsers and some hardened profiles can throw on matchMedia. Light is
    // the safe answer: it is what the stylesheet assumes with no class applied.
    return false;
  }
}

/**
 * Storage is read lazily on first access rather than at import time, so importing
 * this module in a non-browser context is harmless.
 */
function ensureHydrated() {
  if (hydrated) return;
  hydrated = true;
  try {
    stored = parseStoredTheme(globalThis.localStorage?.getItem(THEME_STORAGE_KEY));
  } catch {
    // Private mode and hardened browser profiles can throw on access. Absence of
    // storage means absence of a choice, which resolves to the system preference.
    stored = null;
  }
  systemPrefersDark = readSystemPreference();
}

/**
 * Subscribes to the operating system's setting, once, on the first listener.
 *
 * Registered on first subscribe rather than at module scope so that importing the
 * module never attaches a listener as a side effect, and guarded so a second
 * subscription cannot stack a second handler on the same query.
 */
function ensureSystemListener() {
  if (mediaQuery || typeof globalThis.matchMedia !== "function") return;
  try {
    mediaQuery = globalThis.matchMedia(SYSTEM_DARK_QUERY);
  } catch {
    mediaQuery = null;
    return;
  }
  mediaQuery.addEventListener("change", (event) => {
    systemPrefersDark = event.matches;
    emit();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  ensureHydrated();
  ensureSystemListener();
  return () => listeners.delete(listener);
}

/**
 * One snapshot, a primitive.
 *
 * `useSyncExternalStore` compares snapshots by identity, so returning an object that
 * is rebuilt on every call would re-render forever. The one value the hook exposes is
 * therefore derived from the store on demand and stays stable unless it genuinely
 * changed.
 *
 * The system preference is deliberately not a snapshot of its own. It used to be one,
 * so that the reset control could name the direction the system currently pointed even
 * while an explicit choice was in effect and suppressing re-renders. With no such
 * control, the only reader is the resolution rule below, and a system change still
 * reaches it: the media listener emits, `getThemeSnapshot` returns a different string,
 * and `theme` re-renders. A second subscription would now exist to keep fresh a value
 * nothing displays.
 */
function getThemeSnapshot(): Theme {
  ensureHydrated();
  return resolveTheme(stored, systemPrefersDark);
}

/**
 * The server has no media query, so it renders the light default. Hydration then
 * reconciles to the real value; the `.dark` class itself is already correct before
 * first paint because the bootstrap script sets it, which is the part that matters
 * visually.
 */
function getServerThemeSnapshot(): Theme {
  return "light";
}

function persist(next: Theme) {
  stored = next;
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // The in-memory value still applies for this session.
  }
  emit();
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getThemeSnapshot, getServerThemeSnapshot);

  // The class is set here as well as in the bootstrap script, and the duplication is
  // deliberate. The script owns the *first paint*, which is what stops the page
  // flashing the light tokens before React starts. This effect owns every change
  // after that - a choice made in this tab, or a system preference that changed
  // while the page was open - because the script runs exactly once and cannot
  // respond to anything.
  //
  // `toggle` with an explicit condition rather than add/remove so the class is never
  // left half-applied, and so that setting the theme that is already in effect is a
  // no-op rather than a write.
  useEffect(() => {
    document.documentElement.classList.toggle(DARK_CLASS, theme === "dark");
  }, [theme]);

  return {
    theme,
    /** Records an explicit choice. The only writer. */
    setTheme: persist,
  };
}
