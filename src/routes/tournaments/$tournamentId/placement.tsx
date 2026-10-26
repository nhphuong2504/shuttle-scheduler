import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Page, EmptyState, Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { InfoNote } from "@/components/ui/info-note";
import { compareEventOrder } from "@/lib/tournament/event-order";
import {
  buildCategoryView,
  lockPlacementSeeds,
  resetPlacementStage,
  savePlacementSeedOrder,
  setPlacementSkill,
  shuffleSeedFor,
  stageResetBlockedBy,
  stageResetNote,
  syncPlacementEntrants,
  type CategoryPlacementView,
} from "@/lib/tournament/placement-actions";
import {
  SKILL_LABELS,
  SKILL_LEVELS,
  followsSkillBlocks,
  isSkillLevel,
} from "@/lib/tournament/placement-seed";
import {
  indexBy,
  teamLabel,
  useCategories,
  useScopedAccess,
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
} from "@/lib/tournament/data";
import { mulberry32 } from "@/lib/tournament/rng";
import { PlacementTierLegend } from "@/components/placement-tier-legend";

export const Route = createFileRoute("/tournaments/$tournamentId/placement")({
  head: () => ({
    meta: [
      { title: "Placement | Tournova Tournament Ops" },
      {
        name: "description",
        content:
          "Set the seed order for a two-round placement tournament and see which Draw A, B, C or D tier each entrant has sorted into. Results are entered on the Scores page.",
      },
      { property: "og:title", content: "Placement | Tournova Tournament Ops" },
      {
        property: "og:description",
        content:
          "Set the seed order for a two-round placement tournament and see which Draw A, B, C or D tier each entrant has sorted into. Results are entered on the Scores page.",
      },
    ],
  }),
  component: PlacementPage,
});

/**
 * Seeding for the two-round placement format: the seed order, the skill blocks it
 * comes from, and the Draw A/B/C/D tier each entrant has been sorted into.
 *
 * It is a separate route from `/pools` and `/draws` because this format has its own
 * tables. It deliberately does not list matches — the two rounds and the four
 * brackets are all scored on `/matches`, so a match list here was a second copy of
 * the same table with a second set of score buttons.
 */

