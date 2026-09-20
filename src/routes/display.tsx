import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ThemeToggle } from "@/components/theme-toggle";
import {
  indexBy,
  teamLabel,
  useActiveTournament,
  useCategories,
  useCourts,
  useDrawMatches,
  useDraws,
  usePlacementEntrants,
  usePlacementMatches,
  usePlayers,
  usePoolMatches,
  useRealtimeRefresh,
  useTeams,
  useTierDrawMatches,
  useTierDraws,
  type Court,
} from "@/lib/tournament/data";
import { buildDeskMatches, type DeskMatch } from "@/lib/tournament/desk-matches";
import { deriveCourtState, deskKindPhase } from "@/lib/tournament/desk";
import { minutesSince, timeLabel } from "@/lib/tournament/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/display")({
  head: () => ({
    meta: [
      { title: "Venue Board | ShuttleNet Live Courts" },
      {
        name: "description",
        content:
          "Wall display for the hall: every court, who is on it, how long they have been playing and who is called next.",
      },
      { property: "og:title", content: "Venue Board | ShuttleNet Live Courts" },
      {
        property: "og:description",
        content: "Wall display for the hall: every court, who is on now and who is called next.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DisplayPage,
});

/**
 * Two viewing classes, because one board cannot serve both distances.
 *
 * Class A is court-side, read from three to six metres: every court shows, and a
 * second line of detail is affordable. Class B is the wall board, read from eight
 * to fifteen metres: only live courts show, secondary text is dropped entirely and
 * the type jumps to the far-view floor. The sizes come straight from the
 * `--fv-*` tokens, which are solved against viewing distance in `styles.css`.
 */
type ViewClass = "a" | "b";

function DisplayPage() {
  useRealtimeRefresh();

  const { data: tournament } = useActiveTournament();
  const { data: courts } = useCourts();
  const { data: categories } = useCategories();
  const { data: teams } = useTeams();
  const { data: players } = usePlayers();
  const { data: poolMatches } = usePoolMatches();
  const { data: draws } = useDraws();
  const { data: drawMatches } = useDrawMatches();
  const { data: placementEntrants } = usePlacementEntrants();
  const { data: placementMatches } = usePlacementMatches();
  const { data: tierDraws } = useTierDraws();
  const { data: tierDrawMatches } = useTierDrawMatches();

  const [viewClass, setViewClass] = useState<ViewClass>("a");
  const [now, setNow] = useState(() => Date.now());
  const [chromeVisible, setChromeVisible] = useState(true);

  // A wall panel is never touched, so the clock has to move on its own.
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(tick);
  }, []);

  // The controls fade out so the board is only the board once it is hung.
  useEffect(() => {
    if (!chromeVisible) return;
    const hide = window.setTimeout(() => setChromeVisible(false), 8_000);
    return () => window.clearTimeout(hide);
  }, [chromeVisible]);

  const teamMap = useMemo(() => indexBy(teams), [teams]);
  const playerMap = useMemo(() => indexBy(players), [players]);
  const entrantMap = useMemo(() => indexBy(placementEntrants), [placementEntrants]);

  const entrantTeam = useCallback(
    (entrantId: string | null) => (entrantId ? (entrantMap.get(entrantId)?.team_id ?? null) : null),
    [entrantMap],
  );

  const allMatches = useMemo<DeskMatch[]>(
    () =>
      buildDeskMatches({
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

  const slotMinutesFor = useCallback(
    (match: DeskMatch) =>
      deskKindPhase(match.kind) === "group"
        ? (tournament?.group_slot_minutes ?? 20)
        : (tournament?.knockout_slot_minutes ?? 25),
    [tournament],
  );
  const restMinutesFor = useCallback(
    (match: DeskMatch) =>
      deskKindPhase(match.kind) === "group"
        ? (tournament?.group_rest_gap_minutes ?? 10)
        : (tournament?.knockout_rest_gap_minutes ?? 30),
    [tournament],
  );

  const orderedCourts = useMemo(
    () => [...(courts ?? [])].sort((a, b) => a.number - b.number),
    [courts],
  );

  const board = useMemo(
    () =>
      orderedCourts.map((court) => ({
        court,
        state: deriveCourtState(court.id, allMatches, slotMinutesFor, restMinutesFor, now),
      })),
    [orderedCourts, allMatches, slotMinutesFor, restMinutesFor, now],
  );

  const label = (id: string | null) => teamLabel(id ? teamMap.get(id) : undefined, playerMap);
  const liveCourts = board.filter((row) => row.state.playing);
  const shown = viewClass === "b" ? liveCourts : board;

  return (
    <div
      className="min-h-screen bg-background font-body text-foreground"
      onMouseMove={() => setChromeVisible(true)}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-4 px-8 pt-7">
        <div className="min-w-0">
          <h1
            className="truncate font-display font-extrabold tracking-tight"
            style={{ fontSize: viewClass === "b" ? "var(--fv-b-label)" : "var(--fv-a-label)" }}
          >
            {tournament?.name ?? "Live courts"}
          </h1>
          {viewClass === "a" ? (
            <p className="mt-1 text-2xl text-muted-foreground">
              {liveCourts.length} of {board.length} courts playing
            </p>
          ) : null}
        </div>
        <p
          className="font-score font-bold tabular-nums"
          style={{ fontSize: viewClass === "b" ? "var(--fv-b-label)" : "var(--fv-a-label)" }}
        >
          {timeLabel(new Date(now), tournament?.venue_timezone ?? undefined)}
        </p>
      </header>

      <main className="px-8 pb-10 pt-6">
        {shown.length === 0 ? (
          <p
            className="py-24 text-center text-muted-foreground"
            style={{ fontSize: "var(--fv-a-label)" }}
          >
            No matches on court right now.
          </p>
        ) : (
          <div
            className={cn(
              "grid gap-5",
              viewClass === "b"
                ? "grid-cols-1 xl:grid-cols-2"
                : "grid-cols-1 md:grid-cols-2 2xl:grid-cols-3",
            )}
          >
            {shown.map(({ court, state }) => (
              <CourtBoardCard
                key={court.id}
                court={court}
                viewClass={viewClass}
                playing={state.playing}
                next={state.next}
                overrun={state.state === "overrun"}
                elapsedMinutes={state.elapsedMinutes}
                label={label}
                timezone={tournament?.venue_timezone ?? undefined}
              />
            ))}
          </div>
        )}
      </main>

      <div
        className={cn(
          "fixed bottom-5 right-5 flex items-center gap-2 rounded-full border border-hairline bg-surface/90 px-3 py-2 shadow-raise backdrop-blur transition-opacity duration-500",
          chromeVisible ? "opacity-100" : "opacity-0 hover:opacity-100",
        )}
      >
        <div
          className="inline-flex items-center rounded-full border border-hairline bg-muted/50 p-0.5"
          role="group"
          aria-label="Viewing distance"
        >
          {(
            [
              ["a", "Court-side"],
              ["b", "Wall board"],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              type="button"
              aria-pressed={viewClass === value}
              onClick={() => setViewClass(value)}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors",
                viewClass === value
                  ? "bg-surface text-foreground shadow-panel"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {text}
            </button>
          ))}
        </div>
        <ThemeToggle />
        <button
          type="button"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void document.documentElement.requestFullscreen?.();
          }}
          className="rounded-full border border-hairline px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          Full screen
        </button>
      </div>
    </div>
  );
}

/**
 * One court.
 *
 * Class B drops the tag, the clock and the next-up line: at ten metres they are
 * unreadable anyway, and the space they take is space the names need. The live
 * marker is a chip fill plus foreground-ink type, never coloured type — the live
 * ink cannot reach the 7:1 the far-view class asks for.
 */
function CourtBoardCard({
  court,
  viewClass,
  playing,
  next,
  overrun,
  elapsedMinutes,
  label,
  timezone,
}: {
  court: Court;
  viewClass: ViewClass;
  playing: DeskMatch | null;
  next: DeskMatch | null;
  overrun: boolean;
  elapsedMinutes: number | null;
  label: (id: string | null) => string;
  timezone: string | undefined;
}) {
  const far = viewClass === "b";
  const nameSize = far ? "var(--fv-b-min)" : "var(--fv-a-body)";

  return (
    <section
      className={cn(
        "rounded-3xl border bg-surface p-6 shadow-panel",
        playing ? "border-state-live-ink/35" : "border-hairline",
      )}
    >
      <header className="flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <span
            className="font-display font-extrabold leading-none tracking-tight"
            style={{ fontSize: far ? "var(--fv-b-court)" : "var(--fv-a-label)" }}
          >
            C{court.number}
          </span>
          {!far && playing ? (
            <span className="rounded-full bg-state-live-chip px-3 py-1 font-score text-base font-bold uppercase tracking-wider text-state-live-ink">
              {playing.tag}
            </span>
          ) : null}
        </div>
        {playing ? (
          <span
            className={cn(
              "rounded-full px-4 py-1.5 font-display font-bold uppercase tracking-wider",
              overrun ? "bg-warn-surface text-warn-foreground" : "bg-state-live-chip text-foreground",
            )}
            style={{ fontSize: far ? "var(--fv-a-body)" : "1.125rem" }}
          >
            {overrun ? "Overrun" : "Live"}
          </span>
        ) : (
          <span
            className="rounded-full bg-muted px-4 py-1.5 font-display font-bold uppercase tracking-wider text-muted-foreground"
            style={{ fontSize: far ? "var(--fv-a-body)" : "1.125rem" }}
          >
            {next ? "Next up" : "Free"}
          </span>
        )}
      </header>

      <div className="mt-5 space-y-2">
        {playing || next ? (
          [0, 1].map((side) => {
            const match = playing ?? next!;
            const teamId = match.teams[side] ?? null;
            return (
              <p
                key={side}
                className="truncate font-display font-bold leading-tight"
                style={{ fontSize: nameSize }}
              >
                {label(teamId)}
              </p>
            );
          })
        ) : (
          <p className="text-muted-foreground" style={{ fontSize: "var(--fv-a-body)" }}>
            Nothing scheduled
          </p>
        )}
      </div>

      {!far ? (
        <footer className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-hairline pt-3 text-xl text-muted-foreground">
          {playing ? (
            <span className="font-score tabular-nums">
              {elapsedMinutes ?? minutesSince(playing.startedAt) ?? 0} min on court
            </span>
          ) : next ? (
            <>
              <span className="font-score tabular-nums">{timeLabel(next.scheduled, timezone)}</span>
              <span>{next.tag}</span>
            </>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}
