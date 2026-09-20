/**
 * Theme state, shared across routes and persisted.
 *
 * Follows the module-scope store pattern used by `useDensity` and `useSession`, and
 * for the same reason: each route renders its own `AppShell`, so a per-component
 * `useState` would reset the control on navigation.
 *
 * The one structural difference from `useDensity` is that this store has two inputs,
 * not one. Density's fallback is derived from the route, which is knowable from a
 * single snapshot; theme's fallback is the operating system's colour scheme, which
 * the page does not control and which can change while the page is open. So the
 * store tracks the system preference alongside the stored choice, and subscribes to
 * `prefers-color-scheme` so a window that moves from a bright desk to a dim room is
 * followed live - but only while no explicit choice exists, because the resolution
 * rule still puts the operator first.
 *
 * Writability is asymmetric on purpose, exactly as in `useDensity`: `setTheme`
 * records an explicit choice and nothing else writes. In particular, the system
 * preference must never be written to storage - doing so would convert "I have not
 * chosen" into "I chose what the operating system happened to be at the time", and
 * the operator could never get back to following the system.
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
 * Three snapshots, all primitives.
 *
 * `useSyncExternalStore` compares snapshots by identity, so returning an object that
 * is rebuilt on every call would re-render forever. Each value the hook exposes is
 * therefore derived from the store separately and stays stable unless it genuinely
 * changed.
 *
 * The system preference is a snapshot in its own right rather than read straight off
 * the module variable during render. Read straight off, it goes stale in exactly one
 * case: while an explicit choice is in effect, a system change does not alter the
 * resolved theme, so React has no reason to re-render and the value shown to the
 * operator would describe a setting the operating system no longer has. That is a
 * small, cosmetic staleness - it feeds a tooltip - but it is the kind of small
 * cosmetic lie that is cheaper to prevent than to remember.
 */
function getStoredSnapshot(): Theme | null {
  ensureHydrated();
  return stored;
}

function getThemeSnapshot(): Theme {
  ensureHydrated();
  return resolveTheme(stored, systemPrefersDark);
}

function getSystemSnapshot(): boolean {
  ensureHydrated();
  return systemPrefersDark;
}

function getServerStoredSnapshot(): Theme | null {
  return null;
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

function getServerSystemSnapshot(): boolean {
  return false;
}

function persist(next: Theme | null) {
  stored = next;
  try {
    if (next === null) globalThis.localStorage?.removeItem(THEME_STORAGE_KEY);
    else globalThis.localStorage?.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // The in-memory value still applies for this session.
  }
  emit();
}

export function useTheme() {
  const preference = useSyncExternalStore(subscribe, getStoredSnapshot, getServerStoredSnapshot);
  const theme = useSyncExternalStore(subscribe, getThemeSnapshot, getServerThemeSnapshot);
  const systemPrefersDark = useSyncExternalStore(
    subscribe,
    getSystemSnapshot,
    getServerSystemSnapshot,
  );

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
    /** The system's setting, so a "System" reset can say which way it currently points. */
    systemPrefersDark,
    /** True only when the operator chose this, not when the system supplied it. */
    isExplicit: preference !== null,
    /** Records an explicit choice. The only writer. */
    setTheme: persist,
    /** Returns to following the system by removing the choice. */
    clearTheme: () => persist(null),
  };
}
