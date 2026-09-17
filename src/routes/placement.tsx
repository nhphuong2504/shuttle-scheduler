import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell, EmptyState, Panel, StatusPill } from "@/components/app-shell";
import { GamesDialog } from "@/components/placement/GamesDialog";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { PLACEMENT_TIERS, entrantCountNote } from "@/lib/tournament/competition-format";
import {
  bracketNote,
  bracketRounds,
  buildCategoryView,
  generatePlacementRoundOne,
  generatePlacementRoundTwo,
  generateTierDraws,
  lockPlacementSeeds,
  reportPlacementMatch,
  reportTierDrawMatch,
  resetPlacementResult,
  resetTierDrawResult,
  setPlacementSkill,
  shuffleSeedFor,
  syncPlacementEntrants,
  type CategoryPlacementView,
} from "@/lib/tournament/placement-actions";
import {
  indexBy,
  teamLabel,
  useCategories,
  usePlacementEntrants,
  usePlacementMatches,
  usePlayers,
  useTeams,
  useTierDrawMatches,
  useTierDraws,
  useTournamentScope,
  type Category,
  type Player,
  type PlacementEntrant,
  type PlacementMatch,
  type Team,
  type TierDraw,
  type TierDrawMatch,
} from "@/lib/tournament/data";
import { gamesLabel, parseGames, type GameScore } from "@/lib/tournament/format";
import { mulberry32 } from "@/lib/tournament/rng";
import { ruleForStage, type ScoringRule } from "@/lib/tournament/scoring";

export const Route = createFileRoute("/placement")({
  head: () => ({
    meta: [
      { title: "Placement & Draws | ShuttleNet Tournament Ops" },
      {
        name: "description",
        content:
          "Run the two placement rounds, then the A/B/C/D knockout draws. Every entrant plays two placement matches before the brackets are drawn.",
      },
      { property: "og:title", content: "Placement & Draws | ShuttleNet Tournament Ops" },
      {
        property: "og:description",
        content:
          "Run the two placement rounds, then the A/B/C/D knockout draws. Every entrant plays two placement matches before the brackets are drawn.",
      },
    ],
  }),
  component: PlacementPage,
});

/**
 * The one screen that runs the two-round placement format end to end: seeds,
 * round one, round two, then the four knockout draws.
 *
 * It is a separate route from `/pools` and `/draws` because this format has its
 * own tables. Reusing those pages would have meant a page that has to know which
 * format it is looking at, which is exactly the coupling the separate tables were
 * meant to avoid.
 */

interface ScoringRequest {
  kind: "placement" | "knockout";
  matchId: string;
  title: string;
  labels: [string, string];
  rule: ScoringRule;
  initial: GameScore[] | undefined;
}

