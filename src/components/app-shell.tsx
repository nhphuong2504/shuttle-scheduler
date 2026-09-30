import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { type ReactNode } from "react";

import { TournamentSwitcher } from "@/components/tournament-switcher";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { useTheme } from "@/hooks/useTheme";
import { supabase } from "@/integrations/supabase/client";
import {
  normalizeTournamentStatus,
  tournamentStatusLabel,
  type TournamentStatus,
} from "@/lib/auth/authorization";
import type { Theme } from "@/lib/design/theme";
import { signInSearch } from "@/lib/routing/redirect";
import {
  registrationStateHint,
  registrationStateLabel,
  type RegistrationState,
} from "@/lib/tournament/registration-state";
import { useTournamentContext } from "@/lib/tournament/data";
import {
  BYE_NOTE,
  displayStateFor,
  MATCH_DISPLAY_LABEL,
  MATCH_DISPLAY_TIER,
} from "@/lib/tournament/match-status";
import { cn } from "@/lib/utils";

/**
 * Page chrome, split by audience.
 *
 * There are two shells, because there are two audiences and the header is where they
 * differ:
 *
 *  - **`WorkspaceShell`** wraps one tournament. It is rendered by the layout route
 *    (`/tournaments/$tournamentId/route.tsx`), so it mounts once for the whole workspace
 *    rather than once per page, and it carries the tournament's own identity: name,
 *    lifecycle status, and the section nav for the pages under it. Its read-only
 *    treatment is one component shared by a signed-out visitor and a signed-in viewer,
 *    because the two are the same fact - this caller may not change anything here.
 *  - **`PublicShell`** wraps the pages that are not about one tournament: the front door,
 *    sign-in, Explore, My Tournaments and the create flow. It has no tournament to name
 *    and no scoped section nav, because there is nothing for it to navigate to; it carries
 *    the public nav instead.
 *
 * The split is what lets the workspace header hold the tournament's name at all. While
 * every page rendered its own shell, the header could only show what a page passed it,
 * so a visitor had no way to tell which tournament a page was about beyond reading its
 * title.
 *
 * ## The primitives stay here
 *
 * `Panel`, `StatTile`, `EmptyState`, `StatusPill` and `ByeMarker` are exported from this
 * file and used by both shells' pages. They are deliberately not split alongside the
 * shells: the vocabulary they render is one vocabulary, and the status tiers come from
 * [`match-status.ts`](../lib/tournament/match-status.ts) rather than from a component.
 */

/**
 * The workspace navigation.
 *
 * Pools and Draws are deliberately absent: the tournament creation flow replaced
 * the round-robin engine with the two-round placement format, and the round-robin
 * route files and every library they depend on are untouched, so those pages still
 * exist for a direct URL; only the nav entries are gone.
 *
 * `Placement` and `Schedule` are the format that *is* built, so they are the two
 * entries that lead to its own engine.
 *
 * **Every section is a child of the workspace layout, so a nav link carries an id.**
 * Until S6 there was a second address beside each scoped one - the flat path the section
 * lived at before the workspace move - because `PublicShell` rendered this nav outside a
 * workspace, where no id exists. It carries the public nav now, so the pair is gone: the
 * only consumer of these entries is the shell that knows its tournament, and the flat
 * paths survive only as redirects (`lib/routing/workspace-redirect.ts`).
 *
 * `Registration` became `Entries` in the same commit that moved the file to
 * `entries.tsx`. That is deliberate rather than cosmetic: S11 adds a *different*
 * surface at `/registrations` - the queue of requests awaiting a decision - and one
 * of the two names had to give. The operator page lists who is already in the
 * tournament, which is what "Entries" says and "Registration" no longer does.
 */
