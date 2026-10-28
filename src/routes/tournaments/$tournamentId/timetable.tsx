import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { EmptyState, Page, StatusPill } from "@/components/app-shell";
import { readerDayLabel } from "@/components/reader/day-picker";
import {
  ReaderMatchList,
  ReaderMatchRow,
  ReaderState,
  type MatchReading,
  ReaderConnection,
} from "@/components/reader/reader-match";
import { useReaderMatches } from "@/hooks/useReaderMatches";
import { normalizeTournamentStatus } from "@/lib/auth/authorization";
import { attributeMatchesToDays } from "@/lib/tournament/day-scope";
import type { DeskMatch } from "@/lib/tournament/desk-matches";
import { compareEventOrder } from "@/lib/tournament/event-order";
import { timeLabel } from "@/lib/tournament/format";
import { inPlayingOrder, isFinished } from "@/lib/tournament/reader-board";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/tournaments/$tournamentId/timetable")({
  head: () => ({
    meta: [
      { title: "Schedule | Tournova" },
      {
        name: "description",
        content: "Every scheduled match, day by day, in the order it is played.",
      },
      { property: "og:title", content: "Schedule | Tournova" },
      {
        property: "og:description",
        content: "Every scheduled match, day by day, in the order it is played.",
      },
    ],
  }),
  component: TimetablePage,
});

/**
 * The reader's full schedule: every match with a court or a time, day by day, in playing order.
 *
 * Now answers "what is happening" with the next few matches; this page answers "when is
 * everything", so nothing is capped. It is a timetable read from the published schedule, not
 * the organiser's Schedule page at `…/schedule` - it carries no forecast, no conflicts and no
 * planning controls. Each day is its own list, so a reader scrolls to the day they came for.
 *
 * While play is on, the list opens where play is - the first match still to finish - rather
 * than at the first match of the morning, and "Jump to now" brings a reader back there.
 */
