import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PLAYER_SEARCH_MIN_CHARS, searchPlayers, type Player } from "@/lib/tournament/data";

/** How long typing must pause before the roster is asked. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Chooses a person already entered in this tournament by searching for them.
 *
 * The roster is not loaded: it is global, so it grows with every tournament ever run, and a
 * list of everyone is neither something a desk can scan nor something it should be able to
 * download. The box asks the server for a handful of matches once there are two characters.
 * That also makes the picker honest about what it does - it finds a person, it does not show
 * a population.
 *
 * Plain inputs and buttons rather than an ARIA combobox: a results list of buttons is a
 * pattern a screen reader and a keyboard already handle, and the count is announced through a
 * polite live region, so there is no widget state to keep in step.
 */
export function PlayerPicker({
  id,
  tournamentId,
  selected,
  onChange,
  exclude,
  hidden,
}: {
  /** Names the search box. Required, for the same reason a select's `id` is. */
  id: string;
  tournamentId: string | null;
  /** The chosen person, or null. The picker shows the choice; the parent owns it. */
  selected: Player | null;
  onChange: (player: Player | null) => void;
  /** People who cannot be chosen here (already chosen in the other slot). */
  exclude?: ReadonlySet<string>;
  /** People who are filtered out because the entry rules would refuse them. */
  hidden?: (playerId: string) => boolean;
}) {
  const listId = useId();
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const enough = debounced.length >= PLAYER_SEARCH_MIN_CHARS;
  const search = useQuery({
    queryKey: ["player-search", tournamentId, debounced],
    enabled: !!tournamentId && enough && !selected,
    staleTime: 30_000,
    queryFn: () => searchPlayers(tournamentId as string, debounced),
  });

  if (selected) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-hairline px-3 py-2 text-sm">
        <span className="min-w-0 break-words" id={`${id}-chosen`}>
          {selected.name}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-describedby={`${id}-chosen`}
          onClick={() => {
            setText("");
            setDebounced("");
            onChange(null);
          }}
        >
          Change
        </Button>
      </div>
    );
  }

  const rows = (search.data ?? []).filter((p) => !exclude?.has(p.id) && !hidden?.(p.id));
  const dropped = (search.data?.length ?? 0) - rows.length;

  return (
    <div className="space-y-2">
      <Input
        id={id}
        type="search"
        autoComplete="off"
        placeholder="Search by name"
        aria-controls={listId}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {!enough
          ? ""
          : search.isFetching
            ? "Searching"
            : `${rows.length} ${rows.length === 1 ? "match" : "matches"}`}
      </p>
      <ul id={listId} className="max-h-60 divide-y divide-hairline overflow-y-auto">
        {rows.map((player) => (
          <li key={player.id}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50 focus-visible:bg-muted/50"
              onClick={() => onChange(player)}
            >
              <span className="min-w-0 break-words">{player.name}</span>
              {player.gender ? (
                <span className="text-xs text-muted-foreground">{player.gender}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {!enough ? (
        <p className="text-sm text-muted-foreground">
          Search this tournament using at least {PLAYER_SEARCH_MIN_CHARS} letters. Someone new? Add them first.
        </p>
      ) : search.isError ? (
        <p className="text-sm text-danger-foreground">Could not search the roster.</p>
      ) : !search.isFetching && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {dropped > 0
            ? `${dropped} matching ${dropped === 1 ? "person is" : "people are"} not eligible for this entry.`
            : "Nobody matches. Add them as a new player."}
        </p>
      ) : null}
    </div>
  );
}
