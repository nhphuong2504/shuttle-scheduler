import {
  COURT_STATE_CHIP,
  COURT_STATE_LABEL,
  COURT_STATE_TILE,
  type CourtState,
} from "@/lib/tournament/court-state";

/**
 * The Desk as a spectator sees it on a phone: read-only, the board and nothing to press.
 *
 * Its wording is the read-only Desk's own - the notice, the subtitle and "View match" - so
 * the front door promises exactly what a visitor will find. One image to assistive
 * technology, like the Desk still above it.
 */
export function ReaderPreview() {
  return (
    <div
      role="img"
      aria-label="The court board on a phone, read-only: Court 1 is playing, Court 2 has run over its slot."
      className="flex h-[440px] min-w-0 flex-[1_1_440px] justify-center overflow-hidden rounded-2xl bg-muted px-5 pt-10"
    >
      <div className="flex w-[280px] shrink-0 flex-col gap-3 rounded-t-[34px] bg-background px-3.5 py-5 shadow-[0_0_0_7px_var(--foreground)]">
        <p className="rounded-lg border border-info-border bg-info-surface px-2.5 py-2 text-xs leading-snug text-info-foreground">
          Read-only view. Sign in to start, score and schedule matches.
        </p>
        <div>
          <p className="font-display text-lg font-bold">Control desk</p>
          <p className="text-xs text-muted-foreground">A live view of one tournament day: what is on each court.</p>
        </div>
        <div className="flex gap-1">
          <span className="rounded-md bg-primary px-2 py-1.5 text-xs font-semibold text-primary-foreground tabular-nums">
            Sat, Oct 18
          </span>
          <span className="rounded-md bg-muted px-2 py-1.5 text-xs font-semibold text-muted-foreground tabular-nums">
            Sun, Oct 19
          </span>
        </div>
        <PhoneTile court={1} state="playing" names="Hannah Kim vs Grace Lowe" timer="12′ on court" />
        <PhoneTile
          court={2}
          state="overrun"
          names="Ben Carter / Leo Nguyen vs Max Walsh / Owen Brooks"
          timer="37′ on court · +12 over slot"
        />
      </div>
    </div>
  );
}

function PhoneTile({
  court,
  state,
  names,
  timer,
}: {
  court: number;
  state: CourtState;
  names: string;
  timer: string;
}) {
  return (
    <div className={`flex flex-col gap-1 rounded-xl border p-2.5 ${COURT_STATE_TILE[state]}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold">Court {court}</span>
        <span
          className={`rounded-full px-2 py-0.5 font-score text-xs font-semibold uppercase tracking-wide ${COURT_STATE_CHIP[state]}`}
        >
          {COURT_STATE_LABEL[state]}
        </span>
      </div>
      <span className="text-sm font-semibold leading-snug">{names}</span>
      <span
        className={`text-xs tabular-nums ${state === "overrun" ? "font-semibold text-warn-foreground" : "text-muted-foreground"}`}
      >
        {timer}
      </span>
      <span className="text-xs font-semibold text-primary-ink">View match</span>
    </div>
  );
}
