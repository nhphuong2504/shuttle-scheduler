/**
 * Two-round placement format: client actions and view-model builders.
 *
 * This module is the bridge between the pure pairing engine and the database. It
 * is deliberately separate from `actions.ts`, which drives the legacy round-robin
 * engine: the two formats share no tables, and mixing them in one file is how a
 * helper ends up quietly operating on the wrong format's rows.
 *
 * The split of responsibility is the same one the SQL migration documents:
 *
 *   * The PAIRING is computed here, by `placement.ts` / `tier-draw.ts` /
 *     `placement-seed.ts`, which are covered by exhaustive tests.
 *   * The RPCs VALIDATE and PERSIST. They re-check the placement gate and the
 *     completeness of a batch, so a bug here produces a rejected call rather
 *     than a corrupt bracket.
 *
 * A consequence worth knowing: everything that reads state back (outcomes, the
 * gate, the tier groups) reconstructs the engine's own input types from the
 * database rows. That is what keeps one implementation of the rules.
 */

import { supabase } from "@/integrations/supabase/client";

import type { Category, PlacementEntrant, PlacementMatch, TierDraw, TierDrawMatch } from "./data";
import {
  buildPlacementRoundTwo,
  computePlacementOutcomes,
  pairPlacementRoundOne,
  placementGate,
  requiredPlacementMatches,
  type EntrantPlacementOutcome,
  type GeneratedPlacementMatch,
  type PlacementEntrantRef,
  type PlacementGate,
  type PlacementStage,
} from "./placement";
import { assignSeeds, type AssignedSeed, type SeedableEntrant } from "./placement-seed";
import { seedFromString, type RandomFn } from "./rng";
import { buildTierBracket, type TierBracketPlan } from "./tier-draw";
import {
  placementFeederSlots,
  resolvePlacementFeederSlots,
  type PlacementFeederSlot,
} from "./placement-feeders";
import type { DrawTier } from "./competition-format";

