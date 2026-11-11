import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useMemo, useState } from "react";

import {
  Page,
  ByeMarker,
  EmptyState,
  Panel,
  StatTile,
  StatusPill,
} from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { compareEventIds, compareEventOrder } from "@/lib/tournament/event-order";
import {
  indexBy,
  teamLabel,
  useScopedAccess,
  useScopedTournament,
  useCategories,
  useCourts,
  useDrawMatches,
  useDraws,
  usePlacementEntrants,
  usePlacementMatches,
  usePlayers,
  usePoolMatches,
  usePools,
  useRealtimeRefresh,
  useTeams,
  useTierDrawMatches,
  useTierDraws,
} from "@/lib/tournament/data";
import { isSupportedFormat } from "@/lib/tournament/competition-format";
import { gamesLabel, parseGames, timeLabel } from "@/lib/tournament/format";
import {
  DEFAULT_KNOCKOUT_RULE,
  DEFAULT_PLACEMENT_RULE,
  LEGACY_GAME_RULE,
  ruleForStage,
  scoringRuleLabel,
} from "@/lib/tournament/scoring";
import { buildDeskMatches, type DeskMatch } from "@/lib/tournament/desk-matches";
import { BYE_NOTE, isByeMatch } from "@/lib/tournament/match-status";
import { MatchOperationsDialog } from "./desk";
import { sideThatWon } from "@/lib/tournament/match-winner";

export const Route = createFileRoute("/tournaments/$tournamentId/scores")({
  head: () => ({
    meta: [
      { title: "Scores | Tournova Tournament Ops" },
      {
        name: "description",
        content:
          "Every match in the tournament, where and when it is played, and its score.",
      },
      { property: "og:title", content: "Scores | Tournova Tournament Ops" },
      {
        property: "og:description",
        content:
          "Every match in the tournament, where and when it is played, and its score.",
      },
    ],
  }),
  /**
   * The search lives in the address, so "Ho Duc's matches" is a link a player can send. Only a
   * non-empty string is kept; anything else is dropped rather than trusted.
   */
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const q = search["q"];
    return typeof q === "string" && q.trim().length > 0 ? { q } : {};
  },
  component: MatchesPage,
});

type StatusFilter = "all" | "pending" | "live" | "done";

function matchesStatusFilter(status: string, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "live") return status === "in-progress";
  if (filter === "done") return status === "reported" || status === "walkover";
  return status !== "reported" && status !== "walkover" && status !== "in-progress";
}

/**
 * One filter in a group of them.
 *
 * Three things about the group are asserted rather than assumed, because the same control
 * is drawn one route over on Explore and that copy already does all three:
 *
 *  - `role="group"` with a name, so the row of chips is announced as one filter rather
 *    than as five unrelated buttons.
 *  - `aria-pressed`, which is what makes "this is the filter you are looking at" a fact
 *    the reader can perceive. Without it the two states differ only in fill, and the
 *    only thing that said so was colour. It also brings the chip into the WCAG 1.4.11
 *    sweep, which selects its nodes by exactly this attribute - so an unlabelled group of
 *    pressed buttons is not merely unannounced, it is unmeasured.
 *  - `border-input` rather than the hairline. The boundary is what tells a reader there is
 *    a control here, and `--border` is the decorative weight the design system explicitly
 *    exempts from 1.4.11; `--border-control` is the functional one. It matters more here
 *    than on Explore: an unselected chip is a surface fill inside a surface-fill panel, so
 *    the hairline is the only thing drawing it at all.
 */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-sm font-semibold transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-surface text-muted-foreground hover:bg-muted/60",
      )}
    >
      {children}
    </button>
  );
}

