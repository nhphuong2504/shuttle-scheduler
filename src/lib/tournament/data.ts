import {
  keepPreviousData,
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useSession } from "@/hooks/useSession";
import { supabase } from "@/integrations/supabase/client";
import {
  normalizeTournamentStatus,
  type TournamentAccess,
  type TournamentStatus,
} from "@/lib/auth/authorization";
import type { Database } from "@/integrations/supabase/types";
import {
  normalizeRegistrationDecision,
  normalizeRegistrationState,
  type RegistrationDecision,
  type RegistrationState,
} from "@/lib/tournament/registration-state";
import {
  toRegistrationQueue,
  type RegistrationQueue,
  type ReviewRegistrationRow,
} from "@/lib/tournament/registration";

export type Category = Database["public"]["Tables"]["categories"]["Row"];
export type Court = Database["public"]["Tables"]["courts"]["Row"];
export type Player = {
  id: string;
  name: string;
  gender: string | null;
  email?: string | null;
  phone?: string | null;
  created_at?: string | undefined;
};
export type Team = Database["public"]["Tables"]["teams"]["Row"];
export type Pool = Database["public"]["Tables"]["pools"]["Row"];
export type PoolEntry = Database["public"]["Tables"]["pool_entries"]["Row"];
export type PoolMatch = Database["public"]["Tables"]["pool_matches"]["Row"];
export type Draw = Database["public"]["Tables"]["draws"]["Row"];
export type DrawMatch = Database["public"]["Tables"]["draw_matches"]["Row"];
export type Tournament = Database["public"]["Tables"]["tournaments"]["Row"];
export type TournamentDay = Database["public"]["Tables"]["tournament_days"]["Row"];
export type TournamentDayCourt = Database["public"]["Tables"]["tournament_day_courts"]["Row"];
export type TournamentDayBreak = Database["public"]["Tables"]["tournament_day_breaks"]["Row"];
export type TournamentEditor = Database["public"]["Tables"]["tournament_editors"]["Row"];
export type Profile = Database["public"]["Tables"]["profiles"]["Row"];

/**
 * The editor roster as the access panel receives it: membership joined to the person,
 * plus the owner flagged in the same list because "who can edit this" is one question.
 *
 * `profile_id` is a person, never an identity, and it is present for every row - the
 * owner's profile exists before their identity does, so unlike the Phase 1 shape there
 * is no "has not signed in yet" row that cannot be acted on.
 */
export interface TournamentEditorRow {
  profile_id: string;
  email: string;
  is_owner: boolean;
  created_at: string;
}

/**
 * The two-round placement format's own tables. These are deliberately separate
 * from `pools`/`pool_matches`/`draws`/`draw_matches`, which the legacy
 * round-robin engine still owns, so no hook has to guess which format it is
 * looking at.
 */
export type PlacementEntrant = Database["public"]["Tables"]["placement_entrants"]["Row"];
export type PlacementMatch = Database["public"]["Tables"]["placement_matches"]["Row"];
export type TierDraw = Database["public"]["Tables"]["tier_draws"]["Row"];
export type TierDrawMatch = Database["public"]["Tables"]["tier_draw_matches"]["Row"];

/** The stages the legacy round-robin scheduler knows how to place. */
export type StageName = "group" | "knockout";

/**
 * The stages the placement format schedules. `placement` replaces `group` as the
 * first stage and `knockout` here means the A/B/C/D tier draws.
 */
export type PlacementStageName = "placement" | "knockout";

/**
 * The kinds of conflict `schedule_conflicts(uuid)` reports about a published schedule.
 *
 * Computed, never stored: a conflict is a property of the rows as they stand, so it
 * disappears the moment the desk fixes it rather than needing to be cleared by hand.
 *
 * Each is reported only against a match the desk can still act on - one still
 * `scheduled` (`past_closing` also covers an `in-progress` match) - so a match that
 * has already been played is never flagged. Being merely *late* is not here either:
 * the desk's own overdue alert covers that.
 */
export type ScheduleConflictKind =
  | "court_overlap"
  | "rest_shortfall"
  | "break"
  | "past_closing"
  | "before_prerequisite";

/** One reason a still-scheduled match cannot currently be played as published. */
export interface ScheduleConflict {
  match_table: string;
  match_id: string;
  court_id: string | null;
  scheduled_time: string | null;
  ended_at: string | null;
  conflict_kind: ScheduleConflictKind;
  detail: string;
}

async function must<T>(
  p: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return (data ?? []) as T;
}

/**
 * Every tournament-scoped query key ends with the tournament id, so switching
 * the active tournament invalidates the whole cache slice at once.
 */
export function scopedKey(base: readonly unknown[], tournamentId: string | null | undefined) {
  return [...base, tournamentId ?? null];
}

export const keys = {
  categories: ["categories"] as const,
  courts: ["courts"] as const,
  players: ["players"] as const,
  teams: ["teams"] as const,
  pools: ["pools"] as const,
  poolEntries: ["pool_entries"] as const,
  poolMatches: ["pool_matches"] as const,
  draws: ["draws"] as const,
  drawMatches: ["draw_matches"] as const,
  myProfile: ["my_profile"] as const,
  editorTournaments: ["editor_tournaments"] as const,
  /** The ids of the tournaments the caller owns. The other half is `editorTournaments`. */
  ownedTournaments: ["owned_tournaments"] as const,
  /**
   * The summary read behind Explore, My Tournaments and the create flow's list.
   *
   * One base key with a discriminator appended, so a filter change is a new cache entry
   * rather than a shared one: Explore's search term and My Tournaments' id set are
   * different questions about the same rows.
   */
  tournamentSummaries: ["tournament_summaries"] as const,
  /** The one-word answer from `tournament_registration_state`, per tournament. */
  registrationState: ["registration_state"] as const,
  /** The caller's own registration request, per tournament. */
  myRegistration: ["my_registration"] as const,
  /** The reviewer's queue of registration requests, per tournament. */
  registrationQueue: ["registration_queue"] as const,
  tournamentDays: ["tournament_days"] as const,
  tournamentById: ["tournament_by_id"] as const,
  tournamentReadiness: ["tournament_readiness"] as const,
  /** The computed conflicts in a schedule, per tournament. See `schedule_conflicts`. */
  scheduleConflicts: ["schedule_conflicts"] as const,
  dayCourts: ["tournament_day_courts"] as const,
  dayBreaks: ["tournament_day_breaks"] as const,
  tournamentEditors: ["tournament_editors"] as const,
  placementEntrants: ["placement_entrants"] as const,
  placementMatches: ["placement_matches"] as const,
  tierDraws: ["tier_draws"] as const,
  tierDrawMatches: ["tier_draw_matches"] as const,
  currentTournamentPointer: ["current_tournament_pointer"] as const,
};

