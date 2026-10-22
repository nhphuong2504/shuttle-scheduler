import { useMemo } from "react";
import { toast } from "sonner";

import { Panel } from "@/components/app-shell";
import { TournamentResults } from "@/components/tournament-results";
import { Button } from "@/components/ui/button";
import {
  useCategories,
  usePlacementEntrants,
  usePlacementMatches,
  usePlayers,
  useTeams,
  useTierDrawMatches,
  useTierDraws,
} from "@/lib/tournament/data";
import { buildResultsCsv, resultCounts } from "@/lib/tournament/results-export";

/**
 * What an organiser is left with when the tournament is completed: who won, how it went,
 * the link to send around, and the results as a file.
 *
 * Completing used to end in a sentence saying nothing could be changed. This keeps the
 * sentence and adds the three things a host does next - share the result, keep a copy, and
 * (from My Tournaments) start next year's from this one. Nothing here writes anything.
 */
export function WrapUp({ tournamentId, name }: { tournamentId: string; name: string }) {
  const { data: categories } = useCategories();
  const { data: entrants } = usePlacementEntrants();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: placementMatches } = usePlacementMatches();
  const { data: draws } = useTierDraws();
  const { data: tierMatches } = useTierDrawMatches();

  const input = useMemo(
    () => ({
      categories: categories ?? [],
      entrants: entrants ?? [],
      teams: teams ?? [],
      players: players ?? [],
      placementMatches: placementMatches ?? [],
      draws: draws ?? [],
      tierMatches: tierMatches ?? [],
    }),
    [categories, entrants, teams, players, placementMatches, draws, tierMatches],
  );
  const counts = useMemo(() => resultCounts(input), [input]);
  const ready = Boolean(categories && entrants && placementMatches && tierMatches);

  const link = () => `${window.location.origin}/tournaments/${tournamentId}/scores`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link());
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy. The link is " + link());
    }
  };

  const download = () => {
    const blob = new Blob(["﻿", buildResultsCsv(input)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${name.trim().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "tournament"}-results.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5" data-testid="wrap-up">
      <Panel title="How it went">
        <p className="text-base">
          {ready
            ? `${counts.played} ${counts.played === 1 ? "match" : "matches"} played` +
              (counts.walkovers ? `, ${counts.walkovers} by walkover` : "") +
              (counts.unplayed ? `, ${counts.unplayed} never played` : "") +
              "."
            : "Counting the matches…"}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void copyLink()}>
            Copy results link
          </Button>
          <Button variant="outline" disabled={!ready} onClick={download}>
            Download results (CSV)
          </Button>
        </div>
      </Panel>
      <TournamentResults tournamentId={tournamentId} />
    </div>
  );
}