const SECTIONS = [
  { label: "Desk", scoped: "/tournaments/$tournamentId/desk" },
  { label: "Entries", scoped: "/tournaments/$tournamentId/entries" },
  { label: "Placement", scoped: "/tournaments/$tournamentId/placement" },
  { label: "Knockout", scoped: "/tournaments/$tournamentId/knockout" },
  { label: "Schedule", scoped: "/tournaments/$tournamentId/schedule" },
  { label: "Scores", scoped: "/tournaments/$tournamentId/scores" },
] as const;

/**
 * The two entries that belong to the people who run the tournament.
 *
 * Both are gated on `can_edit` rather than on being signed in, because both are about
 * changing this tournament: Setup is where its configuration and lifecycle live, and
 * Access is who else may operate it. A viewer is offered neither entry - the pages
 * themselves say plainly that they cannot be used, but a nav entry that leads to a page
 * telling you no is a worse answer than not offering the trip.
 */
const EDITOR_SECTIONS = [
  { label: "Setup", scoped: "/tournaments/$tournamentId/settings" },
  { label: "Access", scoped: "/tournaments/$tournamentId/access" },
] as const;

/**
 * The public navigation: the three addresses that are not about one tournament.
 *
 * The workspace nav resolves its sections against a tournament id, and outside a
 * workspace there is none - so until S6 this shell rendered the *flat* legacy paths and
 * let them resolve on the caller's pointer. That is gone, and it is the better answer
 * rather than merely the tidier one: a nav entry that silently moves a reader to
 * whichever tournament their pointer names is a nav entry that lies about where it goes.
 * These three say what they are.
 *
 * It does not change with the session. "My tournaments" and "New tournament" lead a
 * visitor to a page that states plainly what it needs rather than to a dead link, and a
 * nav that grows an entry once the session settles would move the row the reader is
 * aiming at.
 */
const PUBLIC_SECTIONS = [
  { label: "Explore", to: "/explore" },
  { label: "My tournaments", to: "/me/tournaments" },
  { label: "New tournament", to: "/tournaments/new" },
] as const;

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Shared so the two nav branches cannot drift into two different-looking navs. */
const NAV_ITEM_CLASS =
  "rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
const NAV_ACTIVE_CLASS =
  "bg-primary text-primary-foreground shadow-panel hover:bg-primary hover:text-primary-foreground";

/**
 * Theme switch.
 *
 * The shell's only appearance control. A `role="group"` of pressed buttons rather
 * than a radiogroup, on the same reasoning as any other immediate-apply control:
 * themes take effect as they are pressed and are not a form field awaiting
 * submission, so `aria-pressed` describes them accurately while a radio role would
 * imply a pending value.
 *
 * The honesty rule: the pressed button reflects what is actually rendering,
 * including when that came from the operating system rather than from a choice made
 * here. On a first visit nothing is stored, the system supplies the theme, and the
 * button for it reads as pressed — which is the state the operator can see, so it is
 * the state the control reports.
 *
 * There are two buttons and no third. The reset that returned to following the
 * operating system used to sit beside them and is gone, and its cost is real rather
 * than cosmetic: a chosen theme is now the only reachable state, so an operator who
 * picks one cannot go back to following the system. What is *not* gone is the
 * fallback itself — an unset preference still resolves from the operating system, as
 * `resolveTheme` has always done, which is why the controls work without a choice
 * having been made. See `useTheme` for why nothing ever writes that preference.
 */