function PlacementPage() {
  const qc = useQueryClient();
  const { tournament } = useTournamentScope();
  // One edit right, not two: the former `canEditPlacementEntrants` and the
  // tournament-admin reset are both `can_edit_tournament` in the database.
  const access = useScopedAccess();
  const canEdit = access.can_edit;
  const { data: categories } = useCategories();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: entrants } = usePlacementEntrants();
  const { data: matches } = usePlacementMatches();
  const { data: draws } = useTierDraws();
  const { data: tierMatches } = useTierDrawMatches();

  const playerMap = useMemo(() => indexBy(players), [players]);
  const teamMap = useMemo(() => indexBy(teams), [teams]);

  const refresh = () => qc.invalidateQueries();

  /**
   * The active events, in the standard order rather than the order they were added.
   *
   * `sort_order` is the order the toggles were pressed, which is a fact about how the
   * tournament was set up, not about the tournament: a field entered WS before MS would
   * otherwise list Women's Singles first here and nowhere else. See `compareEventOrder`.
   */
  const live = (categories ?? [])
    .filter((category) => category.active)
    .sort(compareEventOrder);
  const wrongFormat = tournament != null && tournament.format !== "two_round_placement";

  /**
   * Whether the stage reset is available yet, and if not, what is holding it.
   *
   * It reads the same three tables the Schedule tab's reset clears, so "the schedule is
   * clear" means the same thing on both sides. The gate itself is `stageResetBlockedBy`;
   * the RPC enforces the identical refusal, because a session can call it directly.
   */
  const resetBlocked = stageResetBlockedBy({
    placementMatches: (matches ?? []).length,
    tierDraws: (draws ?? []).length,
    tierMatches: (tierMatches ?? []).length,
  });

  /** Whether the reset is in flight, so the header button cannot be pressed twice. */
  const [resetting, setResetting] = useState(false);

  /**
   * Discards the whole placement stage and returns it to a registered field.
   *
   * This is the reset that clears the seed order, and it belongs on this tab because
   * this is the tab that owns the seed order — "Shuffle & lock seeds" is here. The
   * Schedule tab's reset deliberately does not clear the seeding: it discards the
   * matches, draws and results and leaves the order alone, so rebuilding a schedule
   * cannot quietly destroy an order set by hand.
   *
   * It is available only once that schedule is gone, for the reason `stageResetBlockedBy`
   * states: the seeding is what round one was paired from, so discarding it while the
   * bracket survives would leave matches that cannot explain their own pairings. The
   * order is therefore always: clear the schedule, then clear the seeding. Admin-only and
   * irreversible, hence the explicit confirmation that names what it destroys.
   */
  const resetStage = async () => {
    if (!tournament || resetBlocked) return;
    const confirmed = window.confirm(
      "Clear the seed order and start the placement stage over?\n\n" +
        "This clears the seed order and any waivers, so every event goes back to a registered " +
        "field ready to shuffle and lock seeds again, and every result and scheduled time goes " +
        "with them. The schedule is already clear: the Schedule tab's reset clears the matches " +
        "and draws and keeps the seed order, and this is the step after it that drops the order " +
        "too. It cannot be undone.",
    );
    if (!confirmed) return;

    setResetting(true);
    try {
      const reset = await resetPlacementStage(tournament.id);
      refresh();
      toast.success(stageResetNote(reset));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reset the placement stage");
    } finally {
      setResetting(false);
    }
  };

  /**
   * The stage reset, as the page's only header action.
   *
   * It is one action, not a section, so it is a header button rather than a panel: a card
   * wrapping a single button spent a title, a toggle and a paragraph of copy on it, and
   * the panel sat below the events it discards. The confirmation carries the detail now
   * that the surrounding copy is gone.
   *
   * The destructive variant, not the outline the Scores link uses: the design system
   * reserves a saturated slot for "a destructive action when one is present", and this is
   * that action on this page. Faded to 50% when the gate is closed, which reads as
   * unavailable rather than as merely quiet.
   *
   * The refusal is carried on the control twice, and it has to be twice. A disabled button
   * cannot show a `title` of its own — `Button` sets `disabled:pointer-events-none` — so
   * the wrapper span holds the hover for a mouse; and `sr-only` text is still laid out, so
   * a hidden span beside it is measured as clipped by the layout matrix, which leaves
   * `aria-description` as the way to get the same sentence to an assistive technology.
   */
  const resetAction = canEdit ? (
    <span title={resetBlocked ?? undefined} className="inline-flex">
      <Button
        variant="destructive"
        size="sm"
        disabled={resetting || !tournament || resetBlocked != null}
        aria-description={resetBlocked ?? undefined}
        onClick={() => void resetStage()}
      >
        Reset
      </Button>
    </span>
  ) : null;

  return (
    <Page
      title="Placement"
      subtitle="Every entrant plays two placement matches."
      actions={resetAction}
    >
      {wrongFormat ? null : <PlacementTierLegend />}
      {wrongFormat ? (
        <div className="mb-4 rounded-lg border border-warn-border bg-warn-surface px-3 py-2 text-sm font-medium text-warn-foreground">
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
              hint="Add an event in tournament setup before running the placement stage."
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
            canEdit={canEdit}
            onRefresh={refresh}
          />
        ))}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// One category
// ---------------------------------------------------------------------------