async function rpc(name: string, args: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.rpc(name as never, args as never);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Shape conversion
//
// The engine speaks in entrant ids and `stage`/`key`; the RPC payloads speak in
// TEAM ids. The reason for the difference is regeneration: round two replaces its
// rows, so the entrant rows it referenced are recreated, while the team behind
// them is stable. Sending team ids means a payload stays valid across that.
// ---------------------------------------------------------------------------

/** The engine's view of an entrant: identity and seed, nothing else. */
export function toEntrantRefs(entrants: readonly PlacementEntrant[]): PlacementEntrantRef[] {
  return entrants.map((entrant) => ({ id: entrant.id, seed: entrant.seed ?? 0 }));
}

/**
 * Rebuilds the engine's match type from stored rows.
 *
 * `prerequisiteKeys` is left empty on purpose: it exists so the round-two
 * generator can express ordering, and nothing that reads state back needs it.
 */
export function toGeneratedMatches(matches: readonly PlacementMatch[]): GeneratedPlacementMatch[] {
  return matches.map((match) => ({
    key: match.generation_key,
    stage: match.stage as PlacementStage,
    entrantAId: match.entrant_a_id,
    entrantBId: match.entrant_b_id,
    isMakeup: match.is_makeup,
    isCrossover: match.is_crossover,
    prerequisiteKeys: [],
  }));
}

/** Decided winners, keyed by generation key, which is what the engine reads. */
export function decidedWinners(matches: readonly PlacementMatch[]): Map<string, string | null> {
  return new Map(
    matches.map((match) => [
      match.generation_key,
      match.status === "reported" || match.status === "walkover" ? match.winner_id : null,
    ]),
  );
}

/** Entrant id -> team id, for building RPC payloads. */
function teamIdByEntrant(entrants: readonly PlacementEntrant[]): Map<string, string> {
  return new Map(entrants.map((entrant) => [entrant.id, entrant.team_id]));
}

interface MatchPayload {
  key: string;
  entrant_a_team_id: string;
  entrant_b_team_id: string;
  is_makeup: boolean;
  is_crossover: boolean;
  prerequisite_keys: string[];
}

function toMatchPayload(
  matches: readonly GeneratedPlacementMatch[],
  entrants: readonly PlacementEntrant[],
): MatchPayload[] {
  const teamIds = teamIdByEntrant(entrants);
  return matches.map((match) => {
    const a = teamIds.get(match.entrantAId);
    const b = teamIds.get(match.entrantBId);
    if (!a || !b) {
      throw new Error(`Match ${match.key} refers to an entrant that is not in this category.`);
    }
    return {
      key: match.key,
      entrant_a_team_id: a,
      entrant_b_team_id: b,
      is_makeup: match.isMakeup,
      is_crossover: match.isCrossover,
      prerequisite_keys: match.prerequisiteKeys,
    };
  });
}

/**
 * Who was held out of round one, derived rather than stored.
 *
 * Deriving it is what makes the rule self-consistent: an entrant with no
 * round-one match is held by definition, so this cannot disagree with the
 * generated pairs even if the pairings are regenerated.
 */
export function heldEntrantId(
  entrants: readonly PlacementEntrant[],
  matches: readonly PlacementMatch[],
): string | null {
  const roundOne = new Set<string>();
  for (const match of matches) {
    if (match.stage !== "round1") continue;
    roundOne.add(match.entrant_a_id);
    roundOne.add(match.entrant_b_id);
  }
  const held = entrants.filter((entrant) => !entrant.excluded && !roundOne.has(entrant.id));
  // More than one unpaired entrant means round one has not been generated yet, so
  // there is no held entrant to report.
  return held.length === 1 ? (held[0] as PlacementEntrant).id : null;
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export interface CategoryPlacementView {
  /** Entrants the desk is actually running, i.e. not waived. */
  active: PlacementEntrant[];
  excluded: PlacementEntrant[];
  refs: PlacementEntrantRef[];
  matches: PlacementMatch[];
  roundOne: PlacementMatch[];
  roundTwo: PlacementMatch[];
  /** Logical round-two slots; actual placement rows still always have two known entrants. */
  roundTwoSlots: PlacementFeederSlot[];
  outcomes: EntrantPlacementOutcome[];
  gate: PlacementGate;
  /** Entrants grouped by tier, or empty until every record is decided. */
  byTier: Record<DrawTier, EntrantPlacementOutcome[]>;
  heldEntrantId: string | null;
  seedsLocked: boolean;
  /** Required matches per entrant, which is 0, 1 or 2 depending on field size. */
  requiredMatches: number;
  /**
   * Whether this field has a round one to play at all. A field of one does not:
   * the sole entrant takes Draw A with no matches, so the UI must not offer a
   * generate button that would create nothing.
   */
  roundOneExpected: boolean;
  /**
   * Whether this field has a round two. It does not for a field of one or two,
   * because the make-up rule needs a winner and a loser to draw from.
   */
  roundTwoExpected: boolean;
  stage: "seeding" | "round1" | "round2" | "draws";
}

/** A field of two plays one round-one match, then stops. */
export const MIN_ENTRANTS_FOR_ROUND_ONE = 2;
/** A field of three is the smallest that can produce make-up matches. */
export const MIN_ENTRANTS_FOR_ROUND_TWO = 3;

export function buildCategoryView(
  entrants: readonly PlacementEntrant[],
  matches: readonly PlacementMatch[],
): CategoryPlacementView {
  const active = entrants.filter((entrant) => !entrant.excluded);
  const refs = toEntrantRefs(active);
  const generated = toGeneratedMatches(matches);
  const outcomes = computePlacementOutcomes({
    entrants: refs,
    matches: generated,
    winners: decidedWinners(matches),
  });

  const byTier: Record<DrawTier, EntrantPlacementOutcome[]> = { A: [], B: [], C: [], D: [] };
  for (const outcome of outcomes) {
    if (outcome.tier) byTier[outcome.tier].push(outcome);
  }
  for (const tier of ["A", "B", "C", "D"] as DrawTier[]) {
    byTier[tier].sort((a, b) => a.seed - b.seed);
  }

  const roundOne = matches.filter((match) => match.stage === "round1");
  const roundTwo = matches.filter((match) => match.stage === "round2");
  const seedsLocked = active.length > 0 && active.every((entrant) => entrant.seed != null);
  const roundTwoSlots =
    seedsLocked && roundOne.every((m) => m.status !== "void")
      ? placementFeederSlots(refs, toGeneratedMatches(roundOne))
      : [];

  // The gate is given EVERY entrant, including waived ones, so it can report how
  // many were skipped. It derives the field size from the entrants who are
  // actually playing, so a waiver cannot change the requirement.
  const gate = placementGate(
    entrants.map((entrant) => ({
      id: entrant.id,
      seed: entrant.seed ?? 0,
      excluded: entrant.excluded,
    })),
    outcomes,
  );

  const roundOneExpected = active.length >= MIN_ENTRANTS_FOR_ROUND_ONE;
  const roundTwoExpected = active.length >= MIN_ENTRANTS_FOR_ROUND_TWO;

  const roundOneSettled =
    roundOne.length > 0 &&
    roundOne.every((match) => match.status === "reported" || match.status === "walkover");

  // The stage the desk is working on, which is what the header reports. The gate
  // decides "draws" rather than a round count, so a field of one or two reaches
  // the draws without a round two — the same condition the database enforces.
  const stage: CategoryPlacementView["stage"] = !seedsLocked
    ? "seeding"
    : gate.ready
      ? "draws"
      : roundOne.length === 0 || !roundOneSettled
        ? "round1"
        : "round2";

  return {
    active,
    excluded: entrants.filter((entrant) => entrant.excluded),
    refs,
    matches: [...matches],
    roundOne,
    roundTwo,
    roundTwoSlots,
    outcomes,
    gate,
    byTier,
    heldEntrantId: heldEntrantId(active, matches),
    seedsLocked,
    requiredMatches: requiredPlacementMatches(active.length),
    roundOneExpected,
    roundTwoExpected,
    stage,
  };
}

// ---------------------------------------------------------------------------
// Entrants and seeding
// ---------------------------------------------------------------------------

/** Creates an entrant row for every active team, and waives withdrawn ones. */
export async function syncPlacementEntrants(categoryId: string): Promise<void> {
  await rpc("sync_placement_entrants", { p_category_id: categoryId });
}

export async function setPlacementSkill(
  categoryId: string,
  teamId: string,
  skillLevel: string,
): Promise<void> {
  await rpc("set_placement_skill", {
    p_category_id: categoryId,
    p_team_id: teamId,
    p_skill_level: skillLevel,
  });
}

/**
 * A stable per-category seed for the shuffle.
 *
 * Keyed on the category so two categories do not shuffle identically, and stable
 * so a re-render cannot re-roll the order. The shuffle only happens when the host
 * presses the button, never during render.
 */
export function shuffleSeedFor(categoryId: string): number {
  return seedFromString(`placement:${categoryId}`);
}

/** The seed order the host is about to commit, strongest block first. */
export function planSeeds(entrants: readonly PlacementEntrant[], random: RandomFn): AssignedSeed[] {
  const seedable: SeedableEntrant[] = entrants
    .filter((entrant) => !entrant.excluded)
    .map((entrant) => ({ id: entrant.id, skillLevel: entrant.skill_level as never }));
  return assignSeeds(seedable, random);
}

/** The RPC payload for a seed order: entrant ids in order, seeded 1..N. */
function toSeedPayload(
  entrants: readonly PlacementEntrant[],
  orderedEntrantIds: readonly string[],
): { team_id: string; seed: number }[] {
  const teamIds = teamIdByEntrant(entrants);
  return orderedEntrantIds.map((entrantId, index) => {
    const teamId = teamIds.get(entrantId);
    if (!teamId) throw new Error("A seeded entrant has no team.");
    return { team_id: teamId, seed: index + 1 };
  });
}

/** Writes and freezes the seed order. */
export async function lockPlacementSeeds(
  categoryId: string,
  entrants: readonly PlacementEntrant[],
  random: RandomFn,
): Promise<AssignedSeed[]> {
  const assigned = planSeeds(entrants, random);
  await rpc("lock_placement_seeds", {
    p_category_id: categoryId,
    p_seeds: toSeedPayload(
      entrants,
      assigned.map((entry) => entry.id),
    ),
  });
  return assigned;
}

/**
 * Writes an explicit seed order rather than computing one by shuffling.
 *
 * This is the drag-to-reorder path on the seeding table. It calls the same RPC as
 * the shuffle, because the write is identical — a full permutation of the field,
 * seeds 1..N — and the two differ only in who chose the order. Going through the
 * same function is what keeps the reorder subject to the same guard: the RPC
 * refuses once any placement match exists, so a hand-made order cannot silently
 * disagree with pairings generated from the previous one.
 *
 * The order is validated here as well as in the database. The RPC can only report
 * a count mismatch, which is a poor description of "you named the wrong entrants",
 * and the caller wants that explanation at the drop rather than from a failed call.
 */
export async function savePlacementSeedOrder(
  categoryId: string,
  entrants: readonly PlacementEntrant[],
  orderedEntrantIds: readonly string[],
): Promise<void> {
  const active = entrants.filter((entrant) => !entrant.excluded);

  const seen = new Set<string>();
  for (const entrantId of orderedEntrantIds) {
    if (seen.has(entrantId)) {
      throw new Error("The new seed order names the same entrant twice.");
    }
    seen.add(entrantId);
  }
  if (orderedEntrantIds.length !== active.length || active.some((e) => !seen.has(e.id))) {
    throw new Error("The new seed order has to name every entrant in the event exactly once.");
  }

  await rpc("lock_placement_seeds", {
    p_category_id: categoryId,
    p_seeds: toSeedPayload(entrants, orderedEntrantIds),
  });
}

// ---------------------------------------------------------------------------
// Stage generation
// ---------------------------------------------------------------------------

/**
 * Generates round one from the locked seed order.
 *
 * The payload is checked before it is sent, because the RPC can only tell that a
 * batch was incomplete, not that the pairing was wrong.
 */
export async function generatePlacementRoundOne(
  categoryId: string,
  entrants: readonly PlacementEntrant[],
  force = false,
): Promise<number> {
  const active = entrants.filter((entrant) => !entrant.excluded);
  if (active.some((entrant) => entrant.seed == null)) {
    throw new Error("Lock the seed order before generating placement matches.");
  }
  const plan = pairPlacementRoundOne(toEntrantRefs(active));
  const payload = toMatchPayload(plan.matches, entrants);
  const { data, error } = await supabase.rpc("apply_placement_generation", {
    p_category_id: categoryId,
    p_matches: payload as never,
    p_force: force,
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

/**
 * Generates round two from round-one results.
 *
 * Fixed feeders append ready matches without waiting on unrelated results.
 * Odd fields/crossover still require the complete round-one winner/loser sets.
 */
export async function generatePlacementRoundTwo(
  categoryId: string,
  entrants: readonly PlacementEntrant[],
  matches: readonly PlacementMatch[],
  force = false,
): Promise<number> {
  const active = entrants.filter((entrant) => !entrant.excluded);
  const roundOne = matches.filter((match) => match.stage === "round1");
  if (
    !force &&
    placementFeederSlots(toEntrantRefs(active), toGeneratedMatches(roundOne)).length > 0
  ) {
    const { data, error } = await supabase.rpc("open_ready_placement_round_two", {
      p_category_id: categoryId,
    });
    if (error) throw new Error(error.message);
    return Number(data ?? 0);
  }
  const undecided = roundOne.filter(
    (match) => match.status !== "reported" && match.status !== "walkover",
  );
  if (undecided.length > 0) {
    throw new Error(
      `Round two needs every round one result first — ${undecided.length} still to play.`,
    );
  }

  const plan = buildPlacementRoundTwo({
    entrants: toEntrantRefs(active),
    roundOne: toGeneratedMatches(roundOne),
    roundOneWinners: decidedWinners(roundOne),
    heldEntrantId: heldEntrantId(active, matches),
  });

  const payload = toMatchPayload(plan.matches, entrants);
  const { data, error } = await supabase.rpc("apply_placement_round_two", {
    p_category_id: categoryId,
    p_matches: payload as never,
    p_force: force,
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

export interface TierDrawPayload {
  tier: DrawTier;
  bracket_size: number;
  entrant_count: number;
  champion_team_id: string | null;
  matches: {
    round: number;
    slot: number;
    entrant_a_team_id: string | null;
    entrant_b_team_id: string | null;
    winner_team_id: string | null;
    is_bye: boolean;
  }[];
}

/**
 * Turns the four bracket plans into the RPC payload.
 *
 * Exported and pure so the tier-to-bracket projection is testable without a
 * database. An empty tier is dropped rather than sent: there is nothing to draw,
 * and `bracket_size >= 1` would reject a placeholder row anyway.
 */
export function toTierDrawPayload(
  plans: readonly TierBracketPlan[],
  entrants: readonly PlacementEntrant[],
): TierDrawPayload[] {
  const teamIds = teamIdByEntrant(entrants);
  const teamIdOf = (entrantId: string | null): string | null =>
    entrantId ? (teamIds.get(entrantId) ?? null) : null;

  return plans
    .filter((plan) => plan.entrantCount > 0)
    .map((plan) => ({
      tier: plan.tier,
      bracket_size: plan.bracketSize,
      entrant_count: plan.entrantCount,
      champion_team_id: teamIdOf(plan.championId),
      matches: plan.matches.map((match) => ({
        round: match.round,
        slot: match.slot,
        entrant_a_team_id: teamIdOf(match.entrantAId),
        entrant_b_team_id: teamIdOf(match.entrantBId),
        winner_team_id: teamIdOf(match.winnerId),
        is_bye: match.isBye,
      })),
    }));
}

/**
 * Assigns tiers and creates the A/B/C/D brackets.
 *
 * Refused unless the whole field has completed its placement matches, matching
 * the database gate. The tier assignment itself comes from
 * `computePlacementOutcomes`, so the bracket a player lands in is decided by the
 * same function the desk is reading.
 */
export async function generateTierDraws(
  categoryId: string,
  entrants: readonly PlacementEntrant[],
  matches: readonly PlacementMatch[],
  force = false,
): Promise<void> {
  const view = buildCategoryView(entrants, matches);
  if (!view.gate.ready) {
    throw new Error(
      `Every entrant needs ${view.gate.requiredMatches} placement matches before draws — ` +
        `${view.gate.short.length} still short.`,
    );
  }

  const plans: TierBracketPlan[] = (["A", "B", "C", "D"] as DrawTier[]).map((tier) =>
    buildTierBracket(
      tier,
      view.byTier[tier].map((outcome) => ({ id: outcome.entrantId, seed: outcome.seed })),
    ),
  );

  const tierPayload = (["A", "B", "C", "D"] as DrawTier[]).flatMap((tier) =>
    view.byTier[tier].map((outcome) => {
      const teamId = entrants.find((entrant) => entrant.id === outcome.entrantId)?.team_id;
      if (!teamId) throw new Error("A tiered entrant has no team.");
      return { team_id: teamId, tier };
    }),
  );

  const { error } = await supabase.rpc("apply_tier_draws", {
    p_category_id: categoryId,
    p_tiers: tierPayload as never,
    p_draws: toTierDrawPayload(plans, entrants) as never,
    p_force: force,
  });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// The queue's generation step
// ---------------------------------------------------------------------------

/** Why a category was left alone, in the desk's terms rather than an error code. */
export interface SkippedCategory {
  categoryId: string;
  code: string;
  reason: string;
}

export interface StageGenerationOutcome {
  generated: { roundOne: number; roundTwo: number; draws: number };
  skipped: SkippedCategory[];
}

export interface GenerateMissingStagesInput {
  categories: readonly Category[];
  entrants: readonly PlacementEntrant[];
  matches: readonly PlacementMatch[];
  draws: readonly TierDraw[];
}

/**
 * Creates whatever stage the queue is waiting on, for every category, in order.
 *
 * This is what makes one Build button enough. The generators were moved off the
 * Placement tab, so without this a build has nothing to schedule. Fixed feeders
 * append ready round-two matches while round one is still running; adaptive
 * fields wait for the whole round. The knockout gate still requires full records.
 *
 * A category that cannot advance is reported rather than thrown: one event with
 * unlocked seeds must not stop the other four from being scheduled.
 */
export async function generateMissingStages(
  input: GenerateMissingStagesInput,
): Promise<StageGenerationOutcome> {
  const outcome: StageGenerationOutcome = {
    generated: { roundOne: 0, roundTwo: 0, draws: 0 },
    skipped: [],
  };

  for (const category of input.categories) {
    const entrants = input.entrants.filter((entrant) => entrant.category_id === category.id);
    if (!entrants.length) continue;
    const matches = input.matches.filter((match) => match.category_id === category.id);
    const view = buildCategoryView(entrants, matches);
    const skip = (reason: string) => {
      outcome.skipped.push({ categoryId: category.id, code: category.code, reason });
    };

    if (!view.seedsLocked) {
      skip("seed order is not locked");
      continue;
    }

    // Fixed feeders can open round two while round one is still being played.
    // Repeated calls append missing rows; they never replace a published match.
    if (view.roundTwoSlots.length > 0 && !view.gate.ready) {
      const existing = new Set(view.roundTwo.map((m) => m.generation_key));
      if (
        resolvePlacementFeederSlots(view.roundTwoSlots, toGeneratedMatches(view.roundOne),
          decidedWinners(view.roundOne)).some((m) => !existing.has(m.key))
      ) {
        outcome.generated.roundTwo += await generatePlacementRoundTwo(
          category.id,
          entrants,
          matches,
        );
      }
      continue;
    }

    if (view.stage === "round1") {
      if (view.roundOne.length > 0 || !view.roundOneExpected) continue;
      outcome.generated.roundOne += await generatePlacementRoundOne(category.id, entrants);
      continue;
    }

    if (view.stage === "round2") {
      if (view.roundTwo.length > 0 || !view.roundTwoExpected) continue;
      outcome.generated.roundTwo += await generatePlacementRoundTwo(category.id, entrants, matches);
      continue;
    }

    // Draws. A field of one or two reaches here without a round two, which is the
    // same condition the database enforces.
    if (input.draws.some((draw) => draw.category_id === category.id)) continue;
    await generateTierDraws(category.id, entrants, matches);
    outcome.generated.draws += 1;
  }

  return outcome;
}

/** Recovery also watches unlocked generations, not just rows already missing a court/time. */
export function pendingPlacementGenerationKeys(
  entrants: readonly PlacementEntrant[],
  matches: readonly PlacementMatch[],
  draws: readonly TierDraw[],
): string[] {
  const categoryIds = new Set(matches.map((m) => m.category_id));
  return [...categoryIds]
    .flatMap((categoryId) => {
      const view = buildCategoryView(
        entrants.filter((e) => e.category_id === categoryId),
        matches.filter((m) => m.category_id === categoryId),
      );
      if (!view.seedsLocked) return [];
      if (view.gate.ready)
        return draws.some((d) => d.category_id === categoryId) ? [] : [`${categoryId}:draws`];
      if (view.roundTwoSlots.length) {
        const existing = new Set(view.roundTwo.map((m) => m.generation_key));
        return resolvePlacementFeederSlots(
          view.roundTwoSlots,
          toGeneratedMatches(view.roundOne),
          decidedWinners(view.roundOne),
        )
          .filter((m) => !existing.has(m.key))
          .map((m) => `${categoryId}:${m.key}`);
      }
      return view.stage === "round2" && view.roundTwo.length === 0 && view.roundTwoExpected
        ? [`${categoryId}:round2`]
        : [];
    })
    .sort();
}

/** True when `generateMissingStages` created anything, so a refetch is needed. */
export function stageGenerationChanged(outcome: StageGenerationOutcome): boolean {
  const { roundOne, roundTwo, draws } = outcome.generated;
  return roundOne > 0 || roundTwo > 0 || draws > 0;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * The most a finish may be backdated, in minutes.
 *
 * Mirrors `c_max_minutes_ago` in `20261011000000_report_ended_minutes_ago.sql`, which
 * is the authority — this copy only lets the desk refuse an out-of-range number before
 * it makes the round trip. Twelve hours covers an honest late entry; the point is to
 * catch a typo, whose resolved finish would land before the day began.
 */
export const MAX_ENDED_MINUTES_AGO = 720;

/**
 * The match as the dialog opened it, for the server's staleness check.
 *
 * `reportedAt` is null for a match nobody has reported, which is a real expectation and not
 * an absence of one: the server binds the timestamp to `status = 'reported'`, so a first
 * entry is guarded by the status alone and a correction by both. Keeping it optional means
 * a scripted caller - and every integration fixture - asks for no check at all.
 */
export interface ResultSnapshot {
  status: string;
  reportedAt: string | null;
}

/**
 * The argument for a report, omitting the offset when it is zero.
 *
 * The database default is 0 and means "keep the old COALESCE(ended_at, now())", so
 * sending nothing keeps every existing caller and every test fixture on the old path.
 * A zero sent explicitly would be the same value, but omitting it keeps the request
 * shape — and the mocks that assert it — unchanged.
 *
 * The snapshot follows the same rule: absent entirely when the caller is not checking, so
 * the request shape of every existing caller is untouched. A null `reportedAt` is omitted
 * rather than sent, because NULL is how the server says "do not compare a result token".
 */
function reportArgs(
  matchId: string,
  games: unknown,
  endedMinutesAgo: number,
  expected?: ResultSnapshot,
) {
  return {
    p_match_id: matchId,
    p_games: games,
    ...(endedMinutesAgo > 0 ? { p_ended_minutes_ago: endedMinutesAgo } : {}),
    ...(expected
      ? {
          p_expected_status: expected.status,
          ...(expected.reportedAt ? { p_expected_reported_at: expected.reportedAt } : {}),
        }
      : {}),
  };
}

/**
 * Reports a placement result. The database applies the tournament's placement rule.
 *
 * Returns the ripple the result caused. Reporting now reflows the rest of the day,
 * so a match that finished late pushes everything after it on that court — and the
 * desk should be told that happened rather than having to notice.
 *
 * `endedMinutesAgo` is for a result entered after the fact: the database backdates the
 * finish by that many minutes, measured on its own clock, so a late entry no longer
 * reflows the day as though the match ran long. Leave it at 0 when reporting live.
 */
export async function reportPlacementMatch(
  matchId: string,
  games: unknown,
  tournamentId: string,
  endedMinutesAgo = 0,
  expected?: ResultSnapshot,
): Promise<PlacementScheduleImpact> {
  const { impact } = await withPlacementScheduleImpact(tournamentId, () =>
    rpc("report_placement_result", reportArgs(matchId, games, endedMinutesAgo, expected)),
  );
  return impact;
}

/**
 * Reports a knockout result. The database applies the knockout rule, advances the
 * bracket and then reflows the day, so the next round may already exist and may
 * already have moved by the time this resolves.
 *
 * `endedMinutesAgo` behaves as it does for a placement result.
 */
export async function reportTierDrawMatch(
  matchId: string,
  games: unknown,
  tournamentId: string,
  endedMinutesAgo = 0,
  expected?: ResultSnapshot,
): Promise<PlacementScheduleImpact> {
  const { impact } = await withPlacementScheduleImpact(tournamentId, () =>
    rpc("report_tier_draw_result", reportArgs(matchId, games, endedMinutesAgo, expected)),
  );
  return impact;
}

// ---------------------------------------------------------------------------
// Schedule impact
// ---------------------------------------------------------------------------

export interface PlacementScheduleImpact {
  shiftedMatches: number;
  largestShiftMinutes: number;
  direction: "earlier" | "later" | "mixed" | "none";
}

/** Only the still-movable rows: a reported or in-progress match cannot be shifted. */
type ScheduleSnapshot = Map<string, number>;

async function placementScheduleSnapshot(tournamentId: string): Promise<ScheduleSnapshot> {
  const snapshot: ScheduleSnapshot = new Map();
  const [placement, tier] = await Promise.all([
    supabase
      .from("placement_matches")
      .select("id, scheduled_time")
      .eq("tournament_id", tournamentId)
      .eq("status", "scheduled"),
    supabase
      .from("tier_draw_matches")
      .select("id, scheduled_time")
      .eq("tournament_id", tournamentId)
      .eq("status", "scheduled"),
  ]);
  if (placement.error) throw new Error(placement.error.message);
  if (tier.error) throw new Error(tier.error.message);
  for (const row of placement.data ?? []) {
    if (row.scheduled_time) snapshot.set(`p:${row.id}`, new Date(row.scheduled_time).getTime());
  }
  for (const row of tier.data ?? []) {
    if (row.scheduled_time) snapshot.set(`t:${row.id}`, new Date(row.scheduled_time).getTime());
  }
  return snapshot;
}

function comparePlacementSchedule(
  before: ScheduleSnapshot,
  after: ScheduleSnapshot,
): PlacementScheduleImpact {
  const deltas: number[] = [];
  for (const [id, next] of after) {
    const previous = before.get(id);
    if (previous != null && previous !== next) {
      deltas.push(Math.round((next - previous) / 60_000));
    }
  }
  const earlier = deltas.some((delta) => delta < 0);
  const later = deltas.some((delta) => delta > 0);
  return {
    shiftedMatches: deltas.length,
    largestShiftMinutes: deltas.reduce((largest, delta) => Math.max(largest, Math.abs(delta)), 0),
    direction: earlier && later ? "mixed" : earlier ? "earlier" : later ? "later" : "none",
  };
}

/**
 * Snapshots the schedule, runs the work, and reports what moved.
 *
 * The snapshot is taken before and after rather than predicted, because the reflow
 * runs in SQL across two tables and its result is not something the client should
 * be re-deriving. Same approach as the legacy `withScheduleImpact`, kept separate
 * because it reads the placement tables.
 */
export async function withPlacementScheduleImpact<T>(
  tournamentId: string,
  work: () => Promise<T>,
): Promise<{ result: T; impact: PlacementScheduleImpact }> {
  const before = await placementScheduleSnapshot(tournamentId);
  const result = await work();
  const after = await placementScheduleSnapshot(tournamentId);
  return { result, impact: comparePlacementSchedule(before, after) };
}

/**
 * A one-line note for the desk, or null when nothing moved.
 *
 * Returns null rather than "0 matches moved" on purpose: the common case is that a
 * result changes nothing, and saying so on every score entry would train the desk
 * to ignore the line that matters.
 *
 * "Downstream" is the honest word: these are the later matches on the same court,
 * plus any match pulled forward by a freed player — not everything on the day.
 */
export function scheduleImpactNote(impact: PlacementScheduleImpact): string | null {
  if (impact.shiftedMatches === 0) return null;
  const count = `${impact.shiftedMatches} later match${impact.shiftedMatches === 1 ? "" : "es"}`;
  const distance = `by up to ${impact.largestShiftMinutes} min`;
  // A mixed reflow has no single direction, so none is claimed.
  if (impact.direction === "mixed") return `${count} rescheduled ${distance}`;
  // "Delayed" is only said of a push later; an earlier move is not a delay.
  if (impact.direction === "later") return `${count} delayed ${distance}`;
  return `${count} moved ${impact.direction} ${distance}`;
}

export async function startPlacementMatch(matchId: string, courtId: string | null): Promise<void> {
  await rpc("start_placement_match", { p_match_id: matchId, p_court_id: courtId });
}

export async function startTierDrawMatch(matchId: string, courtId: string | null): Promise<void> {
  await rpc("start_tier_draw_match", { p_match_id: matchId, p_court_id: courtId });
}

/**
 * Moves a placement-format match to another court and time, by hand.
 *
 * `p_table` is one of the two placement tables, matching the desk's own
 * table-scoped move for the round-robin format. The database refuses a move onto an
 * occupied court or a player who is busy or still resting, using the group timings
 * for the placement rounds and the knockout timings for the brackets.
 */
export async function reschedulePlacementMatch(
  table: "placement_matches" | "tier_draw_matches",
  matchId: string,
  courtId: string,
  scheduledTime: string,
): Promise<void> {
  await rpc("reschedule_placement_match", {
    p_table: table,
    p_match_id: matchId,
    p_court_id: courtId,
    p_scheduled_time: scheduledTime,
  });
}

/**
 * Clears a placement result.
 *
 * Fixed feeders retract unplayed children, and refuse once a child starts.
 * Adaptive/legacy round twos retain the category-wide regeneration guard.
 */
export async function resetPlacementResult(matchId: string): Promise<void> {
  await rpc("reset_placement_result", { p_match_id: matchId });
}

export async function resetTierDrawResult(matchId: string): Promise<void> {
  await rpc("reset_tier_draw_result", { p_match_id: matchId });
}

// ---------------------------------------------------------------------------
// The two resets
// ---------------------------------------------------------------------------
//
// Scheduling and seeding are separate decisions, made on separate tabs, so they get
// separate resets rather than one action that always takes both. See
// `20260926000000_placement_schedule_reset.sql` for the full reasoning.
//
//   * `resetPlacementSchedule` — the Schedule tab. Discards the matches, the draws
//     and the derived tiers; keeps the seed order and the waivers, so the schedule
//     rebuilds on the same seeding.
//   * `resetPlacementStage` — the Placement tab, which owns the seed order. Also
//     clears the seed order and the waivers, back to a registered field.

/** What a schedule reset removed, so the desk can be told rather than left guessing. */
export interface PlacementScheduleReset {
  placementMatches: number;
  tierDraws: number;
  tierMatches: number;
}

/** What a whole-stage reset removed: a schedule reset plus the entrant state. */
export interface PlacementStageReset extends PlacementScheduleReset {
  entrants: number;
}

/** The match and draw counts, shared by both reset notes. */
function resetCountParts(reset: PlacementScheduleReset): string[] {
  return [
    reset.placementMatches > 0
      ? `${reset.placementMatches} placement match${reset.placementMatches === 1 ? "" : "es"}`
      : null,
    reset.tierMatches > 0
      ? `${reset.tierMatches} knockout match${reset.tierMatches === 1 ? "" : "es"}`
      : null,
    reset.tierDraws > 0 ? `${reset.tierDraws} draw${reset.tierDraws === 1 ? "" : "s"}` : null,
  ].filter((part): part is string => part != null);
}

/**
 * Discards the schedule — every placement and knockout match, every draw and every
 * result — and keeps the seeding.
 *
 * The seed order, the lock and the waivers survive, so the stage comes back at round
 * one on the same seeding and "Build the schedule" regenerates from it. This is the
 * reset for rebuilding a schedule, not for starting the tournament over. Admin-only
 * and irreversible; the caller is expected to have confirmed with the desk first.
 */
export async function resetPlacementSchedule(
  tournamentId: string,
): Promise<PlacementScheduleReset> {
  const { data, error } = await supabase.rpc(
    "reset_placement_schedule" as never,
    {
      p_tournament_id: tournamentId,
    } as never,
  );
  if (error) throw new Error(error.message);
  const counts = (data ?? {}) as Partial<PlacementScheduleReset>;
  return {
    placementMatches: counts.placementMatches ?? 0,
    tierDraws: counts.tierDraws ?? 0,
    tierMatches: counts.tierMatches ?? 0,
  };
}

/**
 * Why the stage reset cannot run yet, or `null` when it can.
 *
 * The stage reset is the one that discards the **seed order**, and that order is not
 * free-standing: round one is paired *from* it, so a bracket that still exists is a
 * bracket whose pairings only make sense against the seeding behind it. Clearing the
 * seeding while those rows survive leaves matches that still play and can no longer
 * explain why anyone faced anyone — the hazard `20260917090000` closed for a hand
 * reorder, one step further on.
 *
 * So the order goes only once nothing depends on it. The host clears the schedule first,
 * which keeps the seeding, and this becomes available afterwards. That two-step is the
 * gate; the same refusal is enforced in the RPC, because the button is not the only
 * caller — see `20260926010000_placement_stage_reset_gate.sql`.
 *
 * It takes the same count shape the resets return, so the reason can name exactly what
 * is still outstanding rather than saying "the schedule is not empty".
 */
export function stageResetBlockedBy(schedule: PlacementScheduleReset): string | null {
  const parts = resetCountParts(schedule);
  if (!parts.length) return null;
  return (
    `${parts.join(", ")} still on the schedule. The seed order cannot be discarded while a ` +
    `bracket paired from it is still there, so use the Reset panel on the Schedule tab first ` +
    `— that clears the schedule and keeps the seeding, and this reset is available once it has.`
  );
}

/** One line describing what a schedule reset discarded, for the confirmation toast. */
export function scheduleResetNote(reset: PlacementScheduleReset): string {
  const parts = resetCountParts(reset);
  if (!parts.length) return "Nothing had been played yet — the seed order is intact.";
  return `Removed ${parts.join(", ")}. The seed order and waivers are kept.`;
}

/**
 * Discards the entire placement stage: every match, every draw, every result and the
 * whole schedule, back to a registered field with nothing played.
 *
 * The seed order and the waived flags go with it, so this returns the stage to
 * exactly the state it is in after entrants are synced — the next action is
 * "Shuffle & lock seeds". It is the reset the **Placement** tab offers, because that
 * is the tab that owns the seed order. Admin-only and irreversible; the caller is
 * expected to have confirmed with the desk first.
 *
 * It refuses while the schedule still holds anything paired from that order — see
 * `stageResetBlockedBy`, which is the same gate the UI reads before offering the button.
 */
export async function resetPlacementStage(tournamentId: string): Promise<PlacementStageReset> {
  const { data, error } = await supabase.rpc(
    "reset_placement_stage" as never,
    {
      p_tournament_id: tournamentId,
    } as never,
  );
  if (error) throw new Error(error.message);
  const counts = (data ?? {}) as Partial<PlacementStageReset>;
  return {
    placementMatches: counts.placementMatches ?? 0,
    tierDraws: counts.tierDraws ?? 0,
    tierMatches: counts.tierMatches ?? 0,
    entrants: counts.entrants ?? 0,
  };
}

/** One line describing what a stage reset discarded, for the confirmation toast. */
export function stageResetNote(reset: PlacementStageReset): string {
  const parts = resetCountParts(reset);
  if (!parts.length) return "Nothing had been played yet — the seeds were unlocked.";
  return `Removed ${parts.join(", ")}. Seeds and waivers cleared.`;
}

// ---------------------------------------------------------------------------
// Derived display helpers
// ---------------------------------------------------------------------------

/** The entrant's tier, or a dash while the stage is undecided. */
export function tierLabel(outcome: EntrantPlacementOutcome | undefined): string {
  if (!outcome) return "—";
  return outcome.tier ?? "—";
}

/**
 * Why a tier's bracket has the shape it does, for the desk to read at a glance.
 * A bye in a knockout is a reward, so the phrasing says so rather than leaving
 * the host to infer it from an empty slot.
 */
export function bracketNote(draw: TierDraw): string {
  const byes = draw.bracket_size - draw.entrant_count;
  if (draw.entrant_count === 1) return "Sole entrant — champion, no bracket played.";
  const parts = [`${draw.entrant_count} entrants`];
  if (byes > 0) parts.push(`${byes} bye${byes === 1 ? "" : "s"} to the top seeds`);
  parts.push(`bracket of ${draw.bracket_size}`);
  return parts.join(", ");
}

/** True when a tier draw has a champion, whether by bye or by winning the final. */
export function tierIsDecided(draw: TierDraw | undefined): boolean {
  return !!draw?.champion_id;
}

/** Group the tier-draw matches by draw, then round, which is how a bracket reads. */
export function bracketRounds(matches: readonly TierDrawMatch[]): Map<number, TierDrawMatch[]> {
  const byRound = new Map<number, TierDrawMatch[]>();
  for (const match of matches) {
    const list = byRound.get(match.round) ?? [];
    list.push(match);
    byRound.set(match.round, list);
  }
  for (const list of byRound.values()) list.sort((a, b) => a.slot - b.slot);
  return byRound;
}
