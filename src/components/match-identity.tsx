import type { DeskMatch } from "@/lib/tournament/desk-matches";

/** Keep event/draw and round readable as separate units, including on narrow cards. */
export function MatchIdentity({ match }: { match: Pick<DeskMatch, "tag" | "roundTag"> }) {
  const suffix = match.roundTag ? `, ${match.roundTag}` : "";
  const identity =
    suffix && match.tag.endsWith(suffix)
      ? match.tag.slice(0, -suffix.length).replace(" — ", " ")
      : match.tag;
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span data-match-identity>{identity}</span>
      {match.roundTag ? (
        <span data-match-round>
          <span className="sr-only">, </span>
          {match.roundTag}
        </span>
      ) : null}
    </span>
  );
}