function CategorySection({
  category,
  teams,
  playerMap,
  entrants,
  matches,
  canEdit,
  onRefresh,
}: {
  category: Category;
  teams: Team[];
  playerMap: Map<string, Player>;
  entrants: PlacementEntrant[];
  matches: PlacementMatch[];
  canEdit: boolean;
  onRefresh: () => void;
}) {
  const view = useMemo(() => buildCategoryView(entrants, matches), [entrants, matches]);
  const activeTeams = teams.filter((team) => !team.withdrawn);
  const teamMap = useMemo(() => indexBy(teams), [teams]);
  // A match row carries ENTRANT ids, not team ids, so naming one needs the
  // entrant -> team hop. Leaving the hop out does not fail loudly: every lookup
  // misses and the whole page reads "TBC". The seeding table is the one place
  // that has a team id to hand, and it passes the entrant id instead so there is
  // a single, entrant-keyed function rather than one function used two ways.
  const entrantTeam = useMemo(() => {
    const map = new Map<string, string>();
    for (const entrant of entrants) map.set(entrant.id, entrant.team_id);
    return map;
  }, [entrants]);
  const labelEntrant = (entrantId: string | null | undefined) => {
    const teamId = entrantId ? entrantTeam.get(entrantId) : undefined;
    return teamId ? teamLabel(teamMap.get(teamId), playerMap) : "TBC";
  };

  // The placement stage holds an odd entrant rather than issuing a bye. That is said on the
  // held entrant's own row ("Why X plays both matches in Round 2"), not in a banner here: the
  // field is odd for most events, so a banner repeated the same paragraph down the page.

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
          <span className="ml-2 font-score text-sm font-normal text-muted-foreground">
            {view.active.length} entrants, {view.matches.length} matches,{" "}
            {view.stage === "round1" && view.roundTwo.length > 0
              ? "Rounds 1 & 2"
              : stageLabel(view.stage)}
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
        <SeedingPanel
          category={category}
          view={view}
          label={labelEntrant}
          canEdit={canEdit}
          onRefresh={onRefresh}
        />
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
  label: (entrantId: string | null | undefined) => string;
  canEdit: boolean;
  onRefresh: () => void;
}) {
  const counts = { advanced: 0, intermediate: 0, beginner: 0 };
  for (const entrant of view.active) {
    const level = entrant.skill_level as keyof typeof counts;
    if (level in counts) counts[level]++;
  }

  const hasMatches = view.matches.length > 0;

  // Reordering is offered only where a new order can actually be written: the seed
  // order has to exist, and the stage has to be empty. The second condition is not
  // a UI preference, it is the database's own guard — once round one has been
  // generated its pairings came from this order, so permuting it afterwards would
  // leave matches whose seeds no longer explain them.
  const canReorder = canEdit && view.seedsLocked && !hasMatches;

  const entrantById = useMemo(
    () => new Map(view.active.map((entrant) => [entrant.id, entrant])),
    [view.active],
  );
  const outcomeById = useMemo(
    () => new Map(view.outcomes.map((outcome) => [outcome.entrantId, outcome])),
    [view.outcomes],
  );

  // The order the table reads. With no seeds written there is no order to speak of,
  // so this keeps the sort the table always used: seeded entrants by seed, then the
  // unseeded ones.
  const storedOrder = useMemo(() => {
    if (!view.seedsLocked) {
      return view.outcomes
        .slice()
        .sort((a, b) => {
          if (a.seed === 0 || b.seed === 0) return a.seed === 0 ? 1 : -1;
          return a.seed - b.seed;
        })
        .map((outcome) => outcome.entrantId);
    }
    return [...view.active]
      .sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0))
      .map((entrant) => entrant.id);
  }, [view.active, view.outcomes, view.seedsLocked]);

  // Held locally only for the length of a write, so a dropped row moves under the
  // cursor rather than after a round trip. Re-seeded whenever the stored order
  // changes, which is what makes a saved reorder and a refetch agree again.
  const [order, setOrder] = useState<string[]>(storedOrder);
  useEffect(() => setOrder(storedOrder), [storedOrder]);

  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The authoritative record of which row is being dragged. A drag spans several
  // browser tasks, and React may not have re-rendered between them, so the state
  // below is only good enough to style the rows — the handlers read this.
  const dragIdRef = useRef<string | null>(null);

  // Dragging is suspended while a write is in flight. Two overlapping reorders
  // would race, and the loser would be whichever request happened to land last
  // rather than whichever the host made last.
  const canDragNow = canReorder && !saving;

  const rows = order
    .map((entrantId) => entrantById.get(entrantId))
    .filter((entrant): entrant is PlacementEntrant => entrant != null);

  const orderFollowsBlocks = followsSkillBlocks(rows.map((entrant) => entrant.skill_level));

  /**
   * Moves one entrant to another's position and writes the resulting order.
   *
   * A failure restores the previous order rather than leaving the screen ahead of
   * the database: every later pairing is derived from these numbers, so a list that
   * disagreed with them would be worse than a rejected drag.
   */
  async function move(fromId: string, toId: string) {
    const previous = order;
    const from = previous.indexOf(fromId);
    const to = previous.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;

    const next = previous.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved as string);

    setOrder(next);
    setSaving(true);
    try {
      await savePlacementSeedOrder(category.id, view.active, next);
      onRefresh();
    } catch (error) {
      setOrder(previous);
      toast.error(error instanceof Error ? error.message : "Could not save the seed order");
    } finally {
      setSaving(false);
    }
  }

  /** The arrows, which are the keyboard and touch path to the same move as a drag. */
  async function step(entrantId: string, delta: number) {
    const index = order.indexOf(entrantId);
    const target = order[index + delta];
    if (index < 0 || !target) return;
    await move(entrantId, target);
  }

  return (
    <Panel
      title="Seeding"
      right={
        // Whether the order can still change is the editor's question; a reader is only shown it.
        canEdit ? (
          <span className="flex items-center gap-1">
            <span className="font-score text-t4 text-muted-foreground">
              {saving ? "saving…" : view.seedsLocked ? "locked" : "not locked"}
            </span>
            <InfoNote label="How seeding works">
              <p>
                Skill level decides the seed order once: entrants are grouped by the block they
                reported, shuffled inside it, and seeded strongest block first. Every pairing
                rule after this reads the seed only.
              </p>
              <p>
                Drag a row to set the order by hand, or use the arrows. Each change is saved
                straight away.
              </p>
              <p>
                Seeds can be re-shuffled until the schedule is built. After that the order is
                frozen, and changing it means resetting the schedule first.
              </p>
            </InfoNote>
          </span>
        ) : null
      }
    >
      <div className="space-y-3">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                {canReorder ? (
                  <th className="w-20">
                    <span className="sr-only">Reorder</span>
                  </th>
                ) : null}
                <th className="w-12">Seed</th>
                <th>Entrant</th>
                <th>Skill</th>
                <th className="text-right">Matches</th>
                <th>Tier</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entrant, index) => {
                const outcome = outcomeById.get(entrant.id);
                const isDropTarget = canDragNow && overId === entrant.id && dragId !== entrant.id;
                // `data-table` paints a zebra background on `td`, and that rule
                // outranks a utility class on the row, so the drop highlight is
                // applied to the cells and inline.
                const dropProps = isDropTarget
                  ? {
                      style: {
                        backgroundColor: "color-mix(in oklab, var(--primary) 14%, transparent)",
                      },
                    }
                  : {};
                return (
                  <tr
                    key={entrant.id}
                    draggable={canDragNow}
                    className={canReorder ? "cursor-grab active:cursor-grabbing" : undefined}
                    onDragStart={(event) => {
                      if (!canDragNow) return;
                      // Firefox refuses to start a drag without a payload, so this
                      // is what makes the row draggable rather than a nicety.
                      const payload = entrant.id;
                      event.dataTransfer.setData("text/plain", payload);
                      event.dataTransfer.effectAllowed = "move";
                      dragIdRef.current = payload;
                      setDragId(payload);
                    }}
                    onDragOver={(event) => {
                      // Read the ref, not the state: `dragover` fires many times per
                      // drag and only the ref is guaranteed to be current.
                      const dragging = dragIdRef.current;
                      if (!canDragNow || dragging === null || dragging === entrant.id) return;
                      // Without preventDefault the browser refuses the drop outright.
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setOverId(entrant.id);
                    }}
                    onDragLeave={() =>
                      setOverId((current) => (current === entrant.id ? null : current))
                    }
                    onDrop={(event) => {
                      event.preventDefault();
                      // The ref is emptied before the move so a stray second drop
                      // cannot replay it. The payload is the fallback for a drag that
                      // began in another window, where no ref was ever set.
                      const dropped = dragIdRef.current ?? event.dataTransfer.getData("text/plain");
                      dragIdRef.current = null;
                      setDragId(null);
                      setOverId(null);
                      if (dropped && dropped !== entrant.id) void move(dropped, entrant.id);
                    }}
                    onDragEnd={() => {
                      dragIdRef.current = null;
                      setDragId(null);
                      setOverId(null);
                    }}
                  >
                    {canReorder ? (
                      <td className="w-20 py-1 pr-0" {...dropProps}>
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <GripVertical className="size-3.5 shrink-0" aria-hidden />
                          {/*
                            The arrows are the keyboard and touch path to the same move as a
                            drag, so they have to be hit-sized: WCAG 2.2 AA asks for a 24px
                            minimum, and `p-0.5` around a 14px glyph measured 18px with only
                            12px of safe space between the pair. The glyph stays 14px — the
                            real control is the whole 24px box around it.
                          */}
                          <button
                            type="button"
                            draggable={false}
                            className="grid size-6 place-items-center rounded hover:bg-muted hover:text-foreground disabled:opacity-30"
                            aria-label={`Move ${label(entrant.id)} up one seed`}
                            disabled={index === 0 || saving}
                            onClick={() => void step(entrant.id, -1)}
                          >
                            <ChevronUp className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            draggable={false}
                            className="grid size-6 place-items-center rounded hover:bg-muted hover:text-foreground disabled:opacity-30"
                            aria-label={`Move ${label(entrant.id)} down one seed`}
                            disabled={index === rows.length - 1 || saving}
                            onClick={() => void step(entrant.id, 1)}
                          >
                            <ChevronDown className="size-3.5" />
                          </button>
                        </div>
                      </td>
                    ) : null}
                    <td className="font-score text-sm font-semibold text-primary" {...dropProps}>
                      {/* The live position, so a drag reads correctly before its write
                          lands. Before the seeds are written there is nothing to number. */}
                      {view.seedsLocked ? index + 1 : "—"}
                    </td>
                    <td className="pr-2 font-medium" {...dropProps}>
                      {label(entrant.id)}
                      {view.roundOne.length > 0 && entrant.id === view.heldEntrantId ? (
                        <InfoNote
                          label={`Why ${label(entrant.id)} plays both matches in Round 2`}
                          className="ml-1 align-middle"
                        >
                          <p>Plays both placement matches in Round 2. Did not play in Round 1 because the field had an odd number of entrants.</p>
                        </InfoNote>
                      ) : null}
                    </td>
                    <td {...dropProps}>
                      {canEdit && !view.seedsLocked ? (
                        // The options and their labels come from `SKILL_LEVELS`/`SKILL_LABELS`,
                        // the same vocabulary the seed order is built from, so the control
                        // cannot offer a word the seeding does not know. `border-input` rather
                        // than the hairline: this boundary is what tells the reader a control
                        // is here, and the hairline is decorative and exempt from 1.4.11.
                        <select
                          className="h-7 rounded-md border border-input bg-background px-2 text-sm"
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
                          {SKILL_LEVELS.map((level) => (
                            <option key={level} value={level}>
                              {SKILL_LABELS[level]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-sm">
                          {isSkillLevel(entrant.skill_level)
                            ? SKILL_LABELS[entrant.skill_level]
                            : entrant.skill_level}
                        </span>
                      )}
                    </td>
                    <td className="text-right font-score text-sm" {...dropProps}>
                      {outcome?.played ?? 0}/{view.requiredMatches}
                    </td>
                    <td className="font-score text-sm" {...dropProps}>
                      {outcome?.tier ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {canEdit ? (
          <p className="text-t4 text-muted-foreground">
            Blocks: {counts.advanced} advanced, {counts.intermediate} intermediate,{" "}
            {counts.beginner} beginner
            {view.excluded.length > 0 ? `, ${view.excluded.length} waived` : ""}
          </p>
        ) : null}

        {canReorder && !orderFollowsBlocks ? (
          <p className="rounded-md border border-warn-border bg-warn-surface px-3 py-2 text-t4 font-medium text-warn-foreground">
            This order no longer follows the skill blocks. &quot;Re-shuffle seeds&quot; puts them
            back.
          </p>
        ) : null}

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
          <p className="text-t4 text-muted-foreground">
            Frozen: placement matches already exist.
          </p>
        ) : null}
      </div>
    </Panel>
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