/**
 * The caller's working tournament, as `current_tournament_id()` resolves it.
 *
 * Read for redirects rather than for rendering - since S3 the route's `$tournamentId`
 * decides what a page shows - and for the two surfaces that are *about* the caller rather
 * than about a page: Home's Continue card and, from S7, the switcher. What it no longer
 * decides is where `/` goes, because S6 made that a page of its own.
 *
 * The readers are components rather than route loaders, deliberately: the pointer is a
 * session fact, and a `beforeLoad` also runs during server rendering, where the request is
 * anonymous and `current_tournament_id()` would answer with the public desk default. See
 * `components/workspace-redirect.tsx` for that argument in full.
 *
 * Deliberately not cached in React state and deliberately short-lived at the call site:
 * a stale pointer would send a caller to the tournament they just switched away from.
 */
export function currentTournamentPointerQueryOptions() {
  return {
    queryKey: keys.currentTournamentPointer,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("current_tournament_id");
      if (error) throw new Error(error.message);
      return (data as string | null) ?? null;
    },
  };
}

/**
 * The pointer as a hook, for the surfaces that are *about* the caller rather than about
 * one tournament.
 *
 * Pages under the workspace never need this: their route names the tournament and the
 * layout publishes it, which is why `useScopedTournament` exists. This is the other
 * direction - "which tournament is this person working in" - and its callers are the
 * settings list's marker and (S7) the switcher, both of which talk about the caller's
 * choice rather than about the page they are on.
 */
export function useCurrentTournamentPointer() {
  return useQuery(currentTournamentPointerQueryOptions());
}

/**
 * The tournament a workspace is scoped to, and the caller's access to it.
 *
 * This used to be a *global* read - `current_tournament_id()` resolved the caller's
 * pointer and every scoped hook keyed off that one answer. The pointer is still how a
 * user's working tournament is chosen, but it is no longer how a page finds out which
 * tournament it is showing: the route owns that
 * (`/tournaments/$tournamentId/...`), and it publishes the answer here, so the scoped
 * hooks below keep their shape while resolving from the URL instead of from a global.
 *
 * Two consequences worth stating, because they are the point of the change:
 *
 *  - **The same URL is the same tournament for everyone.** A link opened by the owner
 *    and by a viewer resolves to one tournament, not to each reader's own pointer.
 *    That is what makes a workspace linkable at all, and it is why the pointer is no
 *    longer consulted to decide what to render.
 *  - **The pointer is now only a navigation convenience.** `set_current_tournament`
 *    (S7) lets the switcher move it; it is a distinct concern from what a page shows.
 */
export interface TournamentScopeValue {
  /** The tournament the route names, or null while it is still loading. */
  tournament: Tournament | null;
  /** Its id, or null while loading. The scoped hooks key on this. */
  tournamentId: string | null;
  /** The caller's access to it. All-false for a viewer and for a visitor. */
  access: TournamentAccess;
  /** True until the access read resolves, so a caller can tell "no" from "not yet". */
  accessLoading: boolean;
}

export const TournamentScopeContext = createContext<TournamentScopeValue | null>(null);

/**
 * The scope, or an error.
 *
 * Throwing rather than returning a null-ish default is deliberate: a scoped hook used
 * outside the layout would otherwise silently query nothing and render an empty screen,
 * which is the failure mode the context exists to remove. A missing provider is a
 * routing mistake, and it should be loud.
 */
export function useTournamentContext(): TournamentScopeValue {
  const value = useContext(TournamentScopeContext);
  if (!value) {
    throw new Error(
      "useTournamentContext: no TournamentScopeContext. Scoped reads belong under " +
        "src/routes/tournaments/$tournamentId/route.tsx, which provides it.",
    );
  }
  return value;
}

/** The tournament the route names. Replaces the global `useActiveTournament()`. */
export function useScopedTournament(): Tournament | null {
  return useTournamentContext().tournament;
}

/** Its id. Replaces the global `useTournamentId()`. */
export function useTournamentId(): string | null {
  return useTournamentContext().tournamentId;
}

/** The caller's access, resolved once by the layout rather than once per page. */
export function useScopedAccess(): TournamentAccess {
  return useTournamentContext().access;
}

export function useScopedAccessLoading(): boolean {
  return useTournamentContext().accessLoading;
}

export function useTournamentDays() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.tournamentDays, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<TournamentDay[]>(
        supabase
          .from("tournament_days")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("day_number"),
      ),
  });
}

/**
 * The scoped tournament plus its ordered days, which is what the UI mostly wants.
 *
 * Named `useTournamentScope` before the route context existed; it is kept because
 * callers read it as "the tournament and its days", which is still what it returns.
 */
export function useTournamentScope() {
  const scope = useTournamentContext();
  const daysQuery = useTournamentDays();
  return {
    tournament: scope.tournament,
    days: daysQuery.data ?? [],
    loading: daysQuery.isLoading,
  };
}

/**
 * The caller's own profile.
 *
 * Needed because ownership is stored as a *profile* id - `tournaments.owner_profile_id` -
 * and the session only knows the auth user id. Comparing the two directly would be
 * wrong rather than merely awkward: a profile outlives its identity, which is what lets
 * ownership survive a staging re-import, so the two ids are genuinely different things.
 *
 * One read, and the `profiles` policy returns only the caller's own row.
 */
