import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { setCurrentTournament } from "@/lib/tournament/actions";
import { useMyTournaments } from "@/lib/tournament/data";
import { cn } from "@/lib/utils";

/**
 * The one control that changes *which* tournament you are working in.
 *
 * It sits in the workspace's section row rather than in the header's top row, and the
 * placement is load-bearing rather than cosmetic. The workspace header has two rows, each
 * with its own centred `max-w-[1400px]` container, and the panel below hangs from the row
 * that contains it. Anchored to the top row it would open *over* the section nav, because
 * `top-full` there means "below the top row" and the nav is what comes next.
 *
 * The section row is also the only element here that *cannot* move. The row is
 * `flex-wrap`, so the trigger can wrap onto a line of its own while the nav sits above it;
 * a panel anchored to the trigger would then be positioned from a box that is no longer at
 * the row's edge, and one anchored to the trigger's own line would overlap the pills that
 * wrapped around it. The row is the last block in the header at every width, so `top-full`
 * on it means "below the whole header" - measured at 4px below the header's bottom edge,
 * and it does not move as the row wraps.
 *
 * ## What `right-0` actually resolves against
 *
 * The row is padded (`px-4`), and `right-0` resolves against its *padding* box, so the
 * panel's right edge is the container's outer edge rather than the nav's content edge: it
 * comes to rest 16px to the right of the trigger, and at a viewport narrower than the
 * container the two coincide and the panel is flush with the viewport. That is a
 * consequence of anchoring to a box that does not wrap rather than a choice, and it is
 * recorded rather than corrected: the alternative - `right-4`, or a wrapper around the
 * trigger - restates the row's padding as a magic number in a second place.
 *
 * What has to hold at every width is that the panel is *inside* the viewport, and that is
 * `max-w-[calc(100vw-2rem)]`'s job rather than the anchor's. Measured with the panel open
 * at 1920, 1366, 1024, 768, 390 and 320, the document overflows by 0 and the panel's own
 * box never leaves the viewport; the slack goes to the panel's left edge, which is at 32px
 * when the viewport is 320.
 *
 * ## A disclosure, not a menu, and not a select
 *
 * A native `<select>` was the obvious choice and it is wrong here twice over. Its value
 * would be a tournament name duplicated beside the name the header already displays - two
 * identical strings in one header, which is noise for a sighted reader and a repeated
 * fragment for a screen reader, and it is not a value display at all: this control *acts*.
 * So it is a plain disclosure - a `button` with `aria-expanded` and a list of buttons that
 * appears when it is open - which is the shape the control actually has, and which needs no
 * arrow-key semantics that `role="menu"` would promise and this does not implement.
 *
 * Keyboard behaviour is the browser's: the trigger is a real button, the items are real
 * buttons, and they are the next thing in the document after it, so Tab reaches them in
 * order and Enter or Space activates them. What is added is the two things a disclosure
 * has to do itself - Escape closes and returns focus to the trigger, and a click anywhere
 * else closes.
 *
 * ## What it writes, and what it does not
 *
 * Selecting a tournament writes `set_current_tournament` and then goes to that
 * tournament's desk. The pointer is *this caller's own choice* and nothing global moves:
 * it is the successor to the old global "make active", which moved every person's desk at
 * once.
 *
 * It is the workspace's writer of that action, and one of the three acts that use it - the
 * create flow points at the tournament it has just made, and a tournament card offers the
 * same move from a list. Which three those are, and that the RPC's own name stays in
 * `actions.ts`, is asserted in `src/routes/-surfaces.test.ts`, so a fourth writer has to be
 * a deliberate edit rather than an accident.
 *
 * It lands on the desk rather than on the section you were reading, because that is what
 * the other control that performs this act does (`/me/tournaments`) and because switching
 * tournaments is a change of subject. One rule for one act.
 *
 * ## Empty is a state, and it has its own answer
 *
 * A caller whose own list is empty is not shown a switcher with nothing in it. They are
 * offered the thing that would give them one, so the control never opens onto an apology.
 * That caller is a platform admin working in somebody else's tournament - the one way to
 * hold the edit right over a tournament that is neither owned nor edited - because everyone
 * else who may edit a tournament holds it in this list by definition.
 *
 * ## It is the operator's control, so only an operator is shown it
 *
 * The workspace renders it under the edit right and nowhere else (`WorkspaceShell` in
 * `app-shell.tsx`). A reader gets the public list instead, which is why this component no
 * longer has a signed-out branch: the `Create tournament` button it used to draw for a
 * visitor was an operator's act in a read-only header, and the audience it existed for is
 * served by the entry they arrived through.
 *
 * The panel is a floating layer, and it is drawn with the shipped vocabulary for one:
 * `bg-popover` with a hairline edge and `shadow-raise`, which is `Panel`'s idiom promoted
 * one elevation level. Its edge is deliberately *not* `border-control`: that token is for
 * a control's own boundary, and a panel's boundary is decoration in the same way a card's
 * is. What has to be perceivable here is the text of the items, and each item is a labelled
 * button, which WCAG 1.4.11 exempts.
 */
