import { createFileRoute } from "@tanstack/react-router";

import { DayPlanner } from "@/components/schedule/day-planner";
import { PlacementScheduler } from "@/components/schedule/placement-scheduler";
import { isSupportedFormat } from "@/lib/tournament/competition-format";
import { useScopedTournament } from "@/lib/tournament/data";

export const Route = createFileRoute("/tournaments/$tournamentId/schedule")({
  head: () => ({
    meta: [
      { title: "Schedule | Tournova Tournament Ops" },
      {
        name: "description",
        content:
          "Build the court schedule day by day with stage-specific rest gaps and overrun forecasts.",
      },
      { property: "og:title", content: "Schedule | Tournova Tournament Ops" },
      {
        property: "og:description",
        content:
          "Build the court schedule day by day with stage-specific rest gaps and overrun forecasts.",
      },
    ],
  }),
  component: Schedule,
});

/**
 * The tournament's court schedule, in whichever shape its format schedules by.
 *
 * One route rather than two, because "the schedule" is one destination in the shell and
 * a link to it must not have to know the format to resolve. The two views are genuinely
 * different pages underneath — the round-robin planner works from `pool_matches` and
 * `draw_matches`, the placement scheduler from the placement rounds and tiers — so the
 * choice is made here, once, from the stored format rather than by merging their tables.
 *
 * `isSupportedFormat` is the same predicate the desk uses, so a tournament cannot be
 * scheduling-shaped one way on the desk and another way here.
 */
function Schedule() {
  const tournament = useScopedTournament();
  if (!tournament) return null;
  return isSupportedFormat(tournament.format) ? <PlacementScheduler /> : <DayPlanner />;
}
