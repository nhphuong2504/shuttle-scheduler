import { Link, createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { PublicShell } from "@/components/app-shell";
import "@/components/story/story.css";

export const Route = createFileRoute("/story")({
  head: () => ({
    meta: [
      { title: "Our story | Tournova" },
      {
        name: "description",
        content:
          "Why Tournova exists, by its founder: what makes amateur tournaments hard to run, and how Tournova schedules and operates them for organisers, players and spectators.",
      },
    ],
  }),
  component: StoryPage,
});

const FOUNDER = "Phuong Nguyen";

/**
 * The founder's story, in the first person under the founder's own byline - the one public
 * page that names the operator, at the founder's request. Everything it says the product does
 * is shipped behaviour; what is still a direction (other formats, other sports) is worded as
 * one.
 *
 * It is drawn in the landing's world (DESIGN.md, "The Court Board"): prose on the app's grey
 * wall, and figures as sheets pinned beside it. It draws its own masthead so the title and
 * byline sit on the reading column rather than at the shell's left edge.
 */
function StoryPage() {
  return (
    <PublicShell bare>
      <div className="st-page">
        <article className="st-article" aria-labelledby="story-title">
          <header>
            <h1 id="story-title" className="st-title">
              The story behind Tournova
            </h1>
            <p className="st-dek">Rethinking how amateur tournaments are organised.</p>
            <div className="st-byline">
              <p>
                <span className="st-byline-name">{FOUNDER}</span>
                <br />
                <span className="st-byline-role">Founder, Tournova</span>
              </p>
            </div>
          </header>

          <Section title="Where it started">
            <p>
              I love playing badminton, and like many people who take the sport seriously, I look
              for chances to test myself in tournaments. Every year, Iowa State University and
              communities across Iowa and neighbouring states host amateur badminton tournaments,
              and over the past four years I have played in a number of them.
            </p>
            <p>
              Across those events I kept seeing the same thing: organising an amateur tournament is
              far more chaotic, inefficient and frustrating than it should be.
            </p>
            <p>
              Amateur events have problems professional ones do not. Picture more than a hundred
              players, eight or ten courts, and one or two days to finish every match. A player may
              enter men&rsquo;s singles, men&rsquo;s doubles and mixed doubles, so scheduling one
              match affects their partners, their opponents and several other matches.
            </p>
            <p>
              Amateur tournaments also need to give people real chances to play. Nobody wants to
              drive for hours, lose their first match and go home. That is why many events use
              formats that guarantee several matches, with placement or consolation rounds.
            </p>
            <p>
              Together, that makes a surprisingly hard scheduling problem, and the people solving it
              are often volunteers working under pressure with limited tools.
            </p>
          </Section>

          <Section title="The problem">
            <p>
              Many of the tournaments I have played in, and many I have heard about from other
              players and organisers, still run on an older tournament management system. It covers
              the basics, but its screens and workflows are hard to work with, especially when you
              are managing a lot of matches in real time.
            </p>
            <p>
              What surprised me was that organisers kept using it year after year. Everyone
              recognised the problems, but there was no alternative that really met their needs.
              After several tournaments, the same issues kept coming back.
            </p>

            <h3>1. Inefficient scheduling and court use</h3>
            <p>
              Schedules are often built and adjusted by hand, weighing court availability, player
              conflicts, match dependencies and rest all at once. A court can sit empty while
              matches wait, while one player gets back-to-back matches and another waits hours. The
              hard part is not finding a free court. It is choosing the next match without creating
              new conflicts elsewhere.
            </p>

            <h3>2. Not knowing what&rsquo;s next</h3>
            <p>
              As a player, the most frustrating thing is not knowing when or where your next match
              will be. Often the organisers cannot say either, because it depends on matches that
              have not finished yet. So players keep coming to the desk with the same four
              questions.
            </p>
            <figure className="st-figure">
              <ul className="st-slips" aria-label="Questions players bring to the desk">
                {[
                  "When is my next match?",
                  "Which court am I on?",
                  "Who am I playing?",
                  "How much longer do I have to wait?",
                ].map((question) => (
                  <li key={question} className="st-sheet st-slip">
                    {question}
                  </li>
                ))}
              </ul>
            </figure>
            <p>Every answer is time the organisers are not spending on the tournament.</p>

            <h3>3. Long, unpredictable waits</h3>
            <p>
              A tournament can last all day without players spending much of it on court. Someone
              may play early in the morning and then wait hours for their next match. Without a
              schedule they can trust, they cannot plan meals, warm-ups, breaks or when to come back
              to the venue.
            </p>

            <h3>4. Little visibility into progress</h3>
            <p>
              Players and spectators rarely have an easy way to see which matches are on, who has
              advanced, what has finished or how the draws are going. Even organisers can lose the
              full picture when information is spread across screens or kept by hand.
            </p>

            <h3>5. Constant disruption</h3>
            <p>
              A live tournament is unpredictable. Matches run short or long. Players are busy on
              another court. Some matches cannot start until others finish. One delay can ripple
              across several courts and players, and resolving each of those by hand gets harder as
              the day goes on.
            </p>

            <h3>6. Communication bottlenecks</h3>
            <p>
              Many events still call players to court over a microphone. In a crowded, noisy hall,
              players miss calls, organisers repeat them, and courts sit empty while everyone waits
              for the right people to arrive.
            </p>

            <h3>7. Too much resting on a few people</h3>
            <p>
              Amateur tournaments are usually run by a small team of volunteers who handle
              registration, draws, scheduling, questions, court assignments, results and surprises,
              sometimes all at once. Without one central system, the event depends on their memory
              and constant coordination. Organisers end up stressed, and players get an inconsistent
              experience.
            </p>
          </Section>

          <Section title="Introducing Tournova">
            <p>That experience led to a simple question:</p>
            <p className="st-question">
              What if organisers had software that handled the complexity of scheduling and
              operations, so they could focus on running a great tournament instead of constantly
              fixing problems?
            </p>
            <p>
              That question became <Link to="/">Tournova</Link>, a tournament management and
              scheduling platform. It starts with amateur badminton, with the long-term aim of
              supporting other sports that share the same structure.
            </p>
            <p>
              Tournova treats scheduling not as a fixed list of matches but as a moving coordination
              problem between players, courts, match dependencies and time. And it is built for the
              three groups who experience the same event differently.
            </p>
            <figure className="st-figure">
              <div className="st-sheet st-audience">
                <table className="st-table">
                  <caption className="sr-only">
                    Who Tournova is built for, and what each needs
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Who</th>
                      <th scope="col">What they need</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">Organisers</th>
                      <td>
                        Central control, a reliable schedule, a view of every court, and the ability
                        to react quickly when something goes wrong.
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Players</th>
                      <td>
                        Their opponents, their next match, their court, and enough rest between
                        matches.
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Spectators</th>
                      <td>An easy way to follow matches, results, draws and progress.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </figure>
            <p>
              The goal is to connect those three experiences in one platform, rather than treating
              scheduling, operations and public information as separate problems.
            </p>

            <h3>Constraint-aware scheduling</h3>
            <p>
              At its core, Tournova schedules automatically, balancing goals that pull against each
              other:
            </p>
            <ul>
              <li>keep courts busy whenever a suitable match is ready;</li>
              <li>cut unnecessary waits between a player&rsquo;s matches;</li>
              <li>never send a player back on court without enough rest;</li>
              <li>never overlap a player&rsquo;s matches across events;</li>
              <li>wait for the matches a later round depends on;</li>
              <li>avoid changes that make published times unreliable;</li>
              <li>finish within the venue&rsquo;s hours wherever possible.</li>
            </ul>
            <p>
              These cannot all be maximised at once. Filling an empty court right away might mean a
              player plays without rest. Moving a match earlier might fill a court but confuse
              players who planned around the later time. The aim is not to cram in as many matches
              as possible. It is a practical schedule that works for organisers and is fair to
              players.
            </p>

            <h3>A schedule that follows the day</h3>
            <p>
              A good first schedule is only the beginning. A match might take ten minutes or run far
              longer, and a late match can hold up players who are due in other events. Tournova
              treats the day as an ongoing process: as results come in it places the matches they
              unlock, and when a court runs late it pushes the affected matches back.
            </p>
            <figure className="st-figure">
              <div className="st-late">
                <div
                  className="st-sheet"
                  role="img"
                  aria-label="Court 6's sheet. It is running 12 minutes late, so its next two matches have moved from 10:40 to 10:52 and from 11:05 to 11:17. The earlier times are struck through."
                >
                  <p className="st-sheet-title">Court 6</p>
                  <div className="st-grid">
                    <ol className="st-times">
                      <li>09:50</li>
                      <li>10:15</li>
                      <li>
                        <s>10:40</s>
                        <span className="st-moved">10:52</span>
                      </li>
                      <li>
                        <s>11:05</s>
                        <span className="st-moved">11:17</span>
                      </li>
                    </ol>
                    <div className="st-slots" />
                  </div>
                </div>
                <p className="st-late-note" aria-hidden="true">
                  Running 12 min late.
                  <span>Its next matches start 12 minutes later. No other court moves.</span>
                </p>
              </div>
            </figure>
            <p>
              Those automatic changes stay predictable. Tournova does not pull matches earlier,
              switch their courts or move them to another day just to fill a gap. It only delays
              upcoming matches when it has to. Organisers can still make their own changes, and a
              full rebuild is always previewed before anything moves. Automation does the
              arithmetic; people keep the judgment.
            </p>

            <h3>One desk for every court</h3>
            <p>
              The Desk lets a moderator run every court for the day from one screen: what is on
              court now, what has finished and needs a result, what is next on each court, what is
              delayed or waiting on another match, and where something needs attention. It is meant
              to be a control centre, not just a list of matches.
            </p>

            <h3>Players know what&rsquo;s next</h3>
            <p>
              Players should not have to visit the desk to find out what happens next. Tournova
              shows each player their upcoming matches, opponents, courts and results. That only
              helps if the schedule can be trusted, which is why it favours a clear schedule and
              controlled changes over squeezing out theoretical efficiency.
            </p>

            <h3>Match calls without the microphone</h3>
            <p>
              When the desk calls a match, a signed-in player whose entry is linked to their account
              gets the call, with the court number, in their Tournova notifications. That means
              fewer missed calls, courts ready sooner and less shouting across the hall.
            </p>

            <h3>Open to spectators</h3>
            <p>
              Friends, family and spectators can follow results, read the draws and see how the
              tournament is going, without asking anyone at the desk who is playing or who went
              through.
            </p>

            <h3>From registration to the final</h3>
            <p>
              Scheduling is only one part of a tournament. Tournova covers the rest of it too, from
              registration and entries to draws, live operations, results and completion, so
              organisers do not have to stitch together separate tools.
            </p>

            <h3>A format built for amateurs</h3>
            <p>
              Tournova runs the ABCD drop-flight format that many amateur badminton events use.
              Instead of single elimination, where one loss can end your day, every entrant plays
              two placement matches, and their results place them in Draw A, B, C or D.
            </p>
            <figure className="st-figure">
              <div className="st-sheet st-draws">
                <table className="st-table">
                  <caption className="sr-only">
                    How two placement results decide a player&rsquo;s draw
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Placement 1</th>
                      <th scope="col">Placement 2</th>
                      <th scope="col">Plays in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        [true, true, "A"],
                        [true, false, "B"],
                        [false, true, "C"],
                        [false, false, "D"],
                      ] as const
                    ).map(([first, second, draw]) => (
                      <tr key={draw}>
                        <Result won={first} />
                        <Result won={second} />
                        <td className="st-draw">Draw {draw}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <figcaption>Each draw is single elimination and runs to its own winner.</figcaption>
            </figure>
            <p>
              Players meet others at a similar level, and everyone plays more than once. This is the
              first format. Future versions will add others, so organisers can shape a tournament
              around their players, their venue and their schedule.
            </p>

            <h3>Beyond badminton</h3>
            <p>
              Tournova grew out of badminton, but the problem is not unique to it. Pickleball and
              table tennis events face the same things: limited courts or tables, players in several
              events, overlapping matches, rest, and unpredictable match lengths. The long-term plan
              is a common foundation for scheduling, courts and live operations, with each sport
              bringing its own competition rules.
            </p>
          </Section>

          <Section title="The bigger picture">
            <p>
              Not every problem in running an amateur tournament can be solved by an algorithm.
              There will always be delays, last-minute changes and calls that need a person. But
              organisers should not have to solve the same scheduling and coordination problems by
              hand, over and over again.
            </p>
            <p>
              What interests me is that this is not only a scheduling problem. It is also a
              real-time operations problem and a user experience problem. An efficient schedule
              means little if players cannot trust their times. A clever algorithm helps little if
              organisers cannot see what is happening or step in when something goes wrong. And a
              well-run event still feels frustrating if nobody can follow it.
            </p>
            <p>For Tournova to work, those pieces have to work together:</p>
            <ul>
              <li>
                players know when and where they play, get proper rest, and spend less time waiting
                in the dark;
              </li>
              <li>
                organisers see the whole tournament, do less repetitive work and decide with good
                information when something goes wrong;
              </li>
              <li>spectators follow the competition without relying on scattered announcements.</li>
            </ul>
            <p>
              Tournova starts with badminton and the ABCD drop-flight format, but the ambition is
              broader: amateur tournaments in many sports that are easier to organise, more
              predictable to run and more enjoyable to be part of.
            </p>
            <p className="st-closing">
              Players should get to focus on playing, and organisers on organising, not on fighting
              their scheduling software.
            </p>
            <p className="st-signoff">{FOUNDER}, Founder</p>
          </Section>

          <nav aria-label="Get started" className="st-actions">
            {/* A plain GET form, as on the landing, so it works before the page's script loads. */}
            <form action="/tournaments/new" method="get">
              <button type="submit" className="st-cta">
                Run a tournament — free
              </button>
            </form>
            <Link to="/explore" className="st-follow">
              Follow a tournament
            </Link>
          </nav>
        </article>
      </div>
    </PublicShell>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="st-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Result({ won }: { won: boolean }) {
  return (
    <td className="st-result" data-lost={won ? undefined : ""}>
      {won ? "Won" : "Lost"}
    </td>
  );
}