function MatchRow({
  match,
  left,
  label,
  courtMap,
  canEdit,
  onOpen,
}: {
  match: DeskMatch;
  left: string;
  label: (id: string | null) => string;
  courtMap: Map<string, { number: number }>;
  canEdit: boolean;
  onOpen: () => void;
}) {
  /*
    The side that won is marked the way the bracket marks it - bold, with a check - so a
    result reads without working out which number belongs to whom. A reader is not shown
    "Completed" beside it as well: the mark and the score already say so. The operator keeps
    the pill, which is the status they act on.
  */
  const won = match.status === "reported" ? sideThatWon(match.initialGames) : null;
  const side = (index: 0 | 1) => {
    const winner = won === (index === 0 ? "a" : "b");
    return (
      <span className={winner ? "font-semibold" : undefined}>
        {winner ? <Check aria-hidden className="mr-0.5 inline size-3.5 align-[-2px]" /> : null}
        {label(match.teams[index])}
        {winner ? <span className="sr-only"> (won)</span> : null}
      </span>
    );
  };
  return (
    <li className="grid min-h-[var(--row-height)] grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-md px-2 py-3 text-t3 transition-colors hover:bg-muted/50 sm:flex sm:flex-wrap sm:items-center sm:gap-3 sm:py-1">
      <span className="font-score text-t2 font-semibold text-foreground sm:w-28">{left}</span>
      <span className="col-span-2 row-start-2 min-w-0 text-base sm:min-w-[220px] sm:flex-1 sm:text-t3">
        {side(0)} <span className="text-muted-foreground">vs</span> {side(1)}
      </span>
      <span className="col-start-2 row-start-1 flex shrink-0 flex-col text-right font-score text-t2 text-muted-foreground sm:text-left">
        <span>{match.scheduled ? timeLabel(match.scheduled) : "Time not assigned"}</span>
        <span>{match.courtId ? `Court ${courtMap.get(match.courtId)?.number ?? "?"}` : "Court not assigned"}</span>
      </span>
      <div className="col-span-2 flex flex-wrap items-center justify-between gap-3 sm:contents">
      {canEdit || !won ? <StatusPill status={match.status} /> : null}
      {/* A game score is a number, so it must never be broken across lines. The fixed
          `w-24` this replaces was narrower than three games at the 30-point cap
          ("30-29, 29-30, 30-28"), and because the cell could not grow the value
          wrapped onto two lines: "30-29, 29-30, 30-" / "28", which reads as a
          different score. `whitespace-nowrap` forbids the break and the min-width
          lets the column take the space it needs; the row is already `flex-wrap`, so
          under real pressure the whole cell moves to the next line instead of the
          number giving way. A minimum rather than a fixed width keeps the right edges
          aligned for the ordinary case, where every score is short and the minimum
          wins. */}
      <span className="min-w-24 shrink-0 whitespace-nowrap text-right font-score text-t2">
        {match.score ?? "—"}
      </span>
      {/*
        Open is the editor's way into scoring. A read-only reader sees the result in
        the row and is offered no control, so the button is absent rather than disabled.
        The spacer keeps the score column aligned whether or not the button is drawn —
        the same width the draw list's bye row already reserves.
      */}
      {canEdit ? (
        <Button size="sm" variant="outline" onClick={onOpen}>
          Open
        </Button>
      ) : (
        <span className="w-[62px]" aria-hidden />
      )}
      </div>
    </li>
  );
}

