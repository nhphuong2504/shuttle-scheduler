import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Page, EmptyState, Panel, StatTile } from "@/components/app-shell";
import { CapacityEstimate } from "@/components/capacity-estimate";
import { PlayerPicker } from "@/components/player-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { countIsoDays } from "@/lib/tournament/iso-date";
import { withdrawalImpact, withdrawalWarning } from "@/lib/tournament/withdrawal-impact";
import { createPlayer, createTeam, deleteTeam, setTeamWithdrawn } from "@/lib/tournament/actions";
import { withdrawPlacementTeam } from "@/lib/tournament/placement-actions";
import {
  indexBy,
  teamLabel,
  useScopedAccess,
  useScopedTournament,
  useCategories,
  usePlacementEntrants,
  usePlacementMatches,
  usePlayers,
  useTeams,
  useTierDrawMatches,
  type Player,
} from "@/lib/tournament/data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/tournaments/$tournamentId/entries")({
  head: () => ({
    meta: [
      { title: "Entries | Tournova Tournament Ops" },
      {
        name: "description",
        content:
          "Enter players and doubles pairs into a tournament's categories, up to the per-player limit the tournament is configured with.",
      },
      { property: "og:title", content: "Entries | Tournova Tournament Ops" },
      {
        property: "og:description",
        content:
          "Enter players and doubles pairs into a tournament's categories, up to the per-player limit the tournament is configured with.",
      },
    ],
  }),
  component: EntriesPage,
});

/** The column default, used only before the active tournament has loaded. */
const DEFAULT_CATEGORY_CAP = 2;

/**
 * The per-player category cap is tournament configuration (1–5), so every piece
 * of copy has to read it. These live outside the component because the page's
 * meta strings are built before any hook runs.
 */
const CAP_WORDS: Record<number, string> = {
  1: "single",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
};

function capWord(cap: number): string {
  return CAP_WORDS[cap] ?? String(cap);
}

function capLabel(cap: number): string {
  return `At ${capWord(cap)}-category cap`;
}

function capSubtitle(cap: number): string {
  const limit =
    cap === 1
      ? "Each player may enter a single category."
      : `Each player may enter up to ${cap} categories.`;
  return `${limit} Anything beyond that is rejected outright.`;
}

function capPickerNote(cap: number): string {
  const other = cap === 1 ? "another category" : `${capWord(cap)} other categories`;
  return `Players already in ${other} are hidden from these lists.`;
}

/**
 * The cap levels the desk watches, as their own tiles rather than one tile for
 * the configured cap. Keeping both visible is the point: with a cap of three,
 * the two-category tile is the queue that can still enter and the three-category
 * tile is who is locked out.
 */
const CAP_LEVELS = [2, 3] as const;

/**
 * The operator's entry desk: who is already in the tournament, and the two forms that put
 * someone there.
 *
 * ## Why this page is not called "Registration"
 *
 * It was, and the name was the loose end of S11's rename rather than a decision. That phase
 * added a *different* surface at `/registrations` - the queue of requests awaiting a decision
 * - and the nav entry, the `/registration` redirect and the section comment were all moved to
 * "Entries"; only the page's own title, its `head` and its description were left behind, still
 * promising to "register players and doubles pairs". So three pages answered to one name:
 * this one, the queue at `/registrations`, and `index.tsx`, which is the participant's own
 * "Your registration" and is the one the word actually belongs to.
 *
 * The page lists who is in, which is what "Entries" says. Its `head` now describes the
 * operator's job rather than the participant's, because a description promising a
 * self-service sign-up on a page that is a desk form is wrong for the person who finds it in
 * a search result as well as for the person reading the tab.
 */
