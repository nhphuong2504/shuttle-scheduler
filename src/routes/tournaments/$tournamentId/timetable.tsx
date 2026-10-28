import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { EmptyState, Page, Panel, StatusPill } from "@/components/app-shell";
import { ConnectionBadge } from "@/components/connection-badge";
import { readerDayLabel } from "@/components/reader/day-picker";
import {
  ReaderMatchList,
  ReaderMatchRow,
  ReaderState,
  type MatchReading,
} from "@/components/reader/reader-match";
import { useReaderMatches } from "@/hooks/useReaderMatches";
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
  // Times read in the browser's zone, as the Desk and Scores print them, so one match has one time.
  const reading: MatchReading = { label, courtName };

  return (
    <Page
      title="Schedule"
      subtitle="Every scheduled match, day by day, in the order it is played."
      actions={<ConnectionBadge status={live.status} lastUpdatedAt={live.lastUpdatedAt} />}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          {events.length > 1 ? (
            <div role="group" aria-label="Filter by event" className="flex flex-wrap gap-1.5">
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
            <Panel>
              <EmptyState
                title="No matches scheduled"
                hint={
                  hideFinished || eventId !== "all"
                    ? "Nothing matches these filters. Clear them to see the whole schedule."
                    : "Matches appear here once the organiser gives them a court and a time."
                }
              />
            </Panel>
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
                        match={match}
                        reading={reading}
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
    </Page>
  );
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
        "min-h-11 rounded-full border px-4 text-sm font-semibold transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-surface text-muted-foreground hover:bg-muted/60",
      )}
    >
      {children}
    </button>
  );
}
