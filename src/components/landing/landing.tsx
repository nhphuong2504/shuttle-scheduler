import { Link, useLocation } from "@tanstack/react-router";

import { PublicShell } from "@/components/app-shell";
import { TournovaMark } from "@/components/brand/tournova-mark";
import { signInSearch } from "@/lib/routing/redirect";

/**
 * The front door is the organiser's board: one printed sheet per court, pinned up for the
 * day. One late court is circled, and its sheet has already moved to make room - which is
 * the product's promise drawn before it is said.
 *
 * One court, one number, so it reads at a glance: Court 6's 10:15 match runs 12 minutes over,
 * and the two matches after it on that court each start 12 minutes later. The note and its
 * arrow sit beside that sheet at every breakpoint. No other court moves.
 */

type Hatch = "diag" | "cross" | "dense" | "lines";

interface CourtSheet {
  court: number;
  hatch: Hatch;
  rows: { time: string; was?: string }[];
}

const DAY = ["09:00", "09:25", "09:50", "10:15", "10:40", "11:05"];

const SHEETS: CourtSheet[] = [
  { court: 1, hatch: "diag", rows: DAY.map((time) => ({ time })) },
  { court: 2, hatch: "cross", rows: DAY.map((time) => ({ time })) },
  { court: 3, hatch: "cross", rows: DAY.map((time) => ({ time })) },
  { court: 4, hatch: "lines", rows: DAY.map((time) => ({ time })) },
  { court: 5, hatch: "dense", rows: DAY.map((time) => ({ time })) },
  {
    court: 6,
    hatch: "dense",
    // The court that ran over: both matches after the late one start 12 minutes later.
    rows: [
      ...DAY.slice(0, 4).map((time) => ({ time })),
      { time: "10:52", was: "10:40" },
      { time: "11:17", was: "11:05" },
    ],
  },
];

export function Landing() {
  const href = useLocation({ select: (location) => location.href });

  return (
    <PublicShell bare className="cs-page" header={<BoardHeader signIn={signInSearch(href)} />}>
      <section aria-labelledby="landing-title" className="cs-hero">
        <div
          className="cs-board"
          role="img"
          aria-label="Six court sheets for the day. Court 6 is running 12 minutes late, so its next two matches have moved from 10:40 to 10:52 and from 11:05 to 11:17. The other five courts are unchanged."
        >
          {SHEETS.map((sheet) => (
            <CourtCard key={sheet.court} sheet={sheet} />
          ))}

          <div className="cs-clash">
            <p className="cs-clash-note">
              Court 6 is running
              <br />
              12 min late. Its next
              <br />
              matches have moved.
            </p>
            <p className="cs-clash-shift">
              <span>+12 min</span>
              <svg viewBox="0 0 48 20" className="cs-clash-arrow">
                <path d="M2 4 C 14 18, 30 18, 44 12" />
                <path d="M37 7 L 45 12 L 37 17" />
              </svg>
            </p>
          </div>
        </div>

        <h1 id="landing-title" className="cs-title">
          Every court in order.
          <br />
          Everyone knows what&rsquo;s next.
        </h1>

        <div className="cs-actions">
          {/* A plain GET form, so it reaches the create flow before the page's script loads. */}
          <form action="/tournaments/new" method="get">
            <button type="submit" className="cs-cta">
              Run a tournament — free
            </button>
          </form>
          <Link to="/explore" className="cs-follow">
            Follow a tournament
          </Link>
        </div>

        <p className="cs-sub">When a match runs late, the rest of the day keeps up.</p>
      </section>
    </PublicShell>
  );
}

function CourtCard({ sheet }: { sheet: CourtSheet }) {
  return (
    <div className={`cs-card cs-card-${sheet.court}`}>
      <p className="cs-card-title">Court {sheet.court}</p>
      <div className="cs-grid">
        <ol className="cs-times">
          {sheet.rows.map((row) => (
            <li key={row.time} className={row.was ? "cs-time-moved" : undefined}>
              {row.was ? <s>{row.was}</s> : null}
              {row.time}
            </li>
          ))}
        </ol>
        <div className={`cs-slots cs-hatch-${sheet.hatch}`} />
      </div>
    </div>
  );
}

/** The same mark, name and ways in as the app's own header. */
function BoardHeader({ signIn }: { signIn: ReturnType<typeof signInSearch> }) {
  return (
    <header className="cs-header">
      <Link to="/" aria-label="Tournova" className="cs-logo">
        <TournovaMark className="cs-logo-mark" />
        <span>Tournova</span>
      </Link>
      <nav aria-label="Primary" className="cs-nav">
        <Link to="/explore">
          <span aria-hidden="true" className="cs-nav-short">
            Browse
          </span>
          <span className="cs-nav-full">Browse tournaments</span>
        </Link>
        <Link to="/auth" search={signIn}>
          Sign in
        </Link>
      </nav>
    </header>
  );
}
