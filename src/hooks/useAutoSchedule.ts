import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";

import {
  INITIAL_RETRY,
  attemptResult,
  eventsUnderWay,
  planRetry,
  runAutoSchedule,
  singleFlight,
  type AutoScheduleOutcome,
  type RetryState,
} from "@/lib/tournament/auto-schedule";
import {
  fetchPlacementEntrants,
  fetchPlacementMatches,
  fetchTierDrawMatches,
  fetchTierDraws,
  useCategories,
  useCourts,
  usePlacementMatches,
  useScopedAccess,
  useTeams,
  useTierDrawMatches,
  useTournamentDayBreaks,
  useTournamentDayCourts,
  useTournamentScope,
} from "@/lib/tournament/data";
import { generateMissingStages } from "@/lib/tournament/placement-actions";
import {
  applyPlaceReadyPlan,
  planPlacementSchedule,
  readyUnplacedIds,
} from "@/lib/tournament/placement-schedule";

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
 * One pass, shared by every caller on the page.
 *
 * The Desk reports results through a dialog and also runs the reconciler; both want the same
 * pass, and two of them planning against each other's half-written rows would only make the
 * server decline slots. A module-level flight means a burst from any mix of callers costs one
 * run plus one queued, and the executor is whichever mounted instance registered last, so it
 * always reads current data.
 */
const executors: (() => Promise<AutoScheduleOutcome | null>)[] = [];
const flight = singleFlight<AutoScheduleOutcome | null>(async () => {
  // The most recently mounted instance wins; one unmounting never strands the others.
  const current = executors[executors.length - 1];
  return current ? current() : null;
});

/** Registers this component's executor, built from the data it can see right now. */
function useAutoScheduleExecutor() {
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

  const execute = useCallback(async (): Promise<AutoScheduleOutcome | null> => {
    const l = latest.current;
    if (!l.canEdit || !l.tournament || !l.days?.length || !l.courts?.length) return null;
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
      planDays.map((day) => [day.id, (l.dayBreaks ?? []).filter((brk) => brk.day_id === day.id)]),
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
    return outcome;
  }, [qc]);

  useEffect(() => {
    executors.push(execute);
    return () => {
      const index = executors.lastIndexOf(execute);
      if (index >= 0) executors.splice(index, 1);
    };
  }, [execute]);

  return { canEdit, tournamentId, days, courts, dayCourts, dayBreaks };
}

/**
 * Returns a function to call after a result is saved. It generates what the result unlocked and
 * slots newly ready matches into free court time without moving any published time.
 *
 * Silent on failure and on "nothing to do": the result is already saved, and anything this cannot
 * place is picked up by `useAutoScheduleReconciler` and, when it needs a decision, by the notice on
 * the Schedule page. Only editors run it.
 */
export function useAutoSchedule(): () => void {
  useAutoScheduleExecutor();
  return useCallback(() => {
    // Best-effort: the result is already saved, so a failure here must not surface as one.
    void flight().catch(() => undefined);
  }, []);
}

/**
 * Keeps asking until every ready match has a time or the answer stops changing.
 *
 * This is what replaces a "Place now" button. A lost race with another desk, a dropped request, a
 * result that moved under the plan: all heal on their own, because while any ready match is
 * missing a time this looks again (after a short settle, then with backoff, three tries at most).
 * What it does not do is hammer a persistent answer. "No room before the close" gives the same
 * result every time, so one attempt per situation is enough; the organiser changing the days or
 * courts is a new situation and is tried afresh.
 *
 * Mount it where an editor is already looking at the schedule (the Desk, the Schedule page). With
 * nobody looking nothing retries, which is acceptable: a tournament in progress always has a desk.
 */
export function useAutoScheduleReconciler(): void {
  const { canEdit, tournamentId, days, courts, dayCourts, dayBreaks } = useAutoScheduleExecutor();
  const { data: placementMatches } = usePlacementMatches();
  const { data: tierMatches } = useTierDrawMatches();

  const signature = useMemo(() => {
    if (!canEdit || !tournamentId) return null;
    const ids = readyUnplacedIds(placementMatches ?? [], tierMatches ?? []);
    if (!ids.length) return null;
    // Everything a new answer could depend on: the days they could go on and the courts and
    // breaks of those days. A change to any of it is a new situation, not a repeat.
    const context = JSON.stringify([
      (days ?? []).map((d) => [d.id, d.date, d.start_time, d.end_time]),
      (courts ?? []).map((c) => c.id).sort(),
      (dayCourts ?? []).map((r) => `${r.day_id}:${r.court_id}`).sort(),
      (dayBreaks ?? []).map((b) => `${b.day_id}:${b.start_time}-${b.end_time}`).sort(),
    ]);
    return `${context}|${ids.join(",")}`;
  }, [canEdit, tournamentId, placementMatches, tierMatches, days, courts, dayCourts, dayBreaks]);

  const retry = useRef<RetryState>(INITIAL_RETRY);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const schedule = (delayMs: number | null) => {
      if (delayMs == null || cancelled) return;
      timer = setTimeout(async () => {
        let outcome: AutoScheduleOutcome | null = null;
        let threw = false;
        try {
          outcome = await flight();
        } catch {
          threw = true;
        }
        if (cancelled) return;
        const next = planRetry(retry.current, signature, attemptResult(outcome, threw));
        retry.current = next.state;
        schedule(next.delayMs);
      }, delayMs);
    };

    const first = planRetry(retry.current, signature, null);
    retry.current = first.state;
    schedule(first.delayMs);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [signature]);
}
