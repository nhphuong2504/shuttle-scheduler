import { useCallback, useEffect, useState } from "react";

import { useSession } from "@/hooks/useSession";

/**
 * Which player this account follows as "me" in one tournament, in this browser.
 *
 * A bookmark, not an identity: it grants nothing, and anyone may pick any name, because
 * everything it unlocks - one entrant's matches and path - is already public on the reader's
 * pages. The account-backed answer (`players.profile_id`) is withheld from the client by
 * design, so until a server read exposes "my player" this is the honest shape of the feature.
 *
 * It belongs to a signed-in account: a visitor has no "me" and is offered none, and the choice
 * is kept per account, so two people signing in on one browser do not inherit each other's.
 *
 * Storage can be blocked or absent (a private window, a preview), so every read and write is
 * guarded and the page simply has no "me" when it fails. Read after mount, never during render,
 * so the server and the first browser render agree.
 */
const KEY_PREFIX = "tournova:me:";
const CHANGE_EVENT = "tournova:me-change";

function storageKey(userId: string, tournamentId: string) {
  return `${KEY_PREFIX}${userId}:${tournamentId}`;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function useMyPlayer(tournamentId: string | null) {
  const { session, ready: sessionReady } = useSession();
  const userId = session?.userId ?? null;
  const key = userId && tournamentId ? storageKey(userId, tournamentId) : null;
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    if (!key) {
      setPlayerId(null);
      setStorageReady(true);
      return;
    }
    const sync = () => setPlayerId(read(key));
    sync();
    setStorageReady(true);
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [key]);

  const choose = useCallback(
    (next: string | null) => {
      if (!key) return;
      try {
        if (next) window.localStorage.setItem(key, next);
        else window.localStorage.removeItem(key);
      } catch {
        // Storage refused: keep the choice for this page view only.
      }
      setPlayerId(next);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [key],
  );

  return {
    /** Null for a visitor, and for an account that has not picked yet. */
    playerId: key ? playerId : null,
    /** Whether "me" can be chosen at all: only once signed in. */
    canChoose: !!key,
    ready: sessionReady && storageReady,
    choose,
  };
}
