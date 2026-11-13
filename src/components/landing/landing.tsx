import { Link, useLocation } from "@tanstack/react-router";

import { PublicShell } from "@/components/app-shell";
import { PublicHeader } from "@/components/public-header";
import { TournovaMark } from "@/components/brand/tournova-mark";
import { signInSearch } from "@/lib/routing/redirect";

/**
 * The front door is the organiser's board: one printed sheet per court, pinned up for the
 * day on a badminton court drawn in the app's own line grey. One late court is circled, and its sheet has already moved to make room - which is
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

/**
 * The court behind the board, as [x1, y1, x2, y2] segments of a 1340 × 610 landscape court
 * (doubles and singles sidelines, service lines, centre lines, net and posts). A phone draws
 * the same court in portrait: the same segments with x and y swapped.
 */
const COURT_LINES: Segment[] = [
  [0, 0, 1340, 0],
  [1340, 0, 1340, 610],
  [1340, 610, 0, 610],
  [0, 610, 0, 0],
  [0, 46, 1340, 46],
  [0, 564, 1340, 564],
  [76, 0, 76, 610],
  [1264, 0, 1264, 610],
  [472, 0, 472, 610],
  [868, 0, 868, 610],
  [0, 305, 472, 305],
  [868, 305, 1340, 305],
];
const COURT_NET: Segment[] = [[670, -12, 670, 622]];
const COURT_POSTS: Segment[] = [
  [670, -22, 670, -6],
  [670, 616, 670, 632],
];

type Segment = [number, number, number, number];

function courtPath(segments: Segment[], portrait: boolean) {
  return segments
    .map(([x1, y1, x2, y2]) => (portrait ? `M${y1} ${x1}L${y2} ${x2}` : `M${x1} ${y1}L${x2} ${y2}`))
    .join("");
}

export function Landing() {
  const href = useLocation({ select: (location) => location.href });

  return (
    <PublicShell bare className="cs-page" header={<BoardHeader signIn={signInSearch(href)} />}>
      <section aria-labelledby="landing-title" className="cs-hero">
        <div
          className="cs-board"
          role="img"
          aria-label="Six court sheets for the day, pinned on a badminton court. Court 6 is running 12 minutes late, so its next two matches have moved from 10:40 to 10:52 and from 11:05 to 11:17. The other five courts are unchanged."
        >
          <CourtLines portrait={false} />
          <CourtLines portrait />

          {/* The serve that opens the page: a shuttle lands on Court 6 and knocks it late. */}
          <div className="cs-serve" aria-hidden="true">
            <div className="cs-serve-y">
              <svg viewBox="-14 -20 28 28">
                <path
                  d="M3.5 -2L10 -17H-10L-3.5 -2Z"
                  fill="#FFFFFF"
                  stroke="#111111"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
                <path d="M0 -3V-17M-7 -10.5H7" fill="none" stroke="#111111" strokeWidth="1" />
                <circle cx="0" cy="1.5" r="4.5" fill="#111111" />
              </svg>
            </div>
          </div>

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
              <span className="cs-shift-label">+12 min</span>
              <svg viewBox="0 0 48 20" className="cs-clash-arrow" aria-hidden="true">
                <path d="M2 4 C 14 18, 30 18, 44 12" />
                <path d="M37 7 L 45 12 L 37 17" />
              </svg>
            </p>
          </div>
        </div>

        {/* Where the header has no room for its tagline, the hero says it instead. */}
        <p className="cs-eyebrow">Tournament Management &amp; Scheduling Software</p>
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
      </section>
    </PublicShell>
  );
}

function CourtLines({ portrait }: { portrait: boolean }) {
  return (
    <svg
      className={`cs-court ${portrait ? "cs-court-port" : "cs-court-land"}`}
      viewBox={portrait ? "0 0 610 1340" : "0 0 1340 610"}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d={courtPath(COURT_LINES, portrait)}
        strokeWidth="2"
        strokeLinecap="square"
        fill="none"
      />
      <path d={courtPath(COURT_NET, portrait)} strokeWidth="3" />
      <path d={courtPath(COURT_POSTS, portrait)} strokeWidth="9" />
    </svg>
  );
}

function CourtCard({ sheet }: { sheet: CourtSheet }) {
  return (
    <div className={`cs-card cs-card-${sheet.court}`}>
      <p className="cs-card-title">
        <span>Court</span> <span className="cs-num">{sheet.court}</span>
      </p>
      <div className="cs-grid">
        <ol className="cs-times">
          {sheet.rows.map((row) => (
            <li key={row.time} className={row.was ? "cs-time-moved" : undefined}>
              {row.was ? <s>{row.was}</s> : null}
              <span className="cs-new">{row.time}</span>
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
    <PublicHeader>
      <div className="cs-header">
        <div className="cs-brand">
          <Link to="/" aria-label="Tournova" className="cs-logo">
            <TournovaMark className="cs-logo-mark" />
            <span>Tournova</span>
          </Link>
          <span className="cs-tagline">Tournament Management &amp; Scheduling Software</span>
        </div>
        <nav aria-label="Primary" className="cs-nav">
          <Link to="/explore" className="header-nav-item">
            <span aria-hidden="true" className="cs-nav-short">
              Browse
            </span>
            <span className="cs-nav-full">Browse tournaments</span>
          </Link>
          <Link to="/auth" search={signIn} className="header-nav-item">
            Sign in
          </Link>
        </nav>
      </div>
    </PublicHeader>
  );
}