export function useMyProfile() {
  const { session } = useSession();
  const userId = session?.userId ?? null;
  return useQuery({
    queryKey: [...keys.myProfile, userId],
    enabled: !!userId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const rows = await must<Profile[]>(
        supabase.from("profiles").select("*").eq("user_id", userId as string).limit(1),
      );
      return rows[0] ?? null;
    },
  });
}

/**
 * The ids of tournaments the caller is explicitly an editor of - not the ones they own.
 *
 * One read for the whole list, so a page that lists tournaments does not have to call
 * `tournament_access` once per row. The `tournament_editors` policy lets anyone signed in
 * read their own membership, which is exactly this query.
 *
 * The key is the caller's *profile*, not their auth identity: membership is held by a
 * person now, so this waits on `useMyProfile` and asks nothing until it has one. The two
 * ids are genuinely different values, and comparing them would silently return nothing.
 *
 * This mirrors `can_edit_tournament` for rendering; it is not the gate. Every write still
 * re-checks on the server.
 */
export function useEditorTournamentIds() {
  const { data: profile } = useMyProfile();
  const profileId = profile?.id ?? null;
  return useQuery({
    queryKey: [...keys.editorTournaments, profileId],
    enabled: !!profileId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tournament_editors")
        .select("tournament_id")
        .eq("profile_id", profileId as string);
      if (error) throw new Error(error.message);
      return new Set((data ?? []).map((row) => row.tournament_id));
    },
  });
}

/**
 * A single tournament by id.
 *
 * This is the layout route's loader: unlike the scoped hooks it cannot read the scope,
 * because resolving the scope is what it is for. The creation wizard uses it too, to
 * open a tournament that is not the one in the URL.
 */
export function useTournamentById(tournamentId: string | null | undefined) {
  return useQuery({
    queryKey: scopedKey(keys.tournamentById, tournamentId),
    enabled: !!tournamentId,
    queryFn: async () => {
      const rows = await must<Tournament[]>(
        supabase
          .from("tournaments")
          .select("*")
          .eq("id", tournamentId as string)
          .limit(1),
      );
      return rows[0] ?? null;
    },
  });
}

/**
 * A tournament as a list or a card needs it, from one read.
 *
 * `tournament_summary` returns this shape for every row, so Explore, My Tournaments and the
 * create flow's list cannot disagree about a status word, a start time, a count or whether
 * the caller may edit it. The alternative - which this replaced - was the client reading
 * the whole `tournaments` table and deriving all four, which is four places for the answer
 * to drift from the database.
 */
export type TournamentSummaryAccess = "admin" | "owner" | "editor" | "viewer";

export interface TournamentSummary {
  id: string;
  name: string;
  venue_name: string | null;
  status: TournamentStatus;
  /** The tournament window as instants: 00:00 of its first date, and 00:00 after its last. */
  starts_at: string | null;
  ends_at: string | null;
  /** The first and last playing day as instants. Null until playing days are chosen. */
  play_starts_at: string | null;
  play_ends_at: string | null;
  /** The window as one word, decided by the database rather than by the browser's clock. */
  registration_state: RegistrationState;
  /** Entries (`teams`), which is the entry per I3 - never a derived projection. */
  entry_count: number;
  category_count: number;
  access_level: TournamentSummaryAccess;
}

export interface TournamentSummaryParams {
  /** Matches the name, the venue or one of the tournament's events. */
  query?: string | null;
  status?: TournamentStatus | null;
  /** Restrict to a set. An empty array is "nothing to show", not "everything". */
  ids?: readonly string[] | null;
  limit?: number | null;
  offset?: number | null;
}

/**
 * The summary read, with the vocabulary narrowed on the way in.
 *
 * `tournament_summary` is a `text`-returning read, so PostgREST cannot promise the status
 * word is one of three or the registration state one of seven. Narrowing here means the
 * pages below can switch exhaustively on both, and an unrecognised value renders as the
 * safe member rather than as whatever string arrived.
 */
export async function fetchTournamentSummaries(
  params: TournamentSummaryParams = {},
): Promise<TournamentSummary[]> {
  // Every filter is *omitted* rather than sent as `null`: PostgREST drops a key it is not
  // given, so the function's own defaults apply, and an absent filter cannot be confused
  // with a filter whose value is null. Built by assignment because the generated Args type
  // is `exactOptionalPropertyTypes`, where an explicit `undefined` is not an omission.
  const args: Database["public"]["Functions"]["tournament_summary"]["Args"] = {};
  if (params.query) args.p_query = params.query;
  if (params.status) args.p_status = params.status;
  if (params.ids) args.p_ids = [...params.ids];
  if (params.limit != null) args.p_limit = params.limit;
  if (params.offset != null) args.p_offset = params.offset;

  const { data, error } = await supabase.rpc("tournament_summary", args);
  if (error) throw new Error(error.message);
  return (data ?? []).map(toTournamentSummary);
}

/**
 * One summary row, with the vocabularies narrowed.
 *
 * Shared by every read that returns the card shape - `tournament_summary` and
 * `explore_tournaments` - so a card cannot be built from the same fields two different ways.
 */
function toTournamentSummary(row: {
  id: string;
  name: string;
  venue_name: string | null;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  play_starts_at?: string | null;
  play_ends_at?: string | null;
  registration_state: string;
  entry_count: number | null;
  category_count: number | null;
  access_level: string;
}): TournamentSummary {
  return {
    id: row.id,
    name: row.name,
    venue_name: row.venue_name,
    status: normalizeTournamentStatus(row.status),
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    play_starts_at: row.play_starts_at ?? null,
    play_ends_at: row.play_ends_at ?? null,
    registration_state: normalizeRegistrationState(row.registration_state),
    entry_count: row.entry_count ?? 0,
    category_count: row.category_count ?? 0,
    access_level:
      row.access_level === "admin" ||
      row.access_level === "owner" ||
      row.access_level === "editor"
        ? row.access_level
        : "viewer",
  };
}

/** The date windows Explore offers, as `explore_tournaments` spells them. */
export const EXPLORE_RANGES = ["week", "month", "quarter"] as const;
export type ExploreRange = (typeof EXPLORE_RANGES)[number];

/** The orders Explore offers, as `explore_tournaments` spells them. */
export const EXPLORE_SORTS = ["soonest", "newest", "entries", "name"] as const;
export type ExploreSort = (typeof EXPLORE_SORTS)[number];