function MatchesPage() {
  const qc = useQueryClient();
  useRealtimeRefresh();
  const [selected, setSelected] = useState<{ id: string } | null>(null);
  const { q: searchedFor } = Route.useSearch();
  const { tournamentId } = Route.useParams();
  const navigate = useNavigate();
  const [query, setQueryState] = useState(searchedFor ?? "");
  const setQuery = (value: string) => {
    setQueryState(value);
    const term = value.trim();
    void navigate({
      to: "/tournaments/$tournamentId/scores",
      params: { tournamentId },
      search: term ? { q: term } : {},
      replace: true,
    });
  };
  const [categoryId, setCategoryId] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [stage, setStage] = useState<string | null>(null);
  const { data: categories } = useCategories();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: pools } = usePools();
  const { data: poolMatches } = usePoolMatches();
  const { data: draws } = useDraws();
  const { data: drawMatches } = useDrawMatches();
  const { data: courts } = useCourts();
  const tournament = useScopedTournament();
  /**
   * Whether this user may change a match here.
   *
   * Read from the tournament rather than from a role: a viewer sees the same desk with
   * the controls gone. The server re-checks on every write, so this only decides what is
   * rendered.
   */
  const access = useScopedAccess();
  const canEdit = access.can_edit;
  const { data: placementEntrants } = usePlacementEntrants();
  const { data: placementMatches } = usePlacementMatches();
  const { data: tierDraws } = useTierDraws();
  const { data: tierDrawMatches } = useTierDrawMatches();

  /**
   * Knockout scoring follows the tournament's configured rule. Placement matches
   * stay on the legacy single-game-to-21 rule because `report_pool_result`, which
   * the database uses for them, still enforces exactly that.
   */
  const knockoutRule = useMemo(
    () => (tournament ? ruleForStage(tournament, "knockout") : DEFAULT_KNOCKOUT_RULE),
    [tournament],
  );

  /** The placement rounds carry their own configured rule, unlike a pool match. */
  const placementRule = useMemo(
    () => (tournament ? ruleForStage(tournament, "placement") : DEFAULT_PLACEMENT_RULE),
    [tournament],
  );

  const playerMap = useMemo(() => indexBy(players), [players]);
  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const drawMap = useMemo(() => indexBy(draws), [draws]);
  const courtMap = useMemo(() => indexBy(courts), [courts]);
  const catMap = useMemo(() => indexBy(categories), [categories]);

  /**
   * Whether the round-robin tables are this tournament's own.
   *
   * False for the supported format, which has no pools: the rows still in `pools` and
   * `pool_matches` under such a tournament are leftovers, and a screen that listed them
   * would put finished matches this event cannot have above the ones being played — and
   * would count them in "Matches shown" and "Completed".
   *
   * This gates the lists read straight from those tables, which the shared row builder
   * cannot reach. The builder takes the same format and excludes its copy.
   */
  const roundRobin = !isSupportedFormat(tournament?.format);

  const label = (id: string | null) => teamLabel(id ? teamMap.get(id) : undefined, playerMap);
  const refresh = () => qc.invalidateQueries();

  const entrantTeam = useMemo(() => {
    const map = indexBy(placementEntrants);
    return (entrantId: string | null) => (entrantId ? (map.get(entrantId)?.team_id ?? null) : null);
  }, [placementEntrants]);

  /** The A/B/C/D bracket each tier match belongs to, for grouping the knockout tab. */
  const drawOfTierMatch = useMemo(
    () => new Map((tierDrawMatches ?? []).map((match) => [match.id, match.draw_id])),
    [tierDrawMatches],
  );

  /**
   * Every match of every format, built the same way the control desk builds them.
   *
   * This is what makes the two-round placement format scorable here at all: the list
   * on this page used to be assembled from the round-robin tables only, so a
   * placement tournament showed "No pools generated yet" while fifteen matches were
   * waiting for a result.
   */
  const allRows = useMemo(
    () =>
      buildDeskMatches({
        format: tournament?.format,
        poolMatches,
        drawMatches,
        draws,
        placementMatches,
        tierMatches: tierDrawMatches,
        tierDraws,
        teams,
        categories,
        entrantTeam,
      }),
    [
      tournament?.format,
      poolMatches,
      drawMatches,
      draws,
      placementMatches,
      tierDrawMatches,
      tierDraws,
      teams,
      categories,
      entrantTeam,
    ],
  );

  const keepRow = (row: DeskMatch) => {
    if (categoryId !== "all" && row.categoryId !== categoryId) return false;
    if (!matchesStatusFilter(row.status, statusFilter)) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${label(row.teams[0])} ${label(row.teams[1])}`.toLowerCase().includes(q);
  };

  /** The same filters, for the two round-robin lists that render from their own rows. */
  const keep = (opts: { status: string; catId: string; a: string | null; b: string | null }) => {
    if (categoryId !== "all" && opts.catId !== categoryId) return false;
    if (!matchesStatusFilter(opts.status, statusFilter)) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${label(opts.a)} ${label(opts.b)}`.toLowerCase().includes(q);
  };

  const rowsFor = (kind: DeskMatch["kind"]) => allRows.filter((row) => row.kind === kind);
  const visiblePlacement = useMemo(
    () => rowsFor("placement").filter(keepRow),
    // keepRow reads the current filters and the player map; the rows are memoised.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRows, categoryId, statusFilter, query, teamMap, playerMap],
  );
  const visibleTier = useMemo(
    () => rowsFor("tier").filter(keepRow),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRows, categoryId, statusFilter, query, teamMap, playerMap],
  );

  const visiblePool = useMemo(
    () =>
      roundRobin
        ? (poolMatches ?? []).filter((m) =>
            keep({ status: m.status, catId: m.category_id, a: m.team_a_id, b: m.team_b_id }),
          )
        : [],
    // keep reads the current filters and the player map; the rows are memoised.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roundRobin, poolMatches, categoryId, statusFilter, query, teamMap, playerMap],
  );

  const visibleDraw = useMemo(
    () =>
      roundRobin
        ? (drawMatches ?? []).filter((m) =>
            keep({
              status: m.status,
              catId: drawMap.get(m.draw_id)?.category_id ?? "",
              a: m.team_a_id,
              b: m.team_b_id,
            }),
          )
        : [],
    // keep and drawMap read the current filters and the player map; the rows are memoised.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roundRobin, drawMatches, drawMap, categoryId, statusFilter, query, teamMap, playerMap],
  );

  /** The group tab holds the pools and the placement rounds; the knockout tab the rest. */
  const all = [...visiblePool, ...visiblePlacement, ...visibleDraw, ...visibleTier];
  const doneCount = all.filter((m) => m.status === "reported" || m.status === "walkover").length;
  const liveCount = all.filter((m) => m.status === "in-progress").length;
  const pendingCount = all.length - doneCount - liveCount;
  // Every match query is enabled with the tournament, so all four settle: until they do, the
  // counts are unknown rather than zero.
  const countsLoading =
    !teams || !poolMatches || !drawMatches || !placementMatches || !tierDrawMatches;
  const count = (value: number) => (countsLoading ? null : value);

  /**
   * The row the dialog operates on, resolved from the same list the board uses, so
   * the dialog cannot be handed a row that the list never showed.
   */
  const selectedMatch = useMemo<DeskMatch | null>(
    () => (selected ? (allRows.find((row) => row.id === selected.id) ?? null) : null),
    [selected, allRows],
  );

  /**
   * The placement rounds grouped by event, and the A/B/C/D brackets grouped by draw.
   *
   * Grouping here rather than in the row builder keeps the builder about matches
   * only: the desk draws a court board and has no opinion about panels.
   */
  const groupByCategory = (rows: DeskMatch[]) => {
    const groups = new Map<string, DeskMatch[]>();
    for (const row of rows) {
      const list = groups.get(row.categoryId) ?? [];
      list.push(row);
      groups.set(row.categoryId, list);
    }
    return [...groups.entries()];
  };

  /**
   * The order the event panels are drawn in: the standard order, MS -> WS -> MD -> WD -> XD.
   *
   * `groupByCategory` walks the matches, so a group is created when its event's first match is
   * reached - which is scored-time order, a fact about the draw rather than about the
   * tournament. An event whose first match is late in the day therefore sat below the others,
   * and the panels moved between visits as the schedule changed. `compareEventIds` pins them.
   */
  const placementGroups = useMemo(
    () =>
      [
        ...groupByCategory(
          // In playing order, round by round, rather than by tag: sorted by tag, 18:00 sat above
          // 17:44 inside the same round.
          [...visiblePlacement].sort((a, b) => {
            const at = (m: DeskMatch) =>
              m.scheduled ? new Date(m.scheduled).getTime() : Infinity;
            const x = at(a);
            const y = at(b);
            if (x !== y) return x < y ? -1 : 1;
            return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
          }),
        ),
      ].sort((a, b) => compareEventIds(a[0], b[0], (id) => catMap.get(id))),
    [visiblePlacement, catMap],
  );
  const tierGroups = useMemo(() => {
    // The bracket panels read in event order, then A/B/C/D within an event, so an event's draws
    // stay together however their matches happen to be scheduled.
    const drawById = new Map((tierDraws ?? []).map((draw) => [draw.id, draw]));
    const byDraw = new Map<string, DeskMatch[]>();
    for (const row of visibleTier) {
      const drawId = drawOfTierMatch.get(row.id) ?? "";
      const list = byDraw.get(drawId) ?? [];
      list.push(row);
      byDraw.set(drawId, list);
    }
    return [...byDraw.entries()].sort((a, b) => {
      const drawA = drawById.get(a[0]);
      const drawB = drawById.get(b[0]);
      const byEvent = compareEventIds(drawA?.category_id, drawB?.category_id, (id) =>
        catMap.get(id),
      );
      if (byEvent) return byEvent;
      return (drawA?.tier ?? "").localeCompare(drawB?.tier ?? "");
    });
  }, [visibleTier, drawOfTierMatch, tierDraws, catMap]);

  const searching = !roundRobin && query.trim().length > 0;
  /** A search's matches, both stages together, in the order they are played. */
  const searchRows = useMemo(
    () =>
      [...visiblePlacement, ...visibleTier].sort((a, b) => {
        const at = (m: DeskMatch) =>
          m.scheduled ? new Date(m.scheduled).getTime() : Number.POSITIVE_INFINITY;
        const x = at(a);
        const y = at(b);
        return x === y ? 0 : x < y ? -1 : 1;
      }),
    [visiblePlacement, visibleTier],
  );

  /** The round-robin pools, in the standard event order. */
  const orderedPools = useMemo(
    () =>
      // Pools read in the standard event order too, so a round-robin tournament's group panels
      // sit in the same order as its filter chips.
      [...(pools ?? [])].sort(
        (a, b) =>
          compareEventIds(a.category_id, b.category_id, (id) => catMap.get(id)) ||
          a.name.localeCompare(b.name),
      ),
    [pools, catMap],
  );

  const groupCount = visiblePool.length + visiblePlacement.length;
  const knockoutCount = visibleDraw.length + visibleTier.length;

  return (
    <Page
      title={canEdit ? "Score entry" : "Scores"}
      subtitle={`${roundRobin ? "Group stage" : "Placement"} is ${scoringRuleLabel(roundRobin ? LEGACY_GAME_RULE : placementRule).toLowerCase()}. Knockouts are ${scoringRuleLabel(knockoutRule).toLowerCase()}.`}
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Matches shown" value={count(all.length)} />
          <StatTile
            label={canEdit ? "Awaiting result" : "Still to play"}
            value={count(pendingCount)}
            tone={canEdit && pendingCount ? "warn" : "normal"}
          />
          <StatTile label="On court" value={count(liveCount)} />
          <StatTile label="Completed" value={count(doneCount)} tone="good" />
        </div>

        <Panel bodyClassName="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a player or pair…"
            className="h-9 sm:max-w-xs"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <div
              role="group"
              aria-label="Filter by event"
              className="flex flex-wrap items-center gap-1.5"
            >
              <FilterChip active={categoryId === "all"} onClick={() => setCategoryId("all")}>
                All events
              </FilterChip>
              {(categories ?? []).slice().sort(compareEventOrder).map((c) => (
                <FilterChip
                  key={c.id}
                  active={categoryId === c.id}
                  onClick={() => setCategoryId(c.id)}
                >
                  {c.code}
                </FilterChip>
              ))}
            </div>
            <span className="mx-1 hidden h-5 w-px bg-hairline sm:block" />
            <div
              role="group"
              aria-label="Filter by status"
              className="flex flex-wrap items-center gap-1.5"
            >
              {(
                [
                  ["all", "All"],
                  ["pending", "To play"],
                  ["live", "On court"],
                  ["done", "Done"],
                ] as [StatusFilter, string][]
              ).map(([value, text]) => (
                <FilterChip
                  key={value}
                  active={statusFilter === value}
                  onClick={() => setStatusFilter(value)}
                >
                  {text}
                </FilterChip>
              ))}
            </div>
          </div>
        </Panel>

        {/*
          The stage that opens is the one with matches in it. A tournament past its group stage
          has nothing under "Group stage", and opening on that empty tab sent every reader to a
          page that said "No group matches yet" about a tournament that was already in its
          knockouts. A choice the reader makes wins from then on.
        */}
        {/*
          A search is for one player's matches, and a player's matches run across both stages: the
          two tabs split them, so "Ho Duc" showed two of their five results until the other tab
          was opened. While a search is typed the stages are one list in playing order. The
          round-robin format keeps its tabs: its pool and draw rows are a different shape.
        */}
        {searching ? (
          <Panel
            title={`Matches for "${query.trim()}"`}
            right={
              <span className="font-score text-t4 text-muted-foreground">
                {searchRows.length} match{searchRows.length === 1 ? "" : "es"}
              </span>
            }
            bodyClassName="p-2"
          >
            {searchRows.length ? (
              <ul className="divide-y divide-hairline">
                {searchRows.map((m) => (
                  <MatchRow
                    key={m.id}
                    match={m}
                    left={m.tag}
                    label={label}
                    courtMap={courtMap}
                    canEdit={canEdit}
                    onOpen={() => setSelected({ id: m.id })}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No matches for this search"
                hint="Check the spelling, or clear the search and pick an event."
              />
            )}
          </Panel>
        ) : (
        <Tabs value={stage ?? (groupCount === 0 && knockoutCount > 0 ? "knockout" : "group")} onValueChange={setStage}>
          <TabsList>
            <TabsTrigger value="group">{roundRobin ? "Group stage" : "Placement"} ({groupCount})</TabsTrigger>
            <TabsTrigger value="knockout">Knockout ({knockoutCount})</TabsTrigger>
          </TabsList>

          <TabsContent value="group" className="mt-4 space-y-4">
            {placementGroups.map(([catId, list]) => (
              <Panel
                key={`placement-${catId}`}
                title={`${catMap.get(catId)?.code ?? "Placement"} Placement`}
                right={
                  <span className="font-score text-t4 text-muted-foreground">
                    {list.filter((m) => m.status === "reported").length}/{list.length} reported
                  </span>
                }
                bodyClassName="p-2"
              >
                <ul className="divide-y divide-hairline">
                  {list.map((m) => (
                    <MatchRow
                      key={m.id}
                      match={m}
                      left={m.tag || "R1"}
                      label={label}
                      courtMap={courtMap}
                      canEdit={canEdit}
                      onOpen={() => setSelected({ id: m.id })}
                    />
                  ))}
                </ul>
              </Panel>
            ))}
            {orderedPools.map((pool) => {
              const list = visiblePool
                .filter((m) => m.pool_id === pool.id)
                .sort((a, b) => a.round - b.round);
              if (!list.length) return null;
              const reported = list.filter((m) => m.status === "reported").length;
              return (
                <Panel
                  key={pool.id}
                  title={`${catMap.get(pool.category_id)?.code ?? ""} — ${pool.name}`}
                  right={
                    <span className="font-score text-t4 text-muted-foreground">
                      {reported}/{list.length} reported
                    </span>
                  }
                  bodyClassName="p-2"
                >
                  <ul className="divide-y divide-hairline">
                    {list.map((m) => (
                      <li
                        key={m.id}
                        className="flex min-h-[var(--row-height)] flex-wrap items-center gap-3 rounded-md px-2 py-1 text-t3 transition-colors hover:bg-muted/50"
                      >
                        <span className="w-14 font-score text-t2 font-semibold text-foreground">
                          R{m.round}
                        </span>
                        <span className="min-w-[220px] flex-1">
                          {label(m.team_a_id)} <span className="text-muted-foreground">vs</span>{" "}
                          {label(m.team_b_id)}
                        </span>
                        <span className="font-score text-t2 text-muted-foreground">
                          {timeLabel(m.scheduled_time)}
                          {m.court_id ? `, Court ${courtMap.get(m.court_id)?.number ?? "?"}` : ""}
                        </span>
                        <StatusPill status={m.status} />
                        <span className="w-20 text-right font-score text-t2">
                          {m.status === "reported" ? `${m.score_a}-${m.score_b}` : "—"}
                        </span>
                        {canEdit ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSelected({ id: m.id })}
                          >
                            Open
                          </Button>
                        ) : (
                          <span className="w-[62px]" aria-hidden />
                        )}
                      </li>
                    ))}
                  </ul>
                </Panel>
              );
            })}
            {visiblePool.length === 0 && visiblePlacement.length === 0 ? (
              <Panel>
                <EmptyState
                  title={
                    (pools ?? []).length
                      ? "No group matches match these filters"
                      : "No group matches yet"
                  }
                  hint={
                    (pools ?? []).length
                      ? "Clear the search or pick another event to see more matches."
                      : "Round one appears as soon as the build has created it."
                  }
                />
              </Panel>
            ) : null}
          </TabsContent>

          <TabsContent value="knockout" className="mt-4 space-y-4">
            {tierGroups.map(([drawId, list]) => {
              const draw = (tierDraws ?? []).find((d) => d.id === drawId);
              return (
                <Panel
                  key={`tier-${drawId}`}
                  title={`${catMap.get(draw?.category_id ?? "")?.code ?? ""} Draw ${draw?.tier ?? "?"}`}
                  right={
                    <span className="font-score text-t4 text-muted-foreground">
                      {list.filter((m) => m.status === "reported").length}/{list.length} reported
                    </span>
                  }
                  bodyClassName="p-2"
                >
                  <ul className="divide-y divide-hairline">
                    {list.map((m) => (
                      <MatchRow
                        key={m.id}
                        match={m}
                        left={m.roundTag || m.tag || "Tier"}
                        label={label}
                        courtMap={courtMap}
                        canEdit={canEdit}
                        onOpen={() => setSelected({ id: m.id })}
                      />
                    ))}
                  </ul>
                </Panel>
              );
            })}
            {(draws ?? []).map((draw) => {
              const list = visibleDraw
                .filter((m) => m.draw_id === draw.id)
                .sort((a, b) => a.round - b.round || a.slot - b.slot);
              if (!list.length) return null;
              return (
                <Panel
                  key={draw.id}
                  title={`${catMap.get(draw.category_id)?.code ?? ""} Draw ${draw.tier}`}
                  right={
                    <span className="font-score text-t4 text-muted-foreground">
                      {draw.entrant_count} entrants, bracket {draw.bracket_size}
                    </span>
                  }
                  bodyClassName="p-2"
                >
                  <ul className="divide-y divide-hairline">
                    {list.map((m) => (
                      <li
                        key={m.id}
                        className="flex min-h-[var(--row-height)] flex-wrap items-center gap-3 rounded-md px-2 py-1 text-t3 transition-colors hover:bg-muted/50"
                      >
                        <span className="w-16 font-score text-t2 font-semibold text-foreground">
                          R{m.round}.{m.slot}
                        </span>
                        <span className="min-w-[220px] flex-1">
                          {label(m.team_a_id)} <span className="text-muted-foreground">vs</span>{" "}
                          {label(m.team_b_id)}
                        </span>
                        <span className="font-score text-t2 text-muted-foreground">
                          {timeLabel(m.scheduled_time)}
                          {m.court_id ? `, Court ${courtMap.get(m.court_id)?.number ?? "?"}` : ""}
                        </span>
                        {isByeMatch(m) ? <ByeMarker /> : <StatusPill status={m.status} />}
                        <span className="w-24 text-right font-score text-sm">
                          {m.status === "reported"
                            ? isByeMatch(m)
                              ? BYE_NOTE
                              : gamesLabel(parseGames(m.games))
                            : "—"}
                        </span>
                        {!isByeMatch(m) && canEdit ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSelected({ id: m.id })}
                          >
                            Open
                          </Button>
                        ) : (
                          <span className="w-[62px]" aria-hidden />
                        )}
                      </li>
                    ))}
                  </ul>
                </Panel>
              );
            })}
            {visibleDraw.length === 0 && visibleTier.length === 0 ? (
              <Panel>
                <EmptyState
                  title={
                    (draws ?? []).length
                      ? "No knockout matches match these filters"
                      : "No knockout matches yet"
                  }
                  hint={
                    (draws ?? []).length
                      ? "Clear the search or pick another event to see more matches."
                      : "Brackets appear once every placement match in a category is decided."
                  }
                />
              </Panel>
            ) : null}
          </TabsContent>
        </Tabs>
        )}
      </div>

      <Dialog open={!!selectedMatch && canEdit} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
          {selectedMatch && canEdit ? (
            /*
             * The score desk deliberately shows no schedule conflicts.
             *
             * The conflict overlay belongs to the control desk, where the board is read
             * as a running order; this page is a list of results to enter. An empty list
             * keeps the report flow free of the conflict clause, while the shared component
             * still owns the flow for the desk that does. Starting is the Desk's alone: it
             * starts a court's own next match after its checks, and this page runs none.
             */
            <MatchOperationsDialog
              key={selectedMatch.id}
              match={selectedMatch}
              nameA={label(selectedMatch.teams[0])}
              nameB={label(selectedMatch.teams[1])}
              courtId={selectedMatch.courtId}
              courtNumber={
                selectedMatch.courtId ? (courtMap.get(selectedMatch.courtId)?.number ?? null) : null
              }
              courts={courts ?? []}
              canEdit={canEdit}
              allowStart={false}
              startCheck={null}
              conflicts={[]}
              onConflictsAfterReport={async () => 0}
              playerMap={playerMap}
              scoringRule={
                selectedMatch.kind === "pool"
                  ? LEGACY_GAME_RULE
                  : selectedMatch.kind === "placement"
                    ? placementRule
                    : knockoutRule
              }
              tournamentId={tournament?.id ?? null}
              timezone={tournament?.venue_timezone}
              onDone={() => {
                refresh();
                setSelected(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Page>
  );
}