function PlacementPage() {
  const qc = useQueryClient();
  const { canEditPlacementEntrants, canGeneratePlacement, canScorePlacement } = useSession();
  const { tournament } = useTournamentScope();
  const { data: categories } = useCategories();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: entrants } = usePlacementEntrants();
  const { data: matches } = usePlacementMatches();
  const { data: draws } = useTierDraws();
  const { data: tierMatches } = useTierDrawMatches();
  const [scoring, setScoring] = useState<ScoringRequest | null>(null);

  const playerMap = useMemo(() => indexBy(players), [players]);
  const teamMap = useMemo(() => indexBy(teams), [teams]);

  const placementRule = tournament ? ruleForStage(tournament, "placement") : null;
  const knockoutRule = tournament ? ruleForStage(tournament, "knockout") : null;

  const refresh = () => qc.invalidateQueries();

  const live = (categories ?? []).filter((category) => category.active);
  const wrongFormat = tournament != null && tournament.format !== "two_round_placement";

  return (
    <AppShell
      title="Placement & draws"
      subtitle="Every entrant plays two placement matches. The two results sort them into Draw A (WW), B (WL), C (LW) or D (LL)."
    >
      {wrongFormat ? (
        <div className="mb-4 rounded-lg border border-warn-border bg-warn-surface px-3 py-2 text-xs font-medium text-warn-foreground">
          This tournament's stored format is{" "}
          <span className="font-score">{tournament?.format}</span>, not two-round placement. The
          tables below are the placement format's own and will stay empty for a round-robin event.
        </div>
      ) : null}

      <div className="space-y-8">
        {live.length === 0 ? (
          <Panel>
            <EmptyState
              title="No active events"
              hint="Activate a tournament and enable its events before running the placement stage."
            />
          </Panel>
        ) : null}

        {live.map((category) => (
          <CategorySection
            key={category.id}
            category={category}
            teams={(teams ?? []).filter((team) => team.category_id === category.id)}
            playerMap={playerMap}
            entrants={(entrants ?? []).filter((entrant) => entrant.category_id === category.id)}
            matches={(matches ?? []).filter((match) => match.category_id === category.id)}
            draws={(draws ?? []).filter((draw) => draw.category_id === category.id)}
            tierMatches={tierMatches ?? []}
            canEdit={canEditPlacementEntrants}
            canGenerate={canGeneratePlacement}
            canScore={canScorePlacement}
            placementRule={placementRule}
            knockoutRule={knockoutRule}
            onRefresh={refresh}
            onScore={setScoring}
          />
        ))}
      </div>

      {scoring ? (
        <GamesDialog
          open
          onOpenChange={(open) => !open && setScoring(null)}
          title={scoring.title}
          sideLabels={scoring.labels}
          rule={scoring.rule}
          initialGames={scoring.initial}
          onSubmit={async (games) => {
            if (scoring.kind === "placement") await reportPlacementMatch(scoring.matchId, games);
            else await reportTierDrawMatch(scoring.matchId, games);
            toast.success("Result saved");
            refresh();
          }}
        />
      ) : null}
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// One category
// ---------------------------------------------------------------------------

/**
 * A stage's panel: a title, a one-line explanation of the rule in play, and a
 * count of what is decided. The explanation lives here rather than in a tooltip
 * because the make-up and crossover rules are the parts of this format a host
 * actually needs told while standing at the desk.
 */
function StagePanel({
  title,
  hint,
  meta,
  children,
}: {
  title: string;
  hint: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <Panel
      title={title}
      right={
        meta ? <span className="font-score text-[11px] text-muted-foreground">{meta}</span> : null
      }
    >
      <p className="mb-3 text-xs text-muted-foreground">{hint}</p>
      {children}
    </Panel>
  );
}

function CategorySection({
  category,
  teams,
  playerMap,
  entrants,
  matches,
  draws,
  tierMatches,
  canEdit,
  canGenerate,
  canScore,
  placementRule,
  knockoutRule,
  onRefresh,
  onScore,
}: {
  category: Category;
  teams: Team[];
  playerMap: Map<string, Player>;
  entrants: PlacementEntrant[];
  matches: PlacementMatch[];
  draws: TierDraw[];
  tierMatches: TierDrawMatch[];
  canEdit: boolean;
  canGenerate: boolean;
  canScore: boolean;
  placementRule: ScoringRule | null;
  knockoutRule: ScoringRule | null;
  onRefresh: () => void;
  onScore: (request: ScoringRequest) => void;
}) {
  const view = useMemo(() => buildCategoryView(entrants, matches), [entrants, matches]);
  // `tierMatches` arrives unfiltered, so scope it through this category's draws.
  // The draws themselves are already category-filtered, which is what keeps a
  // tier match from another category out of this bracket.
  const drawIds = useMemo(() => new Set(draws.map((draw) => draw.id)), [draws]);
  const categoryTierMatches = useMemo(
    () => tierMatches.filter((match) => drawIds.has(match.draw_id)),
    [tierMatches, drawIds],
  );
  const activeTeams = teams.filter((team) => !team.withdrawn);
  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const label = (teamId: string | null | undefined) =>
    teamId ? teamLabel(teamMap.get(teamId), playerMap) : "TBC";

  // The placement stage holds an odd entrant, so this is informational, never a
  // blocker. See `entrantCountNote`.
  const oddNote = entrantCountNote(view.active.length);

  const roundOneDecided = view.roundOne.filter(
    (match) => match.status === "reported" || match.status === "walkover",
  ).length;

  async function run(work: () => Promise<unknown>, success: string) {
    try {
      await work();
      toast.success(success);
      onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That action failed.");
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-bold">
          {category.code} — {category.name}
          <span className="ml-2 font-score text-xs font-normal text-muted-foreground">
            {view.active.length} entrants · {view.matches.length} matches · {stageLabel(view.stage)}
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                run(() => syncPlacementEntrants(category.id), `${category.code} entrants synced`)
              }
            >
              Sync entrants
            </Button>
          ) : null}
        </div>
      </div>

      {oddNote ? (
        <p className="rounded-md border border-hairline bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {oddNote}
        </p>
      ) : null}

      {view.active.length === 0 ? (
        <Panel>
          <EmptyState
            title="No entrants yet"
            hint={
              activeTeams.length === 0
                ? "Register teams for this event first."
                : `${activeTeams.length} team(s) registered. Sync entrants to bring them into the placement stage.`
            }
          />
        </Panel>
      ) : (
        <>
          <SeedingPanel
            category={category}
            view={view}
            label={label}
            canEdit={canEdit}
            onRefresh={onRefresh}
          />

          <StagePanel
            title="Round one"
            hint="Seeds are split in half and paired across the split, so the halves meet at their boundary rather than the strongest meeting the weakest."
            meta={`${roundOneDecided}/${view.roundOne.length} decided`}
          >
            {!view.seedsLocked ? (
              <p className="text-xs text-muted-foreground">
                Lock the seed order first — round one pairs from it.
              </p>
            ) : !view.roundOneExpected ? (
              <p className="text-xs text-muted-foreground">
                Not applicable. A field of one plays no matches at all — the sole entrant is the
                champion of Draw A.
              </p>
            ) : view.roundOne.length === 0 ? (
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  disabled={!canGenerate}
                  onClick={() =>
                    run(
                      () => generatePlacementRoundOne(category.id, entrants),
                      `${category.code} round one generated`,
                    )
                  }
                >
                  Generate round one
                </Button>
                <span className="text-xs text-muted-foreground">
                  {view.heldEntrantId
                    ? "One entrant will be held out of round one and play both matches in round two."
                    : "Every entrant is paired."}
                </span>
              </div>
            ) : (
              <MatchList
                matches={view.roundOne}
                label={label}
                canScore={canScore}
                onScore={(match) =>
                  onScore({
                    kind: "placement",
                    matchId: match.id,
                    title: `${label(match.entrant_a_id)} vs ${label(match.entrant_b_id)}`,
                    labels: [label(match.entrant_a_id), label(match.entrant_b_id)],
                    rule: placementRule as ScoringRule,
                    initial: match.status === "reported" ? parseGames(match.games) : undefined,
                  })
                }
                onReset={(match) => run(() => resetPlacementResult(match.id), "Result cleared")}
                canReset={canScore}
                readOnly={!placementRule}
              />
            )}
          </StagePanel>

          <StagePanel
            title="Round two"
            hint={
              view.heldEntrantId
                ? "Winners meet winners and losers meet losers. The held entrant plays one winner and one loser as make-up matches."
                : "Winners meet winners and losers meet losers."
            }
            meta={`${view.roundTwo.length} match${view.roundTwo.length === 1 ? "" : "es"}`}
          >
            {!view.seedsLocked ? (
              <p className="text-xs text-muted-foreground">Waiting on the seed order.</p>
            ) : !view.roundTwoExpected ? (
              <p className="text-xs text-muted-foreground">
                {view.active.length === 1
                  ? "Not applicable. A field of one needs no placement matches."
                  : "Not applicable. A field of two plays one match, then the winner takes Draw A and the loser Draw D."}
              </p>
            ) : view.roundOne.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Generate round one first — its results decide who plays whom here.
              </p>
            ) : roundOneDecided < view.roundOne.length ? (
              <p className="text-xs text-muted-foreground">
                Round two needs every round one result first —{" "}
                {view.roundOne.length - roundOneDecided} still to play.
              </p>
            ) : view.roundTwo.length === 0 ? (
              <Button
                size="sm"
                disabled={!canGenerate}
                onClick={() =>
                  run(
                    () => generatePlacementRoundTwo(category.id, entrants, matches),
                    `${category.code} round two generated`,
                  )
                }
              >
                Generate round two
              </Button>
            ) : (
              <MatchList
                matches={view.roundTwo}
                label={label}
                canScore={canScore}
                onScore={(match) =>
                  onScore({
                    kind: "placement",
                    matchId: match.id,
                    title: `${label(match.entrant_a_id)} vs ${label(match.entrant_b_id)}`,
                    labels: [label(match.entrant_a_id), label(match.entrant_b_id)],
                    rule: placementRule as ScoringRule,
                    initial: match.status === "reported" ? parseGames(match.games) : undefined,
                  })
                }
                onReset={(match) => run(() => resetPlacementResult(match.id), "Result cleared")}
                canReset={canScore}
                readOnly={!placementRule}
              />
            )}
          </StagePanel>

          <DrawsPanel
            category={category}
            view={view}
            entrants={entrants}
            matches={matches}
            draws={draws}
            tierMatches={categoryTierMatches}
            label={label}
            canGenerate={canGenerate}
            canScore={canScore}
            knockoutRule={knockoutRule}
            onRefresh={onRefresh}
            onScore={onScore}
          />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function SeedingPanel({
  category,
  view,
  label,
  canEdit,
  onRefresh,
}: {
  category: Category;
  view: CategoryPlacementView;
  label: (teamId: string | null | undefined) => string;
  canEdit: boolean;
  onRefresh: () => void;
}) {
  const counts = { advanced: 0, intermediate: 0, beginner: 0 };
  for (const entrant of view.active) {
    const level = entrant.skill_level as keyof typeof counts;
    if (level in counts) counts[level]++;
  }

  const hasMatches = view.matches.length > 0;

  return (
    <Panel
      title="Seeding"
      right={
        <span className="font-score text-[11px] text-muted-foreground">
          {view.seedsLocked ? "locked" : "not locked"}
        </span>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Skill level decides the seed order once: entrants are grouped by the block they reported,
          shuffled inside it, and seeded strongest block first. Every pairing rule after this reads
          the seed only.
        </p>

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-12">Seed</th>
                <th>Entrant</th>
                <th>Skill</th>
                <th className="text-right">Matches</th>
                <th>Tier</th>
              </tr>
            </thead>
            <tbody>
              {view.outcomes
                .slice()
                .sort((a, b) => {
                  if (a.seed === 0 || b.seed === 0) return a.seed === 0 ? 1 : -1;
                  return a.seed - b.seed;
                })
                .map((outcome) => {
                  const entrant = view.active.find((e) => e.id === outcome.entrantId);
                  if (!entrant) return null;
                  return (
                    <tr key={entrant.id}>
                      <td className="font-score text-xs font-semibold text-primary">
                        {entrant.seed ?? "—"}
                      </td>
                      <td className="pr-2 font-medium">{label(entrant.team_id)}</td>
                      <td>
                        {canEdit && !view.seedsLocked ? (
                          <select
                            className="h-7 rounded-md border border-hairline bg-surface px-2 text-xs"
                            value={entrant.skill_level}
                            onChange={async (event) => {
                              try {
                                await setPlacementSkill(
                                  category.id,
                                  entrant.team_id,
                                  event.target.value,
                                );
                                onRefresh();
                              } catch (error) {
                                toast.error(
                                  error instanceof Error ? error.message : "Could not set skill",
                                );
                              }
                            }}
                          >
                            <option value="advanced">Advanced</option>
                            <option value="intermediate">Intermediate</option>
                            <option value="beginner">Beginner</option>
                          </select>
                        ) : (
                          <span className="text-xs capitalize">{entrant.skill_level}</span>
                        )}
                      </td>
                      <td className="text-right font-score text-xs">
                        {outcome.played}/{view.requiredMatches}
                      </td>
                      <td className="font-score text-xs">{outcome.tier ?? "—"}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Blocks: {counts.advanced} advanced · {counts.intermediate} intermediate ·{" "}
          {counts.beginner} beginner
          {view.excluded.length > 0 ? ` · ${view.excluded.length} waived` : ""}
        </p>

        {canEdit ? (
          <Button
            size="sm"
            variant={view.seedsLocked ? "outline" : "default"}
            disabled={hasMatches}
            onClick={async () => {
              try {
                if (view.seedsLocked && !window.confirm("Re-shuffle and re-lock the seed order?")) {
                  return;
                }
                await lockPlacementSeeds(
                  category.id,
                  view.active,
                  mulberry32(shuffleSeedFor(category.id)),
                );
                toast.success(`${category.code} seeds locked`);
                onRefresh();
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Could not lock seeds");
              }
            }}
          >
            {view.seedsLocked ? "Re-shuffle seeds" : "Shuffle & lock seeds"}
          </Button>
        ) : null}
        {hasMatches && canEdit ? (
          <p className="text-[11px] text-muted-foreground">
            Seeding is frozen because placement matches already exist. Regenerate them to change the
            order.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Match lists
// ---------------------------------------------------------------------------

function MatchList({
  matches,
  label,
  canScore,
  canReset,
  onScore,
  onReset,
  readOnly,
}: {
  matches: PlacementMatch[];
  label: (teamId: string | null | undefined) => string;
  canScore: boolean;
  canReset: boolean;
  onScore: (match: PlacementMatch) => void;
  onReset: (match: PlacementMatch) => void;
  readOnly: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th className="w-20">Match</th>
            <th>Entrants</th>
            <th>Type</th>
            <th>Score</th>
            <th>Status</th>
            <th className="text-right" />
          </tr>
        </thead>
        <tbody>
          {matches.map((match) => {
            const decided = match.status === "reported" || match.status === "walkover";
            return (
              <tr key={match.id}>
                <td className="font-score text-xs text-muted-foreground">{match.generation_key}</td>
                <td className="pr-2 font-medium">
                  {label(match.entrant_a_id)}
                  <span className="mx-1.5 text-muted-foreground">vs</span>
                  {label(match.entrant_b_id)}
                  {match.winner_id ? (
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      → {label(match.winner_id)}
                    </span>
                  ) : null}
                </td>
                <td className="text-[11px] text-muted-foreground">
                  {match.is_makeup ? "Make-up" : match.is_crossover ? "Crossover" : "—"}
                </td>
                <td className="font-score text-xs">
                  {decided ? gamesLabel(parseGames(match.games)) : "—"}
                </td>
                <td>
                  <StatusPill status={match.status} />
                </td>
                <td className="pl-2 text-right">
                  {readOnly ? null : decided ? (
                    canReset ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (window.confirm("Clear this result so it can be re-entered?")) {
                            onReset(match);
                          }
                        }}
                      >
                        Reset
                      </Button>
                    ) : null
                  ) : canScore ? (
                    <Button size="sm" variant="outline" onClick={() => onScore(match)}>
                      Enter score
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tier draws
// ---------------------------------------------------------------------------

function DrawsPanel({
  category,
  view,
  entrants,
  matches,
  draws,
  tierMatches,
  label,
  canGenerate,
  canScore,
  knockoutRule,
  onRefresh,
  onScore,
}: {
  category: Category;
  view: CategoryPlacementView;
  entrants: PlacementEntrant[];
  matches: PlacementMatch[];
  draws: TierDraw[];
  tierMatches: TierDrawMatch[];
  label: (teamId: string | null | undefined) => string;
  canGenerate: boolean;
  canScore: boolean;
  knockoutRule: ScoringRule | null;
  onRefresh: () => void;
  onScore: (request: ScoringRequest) => void;
}) {
  const short = view.gate.short.length;
  const hasDraws = draws.length > 0;

  return (
    <Panel
      title="Tier draws"
      right={
        <span className="font-score text-[11px] text-muted-foreground">
          {hasDraws ? "drawn" : view.gate.ready ? "ready" : `${short} short`}
        </span>
      }
    >
      <div className="space-y-4">
        {!hasDraws ? (
          <>
            <p className="text-xs text-muted-foreground">
              Draws open once every entrant has completed{" "}
              {view.gate.requiredMatches === 0
                ? "the placement stage"
                : `${view.gate.requiredMatches} decided placement match${view.gate.requiredMatches === 1 ? "" : "es"}`}
              . WW goes to Draw A, WL to B, LW to C, LL to D.
            </p>
            {short > 0 ? (
              <p className="rounded-md border border-hairline bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                Waiting on {short} entrant{short === 1 ? "" : "s"}. A waived entrant is skipped
                rather than blocking the category.
              </p>
            ) : null}
            <Button
              size="sm"
              disabled={!canGenerate || !view.gate.ready}
              onClick={async () => {
                try {
                  await generateTierDraws(category.id, entrants, matches, hasDraws);
                  toast.success(`${category.code} draws generated`);
                  onRefresh();
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Could not generate draws");
                }
              }}
            >
              Generate A/B/C/D draws
            </Button>
          </>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {PLACEMENT_TIERS.map((tierMapping) => {
              const draw = draws.find((entry) => entry.tier === tierMapping.tier);
              const rounds = draw
                ? bracketRounds(tierMatches.filter((match) => match.draw_id === draw.id))
                : new Map<number, TierDrawMatch[]>();

              return (
                <Panel
                  key={tierMapping.tier}
                  title={`${tierMapping.label} · ${tierMapping.title}`}
                  right={
                    <span className="font-score text-[10px] text-muted-foreground">
                      {tierMapping.record}
                    </span>
                  }
                >
                  {!draw ? (
                    <p className="text-xs text-muted-foreground">No entrants in this tier.</p>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-[11px] text-muted-foreground">{bracketNote(draw)}</p>

                      {draw.champion_id ? (
                        <p className="rounded-md border border-hairline bg-mint/10 px-3 py-2 text-xs font-semibold">
                          Champion: {label(draw.champion_id)}
                        </p>
                      ) : null}

                      {[...rounds.entries()].map(([round, roundMatches]) => (
                        <div key={round} className="space-y-1">
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {roundName(round, rounds.size)}
                          </p>
                          {roundMatches.map((match) => (
                            <TierMatchRow
                              key={match.id}
                              match={match}
                              label={label}
                              canScore={canScore}
                              onScore={() =>
                                onScore({
                                  kind: "knockout",
                                  matchId: match.id,
                                  title: `${label(match.entrant_a_id)} vs ${label(match.entrant_b_id)}`,
                                  labels: [label(match.entrant_a_id), label(match.entrant_b_id)],
                                  rule: knockoutRule as ScoringRule,
                                  initial:
                                    match.status === "reported"
                                      ? parseGames(match.games)
                                      : undefined,
                                })
                              }
                              onReset={async () => {
                                try {
                                  await resetTierDrawResult(match.id);
                                  toast.success("Result cleared");
                                  onRefresh();
                                } catch (error) {
                                  toast.error(
                                    error instanceof Error ? error.message : "Could not reset",
                                  );
                                }
                              }}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>
              );
            })}
          </div>
        )}

        {hasDraws ? (
          <>
            <p className="text-[11px] text-muted-foreground">
              Regenerating is only possible before any draw match has been played.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={!canGenerate}
              onClick={async () => {
                if (
                  !window.confirm(
                    "Regenerate the A/B/C/D draws? Any unplayed draw matches are replaced.",
                  )
                ) {
                  return;
                }
                try {
                  await generateTierDraws(category.id, entrants, matches, true);
                  toast.success(`${category.code} draws regenerated`);
                  onRefresh();
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Could not regenerate");
                }
              }}
            >
              Regenerate draws
            </Button>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function TierMatchRow({
  match,
  label,
  canScore,
  onScore,
  onReset,
}: {
  match: TierDrawMatch;
  label: (teamId: string | null | undefined) => string;
  canScore: boolean;
  onScore: () => void;
  onReset: () => void;
}) {
  const decided = match.status === "reported" || match.status === "walkover";
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-hairline px-2 py-1.5">
      <div className="min-w-0 text-xs">
        <span className="font-medium">{label(match.entrant_a_id)}</span>
        <span className="mx-1.5 text-muted-foreground">vs</span>
        <span className="font-medium">{label(match.entrant_b_id)}</span>
        {match.is_bye ? (
          <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            bye
          </span>
        ) : decided ? (
          <span className="ml-2 font-score text-[11px] text-muted-foreground">
            {gamesLabel(parseGames(match.games))}
          </span>
        ) : null}
      </div>
      {match.is_bye ? null : decided ? (
        canScore ? (
          <button
            className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-primary"
            onClick={() => {
              if (window.confirm("Clear this result?")) onReset();
            }}
          >
            reset
          </button>
        ) : null
      ) : canScore ? (
        <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={onScore}>
          Score
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small display helpers
// ---------------------------------------------------------------------------

function stageLabel(stage: CategoryPlacementView["stage"]): string {
  switch (stage) {
    case "seeding":
      return "seeding";
    case "round1":
      return "round one";
    case "round2":
      return "round two";
    case "draws":
      return "draws";
    default:
      return "seeding";
  }
}

/** "Final", "Semi-final", "Quarter-final", then "Round of N" for big brackets. */
function roundName(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semi-final";
  if (fromEnd === 2) return "Quarter-final";
  return `Round of ${2 ** (fromEnd + 1)}`;
}
