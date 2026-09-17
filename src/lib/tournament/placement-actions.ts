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

/** Writes and freezes the seed order. */
export async function lockPlacementSeeds(
  categoryId: string,
  entrants: readonly PlacementEntrant[],
  random: RandomFn,
): Promise<AssignedSeed[]> {
  const assigned = planSeeds(entrants, random);
  const teamIds = teamIdByEntrant(entrants);
  const payload = assigned.map((entry) => {
    const teamId = teamIds.get(entry.id);
    if (!teamId) throw new Error("A seeded entrant has no team.");
    return { team_id: teamId, seed: entry.seed };
  });
  await rpc("lock_placement_seeds", { p_category_id: categoryId, p_seeds: payload });
  return assigned;
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
 * Refused before every round-one match is decided, which is the same condition
 * the database enforces. Checking here as well is what turns a failed request
 * into an immediate explanation.
 */
export async function generatePlacementRoundTwo(
  categoryId: string,
  entrants: readonly PlacementEntrant[],
  matches: readonly PlacementMatch[],
  force = false,
): Promise<number> {
  const active = entrants.filter((entrant) => !entrant.excluded);
  const roundOne = matches.filter((match) => match.stage === "round1");
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
 * Placement tab, so without this a build has nothing to schedule — and because
 * each stage only exists once the previous one is decided, "generate what is
 * missing, then schedule" is the same thing as "wait for round one, then round
 * two, then the knockouts". The database enforces that ordering, so this only
 * has to ask for the next thing rather than sequence anything itself.
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

    // `stage` already encodes the gate: it is `round1` until round one is settled,
    // then `round2`, and `draws` as soon as every entrant has their full record.
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

/** True when `generateMissingStages` created anything, so a refetch is needed. */
export function stageGenerationChanged(outcome: StageGenerationOutcome): boolean {
  const { roundOne, roundTwo, draws } = outcome.generated;
  return roundOne > 0 || roundTwo > 0 || draws > 0;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Reports a placement result. The database applies the tournament's placement rule.
 *
 * Returns the ripple the result caused. Reporting now reflows the rest of the day,
 * so a match that finished late pushes everything after it on that court — and the
 * desk should be told that happened rather than having to notice.
 */
export async function reportPlacementMatch(
  matchId: string,
  games: unknown,
  tournamentId: string,
): Promise<PlacementScheduleImpact> {
  const { impact } = await withPlacementScheduleImpact(tournamentId, () =>
    rpc("report_placement_result", { p_match_id: matchId, p_games: games }),
  );
  return impact;
}

/**
 * Reports a knockout result. The database applies the knockout rule, advances the
 * bracket and then reflows the day, so the next round may already exist and may
 * already have moved by the time this resolves.
 */
export async function reportTierDrawMatch(
  matchId: string,
  games: unknown,
  tournamentId: string,
): Promise<PlacementScheduleImpact> {
  const { impact } = await withPlacementScheduleImpact(tournamentId, () =>
    rpc("report_tier_draw_result", { p_match_id: matchId, p_games: games }),
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
  const count = `${impact.shiftedMatches} downstream match${
    impact.shiftedMatches === 1 ? "" : "es"
  }`;
  const distance = `by up to ${impact.largestShiftMinutes} min`;
  // A mixed reflow has no single direction, so none is claimed.
  if (impact.direction === "mixed") return `${count} moved, ${distance}`;
  return `${count} moved ${impact.direction}, ${distance}`;
}

export async function startPlacementMatch(matchId: string, courtId: string | null): Promise<void> {
  await rpc("start_placement_match", { p_match_id: matchId, p_court_id: courtId });
}

export async function startTierDrawMatch(matchId: string, courtId: string | null): Promise<void> {
  await rpc("start_tier_draw_match", { p_match_id: matchId, p_court_id: courtId });
}

/**
 * Clears a placement result.
 *
 * The database refuses this for a round-one match once round two exists, because
 * the make-up opponents were chosen from that winner. Surfacing it here means the
 * desk gets the explanation at the button rather than from a failed request.
 */
export async function resetPlacementResult(matchId: string): Promise<void> {
  await rpc("reset_placement_result", { p_match_id: matchId });
}

export async function resetTierDrawResult(matchId: string): Promise<void> {
  await rpc("reset_tier_draw_result", { p_match_id: matchId });
}

// ---------------------------------------------------------------------------
// The whole-stage reset
// ---------------------------------------------------------------------------

/** What a reset removed, so the desk can be told rather than left guessing. */
export interface PlacementStageReset {
  placementMatches: number;
  tierDraws: number;
  tierMatches: number;
  entrants: number;
}

/**
 * Discards the entire placement stage: every match, every draw, every result and
 * the whole schedule, back to a registered field with nothing played.
 *
 * The seed order and the waived flags go with it, so this returns the stage to
 * exactly the state it is in after entrants are synced — the next action is
 * "Shuffle & lock seeds". Admin-only and irreversible; the caller is expected to
 * have confirmed with the desk first.
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

/** One line describing what a reset discarded, for the confirmation toast. */
export function stageResetNote(reset: PlacementStageReset): string {
  const parts = [
    reset.placementMatches > 0
      ? `${reset.placementMatches} placement match${reset.placementMatches === 1 ? "" : "es"}`
      : null,
    reset.tierMatches > 0
      ? `${reset.tierMatches} knockout match${reset.tierMatches === 1 ? "" : "es"}`
      : null,
    reset.tierDraws > 0 ? `${reset.tierDraws} draw${reset.tierDraws === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
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
  return parts.join(" · ");
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