function ThemeToggle({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (next: Theme) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="hidden items-center rounded-full border border-hairline bg-muted/60 p-0.5 sm:flex"
    >
      {THEME_OPTIONS.map((option) => {
        const active = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-full px-2.5 py-1 font-semibold transition-colors",
              "text-t4",
              // The ring is the selected-state boundary. Without it the active segment
              // is `bg-surface` on a `bg-muted` container, which measures 1.09:1 in
              // light and 1.02:1 in dark - a selected state a low-vision user cannot
              // see. `ring` draws a box-shadow, so this costs no layout.
              active
                ? "bg-surface text-foreground shadow-panel ring-1 ring-border-selected"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The mark, shared by both shells so the two headers cannot drift apart. */
function BrandMark() {
  return (
    <>
      <span className="grid size-7 place-items-center rounded-lg bg-primary font-display text-t2 font-bold text-primary-foreground shadow-panel">
        T
      </span>
      <span className="font-display text-sm font-bold tracking-tight text-primary">
        TOURNOVA<span className="text-muted-foreground"> / ops</span>
      </span>
    </>
  );
}

/**
 * Who is signed in, and how to stop being signed in.
 *
 * The presence dot is the live ink, not the live chip: it is a 6px solid mark, the same
 * shape the live status pill draws its glyph from, and the chip is a pale wash (L 0.935
 * in light) that would be invisible at this size. The ink is the saturated end of the
 * same hue at both themes, so the dot and a live match read as one colour. Decorative —
 * the email and role beside it carry the meaning — so it stays out of the accessibility
 * tree.
 *
 * ## Signing in returns you to the page you were on
 *
 * The button carries the current address as `/auth`'s `redirect`, so a visitor reading a
 * tournament comes back to it rather than to Home. The address is read from the router
 * rather than passed in, because the shell is rendered by every page and the pages should
 * not each have to remember to say where they are.
 *
 * Signing *out* deliberately carries nothing. A return address describes a page you were
 * kept from, and leaving is the opposite of that: coming back to the page you just walked
 * away from is not a kindness.
 */
function SessionBlock() {
  const { session, signedIn, systemRole } = useSession();
  const navigate = useNavigate();
  const href = useLocation({ select: (location) => location.href });

  if (!signedIn) {
    return (
      <Button
        size="sm"
        onClick={() => navigate({ to: "/auth", search: signInSearch(href) })}
      >
        Sign in
      </Button>
    );
  }

  return (
    <>
      <span className="hidden items-center gap-1.5 rounded-full border border-hairline bg-muted/60 px-2.5 py-1 text-muted-foreground sm:inline-flex">
        <span aria-hidden className="size-1.5 rounded-full bg-state-live-ink" />
        {session?.userEmail}
        {systemRole ? ` · ${systemRole}` : ""}
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          await supabase.auth.signOut();
          navigate({ to: "/auth", replace: true });
        }}
      >
        Sign out
      </Button>
    </>
  );
}

/**
 * The lifecycle status, drawn through the same tiers the match vocabulary uses.
 *
 * A tournament's state is not a match's state, and this is not a second status system:
 * it is the same three treatments applied to the same three meanings, so a host learns
 * one vocabulary.
 *
 *   upcoming     -> tier 3, a neutral chip    (nothing has started)
 *   in_progress  -> tier 1, the saturated live chip, reusing the match `live` tokens
 *   completed    -> tier 4, ink only, no container (an archive state recedes by losing
 *                   its chip rather than by lightening its ink)
 *
 * Every one of the three also carries its own glyph and its own word, so the state
 * survives grayscale. The word comes from `tournamentStatusLabel` rather than a local
 * switch, because a local default is what once labelled every not-yet-started
 * tournament with a lifecycle state the database can no longer produce.
 *
 * Exported because Explore and My Tournaments draw the same pill: it is the tournament's
 * identity, not the workspace header's private drawing of it.
 */
export function TournamentStatusPill({ status }: { status: TournamentStatus }) {
  const label = tournamentStatusLabel(status);

  if (status === "completed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 font-score text-t4 uppercase tracking-wider text-state-completed-ink">
        {STATE_GLYPH["completed"]}
        {label}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-score text-t4 uppercase tracking-wider ring-1 ring-inset",
        status === "in_progress"
          ? "bg-state-live-chip text-state-live-ink ring-state-live-ink/25"
          : "bg-muted text-muted-foreground ring-hairline",
      )}
    >
      {status === "in_progress" ? STATE_GLYPH["live"] : STATE_GLYPH["scheduled"]}
      {label}
    </span>
  );
}

/**
 * The read-only treatment, shared by a visitor and a viewer.
 *
 * One component because it is one fact - this caller may not change anything here - and
 * two sentences because the two callers have different next steps: a visitor can sign in
 * and a viewer cannot buy the right by signing in again, so telling the second one to
 * sign in would be wrong. The treatment itself is identical, which is what stops the
 * workspace from looking like two different products depending on who opened it.
 *
 * It renders only once the access read has settled. Rendering it while the answer is in
 * flight would flash "read-only" at every editor on every navigation, and an editor who
 * sees that banner on load learns to ignore it.
 */
function ReadOnlyNotice({ signedIn }: { signedIn: boolean }) {
  return (
    <div
      className="mb-4 rounded-lg border border-warn-border bg-warn-surface px-3 py-2 text-t4 font-medium text-warn-foreground"
      data-read-only
    >
      {signedIn
        ? "Read-only view. You can see this tournament but not change it — ask its owner for edit access."
        : "Read-only view. Sign in to start, score and schedule matches."}
    </div>
  );
}

/**
 * The registration window, as the database decided it.
 *
 * This is the pill a card draws to answer "can I enter this", and it is deliberately a
 * *read*: the state comes from `tournament_registration_state`, which is computed from the
 * same predicates `submit_tournament_registration` consults. A card that derived the
 * answer from the two timestamps and the lifecycle would disagree with the RPC that
 * refuses the submission, and the person it disagrees with is standing at a desk with a
 * participant in front of them.
 *
 * ## Why one state carries a hue and six do not
 *
 * Green is this system's "something is happening right now" - a live match, a tournament
 * in progress - and an open window is exactly that: a thing accepting input as the page
 * renders. So `open` takes the live treatment rather than a new hue, which is the same
 * reuse `TournamentStatusPill` makes for `in_progress`.
 *
 * The other six are all "nothing is being accepted, and here is why", which is a receding
 * fact rather than an urgent one. They take the neutral tier-3 chip, and they are told
 * apart by their glyph and their word - never by their colour, which they do not vary at
 * all. `completed` is the one exception to the chip: like every other archive state in
 * this system it loses its container and renders as ink, because the tournament is over
 * and the window is no longer a live question.
 */
export function RegistrationStatePill({ state }: { state: RegistrationState }) {
  const label = registrationStateLabel(state);

  if (state === "completed") {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 font-score text-t4 uppercase tracking-wider text-state-completed-ink"
        title={registrationStateHint(state)}
      >
        {REGISTRATION_GLYPH[state]}
        {label}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-score text-t4 uppercase tracking-wider ring-1 ring-inset",
        state === "open"
          ? "bg-state-live-chip text-state-live-ink ring-state-live-ink/25"
          : "bg-muted text-muted-foreground ring-hairline",
      )}
      title={registrationStateHint(state)}
    >
      {REGISTRATION_GLYPH[state]}
      {label}
    </span>
  );
}

