import { useCallback, useEffect, useState } from "react";

/**
 * Which player this browser follows as "me" in one tournament.
 *
 * A bookmark, not an identity: it is kept in this browser only, grants nothing, and anyone may
 * pick any name, because everything it unlocks - one entrant's matches and path - is already
 * public on the reader's pages. The account-backed answer (`players.profile_id`) is withheld
 * from the client by design, so until a server read exposes "my player" this is the honest
 * shape of the feature.
 *
 * Storage can be blocked or absent (a private window, a preview), so every read and write is
 * guarded and the page simply has no "me" when it fails. Read after mount, never during render,
 * so the server and the first browser render agree.
 */
const KEY_PREFIX = "tournova:me:";
const CHANGE_EVENT = "tournova:me-change";

function read(tournamentId: string): string | null {
  try {
    return window.localStorage.getItem(KEY_PREFIX + tournamentId);
  } catch {
    return null;
  }
}

export function useMyPlayer(tournamentId: string | null) {
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!tournamentId) return;
    const sync = () => setPlayerId(read(tournamentId));
    sync();
    setReady(true);
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [tournamentId]);

  const choose = useCallback(
    (next: string | null) => {
      if (!tournamentId) return;
      try {
        if (next) window.localStorage.setItem(KEY_PREFIX + tournamentId, next);
        else window.localStorage.removeItem(KEY_PREFIX + tournamentId);
      } catch {
        // Storage refused: keep the choice for this page view only.
      }
      setPlayerId(next);
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [tournamentId],
  );

  return { playerId, ready, choose };
}