function TimetablePage() {
  const data = useReaderMatches();
  const { live, matches, days, categories, label, courtName } = data;
  const [eventId, setEventId] = useState<string>("all");
  const [hideFinished, setHideFinished] = useState(false);

  const events = useMemo(
    () => [...categories].filter((c) => c.active).sort(compareEventOrder),
    [categories],
  );
  const orderedDays = useMemo(() => [...days].sort((a, b) => a.day_number - b.day_number), [days]);

  const sections = useMemo(() => {
    const scheduled = matches.filter(
      (m) =>
        (m.courtId || m.scheduled) &&
        (eventId === "all" || m.categoryId === eventId) &&
        !(hideFinished && isFinished(m)),
    );
    const { byDayId } = attributeMatchesToDays(orderedDays, scheduled);
    return orderedDays.map((day) => ({ day, rows: inPlayingOrder(byDayId.get(day.id) ?? []) }));
  }, [matches, orderedDays, eventId, hideFinished]);

  const total = sections.reduce((sum, section) => sum + section.rows.length, 0);
  const playing = normalizeTournamentStatus(data.tournament?.status) === "in_progress";
  const listed = sections.flatMap((section) => section.rows);
  const nowIndex = playing ? listed.findIndex((m) => !isFinished(m)) : -1;
  const nowId = listed[nowIndex]?.id ?? null;
  const jumpToNow = (smooth: boolean) => {
    const row = nowId ? document.getElementById(rowAnchor(nowId)) : null;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row?.scrollIntoView({ block: "start", behavior: smooth && !still ? "smooth" : "auto" });
  };
  // Once, on the first load that has a row to go to: later refreshes and filters never move the page.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !nowId) return;
    opened.current = true;
    // When play is still on the first row, the top of the page already is "now".
    if (nowIndex > 0) jumpToNow(false);
  });
  // The way back is offered only while "now" is off screen, where a reader cannot see it.
  const [nowInView, setNowInView] = useState(true);
  useEffect(() => {
    const row = nowId ? document.getElementById(rowAnchor(nowId)) : null;
    if (!row || typeof IntersectionObserver === "undefined") return setNowInView(true);
    const watch = new IntersectionObserver(([entry]) => setNowInView(!!entry?.isIntersecting));
    watch.observe(row);
    return () => watch.disconnect();
  }, [nowId]);
  // Times read in the browser's zone, as the Desk and Scores print them, so one match has one time.
  const reading: MatchReading = { label, courtName };

  return (
    <Page
      title="Schedule"
      subtitle="Every scheduled match, day by day, in the order it is played."
      actions={<ReaderConnection live={live} />}
    >
      <div className="space-y-5">
        {/* One row that scrolls sideways on a phone, so the filters never push the first match down. */}
        <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible sm:px-0">
          {events.length > 1 ? (
            <div
              role="group"
              aria-label="Filter by event"
              className="flex shrink-0 gap-1.5 sm:flex-wrap"
            >
              <Chip active={eventId === "all"} onClick={() => setEventId("all")}>
                All events
              </Chip>
              {events.map((event) => (
                <Chip
                  key={event.id}
                  active={eventId === event.id}
                  onClick={() => setEventId(event.id)}
                >
                  {event.code}
                </Chip>
              ))}
            </div>
          ) : null}
          <Chip active={hideFinished} onClick={() => setHideFinished((value) => !value)}>
            Hide finished
          </Chip>
        </div>

        <ReaderState state={data} loadingLabel="Loading the schedule">
          {total === 0 ? (
            <EmptyState
              title="No matches scheduled"
              hint={
                hideFinished || eventId !== "all"
                  ? "Nothing matches these filters. Clear them to see the whole schedule."
                  : "Matches appear here once the organiser gives them a court and a time."
              }
            />
          ) : (
            <div className="space-y-5">
              {sections.map(({ day, rows }) =>
                rows.length ? (
                  <ReaderMatchList
                    key={day.id}
                    title={readerDayLabel(day)}
                    headingId={`timetable-${day.id}`}
                    right={
                      <span className="text-sm text-muted-foreground">
                        {rows.length} {rows.length === 1 ? "match" : "matches"}
                      </span>
                    }
                    empty={null}
                  >
                    {rows.map((match) => (
                      <ReaderMatchRow
                        key={match.id}
                        id={rowAnchor(match.id)}
                        match={match}
                        reading={reading}
                        place={courtName(match.courtId) ?? "Court to be assigned"}
                        aside={<TimeAndState match={match} />}
                      />
                    ))}
                  </ReaderMatchList>
                ) : null,
              )}
            </div>
          )}
        </ReaderState>
      </div>
      {nowId && !nowInView ? (
        <button
          type="button"
          onClick={() => jumpToNow(true)}
          className="fixed bottom-4 left-1/2 z-20 min-h-11 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-lg transition-colors hover:bg-primary/90"
        >
          Jump to now
        </button>
      ) : null}
    </Page>
  );
}

function rowAnchor(matchId: string) {
  return `timetable-match-${matchId}`;
}

/** The time leads; a live match adds its state and a finished one its score. */
function TimeAndState({ match }: { match: DeskMatch }) {
  return (
    <>
      <span className="whitespace-nowrap font-score text-base font-semibold tabular-nums">
        {match.scheduled ? timeLabel(match.scheduled) : "Time to be set"}
      </span>
      {match.status === "in-progress" || match.status === "walkover" ? (
        <StatusPill status={match.status} />
      ) : match.score ? (
        <span className="whitespace-nowrap font-score text-sm tabular-nums text-muted-foreground">
          {match.score}
        </span>
      ) : null}
    </>
  );
}

function Chip({
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
        "min-h-11 shrink-0 whitespace-nowrap rounded-full border px-4 text-sm font-semibold transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-surface text-muted-foreground hover:bg-muted/60",
      )}
    >
      {children}
    </button>
  );
}