/**
 * The pages under one tournament.
 *
 * Rendered by the layout route, so it mounts once per workspace rather than once per
 * navigation: the header, the nav and the session block survive a move between pages
 * instead of being rebuilt. The tournament and the caller's access both come from the
 * layout's context, which is the same answer the page below it reads.
 */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  const { tournament, tournamentId, access, accessLoading } = useTournamentContext();
  const { signedIn } = useSession();
  const { theme, setTheme } = useTheme();

  const sections = access.can_edit ? [...SECTIONS, ...EDITOR_SECTIONS] : SECTIONS;
  const readOnly = !accessLoading && !access.can_edit;

  return (
    <div className="min-h-screen bg-background font-body text-foreground">
      <header className="sticky top-0 z-30 border-b border-hairline bg-surface/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-2.5">
          {/*
            The brand goes to the tournament you are looking at, never to `/`. It used to
            point at `/` always, which after the workspace move would send an operator
            working in tournament B to whatever their pointer happened to name - possibly
            A. A logo that moves you to a different event than the one on screen is worse
            than one that does nothing.
          */}
          {tournamentId ? (
            <Link
              to="/tournaments/$tournamentId/desk"
              params={{ tournamentId }}
              className="flex items-center gap-2"
            >
              <BrandMark />
            </Link>
          ) : (
            <span className="flex items-center gap-2">
              <BrandMark />
            </span>
          )}

          {/*
            Which tournament this is. The name is truncated rather than wrapped, because a
            long name must not push the nav onto a third line, and the status beside it is
            the one fact a host needs before touching anything.
          */}
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-display text-sm font-semibold">
              {tournament?.name ?? "Loading…"}
            </span>
            {tournament ? (
              <TournamentStatusPill status={normalizeTournamentStatus(tournament.status)} />
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle theme={theme} onChange={setTheme} />
            <SessionBlock />
          </div>
        </div>

        {/*
          The section row, and the reason it is a `div` wrapping the `nav` rather than the
          `nav` itself.

          Two things live on this line: the sections of the tournament you are reading, and
          the control that changes which tournament that is. The second is not a section, so
          it does not belong inside the sections landmark. It also anchors its panel to this
          row, which is the last row of the header: `relative` here is what puts the panel's
          right edge on the same container edge the nav is aligned to, and its top on the
          header's own bottom edge. See `TournamentSwitcher` for what those two facts buy.
        */}
        <div className="relative mx-auto flex max-w-[1400px] flex-wrap items-center gap-1 px-4 py-2">
          <nav aria-label="Tournament sections" className="flex flex-wrap items-center gap-1">
            {tournamentId
              ? sections.map((item) => (
                  <Link
                    key={item.scoped}
                    to={item.scoped}
                    params={{ tournamentId }}
                    className={NAV_ITEM_CLASS}
                    activeProps={{ className: NAV_ACTIVE_CLASS }}
                  >
                    {item.label}
                  </Link>
                ))
              : null}
          </nav>
          <TournamentSwitcher currentId={tournamentId} />
        </div>
      </header>

      <main className="mx-auto min-h-[calc(100vh-5.5rem)] max-w-[1400px] px-4 py-6">
        {readOnly ? <ReadOnlyNotice signedIn={signedIn} /> : null}
        {children}
      </main>
    </div>
  );
}

/**
 * The pages that are not about one tournament.
 *
 * Sign-in, Explore, My Tournaments, the create flow and the front door. It has no
 * tournament to name and no section nav, and it renders the public nav instead - three
 * addresses that need no id, rather than the flat legacy paths that used to resolve on
 * the caller's pointer. See `PUBLIC_SECTIONS` for why that matters.
 */
export function PublicShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { theme, setTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background font-body text-foreground">
      <header className="sticky top-0 z-30 border-b border-hairline bg-surface/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <Link to="/" className="flex items-center gap-2">
            <BrandMark />
          </Link>
          <nav aria-label="Primary" className="flex flex-wrap items-center gap-1">
            {PUBLIC_SECTIONS.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={NAV_ITEM_CLASS}
                activeProps={{ className: NAV_ACTIVE_CLASS }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle theme={theme} onChange={setTheme} />
            <SessionBlock />
          </div>
        </div>
      </header>

      <main className="mx-auto min-h-[calc(100vh-3.5rem)] max-w-[1400px] px-4 py-6">
        <PageHeader title={title} subtitle={subtitle} actions={actions} />
        {children}
      </main>
    </div>
  );
}

/**
 * A page's own title, subtitle and actions.
 *
 * The workspace header names the *tournament*; this names the page inside it. Both cannot
 * be the h1, so the split is: the shell owns the identity that persists across pages, and
 * every page owns the one line that says what it is showing.
 *
 * Not a `<header>` element. It sits inside `main`, where a banner landmark would be a
 * second one nested in the page's own content, and the shape a page's actions live in is
 * the row this renders.
 */
function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

/**
 * One page inside a shell: its title row, then its content.
 *
 * It exists so the split between the shell and the page is a change of *wrapper* rather
 * than a change of shape at every call site. A page used to render `AppShell` around its
 * content and to be the thing that drew the header; it now renders `Page`, and the shell
 * it is drawn inside comes from the layout route above it. The markup a page owns is
 * therefore unchanged - title, subtitle, actions, content - and the thirty pages under
 * the workspace did not have to be re-indented to say so.
 */
export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      {children}
    </>
  );
}