/** What narrows the list, apart from the status, which each section asks for itself. */
export interface ExploreFilters {
  query?: string | null;
  registrationOpen?: boolean;
  range?: ExploreRange | null;
  sort?: ExploreSort;
}

/** One page of the list and the size of the whole result it was cut from. */
export interface ExplorePage {
  rows: TournamentSummary[];
  total: number;
}

export async function fetchExplorePage(
  params: ExploreFilters & { status?: TournamentStatus | null; limit: number; offset: number },
): Promise<ExplorePage> {
  // Every filter is omitted rather than sent as null, for the reason fetchTournamentSummaries
  // gives: an absent argument takes the function's default, and cannot be mistaken for a
  // filter whose value is null.
  const args: Database["public"]["Functions"]["explore_tournaments"]["Args"] = {
    p_limit: params.limit,
    p_offset: params.offset,
  };
  const query = params.query?.trim();
  if (query) args.p_query = query;
  if (params.status) args.p_status = params.status;
  if (params.registrationOpen) args.p_registration_open = true;
  if (params.range) args.p_range = params.range;
  if (params.sort) args.p_sort = params.sort;

  const { data, error } = await supabase.rpc("explore_tournaments", args);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  return { rows: rows.map(toTournamentSummary), total: rows[0]?.total_count ?? 0 };
}

export async function fetchExploreCounts(
  filters: ExploreFilters,
): Promise<Record<TournamentStatus, number>> {
  const args: Database["public"]["Functions"]["explore_tournament_counts"]["Args"] = {};
  const query = filters.query?.trim();
  if (query) args.p_query = query;
  if (filters.registrationOpen) args.p_registration_open = true;
  if (filters.range) args.p_range = filters.range;

  const { data, error } = await supabase.rpc("explore_tournament_counts", args);
  if (error) throw new Error(error.message);
  const counts: Record<TournamentStatus, number> = { upcoming: 0, in_progress: 0, completed: 0 };
  for (const row of data ?? []) counts[normalizeTournamentStatus(row.status)] = row.total;
  return counts;
}

/**
 * The caller's own tournaments, in the two groups My Tournaments draws.
 *
 * "Owned by me" is `owner_profile_id = my profile` and "shared with me" is a
 * `tournament_editors` row for my profile. The two are asked separately and then unioned
 * into *one* summary read, rather than one read per group, because a page that asked
 * twice could render the same tournament twice and a page that asked per row would issue
 * a request per card.
 *
 * Which group a row belongs to is decided by those two id sets and not by
 * `access_level`: an `access_level` of `admin` means the caller is a platform admin, and
 * a platform admin who neither owns nor edits a tournament is not in this list at all -
 * so a group derived from the access word would silently drop an admin's own tournaments.
 */
export function useMyTournaments() {
  const profileQuery = useMyProfile();
  const profileId = profileQuery.data?.id ?? null;
  const editorIdsQuery = useEditorTournamentIds();

  const ownedIds = useQuery({
    queryKey: [...keys.ownedTournaments, profileId],
    enabled: !!profileId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tournaments")
        .select("id")
        .eq("owner_profile_id", profileId as string)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => row.id);
    },
  });

  const editorIds = useMemo(
    () => (editorIdsQuery.data ? [...editorIdsQuery.data].sort() : []),
    [editorIdsQuery.data],
  );
  const owned = useMemo(() => ownedIds.data ?? [], [ownedIds.data]);

  const ids = useMemo(() => [...new Set([...owned, ...editorIds])].sort(), [owned, editorIds]);

  const summaries = useQuery({
    queryKey: [...keys.tournamentSummaries, "mine", ids.join(",")],
    enabled: !!profileId && ownedIds.isSuccess && editorIdsQuery.isSuccess,
    // An empty id set would be read by the database as "everything" if it were sent as
    // null, and as "nothing" if sent as an empty array. Neither is wanted here: the
    // question is "which tournaments are mine", and with none the answer is no rows.
    queryFn: () => (ids.length === 0 ? Promise.resolve([]) : fetchTournamentSummaries({ ids })),
  });

  return {
    summaries: summaries.data ?? [],
    /** The ids the caller owns. The other half of the grouping is `editorIds`. */
    ownedIds: useMemo(() => new Set(owned), [owned]),
    /** The ids the caller is an editor of, excluding their own. */
    editorIds: useMemo(() => new Set(editorIds), [editorIds]),
    /** True until both halves of the answer are known, so a page can wait rather than flash. */
    isLoading:
      profileQuery.isLoading ||
      editorIdsQuery.isLoading ||
      ownedIds.isLoading ||
      summaries.isLoading,
    isError: summaries.isError || editorIdsQuery.isError || ownedIds.isError,
    error: summaries.error ?? editorIdsQuery.error ?? ownedIds.error,
  };
}

/**
 * Explore: every tournament, filtered by a search term and a lifecycle word.
 *
 * `query` is matched by the database over the name, the venue and the events, so this is
 * one read whatever the term. The status filter is validated by the function rather than
 * ignored, so a page cannot render an unfiltered list under a filter label.
 */
export function useExploreTournaments(params: {
  query?: string | null;
  status?: TournamentStatus | null;
}) {
  const query = params.query?.trim() ?? "";
  const status = params.status ?? null;

  return useQuery({
    queryKey: [...keys.tournamentSummaries, "explore", query, status],
    queryFn: () => fetchTournamentSummaries({ query, status }),
    // Keeps the previous page's rows on screen while the next answer arrives, which is
    // what stops the card grid blinking its way through every keystroke.
    placeholderData: (previous) => previous,
  });
}

/**
 * One status group of Explore, a page at a time.
 *
 * Each group is its own read - the page asks for live, upcoming and completed separately -
 * so a group pages on its own and a long list of finished tournaments cannot push a live one
 * out of sight. `loadMore` fetches the next `pageSize` rows; the rows already shown stay
 * where they are, and `total` is what the database says the whole group holds.
 *
 * `enabled` lets the page leave a group unread when a status filter has already chosen
 * another one.
 */
