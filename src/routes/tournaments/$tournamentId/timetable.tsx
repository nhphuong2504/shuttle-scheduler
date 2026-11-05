import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { EmptyState, StatusPill } from "@/components/app-shell";
import { MatchIdentity } from "@/components/match-identity";
import { readerDayLabel } from "@/components/reader/day-picker";
import {
  GameScores,
  ReaderMatchList,
  MatchSidesInline,
  ReaderMatchRow,
  ReaderState,
  ReaderTimeGroup,
  type MatchReading,
  ReaderConnection,
  ReaderPage,
} from "@/components/reader/reader-match";
import { useReaderMatches } from "@/hooks/useReaderMatches";
import { normalizeTournamentStatus } from "@/lib/auth/authorization";
import { attributeMatchesToDays } from "@/lib/tournament/day-scope";
import type { DeskMatch } from "@/lib/tournament/desk-matches";
import { compareEventOrder } from "@/lib/tournament/event-order";
import { timeLabel } from "@/lib/tournament/format";
import { groupByTime, inPlayingOrder, isFinished } from "@/lib/tournament/reader-board";
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
    const row = nowId ? shownRow(nowId) : null;
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
    // Both layouts are in the page and one is hidden; whichever is drawn decides.
    const rows = nowId ? anchorsOf(nowId) : [];
    if (!rows.length || typeof IntersectionObserver === "undefined") return setNowInView(true);
    const seen = new Map<Element, boolean>();
    const watch = new IntersectionObserver((entries) => {
      for (const entry of entries) seen.set(entry.target, entry.isIntersecting);
      setNowInView([...seen.values()].some(Boolean));
    });
    for (const row of rows) watch.observe(row);
    return () => watch.disconnect();
  }, [nowId]);
  // Times read in the browser's zone, as the Desk and Scores print them, so one match has one time.
  const reading: MatchReading = { label, courtName };

  return (
    <ReaderPage
      title="Schedule"
      controls={
        // One row that scrolls sideways on a phone, so the filters never push the first match down.
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
      }
      actions={<ReaderConnection live={live} />}
    >
      <div className="space-y-5">
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
                    wide={<DayTable rows={rows} reading={reading} />}
                  >
                    {groupByTime(rows).map((group) => (
                      <ReaderTimeGroup
                        key={`${group.scheduled}-${group.matches[0]!.id}`}
                        group={group}
                        reading={reading}
                      >
                        {group.matches.map((match) => (
                          <ReaderMatchRow
                            key={match.id}
                            id={rowAnchor(match.id)}
                            match={match}
                            reading={reading}
                            showTime={false}
                            showIdentity={!group.shared}
                            aside={<MatchState match={match} stacked />}
                          />
                        ))}
                      </ReaderTimeGroup>
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
    </ReaderPage>
  );
}

function rowAnchor(matchId: string, wide = false) {
  return `timetable-match-${matchId}${wide ? "-wide" : ""}`;
}

/** A match's row in both layouts - the rows below `lg`, the table from it. */
function anchorsOf(matchId: string): HTMLElement[] {
  return [rowAnchor(matchId), rowAnchor(matchId, true)].flatMap((id) => {
    const row = document.getElementById(id);
    return row ? [row] : [];
  });
}

/** The one of a match's two rows the screen is drawing. */
function shownRow(matchId: string): HTMLElement | null {
  return anchorsOf(matchId).find((row) => row.getClientRects().length > 0) ?? null;
}

/**
 * A day as columns, for a desktop. A wave's time is printed on its first row only, so the
 * column reads as the hall's clock; the rows after it keep the time for a screen reader.
 */
function DayTable({ rows, reading }: { rows: readonly DeskMatch[]; reading: MatchReading }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th className="w-20">Time</th>
          <th className="w-28">Court</th>
          <th>Match</th>
          <th className="w-44">Event</th>
          <th className="w-44 !text-right">Result</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((match, index) => {
          const time = match.scheduled ? timeLabel(match.scheduled) : "Time to be set";
          const repeat = index > 0 && rows[index - 1]!.scheduled === match.scheduled;
          return (
            <tr key={match.id} id={rowAnchor(match.id, true)} className="scroll-mt-28">
              <td className="whitespace-nowrap font-score font-semibold tabular-nums">
                {repeat ? <span className="sr-only">{time}</span> : time}
              </td>
              <td className="whitespace-nowrap font-display font-bold">
                {reading.courtName(match.courtId) ?? (
                  <span className="font-body font-normal text-muted-foreground">Unassigned</span>
                )}
              </td>
              <td>
                <MatchSidesInline match={match} reading={reading} />
              </td>
              <td className="font-score text-sm text-muted-foreground">
                <MatchIdentity match={match} />
              </td>
              <td className="text-right">
                <span className="inline-flex justify-end">
                  <MatchState match={match} />
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** A live match says so and a finished one gives its score: the time is the group's heading. */
function MatchState({ match, stacked = false }: { match: DeskMatch; stacked?: boolean }) {
  if (match.status === "in-progress" || match.status === "walkover") {
    return <StatusPill status={match.status} />;
  }
  return match.score ? (
    <GameScores match={match} stacked={stacked} className="text-sm text-muted-foreground" />
  ) : null;
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
