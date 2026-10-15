import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";

import {
  eventsUnderWay,
  runAutoSchedule,
  singleFlight,
  type AutoScheduleOutcome,
} from "@/lib/tournament/auto-schedule";
import {
  fetchPlacementEntrants,
  fetchPlacementMatches,
  fetchTierDrawMatches,
  fetchTierDraws,
  useCategories,
  useCourts,
  useScopedAccess,
  useTeams,
  useTournamentDayBreaks,
  useTournamentDayCourts,
  useTournamentScope,
} from "@/lib/tournament/data";
import { generateMissingStages } from "@/lib/tournament/placement-actions";
import { applyPlaceReadyPlan, planPlacementSchedule } from "@/lib/tournament/placement-schedule";

/** Plain-language summary of what an automatic pass did, or null when it did nothing visible. */
export function autoScheduleMessage(outcome: AutoScheduleOutcome): string | null {
  const parts: string[] = [];
  const { roundTwo, draws } = outcome.generated;
  if (roundTwo > 0) parts.push("Round 2 drawn");
  if (draws > 0) parts.push("Knockout drawn");
  if (outcome.placed > 0) {
    parts.push(`${outcome.placed} match${outcome.placed === 1 ? "" : "es"} scheduled`);
  }
  return parts.length ? parts.join(", ") : null;
}

/**
 * Returns a function to call after a result is saved. It generates what the result unlocked and
 * slots newly ready matches into free court time without moving any published time.
 *
 * Silent on failure and on "nothing to do": the result is already saved, and the Schedule page's
 * status line is where a match that found no room stays visible. Only editors run it.
 */
export function useAutoSchedule(): () => void {
  const qc = useQueryClient();
  const { tournament, days } = useTournamentScope();
  const canEdit = useScopedAccess().can_edit;
  const tournamentId = tournament?.id ?? null;
  const { data: courts } = useCourts();
  const { data: teams } = useTeams();
  const { data: categories } = useCategories();
  const { data: dayCourts } = useTournamentDayCourts(tournamentId);
  const { data: dayBreaks } = useTournamentDayBreaks(tournamentId);

  // Read at call time, not captured at render, so a pass started a moment later sees current data.
  const latest = useRef({
    tournament,
    days,
    canEdit,
    courts,
    teams,
    categories,
    dayCourts,
    dayBreaks,
  });
  latest.current = { tournament, days, canEdit, courts, teams, categories, dayCourts, dayBreaks };

  const runner = useMemo(
    () =>
      singleFlight(async () => {
        const l = latest.current;
        if (!l.canEdit || !l.tournament || !l.days?.length || !l.courts?.length) return;
        const id = l.tournament.id;
        const activeTournament = l.tournament;
        const planDays = l.days;
        const planCourts = l.courts;

        const dayCourtIds = new Map<string, ReadonlySet<string>>();
        for (const row of l.dayCourts ?? []) {
          const set = new Set(dayCourtIds.get(row.day_id) ?? []);
          set.add(row.court_id);
          dayCourtIds.set(row.day_id, set);
        }
        const breaksByDayId = new Map(
          planDays.map((day) => [
            day.id,
            (l.dayBreaks ?? []).filter((brk) => brk.day_id === day.id),
          ]),
        );

        const outcome = await runAutoSchedule({
          fetchFresh: async () => {
            const [placementMatches, tierMatches, draws, entrants] = await Promise.all([
              fetchPlacementMatches(id),
              fetchTierDrawMatches(id),
              fetchTierDraws(id),
              fetchPlacementEntrants(id),
            ]);
            return { placementMatches, tierMatches, draws, entrants };
          },
          generate: (fresh) => {
            // Never start an event's round one here: that is the first build, which stays the
            // operator's own decision.
            const underWay = eventsUnderWay(fresh);
            return generateMissingStages({
              categories: (l.categories ?? []).filter((category) => underWay.has(category.id)),
              entrants: fresh.entrants,
              matches: fresh.placementMatches,
              draws: fresh.draws,
            });
          },
          plan: (fresh) =>
            planPlacementSchedule({
              mode: "place-ready",
              tournament: activeTournament,
              days: planDays,
              allCourts: planCourts,
              dayCourtIds,
              breaksByDayId,
              teams: l.teams ?? [],
              entrants: fresh.entrants,
              draws: fresh.draws,
              placementMatches: fresh.placementMatches,
              tierMatches: fresh.tierMatches,
              categoryOrder: new Map((l.categories ?? []).map((c) => [c.id, c.sort_order])),
            }),
          apply: applyPlaceReadyPlan,
        });

        const message = autoScheduleMessage(outcome);
        if (message) {
          await qc.invalidateQueries();
          toast.success(message);
        }
      }),
    [qc],
  );

  return useCallback(() => {
    // Best-effort: the result is already saved, so a failure here must not surface as one.
    void runner().catch(() => undefined);
  }, [runner]);
}
