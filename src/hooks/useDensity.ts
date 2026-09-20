/**
 * Density state, shared across routes and persisted.
 *
 * Follows the module-scope store pattern used by `useSession`, and for the same
 * reason: each route renders its own `AppShell`, so a per-component `useState`
 * would reset on navigation.
 *
 * Writability is asymmetric on purpose. `setDensity` records an explicit choice;
 * nothing else writes. Applying a route default must not call it - see
 * `resolveDensity` for why that would silently convert a default into a
 * preference.
 */
import { useEffect, useSyncExternalStore } from "react";

import {
  DENSITY_STORAGE_KEY,
  parseStoredDensity,
  resolveDensity,
  type Density,
} from "@/lib/design/density";

let stored: Density | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Storage is read lazily on first access rather than at import time, so importing
 * this module in a non-browser context is harmless.
 */
function ensureHydrated() {
  if (hydrated) return;
  hydrated = true;
  try {
    stored = parseStoredDensity(globalThis.localStorage?.getItem(DENSITY_STORAGE_KEY));
  } catch {
    // Private mode and hardened browser profiles can throw on access. Absence of
    // storage means absence of a preference, which resolves to the route default.
    stored = null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Density | null {
  ensureHydrated();
  return stored;
}

/** No storage on the server, so the snapshot is stable and null. */
function getServerSnapshot(): Density | null {
  return null;
}

function persist(next: Density | null) {
  stored = next;
  try {
    if (next === null) globalThis.localStorage?.removeItem(DENSITY_STORAGE_KEY);
    else globalThis.localStorage?.setItem(DENSITY_STORAGE_KEY, next);
  } catch {
    // The in-memory value still applies for this session.
  }
  emit();
}

export function useDensity(pathname: string) {
  const preference = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const density = resolveDensity(preference, pathname);

  // The attribute is always set, never removed. `data-density="comfortable"`
  // matches no override block and falls through to the base tokens, which keeps
  // the rendered attribute an honest record of what is in effect rather than
  // leaving an observer to infer it from the absence of `compact`.
  useEffect(() => {
    document.documentElement.dataset["density"] = density;
  }, [density]);

  return {
    density,
    /** True only when the operator chose this, not when a route default supplied it. */
    isExplicit: preference !== null,
    /** Records an explicit choice. The only writer. */
    setDensity: persist,
    /** Returns to the route default by removing the preference. */
    clearDensity: () => persist(null),
  };
}