export function Panel({
  title,
  right,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-hairline bg-surface shadow-panel transition-shadow hover:shadow-raise",
        className,
      )}
    >
      {title || right ? (
        <header className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-hairline px-4 py-2.5">
          <h2 className="font-display text-xs font-bold uppercase tracking-widest text-muted-foreground">
            {title}
          </h2>
          {right}
        </header>
      ) : null}
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "normal",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "normal" | "good" | "warn" | "danger";
}) {
  const toneClass =
    tone === "danger"
      ? "border-danger-border bg-danger-surface"
      : tone === "warn"
        ? "border-warn-border bg-warn-surface"
        : tone === "good"
          ? "border-hairline bg-success/10"
          : "border-hairline bg-surface";
  /**
   * The label takes the surface's own ink, not the neutral muted ink.
   *
   * Phase 6 found this by scanning the desk with data in it for the first time, which
   * is the only way it could be found: on an empty tournament no tile is ever toned,
   * so the pair was never rendered and never measured. In dark mode the label measured
   * 3.95:1 on the warning surface against the 4.5:1 that 12px needs - a real AA failure
   * on three tiles at once, on the row a moderator reads to decide what to do next.
   *
   * The neutral ink is solved against the neutral surfaces, so it cannot be expected to
   * clear a tinted one. Each tone already has an ink solved against its own surface -
   * that is what `warn-foreground` and `danger-foreground` are - and using it is also
   * the better answer visually: a label that shares its tile's tone reads as part of the
   * alert instead of as chrome sitting on top of it.
   */
  const labelClass =
    tone === "danger"
      ? "text-danger-foreground"
      : tone === "warn"
        ? "text-warn-foreground"
        : "text-muted-foreground";
  return (
    <div className={cn("rounded-xl border p-3 shadow-panel", toneClass)}>
      <p className={cn("text-t4 font-semibold uppercase tracking-[0.12em]", labelClass)}>{label}</p>
      <p className="mt-1 font-score text-t1 font-semibold leading-none tracking-tight">{value}</p>
      {hint ? <p className={cn("mt-1 text-t4", labelClass)}>{hint}</p> : null}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-hairline bg-muted/30 px-4 py-8 text-center">
      <p className="font-display text-sm font-semibold">{title}</p>
      {hint ? <p className="max-w-md text-xs text-muted-foreground">{hint}</p> : null}
      {action}
    </div>
  );
}

