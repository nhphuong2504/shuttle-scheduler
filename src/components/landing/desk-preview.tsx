import { Panel } from "@/components/app-shell";
import { TournovaMark } from "@/components/brand/tournova-mark";
import {
  COURT_STATE_CHIP,
  COURT_STATE_LABEL,
  COURT_STATE_TILE,
  type CourtState,
} from "@/lib/tournament/court-state";

/**
 * A still of the Desk at 14:37 on a Saturday, for the visitor's front door.
 *
 * It is drawn from the Desk's own vocabulary - the court-state pill, tile and label tables,
 * the action-row tones, the readiness wording - so the picture cannot drift from the screen
 * it advertises. Nothing in it is interactive: it is one image to a screen reader, named by
 * `aria-label`, and its buttons are drawn as spans so no tab stop leads nowhere.
 *
 * The data is a sample, but it is one consistent moment, and the schedule demo below it
 * continues the same story: Court 2 is 12 minutes over, which is why Ben Carter's match on
 * Court 3 cannot start.
 */
export function DeskPreview() {
  return (
    <div
      role="img"
      aria-label="The Control desk at 14:37: Court 4 is ready to start, Court 2 has run 12 minutes over its slot, and Court 3 is waiting for a player who is still on Court 2."
      className="overflow-hidden rounded-[20px] bg-background shadow-[0_0_0_1px_rgb(23_26_29/0.08),0_60px_120px_-40px_var(--info-foreground)]"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-hairline bg-surface px-4 py-3">
        <span className="size-[11px] rounded-full bg-destructive" />
        <span className="size-[11px] rounded-full bg-warn-border" />
        <span className="size-[11px] rounded-full bg-success" />
        <span className="ml-3 flex min-w-0 items-center gap-2">
          <TournovaMark className="h-5 w-auto shrink-0 text-primary" />
          <span className="hidden font-display text-[15px] font-bold sm:inline">Riverside Open</span>
          <span aria-hidden="true" className="hidden h-4 w-px bg-hairline sm:block" />
          <span className="font-display text-[17px] font-bold whitespace-nowrap">Control desk</span>
          <span className="text-sm whitespace-nowrap text-muted-foreground tabular-nums">Sat 18 Oct</span>
        </span>
        <span className="ml-auto flex items-center gap-2.5">
          <span className="rounded-full bg-state-live-chip px-2.5 py-1 text-sm font-semibold text-state-live-ink">
            Live
          </span>
          <span className="inline-flex h-9 items-center rounded-md border border-input bg-surface px-3.5 text-sm font-medium">
            Refresh
          </span>
        </span>
      </div>

      <div className="flex flex-col gap-3 p-3.5 sm:p-4">
        <Panel
          title="Needs action"
          right={<span className="text-sm text-muted-foreground tabular-nums">14:37 (updates every 30s)</span>}
          className="min-w-0"
          bodyClassName="p-3"
        >
          <ul className="space-y-2 text-base">
            <PreviewActionRow tone="go" title="Court 4 is ready" detail="Jack Evans vs Liam Murphy" action="Start" />
            <PreviewActionRow
              tone="warn"
              title="Ben Carter / Leo Nguyen vs Max Walsh / Owen Brooks, 37 min on court"
              detail="Court 2, past the expected finish"
              action="Open score desk"
            />
          </ul>
        </Panel>

        <Panel
          title="Court board"
          right={<span className="text-sm text-muted-foreground tabular-nums">Sat 18 Oct, 4 courts</span>}
          className="min-w-0"
          bodyClassName="p-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <PreviewTile
              number={1}
              phone={false}
              state="playing"
              tag="WS R2"
              names="Hannah Kim vs Grace Lowe"
              timer="12′ on court"
              next="Next 14:50: Tom Hughes / Dev Patel vs Sam Okafor / Luke Reid"
              readiness={{ text: "Ready now", tone: "ready" }}
            />
            <PreviewTile
              number={2}
              state="overrun"
              tag="MD R2 crossover"
              names="Ben Carter / Leo Nguyen vs Max Walsh / Owen Brooks"
              timer="37′ on court"
              next="Next 14:25: Ryan Lewis / Adam Grant vs Chris Bell / Dan Ortiz"
              readiness={{ text: "Ready now", tone: "ready" }}
            />
            <PreviewTile
              number={3}
              state="free-blocked"
              next="Next 14:35: Ben Carter / Amy Young vs Sam Lee / Ella Fox"
              readiness={{ text: "Ben Carter, on Court 2", tone: "busy" }}
            />
            <PreviewTile
              number={4}
              phone={false}
              state="free-ready"
              next="Next 14:30: Jack Evans vs Liam Murphy"
              readiness={{ text: "Ready now", tone: "ready" }}
            />
          </div>
        </Panel>
      </div>
    </div>
  );
}