export function useExploreSection(
  status: TournamentStatus,
  filters: ExploreFilters,
  pageSize: number,
  enabled = true,
) {
  const query = filters.query?.trim() ?? "";
  const registrationOpen = filters.registrationOpen ?? false;
  const range = filters.range ?? null;
  const sort = filters.sort ?? "soonest";

  const result = useInfiniteQuery({
    queryKey: [
      ...keys.tournamentSummaries,
      "explore-section",
      status,
      query,
      registrationOpen,
      range,
      sort,
      pageSize,
    ],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchExplorePage({
        status,
        query,
        registrationOpen,
        range,
        sort,
        limit: pageSize,
        offset: pageParam,
      }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    // The previous answer stays on screen while a new filter loads, for the reason
    // useExploreTournaments gives.
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => result.data?.pages.flatMap((page) => page.rows) ?? [], [result.data]);
  return {
    rows,
    total: result.data?.pages[0]?.total ?? 0,
    isLoading: result.isLoading,
    isError: result.isError,
    error: result.error,
    hasMore: !!result.hasNextPage,
    isLoadingMore: result.isFetchingNextPage,
    loadMore: () => void result.fetchNextPage(),
    refetch: () => void result.refetch(),
  };
}

/** How many tournaments each status filter would show, for the numbers on its buttons. */
export function useExploreCounts(filters: ExploreFilters) {
  const query = filters.query?.trim() ?? "";
  const registrationOpen = filters.registrationOpen ?? false;
  const range = filters.range ?? null;
  return useQuery({
    queryKey: [...keys.tournamentSummaries, "explore-counts", query, registrationOpen, range],
    queryFn: () => fetchExploreCounts({ query, registrationOpen, range }),
    placeholderData: keepPreviousData,
  });
}


/**
 * One tournament's summary row, for a page that is *about* that tournament.
 *
 * The same read Explore and My Tournaments use, narrowed to one id, so the public tournament
 * page cannot describe a tournament differently from the card a person clicked to reach it.
 * `useTournamentById` still exists for the workspace layout, which needs the raw row's
 * configuration (`max_categories_per_player`, the format, the window instants) rather than
 * the card shape.
 */
export function useTournamentSummary(tournamentId: string | null | undefined) {
  return useQuery({
    queryKey: [...keys.tournamentSummaries, "one", tournamentId ?? null],
    enabled: !!tournamentId,
    queryFn: async () => {
      const rows = await fetchTournamentSummaries({
        ids: [tournamentId as string],
        limit: 1,
      });
      return rows[0] ?? null;
    },
  });
}

/**
 * The registration window as one word, from `tournament_registration_state`.
 *
 * Read separately from the summary even though the summary carries the same word, because
 * the Register panel's gate and its copy must come from the function that
 * `submit_tournament_registration` itself consults. The summary's copy is for a *card* -
 * "can I enter this" at a glance - and a page that offered a form on the strength of a
 * denormalised field in a list read would be one join away from disagreeing with the RPC.
 *
 * Public: the RPC is granted to `anon`, because deciding whether to register is something a
 * person may do before creating an account.
 */
export function useTournamentRegistrationState(tournamentId: string | null | undefined) {
  return useQuery({
    queryKey: scopedKey(keys.registrationState, tournamentId),
    enabled: !!tournamentId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("tournament_registration_state", {
        p_tournament_id: tournamentId as string,
      });
      if (error) throw new Error(error.message);
      return normalizeRegistrationState(data);
    },
  });
}

/** One requested event, as the participant's own panel draws it. */
export interface MyRegistrationEntry {
  entryId: string | null;
  categoryId: string | null;
  categoryCode: string | null;
  categoryName: string | null;
  entryType: string | null;
  partnerName: string | null;
  partnerEmail: string | null;
}

/** The caller's own registration request for one tournament. */
export interface MyRegistration {
  id: string;
  status: RegistrationDecision;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  entries: MyRegistrationEntry[];
}

/**
 * `my_tournament_registration`'s row, in the wire shape the RPC returns.
 *
 * Declared here rather than read from the generated types because that function's `RETURNS
 * TABLE` marks every column non-null in `types.ts`, while a request awaiting a decision
 * genuinely has no `decided_at`, and a request with no entries genuinely has no entry
 * columns. Building the type from the statement instead would be the client believing a lie
 * the generator cannot avoid.
 */
export interface MyRegistrationRow {
  registration_id: string;
  status: string;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  entry_id: string | null;
  category_id: string | null;
  category_code: string | null;
  category_name: string | null;
  entry_type: string | null;
  partner_name: string | null;
  partner_email: string | null;
}

/**
 * The RPC's one-row-per-entry answer, gathered into one request.
 *
 * Pure, and exported, so the gather is tested without a network: the row-per-entry shape is
 * what lets the queue and the participant's panel share one read, and the cost of it is this
 * fold. A request that somehow has no entries still produces one row with null entry columns
 * - which is what a Phase 1 row decided under the old form looks like - so an absent entry
 * must not be mistaken for an absent request.
 */
export function toMyRegistration(
  rows: readonly MyRegistrationRow[],
): MyRegistration | null {
  const first = rows[0];
  if (!first) return null;

  const entries: MyRegistrationEntry[] = [];
  for (const row of rows) {
    // The request's own columns repeat per row; only a row carrying an entry id adds one.
    if (row.entry_id == null) continue;
    entries.push({
      entryId: row.entry_id,
      categoryId: row.category_id,
      categoryCode: row.category_code,
      categoryName: row.category_name,
      entryType: row.entry_type,
      partnerName: row.partner_name,
      partnerEmail: row.partner_email,
    });
  }

  return {
    id: first.registration_id,
    status: normalizeRegistrationDecision(first.status),
    decidedAt: first.decided_at,
    decisionNote: first.decision_note,
    createdAt: first.created_at,
    entries,
  };
}

/**
 * The caller's own registration for one tournament, if they have one.
 *
 * Signed-in only: the RPC resolves the caller's profile, so an anonymous request would
 * return nothing anyway, and asking while signed out would be a request whose answer can
 * only be "no".
 */
export function useMyTournamentRegistration(tournamentId: string | null | undefined) {
  const { signedIn } = useSession();
  return useQuery({
    queryKey: scopedKey(keys.myRegistration, tournamentId),
    enabled: signedIn && !!tournamentId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_tournament_registration", {
        p_tournament_id: tournamentId as string,
      });
      if (error) throw new Error(error.message);
      return toMyRegistration((data ?? []) as unknown as MyRegistrationRow[]);
    },
  });
}