/**
 * How each display state is drawn.
 *
 * The vocabulary itself - which statuses exist, what they are called, which tier
 * each sits in - lives in `@/lib/tournament/match-status`, so the tests and the
 * token integrity check read the same source this component renders from. What
 * stays here is only what needs JSX: the glyphs, and the class strings Tailwind
 * has to see literally in order to emit a rule.
 *
 * Tier is the structural idea. Tiers 1-3 render as a chip; tier 4 renders as
 * bare inline text. That is the whole reason archive states recede.
 *
 *   tier 1  saturated chip   live
 *   tier 2  shared amber     (unoccupied - its states were phantom)
 *   tier 3  neutral chip     scheduled, void
 *   tier 4  NO chip          walkover, completed
 *
 * Colour is never the only channel: every state also carries a distinct glyph
 * and a text label, so the pill survives grayscale and colour blindness.
 */
const STATE_CLASS: Record<string, string> = {
  live: "bg-state-live-chip text-state-live-ink ring-state-live-ink/25",
  scheduled: "bg-state-scheduled-chip text-state-scheduled-ink ring-state-scheduled-ink/25",
  /**
   * Void is the exceptional neutral, and the ring is the exception.
   *
   * A heavier, more opaque inset ring is what makes it read as marked rather
   * than merely empty, and it is the channel that survives dark mode - where the
   * neutral ramp is too compressed for a lightness step to separate void from
   * scheduled at all (7.2% of luminance, against 14.2% in light). Expressing it
   * as an edge rather than a hue keeps it inside the three-hue rule and away from
   * the destructive red, which means disputed or destructive and nothing else.
   */
  void: "bg-state-void-chip text-state-void-ink ring-2 ring-state-void-ink/50",
};

