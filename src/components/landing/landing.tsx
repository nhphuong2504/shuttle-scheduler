import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useState, type CSSProperties, type FormEvent } from "react";

import { PublicShell } from "@/components/app-shell";
import { offerTournamentName } from "@/components/tournament-setup/local-draft";
import { signInSearch } from "@/lib/routing/redirect";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

import { ScheduleDemo } from "./schedule-demo";

/** A piece's place in the first viewport, as % of the 1280×720 composition. */
function box(x: number, y: number, w: number, h: number): CSSProperties {
  return { "--x": `${x}%`, "--y": `${y}%`, "--w": `${w}%`, "--h": `${h}%` } as CSSProperties;
}

export function Landing() {
  const href = useLocation({ select: (location) => location.href });

  return (
    <PublicShell
      bare
      className="flyer-wall"
      header={<WallHeader signIn={signInSearch(href)} />}
    >
      <section
        aria-labelledby="landing-title"
        className="flyer-frame"
      >
        <div className="flyer-group flyer-group-sheet">
          <h1 id="landing-title" className="flyer-piece flyer-headline" style={box(13.67, 16.94, 66.25, 23.89)}>
            Every court in order.
            <br />
            Everyone knows what&rsquo;s next.
          </h1>
          <ul aria-label="Called next" className="flyer-piece flyer-calls" style={box(13.83, 42.65, 48.83, 12.64)}>
            <li>Court 4 · 11:10 · Okafor / Tran vs Silva / Ito</li>
            <li>Court 2 · 11:22</li>
            <li>Court 1 · 11:34</li>
          </ul>
          <StartForm />
          <Link to="/explore" className="flyer-piece flyer-follow" style={box(38.2, 69.44, 12.5, 3.33)}>
            Follow a tournament
          </Link>
        </div>

        <aside
          aria-labelledby="landing-slip"
          className="flyer-group flyer-group-slip"
          style={box(83.85, 24.65, 14.1, 31)}
        >
          <p id="landing-slip" className="flyer-slip-label">
            Your next match
          </p>
          <p className="flyer-slip-court">Court 4</p>
          <p className="flyer-slip-time">11:10</p>
          <p className="flyer-slip-players">
            Okafor / Tran vs
            <br />
            Silva / Ito
          </p>
        </aside>

        <p className="flyer-piece flyer-old-time" style={box(68.0, 65.1, 23.44, 5.28)}>
          <span className="sr-only">Moved from </span>
          <s>Court 2 · 11:10</s>
          <span className="sr-only"> to</span> 11:22 (+12 min)
        </p>

        <h2 id="landing-schedule" className="flyer-piece flyer-next" style={box(14.61, 82.4, 42.19, 13.89)}>
          When a match runs late,
          <br />
          the rest of the day keeps up.
        </h2>
      </section>
    </PublicShell>
  );
}

/** The strip printed along the top of the wall: the name, and the two ways past the sheet. */
function WallHeader({ signIn }: { signIn: ReturnType<typeof signInSearch> }) {
  return (
    <header className="flyer-header">
      <Link to="/" className="flyer-logo">
        Tournova
      </Link>
      <nav aria-label="Primary" className="flyer-nav">
        <Link to="/explore">Explore</Link>
        <Dialog>
          <DialogTrigger className="cursor-pointer">How it works</DialogTrigger>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
            <DialogTitle>How it works</DialogTitle>
            <DialogDescription>
              Court 2 ran 12 minutes over. Press play to see how the schedule adjusts.
            </DialogDescription>
            <ScheduleDemo />
          </DialogContent>
        </Dialog>
        <Link to="/auth" search={signIn}>
          Sign in
        </Link>
      </nav>
    </header>
  );
}

/**
 * Naming the tournament is the first question the create flow asks, so the sheet asks it
 * and hands the answer over. It is a plain GET form underneath, so it still leads to the
 * create flow before the page's script has loaded.
 */
function StartForm() {
  const navigate = useNavigate();
  const [name, setName] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    offerTournamentName(name);
    void navigate({ to: "/tournaments/new" });
  }

  return (
    <form action="/tournaments/new" method="get" onSubmit={submit} className="flyer-group flyer-start">
      <label htmlFor="landing-name" className="sr-only">
        Tournament name
      </label>
      <input
        id="landing-name"
        name="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Tournament name"
        autoComplete="off"
        className="flyer-piece flyer-field"
        style={box(13.83, 58.19, 23.2, 9.58)}
      />
      <button type="submit" className="flyer-piece flyer-cta" style={box(36.95, 58.19, 22.89, 9.58)}>
        Run a tournament — free
      </button>
    </form>
  );
}