/**
 * The reviewer's queue for one tournament: every request, split into pending work and what
 * has already been decided.
 *
 * Editor-gated at the database, so the read is only issued for a caller who can edit rather
 * than asked and refused. The page passes `{ enabled: access.can_edit }` for that reason, and
 * the shell does the same for the nav badge - so the two share one cache entry and one fetch
 * rather than each making their own.
 */
export function useTournamentRegistrationQueue(
  tournamentId: string | null | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: scopedKey(keys.registrationQueue, tournamentId),
    enabled: enabled && !!tournamentId,
    queryFn: () => fetchRegistrationQueue(tournamentId as string),
  });
}

async function fetchRegistrationQueue(tournamentId: string): Promise<RegistrationQueue> {
  const { data, error } = await supabase.rpc("review_tournament_registrations", {
    p_tournament_id: tournamentId,
  });
  if (error) throw new Error(error.message);
  return toRegistrationQueue((data ?? []) as unknown as ReviewRegistrationRow[]);
}

/**
 * How many requests are waiting for a decision, for each of several tournaments.
 *
 * Home asks about every tournament the caller may edit, and a hook cannot be called in a loop,
 * so this is the same read as the queue above issued once per id. It shares the queue's cache
 * key, so a tournament whose queue is already open costs nothing, and the Registrations page
 * and the nav badge see the same answer. The ids passed are the caller's own, so the editor
 * gate on the read is met; an answer that fails reads as zero rather than as an error, since
 * "none waiting" is the safe thing for a summary line to say when it cannot tell.
 */
export function usePendingRegistrationCounts(tournamentIds: readonly string[]) {
  const results = useQueries({
    queries: tournamentIds.map((id) => ({
      queryKey: scopedKey(keys.registrationQueue, id),
      queryFn: () => fetchRegistrationQueue(id),
    })),
  });
  return useMemo(() => {
    const counts = new Map<string, number>();
    tournamentIds.forEach((id, index) => {
      counts.set(id, results[index]?.data?.pending.length ?? 0);
    });
    return counts;
    // `results` is a new array every render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentIds.join(","), results.map((r) => r.dataUpdatedAt).join(",")]);
}

export interface ReadinessCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string | null;
  /**
   * False for a check that is worth showing but must not hold activation back.
   * Absent means blocking, so an older database that has not been migrated still
   * reads as strict.
   */
  blocking?: boolean;
}

export interface TournamentReadiness {
  ready: boolean;
  checks: ReadinessCheck[];
}

/**
 * The authoritative pre-activation checklist. The same function guards the
 * activation RPC, so the review step can never disagree with the database.
 */
export function useTournamentReadiness(tournamentId: string | null | undefined) {
  return useQuery({
    queryKey: scopedKey(keys.tournamentReadiness, tournamentId),
    enabled: !!tournamentId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("tournament_readiness", {
        p_tournament_id: tournamentId as string,
      });
      if (error) throw new Error(error.message);
      return data as unknown as TournamentReadiness;
    },
  });
}

/** Per-day court availability, keyed to an explicit tournament. */
export function useTournamentDayCourts(tournamentId: string | null | undefined) {
  return useQuery({
    queryKey: scopedKey(keys.dayCourts, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<TournamentDayCourt[]>(
        supabase
          .from("tournament_day_courts")
          .select("*")
          .eq("tournament_id", tournamentId as string),
      ),
  });
}

/** Per-day break windows, keyed to an explicit tournament. */
export function useTournamentDayBreaks(tournamentId: string | null | undefined) {
  return useQuery({
    queryKey: scopedKey(keys.dayBreaks, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<TournamentDayBreak[]>(
        supabase
          .from("tournament_day_breaks")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("start_time"),
      ),
  });
}

/** Days for a specific tournament, so a non-active draft can be edited. */
export function useTournamentDaysFor(tournamentId: string | null | undefined) {
  return useQuery({
    queryKey: scopedKey(keys.tournamentDays, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<TournamentDay[]>(
        supabase
          .from("tournament_days")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("day_number"),
      ),
  });
}

/**
 * The venue's courts, in number order.
 *
 * Shared by the two hooks and the court-count writer, so a pool that has just grown can be
 * re-read for the rows it created without a second query definition drifting from this one.
 */
export function fetchCourts(tournamentId: string): Promise<Court[]> {
  return must<Court[]>(
    supabase
      .from("courts")
      .select("*")
      .eq("tournament_id", tournamentId)
      .order("number"),
  );
}

/** Courts for a specific tournament, so a non-active draft can be edited. */
export function useCourtsFor(tournamentId: string | null | undefined) {
  return useQuery({
    queryKey: scopedKey(keys.courts, tournamentId),
    enabled: !!tournamentId,
    queryFn: () => fetchCourts(tournamentId as string),
  });
}

/** Events for a specific tournament, so a non-active draft can be edited. */
export function useCategoriesFor(tournamentId: string | null | undefined) {
  return useQuery({
    queryKey: scopedKey(keys.categories, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<Category[]>(
        supabase
          .from("categories")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("sort_order"),
      ),
  });
}

/** Everything the creation wizard needs to hydrate one draft. */
export function useTournamentDraftData(tournamentId: string | null | undefined) {
  const tournamentQuery = useTournamentById(tournamentId);
  const daysQuery = useTournamentDaysFor(tournamentId);
  const courtsQuery = useCourtsFor(tournamentId);
  const dayCourtsQuery = useTournamentDayCourts(tournamentId);
  const dayBreaksQuery = useTournamentDayBreaks(tournamentId);
  const categoriesQuery = useCategoriesFor(tournamentId);

  const queries = [
    tournamentQuery,
    daysQuery,
    courtsQuery,
    dayCourtsQuery,
    dayBreaksQuery,
    categoriesQuery,
  ];

  return {
    tournament: tournamentQuery.data ?? null,
    days: daysQuery.data ?? [],
    courts: courtsQuery.data ?? [],
    dayCourts: dayCourtsQuery.data ?? [],
    dayBreaks: dayBreaksQuery.data ?? [],
    categories: categoriesQuery.data ?? [],
    isLoading: queries.some((q) => q.isLoading),
    isError: queries.some((q) => q.isError),
    error: queries.find((q) => q.error)?.error ?? null,
  };
}

/**
 * Groups open on day 1 and knockouts close on the final day. A single-day
 * tournament runs both stages on that day.
 */
export function stagesForDay(dayNumber: number, dayCount: number): StageName[] {
  // Expressed through the placement resolver rather than duplicating the day
  // arithmetic, so the two formats cannot disagree about which days carry a
  // stage. `group` is the legacy name for what the placement format calls
  // `placement`, and nothing else differs.
  return placementStagesForDay(dayNumber, dayCount).map((stage) =>
    stage === "placement" ? "group" : "knockout",
  );
}

/**
 * The two-round placement format's day layout: placement on day 1, the A/B/C/D
 * knockouts on the final day.
 *
 * A single-day tournament runs both stages that day, which is the case that makes
 * the ordering matter: placement matches must all finish before any knockout can
 * start. On a two-stage single day the scheduler relies on the knockout rows being
 * `awaitingTeams` until their brackets exist, so nothing to play is ever placed
 * ahead of the stage that feeds it.
 *
 * Like the legacy layout, this does not spill a stage across extra days. A second
 * day is a buffer day with a window but no stage.
 */
export function placementStagesForDay(dayNumber: number, dayCount: number): PlacementStageName[] {
  const stages: PlacementStageName[] = [];
  if (dayNumber === 1) stages.push("placement");
  if (dayNumber === dayCount && !stages.includes("knockout")) stages.push("knockout");
  return stages;
}

export function useCategories() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.categories, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<Category[]>(
        supabase
          .from("categories")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("sort_order"),
      ),
  });
}

export function useCourts() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.courts, tournamentId),
    enabled: !!tournamentId,
    queryFn: () => fetchCourts(tournamentId as string),
  });
}

