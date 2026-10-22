/**
 * Scoring rules, presets and duration suggestions.
 *
 * A scoring rule describes how a match is won; it is deliberately separate from
 * how long the match is scheduled for. The host picks a rule (or a preset) and
 * the system *suggests* a slot duration, which the host can always override.
 *
 * `gamesTo` and `winBy` mirror the database rule used by `report_draw_result`:
 * a game is won by reaching at least `gamesTo` with a margin of at least
 * `winBy`. `bestOf` decides how many games a side must win to take the match.
 */

export interface ScoringRule {
  /** Minimum points to win a game (at least this many, with the required margin). */
  gamesTo: number;
  /** Minimum winning margin, so a deuce can run past `gamesTo`. */
  winBy: number;
  /** Total games in the match; odd, so a side needs a majority. */
  bestOf: number;
}

export interface ScoringPreset extends ScoringRule {
  id: string;
  label: string;
  /** Slot duration this scoring choice suggests, in minutes. */
  suggestedMinutes: number;
  /**
   * True for the built-in "custom" entry, which exists so the host can express
   * a rule that is not one of the common presets.
   */
  custom?: boolean;
}

export const BEST_OF_OPTIONS = [1, 3, 5, 7, 9] as const;

export const SCORING_PRESETS: ScoringPreset[] = [
  {
    id: "single-21",
    label: "Single game to 21",
    gamesTo: 21,
    winBy: 2,
    bestOf: 1,
    suggestedMinutes: 20,
  },
  {
    id: "best-of-3-21",
    label: "Best of 3 to 21",
    gamesTo: 21,
    winBy: 2,
    bestOf: 3,
    suggestedMinutes: 45,
  },
  {
    id: "single-15",
    label: "Single game to 15",
    gamesTo: 15,
    winBy: 2,
    bestOf: 1,
    suggestedMinutes: 15,
  },
  {
    id: "best-of-3-15",
    label: "Best of 3 to 15",
    gamesTo: 15,
    winBy: 2,
    bestOf: 3,
    suggestedMinutes: 35,
  },
  {
    id: "single-11",
    label: "Single game to 11",
    gamesTo: 11,
    winBy: 2,
    bestOf: 1,
    suggestedMinutes: 12,
  },
  {
    id: "custom",
    label: "Custom",
    gamesTo: 21,
    winBy: 2,
    bestOf: 1,
    suggestedMinutes: 20,
    custom: true,
  },
];

export const CUSTOM_PRESET_ID = "custom";

/** Games a side must win to take a `bestOf` match. */
export function gamesNeededToWin(rule: ScoringRule): number {
  return Math.floor(rule.bestOf / 2) + 1;
}

export function isOddBestOf(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 9 && value % 2 === 1;
}

export function isScoringRuleValid(rule: ScoringRule): boolean {
  return (
    Number.isInteger(rule.gamesTo) &&
    rule.gamesTo >= 1 &&
    rule.gamesTo <= 99 &&
    Number.isInteger(rule.winBy) &&
    rule.winBy >= 1 &&
    rule.winBy <= 20 &&
    isOddBestOf(rule.bestOf)
  );
}

/**
 * The hard ceiling a game stops at, or null when the rule has none.
 *
 * Badminton ends a deuce at 30: from 20-20 a side must lead by two, but the first side to
 * reach 30 takes the game at 30-29. That is a property of the 21-point game, so it is
 * derived from the rule rather than stored as a fourth column: a tournament that plays to
 * 15 or 11 has no official cap, and `winBy: 1` has no deuce to end.
 *
 * It is derived on both sides of the wire - `game_point_cap` in the database answers the
 * same question - because a score the dialog accepts and the RPC refuses is worse than
 * either rule alone.
 */
export function gamePointCap(rule: ScoringRule): number | null {
  return rule.gamesTo === 21 && rule.winBy === 2 ? 30 : null;
}