function EntriesPage() {
  const qc = useQueryClient();
  const { data: categories } = useCategories();
  const { data: players } = usePlayers();
  const { data: teams } = useTeams();
  const { data: entrants } = usePlacementEntrants();
  const { data: placementMatches } = usePlacementMatches();
  const { data: tierMatches } = useTierDrawMatches();
  const tournament = useScopedTournament();
  /**
   * The former `canRegister` flag, now the tournament edit right.
   *
   * Entering players and teams at the desk is an edit to the tournament, and it stays an edit
   * now that participants can file their own requests: those arrive at `/registrations` and
   * are decided there, so the self-service path never writes a team row itself. The RPCs still
   * refuse a viewer; this only decides whether the form renders.
   */
  const access = useScopedAccess();
  const canEdit = access.can_edit;

  /**
   * The desk's cap check must agree with the `enforce_two_category_cap` trigger,
   * which reads this same column. Before the tournament loads, fall back to the
   * column default so the page never claims an unlimited cap.
   */
  const categoryCap = tournament?.max_categories_per_player ?? DEFAULT_CATEGORY_CAP;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [gender, setGender] = useState<string>("");

  const [categoryId, setCategoryId] = useState<string>("");
  // The people chosen for the entry. They are held as rows, not ids: a person found by search
  // is not on this tournament yet, so `players` cannot give their name back.
  const [p1, setP1] = useState<Player | null>(null);
  const [p2, setP2] = useState<Player | null>(null);

  const playerMap = useMemo(() => indexBy(players), [players]);
  const category = (categories ?? []).find((c) => c.id === categoryId);
  const isPair = category?.entry_type === "pair";

  const categoryCount = useMemo(() => {
    const map = new Map<string, Set<string>>();
    // Withdrawn entries must not count: the database trigger only counts
    // `withdrawn = false` rows, so including them here would hide a player from
    // the eligible list even though the database would happily accept the entry.
    for (const t of teams ?? []) {
      if (t.withdrawn) continue;
      for (const pid of [t.player_1_id, t.player_2_id]) {
        if (!pid) continue;
        const set = map.get(pid) ?? new Set<string>();
        set.add(t.category_id);
        map.set(pid, set);
      }
    }
    return map;
  }, [teams]);

  const atCap = (playerId: string) => {
    const set = categoryCount.get(playerId);
    if (!set) return false;
    return set.size >= categoryCap && !set.has(categoryId);
  };

  /**
   * A category the tournament runs.
   *
   * `active` on a category is whether it is run at all, which is a different question from
   * whether registration is open - since S11 that word is the participant window's, computed
   * from the lifecycle and the window config and drawn by `RegistrationStatePill`. A category
   * being switched off is a fact about the tournament, not about a window.
   */
  const activeCategories = useMemo(() => (categories ?? []).filter((c) => c.active), [categories]);

  const activeEntryCount = (id: string) =>
    (teams ?? []).filter((t) => t.category_id === id && !t.withdrawn).length;

  const isFull = (id: string) => {
    const cat = (categories ?? []).find((c) => c.id === id);
    if (!cat || cat.max_entries == null) return false;
    return activeEntryCount(id) >= cat.max_entries;
  };

  const openCategories = activeCategories.filter((c) => !isFull(c.id));
  const selectedIsFull = !!categoryId && isFull(categoryId);

  // A category the tournament does not run is hidden from the entry forms, but any that
  // already hold entries stay visible so existing entries can never disappear from the desk.
  const listedCategories = useMemo(
    () =>
      (categories ?? []).filter(
        (c) => c.active || (teams ?? []).some((t) => t.category_id === c.id),
      ),
    [categories, teams],
  );

  const refresh = () => {
    qc.invalidateQueries();
  };

  const addPlayer = async () => {
    try {
      const created = await createPlayer({ name, email, phone, gender });
      // Put the new person straight into the entry being built: the next thing anyone does
      // with a walk-in is enter them.
      const person: Player = { id: created, name: name.trim(), gender: gender || null };
      if (!p1) setP1(person);
      else if (isPair && !p2) setP2(person);
      setName("");
      setEmail("");
      setPhone("");
      setGender("");
      toast.success("Player added");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add player");
    }
  };

  const addEntry = async () => {
    try {
      if (!categoryId || !p1) return;
      if (isPair && !p2) throw new Error("This category needs a pair — pick both players.");
      if (isPair && p1.id === p2?.id) throw new Error("A pair needs two different players.");
      await createTeam({ categoryId, player1: p1.id, player2: isPair && p2 ? p2.id : null });
      setP1(null);
      setP2(null);
      toast.success("Entry added");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add entry");
    }
  };

  const stats = useMemo(() => {
    const all = teams ?? [];
    const active = all.filter((t) => !t.withdrawn);
    const withdrawn = all.length - active.length;
    const entered = new Set<string>();
    // How many players sit at each number of categories. `categoryCount` already
    // excludes withdrawn entries, so this agrees with the database trigger.
    const byCount = new Map<number, number>();
    for (const [pid, set] of categoryCount) {
      entered.add(pid);
      byCount.set(set.size, (byCount.get(set.size) ?? 0) + 1);
    }
    return {
      /** The people with an entry in *this* tournament, which is the count a reader means. */
      entered: entered.size,
      entries: all.length,
      active: active.length,
      withdrawn,
      byCount,
    };
  }, [teams, categoryCount]);

  // Real field sizes, once there are entries: withdrawn teams do not take court time.
  const fieldSizes = useMemo(
    () => activeCategories.map((category) => activeEntryCount(category.id)).filter((n) => n > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeCategories, teams],
  );

  return (
    <Page
      title="Entries"
      subtitle={canEdit ? capSubtitle(categoryCap) : "Who is playing in each event."}
    >
      {/* Before the tournament starts, an editor can see whether these entries fit the hall. */}
      {canEdit && tournament?.status === "upcoming" && fieldSizes.length > 0 ? (
        <CapacityEstimate
          className="mb-4"
          eventCount={fieldSizes.length}
          entrantsPerEvent={fieldSizes}
          days={
            tournament.starts_on
              ? countIsoDays(
                  String(tournament.starts_on).slice(0, 10),
                  String(tournament.ends_on ?? tournament.starts_on).slice(0, 10),
                )
              : 0
          }
        />
      ) : null}

      {/*
        What a reader needs is how big the field is. The roster-wide player count, the players
        with no entry and the two cap tiles are the desk's bookkeeping - they describe the
        whole player list and the entry limit, which only somebody adding entries acts on - so
        they are drawn for an editor and not for a reader.
      */}
      <div
        className={cn(
          // A reader's two counts sit side by side on a phone rather than filling its first screen.
          "mb-4 grid gap-3 sm:grid-cols-2",
          canEdit ? "grid-cols-1" : "grid-cols-2",
          canEdit ? "lg:grid-cols-3 xl:grid-cols-6" : "lg:grid-cols-4",
        )}
      >
        <StatTile label="Players" value={teams ? stats.entered : null} hint="Taking part" />
        <StatTile label="Entries" value={teams ? stats.entries : null} hint="Across all categories" />
        {/*
          "Still in the draw" is the desk's count of who can still be scheduled. To a reader -
          and on a finished tournament, to anyone - it read as a live state the event is not in.
        */}
        {canEdit && tournament?.status !== "completed" ? (
          <StatTile
            label="Active"
            value={teams ? stats.active : null}
            tone="good"
            hint="Still in the draw"
          />
        ) : null}
        {canEdit || stats.withdrawn > 0 ? (
          <StatTile
            label="Withdrawn"
            value={stats.withdrawn}
            tone={stats.withdrawn > 0 ? "warn" : "normal"}
            hint="Pulled out"
          />
        ) : null}
        {(canEdit ? CAP_LEVELS : []).map((level) => {
          const count = stats.byCount.get(level) ?? 0;
          // At or past the configured cap this level cannot enter again; below
          // it, the entry is still open, so the tiles say different things.
          const locked = level >= categoryCap;
          return (
            <StatTile
              key={level}
              label={capLabel(level)}
              value={count}
              tone={locked && count > 0 ? "warn" : "normal"}
              hint={locked ? "Cannot enter more" : "Can enter another"}
            />
          );
        })}
      </div>

      <div className={cn("grid grid-cols-1 gap-4", canEdit && "lg:grid-cols-[340px_1fr]")}>
        {canEdit ? (
        <div className="space-y-4">
          <Panel title="Add player">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="pname">Name</Label>
                <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pemail">Email</Label>
                <Input id="pemail" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pphone">Phone</Label>
                <Input id="pphone" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pgender">Gender</Label>
                <Select value={gender} onValueChange={setGender}>
                  <SelectTrigger id="pgender">
                    <SelectValue placeholder="Required for category checks" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="M">Male</SelectItem>
                    <SelectItem value="F">Female</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                className="w-full"
                disabled={!canEdit || !name.trim()}
                onClick={addPlayer}
              >
                Add player
              </Button>
            </div>
          </Panel>

          <Panel title="Add entry">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="pcategory">Category</Label>
                <Select value={categoryId} onValueChange={setCategoryId}>
                  <SelectTrigger id="pcategory">
                    <SelectValue placeholder="Choose category" />
                  </SelectTrigger>
                  <SelectContent>
                    {openCategories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.code} — {c.name}
                        {c.max_entries != null
                          ? ` (${activeEntryCount(c.id)}/${c.max_entries})`
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!openCategories.length ? (
                  <p className="text-sm text-warn-foreground">
                    Every category this tournament runs is either full or switched off.
                  </p>
                ) : null}
                {selectedIsFull ? (
                  <p className="text-sm text-danger-foreground">
                    That category is full — withdraw an entry to make room.
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="p1">{isPair ? "Player 1" : "Player"}</Label>
                <PlayerPicker
                  id="p1"
                  tournamentId={tournament?.id ?? null}
                  selected={p1}
                  onChange={setP1}
                  exclude={new Set(p2 ? [p2.id] : [])}
                  hidden={atCap}
                />
              </div>
              {isPair ? (
                <div className="space-y-1.5">
                  <Label htmlFor="p2">Player 2</Label>
                  <PlayerPicker
                    id="p2"
                    tournamentId={tournament?.id ?? null}
                    selected={p2}
                    onChange={setP2}
                    exclude={new Set(p1 ? [p1.id] : [])}
                    hidden={atCap}
                  />
                </div>
              ) : null}
              <Button
                className="w-full"
                disabled={!canEdit || !categoryId || !p1 || selectedIsFull}
                onClick={addEntry}
              >
                Add entry
              </Button>
              <p className="text-sm text-muted-foreground">{capPickerNote(categoryCap)}</p>
            </div>
          </Panel>
        </div>
        ) : null}

        <div className="space-y-4">
          {listedCategories.map((c) => {
            const list = (teams ?? []).filter((t) => t.category_id === c.id);
            const activeCount = list.filter((t) => !t.withdrawn).length;
            const full = isFull(c.id);
            return (
              <Panel
                key={c.id}
                title={`${c.code} — ${c.name}`}
                right={
                  <span className="flex items-center gap-2">
                    {!c.active ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        Closed
                      </span>
                    ) : full ? (
                      <span className="rounded-full bg-danger-surface px-2 py-0.5 text-sm font-semibold uppercase tracking-wide text-danger-foreground">
                        Full
                      </span>
                    ) : null}
                    <span className="font-score text-sm text-muted-foreground">
                      {activeCount}
                      {c.max_entries != null ? ` / ${c.max_entries}` : ""} entries
                    </span>
                  </span>
                }
              >
                {list.length === 0 ? (
                  <EmptyState
                    title="No entries yet"
                    hint={
                      canEdit
                        ? "Add players on the left, then create an entry."
                        : "Nobody has entered this category yet."
                    }
                  />
                ) : (
                  <ul className="divide-y divide-hairline">
                    {list.map((t) => (
                      <li
                        key={t.id}
                        className="-mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/50"
                      >
                        <span
                          className={`min-w-0 break-words ${t.withdrawn ? "text-muted-foreground line-through" : ""}`}
                        >
                          {teamLabel(t, playerMap)}
                        </span>
                        <span className="flex gap-2">
                          {canEdit ? (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={async () => {
                                  // Withdrawing flags the entry only. Once matches exist the draw
                                  // and schedule keep the team until a walkover is recorded, so
                                  // say what is left behind before the click takes effect.
                                  if (!t.withdrawn) {
                                    const warning = withdrawalWarning(
                                      teamLabel(t, playerMap),
                                      withdrawalImpact({
                                        teamId: t.id,
                                        entrants: entrants ?? [],
                                        placementMatches: placementMatches ?? [],
                                        tierMatches: tierMatches ?? [],
                                      }),
                                    );
                                    if (warning && !window.confirm(warning)) return;
                                  }
                                  try {
                                    if (!t.withdrawn) {
                                      /*
                                       * A tournament that has started is withdrawn through the RPC,
                                       * which is the whole act: the flag, the waiver, a walkover for
                                       * every unplayed match, the bracket advance and the reflow, in
                                       * one transaction. `setTeamWithdrawn` is the pre-draw half of
                                       * that - it only flags the row, which is why the sync that
                                       * turns it into a waiver is refused once matches exist.
                                       *
                                       * The warning above still runs first: it names the matches and
                                       * says what happens to them, and the RPC then does it.
                                       */
                                      if (tournament?.status !== "upcoming") {
                                        const converted = await withdrawPlacementTeam(t.id);
                                        toast.success(
                                          converted === 0
                                            ? "Entry withdrawn"
                                            : `Entry withdrawn · ${converted} unplayed match${converted === 1 ? "" : "es"} awarded as a walkover`,
                                        );
                                        refresh();
                                        return;
                                      }
                                    }
                                    await setTeamWithdrawn(t.id, !t.withdrawn);
                                    refresh();
                                  } catch (error) {
                                    toast.error(
                                      error instanceof Error
                                        ? error.message
                                        : "Could not update the entry",
                                    );
                                  }
                                }}
                              >
                                {t.withdrawn ? "Reinstate" : "Withdraw"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={async () => {
                                  try {
                                    await deleteTeam(t.id);
                                    refresh();
                                  } catch (error) {
                                    toast.error(
                                      error instanceof Error
                                        ? error.message
                                        : "Could not remove entry",
                                    );
                                  }
                                }}
                              >
                                Remove
                              </Button>
                            </>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            );
          })}
        </div>
      </div>
    </Page>
  );
}