/**
 * The people in the current tournament.
 *
 * Not the roster. `players` is global - one row per person ever entered anywhere - and this
 * used to read all of it through `public_players` on every page, which made the Entries screen
 * report the whole platform as "Players" and let anyone list everybody who had ever played.
 * A page wants the names of the people on *this* tournament's entries, and
 * `tournament_players` answers exactly that: id, name and gender of everyone with a team row
 * here, no email, no phone, no link. Pickers that need to reach beyond the tournament use
 * `searchPlayers` instead.
 */
export function usePlayers() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.players, tournamentId),
    enabled: !!tournamentId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("tournament_players", {
        p_tournament_id: tournamentId as string,
      });
      if (error) throw new Error(error.message);
      const players: Player[] = [];
      for (const row of data ?? []) {
        if (!row.id || !row.name) continue;
        players.push({ id: row.id, name: row.name, gender: row.gender });
      }
      return players;
    },
  });
}

/** Fewest characters the server will search on; shorter text is not worth a request. */
export const PLAYER_SEARCH_MIN_CHARS = 2;

/**
 * Looks a person up in the global roster by name, for the desk adding an entry.
 *
 * Editors of the tournament only, at least two characters, at most `limit` rows. Returns an
 * empty list for text that is too short rather than asking, so a half-typed box costs nothing.
 */
export async function searchPlayers(
  tournamentId: string,
  query: string,
  limit = 20,
): Promise<Player[]> {
  const text = query.trim();
  if (text.length < PLAYER_SEARCH_MIN_CHARS) return [];
  const { data, error } = await supabase.rpc("search_players", {
    p_tournament_id: tournamentId,
    p_query: text,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({ id: row.id, name: row.name, gender: row.gender }));
}

export function useTeams() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.teams, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<Team[]>(
        supabase
          .from("teams")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("created_at"),
      ),
  });
}

export function usePools() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.pools, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<Pool[]>(
        supabase
          .from("pools")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("name"),
      ),
  });
}

export function usePoolEntries() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.poolEntries, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<PoolEntry[]>(
        supabase
          .from("pool_entries")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("position"),
      ),
  });
}

export function usePoolMatches() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.poolMatches, tournamentId),
    enabled: !!tournamentId,
    refetchInterval: 20_000,
    queryFn: () =>
      must<PoolMatch[]>(
        supabase
          .from("pool_matches")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("round"),
      ),
  });
}

export function useDraws() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.draws, tournamentId),
    enabled: !!tournamentId,
    queryFn: () =>
      must<Draw[]>(
        supabase
          .from("draws")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("tier"),
      ),
  });
}

export function useDrawMatches() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.drawMatches, tournamentId),
    enabled: !!tournamentId,
    refetchInterval: 20_000,
    queryFn: () =>
      must<DrawMatch[]>(
        supabase
          .from("draw_matches")
          .select("*")
          .eq("tournament_id", tournamentId as string)
          .order("round"),
      ),
  });
}

/**
 * Everyone who can edit a tournament: the owner, and the editors they appointed.
 *
 * Read through the RPC rather than the table because the owner is a column on
 * `tournaments`, not a row in `tournament_editors`, and the panel must not have to
 * stitch those two sources together on the client. The RPC also enforces
 * `can_edit_tournament`, so a viewer gets an error rather than a roster.
 */
export function useTournamentEditors(tournamentId: string | null | undefined) {
  return useQuery({
    queryKey: scopedKey(keys.tournamentEditors, tournamentId),
    enabled: !!tournamentId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_tournament_editors", {
        p_tournament_id: tournamentId as string,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as TournamentEditorRow[];
    },
  });
}

/** How long the channel must be quiet before the cache is refetched. */
const REALTIME_DEBOUNCE_MS = 400;