/** The preset whose rule matches, or the custom preset when nothing matches. */
export function presetForRule(rule: ScoringRule): ScoringPreset {
  return (
    SCORING_PRESETS.find(
      (preset) =>
        !preset.custom &&
        preset.gamesTo === rule.gamesTo &&
        preset.winBy === rule.winBy &&
        preset.bestOf === rule.bestOf,
    ) ?? (SCORING_PRESETS.find((preset) => preset.custom) as ScoringPreset)
  );
}

/**
 * Suggests a slot duration for a rule. Best-of-N scales sub-linearly because
 * later games are shorter, and the result is rounded to a whole five minutes so
 * schedules stay on tidy boundaries.
 */
export function suggestedSlotMinutes(rule: ScoringRule): number {
  const base = SCORING_PRESETS.find(
    (preset) =>
      !preset.custom &&
      preset.gamesTo === rule.gamesTo &&
      preset.winBy === rule.winBy &&
      preset.bestOf === rule.bestOf,
  );
  if (base) return base.suggestedMinutes;
  return suggestedSlotMinutesForShape(rule);
}

function suggestedSlotMinutesForShape(rule: ScoringRule): number {
  // A game runs roughly to `gamesTo` points; 21 points is about 20 minutes.
  const perGame = Math.max(6, Math.round((rule.gamesTo / 21) * 20));
  // A best-of-N match typically needs about half the games in a full set.
  const gamesPlayed = gamesNeededToWin(rule) + 0.5;
  const total = perGame * gamesPlayed;
  return Math.max(5, Math.round(total / 5) * 5);
}

/** Human summary, e.g. "Best of 3 to 21, win by 2". */
export function scoringRuleLabel(rule: ScoringRule): string {
  const shape = rule.bestOf === 1 ? "Single game" : `Best of ${rule.bestOf}`;
  const margin = rule.winBy === 1 ? "" : `, win by ${rule.winBy}`;
  return `${shape} to ${rule.gamesTo}${margin}`;
}

/** Ruleset used when a tournament predates configurable scoring. */
export const DEFAULT_PLACEMENT_RULE: ScoringRule = {
  gamesTo: 21,
  winBy: 2,
  bestOf: 1,
};

export const DEFAULT_KNOCKOUT_RULE: ScoringRule = {
  gamesTo: 21,
  winBy: 2,
  bestOf: 3,
};

/**
 * The rule the app used before scoring became configurable: group matches were a
 * single game to 21 and knockouts were best of three. Kept so the legacy
 * round-robin surface and its callers keep their exact behaviour.
 */
export const LEGACY_KNOCKOUT_RULE: ScoringRule = { gamesTo: 21, winBy: 2, bestOf: 3 };
export const LEGACY_GAME_RULE: ScoringRule = { gamesTo: 21, winBy: 2, bestOf: 1 };

/**
 * Reads a tournament's configured rule for one stage.
 *
 * Falls back to the stage default when the stored values are not a usable rule —
 * which is what happens against a row written before scoring was configurable, and
 * against a database that has not had the creation-flow migration applied yet. A
 * missing or nonsensical rule must degrade to the old behaviour, never to a rule
 * that would reject every score the desk can enter.
 */
export function ruleForStage(
  tournament: {
    placement_games_to: number;
    placement_win_by: number;
    placement_best_of: number;
    knockout_games_to: number;
    knockout_win_by: number;
    knockout_best_of: number;
  },
  stage: "placement" | "knockout",
): ScoringRule {
  const fallback = stage === "knockout" ? DEFAULT_KNOCKOUT_RULE : DEFAULT_PLACEMENT_RULE;
  const rule =
    stage === "knockout"
      ? {
          gamesTo: tournament.knockout_games_to,
          winBy: tournament.knockout_win_by,
          bestOf: tournament.knockout_best_of,
        }
      : {
          gamesTo: tournament.placement_games_to,
          winBy: tournament.placement_win_by,
          bestOf: tournament.placement_best_of,
        };
  return isScoringRuleValid(rule) ? rule : fallback;
}
