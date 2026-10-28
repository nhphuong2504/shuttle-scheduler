import { Link } from "@tanstack/react-router";

import { DemoPill, RegistrationStatePill } from "@/components/app-shell";
import { EXPLORE_ACTION_OUTLINE, RegisterAction } from "@/components/explore-card";
import type { TournamentSummary } from "@/lib/tournament/data";
import { countText, dateRangeText } from "@/lib/tournament/summary-format";
import { tournamentHomeFor } from "@/lib/tournament/reader-home";

/**
 * The compact shapes Explore uses once a list is long.
 *
 * A card is right for a handful of tournaments and wrong for a few hundred: it spends a whole
 * grid cell on one fact line. An upcoming tournament is read by *when*, so it gets a row with
 * a date tile and sits under its month; a finished one is read by name and result, so it gets
 * a table row. Both take the same \`TournamentSummary\` the cards do, so a tournament says the
 * same thing whichever shape it is drawn in.
 */

/**
 * The month a tournament belongs under, in the reader's own zone.
 *
 * The same zone \`dateRangeText\` prints its times in, so the heading above a row and the date
 * inside it cannot disagree. A tournament with no playing days has no month; it is gathered
 * under one heading of its own rather than guessed into one.
 */
export function monthGroup(startsAt: string | null): { key: string; label: string } {
  if (!startsAt) return { key: "none", label: "Dates to be announced" };
  const date = new Date(startsAt);
  return {
    key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
    label: new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date),
  };
}

/** Rows in order, split wherever the month changes. */
export function groupByMonth(rows: TournamentSummary[]) {
  const groups: { key: string; label: string; rows: TournamentSummary[] }[] = [];
  for (const row of rows) {
    const month = monthGroup(row.starts_at);
    const last = groups.at(-1);
    if (last && last.key === month.key) last.rows.push(row);
    else groups.push({ ...month, rows: [row] });
  }
  return groups;
}

function DateTile({ startsAt }: { startsAt: string | null }) {
  if (!startsAt) {
    return (
      <div
        aria-hidden="true"
        className="grid size-14 place-items-center rounded-lg border border-hairline bg-background text-lg font-bold text-muted-foreground"
      >
        ?
      </div>
    );
  }
  const date = new Date(startsAt);
  return (
    <div
      aria-hidden="true"
      className="w-14 rounded-lg border border-hairline bg-background py-1.5 text-center"
    >
      <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
        {new Intl.DateTimeFormat(undefined, { month: "short" }).format(date)}
      </div>
      <div className="font-display text-2xl font-extrabold leading-none tabular-nums">
        {date.getDate()}
      </div>
    </div>
  );
}

/** One upcoming tournament, as a row under its month. */
export function ExploreRow({
  summary,
  signedIn,
}: {
  summary: TournamentSummary;
  signedIn: boolean;
}) {
  const window = ["opens_soon", "open", "closed"].includes(summary.registration_state);
  return (
    <article className="grid items-center gap-x-4 gap-y-3 rounded-xl border border-hairline bg-surface p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <div className="flex items-start gap-4 sm:contents">
        <DateTile startsAt={summary.starts_at} />
        <div className="min-w-0">
          <h4 className="break-words font-display text-lg font-bold leading-snug">
            <Link
              to={tournamentHomeFor(summary)}
              params={{ tournamentId: summary.id }}
              className="rounded-sm hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {summary.name}
            </Link>
            {/*
              Beside the name rather than out at the end of the row, because the row's end is
              where the actions are and this is not one. The name is the thing being qualified,
              and on a phone the two stay on the same line when the actions wrap below.
            */}
            {summary.is_demo ? <DemoPill className="ml-2 align-middle" /> : null}
          </h4>
          <p className="mt-0.5 break-words text-sm text-muted-foreground">
            {dateRangeText(summary.starts_at, summary.ends_at)}
          </p>
          <p className="break-words text-sm text-muted-foreground">
            {summary.venue_name || "Venue not set"},{" "}
            <span className="tabular-nums">
              {countText(summary.entry_count, "entry", "entries")},{" "}
              {countText(summary.category_count, "event", "events")}
            </span>
          </p>
          {window ? (
            <div className="mt-2">
              <RegistrationStatePill state={summary.registration_state} />
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <RegisterAction summary={summary} signedIn={signedIn} />
        <Link
          to={tournamentHomeFor(summary)}
          params={{ tournamentId: summary.id }}
          className={EXPLORE_ACTION_OUTLINE}
        >
          Details
        </Link>
      </div>
    </article>
  );
}

/**
 * Finished tournaments, as a table on a wide screen and a plain list on a phone.
 *
 * A table is the right shape for "name, dates, venue, size" read down a column, and the wrong
 * one at 320px, where it either scrolls sideways or crushes its columns; so the phone gets the
 * same facts as a list and neither is hidden from a reader who needs it.
 */
export function CompletedList({ rows }: { rows: TournamentSummary[] }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border border-hairline bg-surface sm:block">
        <table className="w-full border-collapse text-left text-base">
          <thead>
            <tr className="bg-background text-sm text-muted-foreground">
              <th scope="col" className="px-4 py-3 font-semibold">
                Tournament
              </th>
              <th scope="col" className="py-3 pr-4 font-semibold">
                Dates
              </th>
              <th scope="col" className="py-3 pr-4 font-semibold">
                Venue
              </th>
              <th scope="col" className="py-3 pr-4 text-right font-semibold">
                Entries
              </th>
              <th scope="col" className="py-3 pr-4 text-right font-semibold">
                Results
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 font-semibold">
                  <Link
                    to={tournamentHomeFor(row)}
                    params={{ tournamentId: row.id }}
                    className="rounded-sm hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {row.name}
                  </Link>
                  {row.is_demo ? <DemoPill className="ml-2 align-middle" /> : null}
                </td>
                <td className="py-3 pr-4 text-muted-foreground">
                  {dateRangeText(row.starts_at, row.ends_at)}
                </td>
                <td className="py-3 pr-4 text-muted-foreground">
                  {row.venue_name || "Venue not set"}
                </td>
                <td className="py-3 pr-4 text-right tabular-nums">{row.entry_count}</td>
                <td className="py-3 pr-4 text-right">
                  <Link
                    to={tournamentHomeFor(row)}
                    params={{ tournamentId: row.id }}
                    className="inline-flex min-h-11 items-center font-semibold text-primary-ink hover:underline"
                  >
                    See results
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-surface sm:hidden">
        {rows.map((row) => (
          <li key={row.id} className="px-4 py-3">
            <Link
              to={tournamentHomeFor(row)}
              params={{ tournamentId: row.id }}
              className="block min-h-11 rounded-sm"
            >
              <strong className="font-display text-lg">{row.name}</strong>
              {row.is_demo ? <DemoPill className="ml-2 align-middle" /> : null}
              <span className="mt-0.5 block text-sm text-muted-foreground">
                {dateRangeText(row.starts_at, row.ends_at)}
              </span>
              <span className="block text-sm text-muted-foreground tabular-nums">
                {countText(row.entry_count, "entry", "entries")}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