export function useRealtimeRefresh() {
  const qc = useQueryClient();
  // Keep the first server and browser render identical; network state is only
  // available after hydration.
  const [status, setStatus] = useState<"connecting" | "live" | "offline" | "error">(
    "connecting",
  );
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => Date.now());
  useEffect(() => {
    const onOffline = () => setStatus("offline");
    const onOnline = () => setStatus("connecting");
    if (!navigator.onLine) setStatus("offline");
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    // One reported result writes the match, its activity row, every match it pushes and the
    // next round - dozens of events within a few hundred milliseconds. Refetching the whole
    // cache on each one is a storm on venue wifi (and `invalidateQueries` cancels the fetch in
    // flight each time), so a burst collapses into a single refetch once it goes quiet.
    let pending: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel("ops-live")
      .on("postgres_changes", { event: "*", schema: "public" }, () => {
        setLastUpdatedAt(Date.now());
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          pending = null;
          void qc.invalidateQueries();
        }, REALTIME_DEBOUNCE_MS);
      })
      .subscribe((next) => {
        if (!navigator.onLine) setStatus("offline");
        else if (next === "SUBSCRIBED") {
          setStatus("live");
          setLastUpdatedAt(Date.now());
        } else if (next === "CHANNEL_ERROR" || next === "TIMED_OUT") setStatus("error");
        else if (next === "CLOSED") setStatus("connecting");
      });
    return () => {
      if (pending) clearTimeout(pending);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      void supabase.removeChannel(channel);
    };
  }, [qc]);
  return { status, lastUpdatedAt };
}

export function teamLabel(team: Team | undefined, players: Map<string, Player>): string {
  if (!team) return "TBC";
  const a = players.get(team.player_1_id)?.name ?? "Unknown";
  const b = team.player_2_id ? players.get(team.player_2_id)?.name : null;
  return b ? `${a} / ${b}` : a;
}

export function teamPlayerIds(team: Team | undefined): string[] {
  if (!team) return [];
  return team.player_2_id ? [team.player_1_id, team.player_2_id] : [team.player_1_id];
}

export function indexBy<T extends { id: string }>(rows: readonly T[] | undefined): Map<string, T> {
  return new Map((rows ?? []).map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Two-round placement format
//
// These read the format's own tables. Ordered the way the desk reads them:
// entrants by seed, matches by stage then generation key, and each tier draw's
// matches by round and slot so a bracket renders top to bottom.
// ---------------------------------------------------------------------------

/**
 * Plain fetchers for the placement tables, shared by the hooks and the scheduler.
 *
 * The build path cannot read these through the query cache. `refetchQueries` resolves
 * as soon as its fetch settles into the cache, and when a fetch is already in flight
 * it resolves against *that* one — which may have been issued before the build's own
 * writes committed. A build that then read `getQueryData` planned from an empty match
 * list while the database held thirty-one rows, and the writer cleared the day and
 * rejected it as half-built. Returning the rows straight from the network removes the
 * cache from the critical path.
 *
 * These are the same queries the hooks run, so a change to one cannot disagree with
 * the other.
 */
export function fetchPlacementEntrants(tournamentId: string): Promise<PlacementEntrant[]> {
  return must<PlacementEntrant[]>(
    supabase
      .from("placement_entrants")
      .select("*")
      .eq("tournament_id", tournamentId)
      // Nulls last: unseeded entrants are shown after the seeded order rather
      // than jumbled into it, which is what makes the pre-lock list readable.
      .order("seed", { ascending: true, nullsFirst: false }),
  );
}

export function fetchPlacementMatches(tournamentId: string): Promise<PlacementMatch[]> {
  return must<PlacementMatch[]>(
    supabase
      .from("placement_matches")
      .select("*")
      .eq("tournament_id", tournamentId)
      .order("stage")
      .order("generation_key"),
  );
}

export function fetchTierDraws(tournamentId: string): Promise<TierDraw[]> {
  return must<TierDraw[]>(
    supabase.from("tier_draws").select("*").eq("tournament_id", tournamentId).order("tier"),
  );
}

export function fetchTierDrawMatches(tournamentId: string): Promise<TierDrawMatch[]> {
  return must<TierDrawMatch[]>(
    supabase
      .from("tier_draw_matches")
      .select("*")
      .eq("tournament_id", tournamentId)
      .order("round")
      .order("slot"),
  );
}

export function usePlacementEntrants() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.placementEntrants, tournamentId),
    enabled: !!tournamentId,
    refetchInterval: 20_000,
    queryFn: () => fetchPlacementEntrants(tournamentId as string),
  });
}

export function usePlacementMatches() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.placementMatches, tournamentId),
    enabled: !!tournamentId,
    refetchInterval: 20_000,
    queryFn: () => fetchPlacementMatches(tournamentId as string),
  });
}

export function useTierDraws() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.tierDraws, tournamentId),
    enabled: !!tournamentId,
    refetchInterval: 20_000,
    queryFn: () => fetchTierDraws(tournamentId as string),
  });
}

export function useTierDrawMatches() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.tierDrawMatches, tournamentId),
    enabled: !!tournamentId,
    refetchInterval: 20_000,
    queryFn: () => fetchTierDrawMatches(tournamentId as string),
  });
}

/**
 * The computed conflicts in the current tournament's schedule.
 *
 * `schedule_conflicts` is a read, not a stored flag, so this needs the same short
 * refetch window the desk's other schedule reads use: a conflict appears the moment the
 * rows that contradict each other exist, and disappears the moment the desk fixes it.
 *
 * The result is deliberately not surfaced anywhere yet. It exists so a caller can ask
 * "is this schedule still playable" without re-deriving the rules in TypeScript.
 */
export async function fetchScheduleConflicts(tournamentId: string): Promise<ScheduleConflict[]> {
  const { data, error } = await supabase.rpc("schedule_conflicts", {
    p_tournament_id: tournamentId,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as ScheduleConflict[];
}

export function useScheduleConflicts() {
  const tournamentId = useTournamentId();
  return useQuery({
    queryKey: scopedKey(keys.scheduleConflicts, tournamentId),
    enabled: !!tournamentId,
    refetchInterval: 20_000,
    queryFn: () => fetchScheduleConflicts(tournamentId as string),
  });
}