export function TournamentSwitcher({ currentId }: { currentId: string | null }) {
  const { summaries, isLoading, isError, error } = useMyTournaments();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    /**
     * `pointerdown` rather than `click`, because the panel must be gone before the press
     * completes anywhere else on the page - closing on `click` leaves the panel visible
     * during the press and lets a press that started outside still land on an item.
     *
     * The trigger is inside the wrapper and is therefore in scope: excluding it matters,
     * because closing on its own pointerdown and then toggling on the click that follows
     * would make the trigger open-once-close-once and look broken.
     */
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  /**
   * Moves this caller's pointer, and follows it.
   *
   * Every query is invalidated rather than the pointer's alone, on the same reasoning
   * `/me/tournaments` uses for the same act: the reads that key off `current_tournament_id`
   * are not all derivable from the pointer's own key, and a cache that keeps describing the
   * tournament you just left is worse than a few refetched requests.
   */
  const switchTo = async (id: string, name: string) => {
    setOpen(false);
    if (id === currentId) return;
    setBusy(true);
    try {
      await setCurrentTournament(id);
      await queryClient.invalidateQueries();
      toast.success(`Now working in ${name}`);
      void navigate({ to: "/tournaments/$tournamentId/desk", params: { tournamentId: id } });
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not switch tournament");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={wrapper} className="ml-auto flex items-center">
      <Button
        ref={trigger}
        type="button"
        size="sm"
        variant="outline"
        /**
         * `aria-haspopup` is deliberately absent. It announces a *menu*, and a menu
         * promises arrow-key navigation between items that this does not implement.
         * `aria-expanded` on a button whose panel follows it in the document is the
         * complete, accurate description of a disclosure.
         */
        aria-expanded={open}
        aria-controls={panelId}
        disabled={busy}
        onClick={() => setOpen((was) => !was)}
      >
        Switch tournament
        <ChevronDown aria-hidden className={cn("transition-transform", open && "rotate-180")} />
      </Button>

      {open ? (
        <div
          id={panelId}
          className="absolute right-0 top-full z-10 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-hairline bg-popover p-1 text-popover-foreground shadow-raise"
        >
          {isLoading ? (
            <p className="px-2 py-2 text-t4 text-muted-foreground">Loading your tournaments…</p>
          ) : isError ? (
            <p className="px-2 py-2 text-t4 text-muted-foreground">
              {error instanceof Error
                ? error.message
                : "The list of your tournaments could not be read."}
            </p>
          ) : summaries.length === 0 ? (
            <div className="px-2 py-2">
              <p className="text-t4 text-muted-foreground">
                You are not running a tournament yet, so there is nothing to switch to.
              </p>
              <Button size="sm" variant="outline" asChild className="mt-2 w-full">
                <Link to="/tournaments/new">Create tournament</Link>
              </Button>
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {summaries.map((summary) => {
                const current = summary.id === currentId;
                return (
                  <li key={summary.id}>
                    <button
                      type="button"
                      /**
                       * The current tournament is marked, not withheld.
                       *
                       * A list that omitted the one you are in would answer "where can
                       * I go" but not "where am I" - and it is the same list as the
                       * set of tournaments you run, so showing all of it and marking
                       * one is the honest draw. Choosing it is a no-op.
                       */
                      aria-current={current ? "true" : undefined}
                      disabled={busy}
                      onClick={() => void switchTo(summary.id, summary.name)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                        "text-t4 hover:bg-accent hover:text-accent-foreground",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        "disabled:pointer-events-none disabled:opacity-50",
                        current ? "font-semibold text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{summary.name}</span>
                      {/*
                        The state carries a glyph and a word as well as a weight, on the
                        same rule as every other state in this system: the check mark and
                        "Working here" are what survive grayscale, and they are the same
                        words `/me/tournaments` already uses for the row you are in.
                      */}
                      {current ? (
                        <span className="inline-flex shrink-0 items-center gap-1 font-score text-sm uppercase tracking-wide text-primary-ink">
                          <Check aria-hidden className="size-3" />
                          Working here
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