/**
 * Tier 4 is ink-only: no fill, no border, no radius.
 *
 * Archive states recede by LOSING their container, not by lightening their ink.
 * Lightening was the original plan and it fails measurement - the lightest grey
 * that still clears 4.5:1 on a surface is about L 0.55, so an archive ink at
 * L 0.64 would be illegal. Dropping the chip removes far more visual weight than
 * a lightness step could, while raising legibility instead of lowering it.
 */
const STATE_TIER4_CLASS = "text-state-completed-ink";

/** Strokes use `currentColor`, so the glyph inherits the state ink. */
function glyph(children: ReactNode) {
  return (
    <svg
      viewBox="0 0 18 18"
      className="size-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const STATE_GLYPH: Record<string, ReactNode> = {
  // Clock — nothing has started yet.
  scheduled: glyph(
    <>
      <circle cx="9" cy="9" r="6.25" />
      <path d="M9 5.75V9l2.25 1.5" />
    </>,
  ),
  // Filled target — the match is running now.
  live: glyph(
    <>
      <circle cx="9" cy="9" r="6.25" />
      <circle cx="9" cy="9" r="2.6" fill="currentColor" stroke="none" />
    </>,
  ),
  // Skip — the tie was passed over, not played.
  walkover: glyph(
    <>
      <path d="M5.6 6.1 9.4 9l-3.8 2.9z" fill="currentColor" stroke="none" />
      <path d="M11.9 6.1v5.8" />
    </>,
  ),
  // Check.
  completed: glyph(<path d="M5 9.4l2.7 2.7L13 6.4" />),
  /**
   * Struck circle — the match was nullified.
   *
   * A slash through a ring is the one shape in this set that reads as "this did
   * not count" without borrowing the meaning of any other state. It is distinct
   * from the walkover glyph in both parts: walkover is a solid triangle beside a
   * vertical bar (a skip), void is a hollow ring with a diagonal through it. The
   * two are the most easily confused pair in the vocabulary, which is why the
   * label is load-bearing rather than decorative.
   */
  void: glyph(
    <>
      <circle cx="9" cy="9" r="6.25" />
      <path d="M5.6 12.4 12.4 5.6" />
    </>,
  ),
};

const STATE_FALLBACK_GLYPH = glyph(
  <circle cx="9" cy="9" r="1.8" fill="currentColor" stroke="none" />,
);

/**
 * One glyph per registration state, and a distinct one for each.
 *
 * Three of these are borrowed from the match vocabulary because the meaning is the same
 * one rather than a resemblance: `live` for a window taking requests now, `scheduled` for
 * one that has not opened, `void` for a tournament that never offered registration at all
 * (a condition that does not apply, which is what the struck ring says). The other four are
 * drawn here: an hourglass for a window still to open, sliders for one held back by the
 * host's own configuration, a lock for one that has closed, and a play mark for one whose
 * event has started.
 */
const REGISTRATION_GLYPH: Record<RegistrationState, ReactNode> = {
  open: STATE_GLYPH["live"],
  not_offered: STATE_GLYPH["void"],
  completed: STATE_GLYPH["completed"],
  // An hourglass: waiting on the clock rather than on anybody's decision.
  opens_soon: glyph(
    <>
      <path d="M6 3.5h6" />
      <path d="M6 14.5h6" />
      <path d="M6.75 3.5v2.4L9 9l2.25-3.1V3.5" />
      <path d="M6.75 14.5v-2.4L9 9l2.25 3.1v2.4" />
    </>,
  ),
  // Sliders: the window exists but the tournament is not configured to accept yet.
  not_ready: glyph(
    <>
      <path d="M3.5 6.25h11" />
      <path d="M3.5 11.75h11" />
      <circle cx="7" cy="6.25" r="1.6" />
      <circle cx="11.5" cy="11.75" r="1.6" />
    </>,
  ),
  // A closed padlock.
  closed: glyph(
    <>
      <rect x="4.25" y="8" width="9.5" height="6.75" rx="1.5" />
      <path d="M6.5 8V6.4a2.5 2.5 0 0 1 5 0V8" />
    </>,
  ),
  // A play mark: the event has begun, so the question is closed by the lifecycle.
  started: glyph(<path d="M6.75 4.9 13.5 9l-6.75 4.1z" />),
};

/** Rightwards arrow — the entrant advances without playing. */
const BYE_GLYPH = glyph(
  <>
    <path d="M4.5 9h9" />
    <path d="M10.5 5.75 13.75 9l-3.25 3.25" />
  </>,
);

export function StatusPill({ status }: { status: string }) {
  const display = displayStateFor(status);

  /**
   * An unrecognised value is printed rather than swallowed.
   *
   * This is the branch a typo takes, and it is deliberately neutral: a muted chip
   * carrying the raw string. It is no longer the branch `void` takes - that was
   * the defect this phase fixes - so an unrecognised value now looks like exactly
   * what it is, which is a value nobody planned for.
   */
  if (!display) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-score text-t2 uppercase tracking-wider text-muted-foreground ring-1 ring-inset ring-hairline">
        {STATE_FALLBACK_GLYPH}
        {status.replace(/_/g, " ")}
      </span>
    );
  }

  const label = MATCH_DISPLAY_LABEL[display];
  const glyphNode = STATE_GLYPH[display];
  const tier = MATCH_DISPLAY_TIER[display];

  if (tier === 4) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 font-score text-t2 uppercase tracking-wider",
          STATE_TIER4_CLASS,
        )}
      >
        {glyphNode}
        {label}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-score text-t2 uppercase tracking-wider ring-1 ring-inset",
        STATE_CLASS[display],
      )}
    >
      {glyphNode}
      {label}
    </span>
  );
}

/**
 * A bye, drawn as a draw condition rather than as a match status.
 *
 * A bye is not a match that happened - it is an entrant who advanced because their
 * opponent slot was empty. It nonetheless has to be stored as a match row, and the
 * generator stores it as `status: "reported"` with `is_bye` and a `note` of "Bye",
 * which means every surface that rendered a plain status pill was calling a bye
 * "Completed". One surface worked around that by passing `"walkover"` instead,
 * which is a different wrong answer: a walkover is a tie that was awarded, and a
 * bye is a tie that was never drawn.
 *
 * The distinguishing channel here is the EDGE, not the hue. A dashed outline is
 * already this app's vocabulary for "not a real thing" - it draws empty states and
 * placeholders - so it reads as provisional without colour, without a new token,
 * and without inventing a status the schema does not have. That matters because
 * the vocabulary is a closed set of five and a bye is not one of them.
 */
export function ByeMarker() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-hairline px-2 py-0.5 font-score text-t2 uppercase tracking-wider text-muted-foreground"
      title={BYE_NOTE}
    >
      {BYE_GLYPH}
      {BYE_NOTE}
    </span>
  );
}
