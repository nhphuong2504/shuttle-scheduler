import { useSyncExternalStore } from "react";

/**
 * Which face of the app a platform admin is looking at: the ordinary `user` one, or `admin`.
 *
 * This is a presentation choice only. It grants nothing: every privilege is still decided by
 * the database and by `useSession().isPlatformAdmin`, so flipping this can never show an
 * operation the server would refuse. Callers that offer the `admin` face must gate it on
 * being a platform admin first; this hook does not know who is signed in.
 *
 * What the admin face contains has not been designed yet. For now the choice is only
 * remembered, so the design can build on it without another migration of the header.
 */
export type ViewMode = "user" | "admin";

const STORAGE_KEY = "tournova:view-mode";

let mode: ViewMode = "user";
let hydrated = false;
const listeners = new Set<() => void>();

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === "admin") mode = "admin";
  } catch {
    // Storage can be blocked; the default of `user` is the safe reading.
  }
}

export function setViewMode(next: ViewMode) {
  if (next === mode) return;
  mode = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not persisting is fine; the choice still holds for this page.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ViewMode {
  hydrate();
  return mode;
}

// The server and the first client render both say `user`, so hydration never mismatches.
function getServerSnapshot(): ViewMode {
  return "user";
}

export function useViewMode(): { viewMode: ViewMode; setViewMode: (next: ViewMode) => void } {
  const viewMode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { viewMode, setViewMode };
}