/** The Desk's `ACTION_TONE`, restated for a still: same fills, same glyphs. */
const ACTION_TONE = {
  go: { row: "bg-primary/10 text-foreground", icon: "bg-primary text-primary-foreground", glyph: "▶", button: "bg-primary text-primary-foreground" },
  warn: {
    row: "border border-warn-border bg-warn-surface text-warn-foreground",
    icon: "bg-warn-foreground text-warn-surface",
    glyph: "!",
    button: "border border-input bg-surface text-foreground",
  },
} as const;

function PreviewActionRow({
  tone,
  title,
  detail,
  action,
}: {
  tone: keyof typeof ACTION_TONE;
  title: string;
  detail: string;
  action: string;
}) {
  const style = ACTION_TONE[tone];
  return (
    <li className={`flex min-h-12 flex-wrap items-center gap-3 rounded-lg px-3 py-2 ${style.row}`}>
      <span className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-extrabold ${style.icon}`}>
        {style.glyph}
      </span>
      <span className="min-w-0 flex-[1_1_180px]">
        <span className="block font-semibold leading-snug">{title}</span>
        <span className="block text-sm">{detail}</span>
      </span>
      <span className={`inline-flex h-10 items-center rounded-md px-4 text-sm font-medium whitespace-nowrap ${style.button}`}>
        {action}
      </span>
    </li>
  );
}

const READINESS_TONE = {
  ready: "text-sm font-semibold text-primary-ink",
  busy: "text-danger-foreground",
} as const;

function PreviewTile({
  number,
  phone = true,
  state,
  tag,
  names,
  timer,
  next,
  readiness,
}: {
  number: number;
  /** Shown on a phone too. The phone keeps only the two courts the story is about. */
  phone?: boolean;
  state: CourtState;
  tag?: string;
  names?: string;
  timer?: string;
  next: string;
  readiness: { text: string; tone: keyof typeof READINESS_TONE };
}) {
  return (
    <div
      className={`rounded-xl border p-3 text-left shadow-panel ${phone ? "" : "hidden sm:block"} ${COURT_STATE_TILE[state]}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-display text-base font-bold whitespace-nowrap">
          Court {number}
        </span>
        <span
          className={`inline-flex rounded-full px-2.5 py-1 font-score text-sm font-semibold uppercase tracking-wide ${COURT_STATE_CHIP[state]}`}
        >
          {COURT_STATE_LABEL[state]}
        </span>
      </div>
      <p className="mt-2 text-[15px] font-semibold leading-snug">
        {names ? (
          <>
            <span className="font-score text-sm font-medium text-muted-foreground">{tag}</span>
            <br />
            {names}
            <br />
            <span
              className={`font-score text-base tabular-nums ${
                state === "overrun" ? "font-semibold text-warn-foreground" : "text-muted-foreground"
              }`}
            >
              {timer}
            </span>
          </>
        ) : (
          <span className="font-medium">
            {state === "free-ready" ? "Free, next match ready" : "Free, next match not ready"}
          </span>
        )}
      </p>
      <div className="mt-2 border-t border-hairline pt-2 text-muted-foreground">
        <p className="text-[13px] leading-snug tabular-nums">{next}</p>
        <span className={READINESS_TONE[readiness.tone]}>{readiness.text}</span>
      </div>
    </div>
  );
}
