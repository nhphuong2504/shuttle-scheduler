import { Panel } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { dateRangeLabel, type DraftForm } from "./types";

/**
 * A one-glance summary of the draft that stays visible while the host moves
 * between steps, so the consequences of each choice are always in view.
 */
export function DraftHeader({ form, isDraft }: { form: DraftForm; isDraft: boolean }) {
  const activeEvents = form.events.filter((event) => event.active !== false);

  return (
    <Panel title="Draft summary" bodyClassName="p-0">
      <div className="border-b border-hairline bg-gradient-to-br from-primary/10 to-transparent px-4 py-3">
        <p className="font-display text-base font-bold leading-tight">
          {form.basics.name.trim() || "Untitled tournament"}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Badge variant={isDraft ? "secondary" : "outline"}>
            {isDraft ? "Draft" : "In progress"}
          </Badge>
          <span className="font-score text-[11px] text-muted-foreground">
            {dateRangeLabel(form.days)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 divide-x divide-hairline border-b border-hairline">
        <MiniStat label="Days" value={form.days.length} />
        <MiniStat label="Events" value={activeEvents.length} />
      </div>

      <dl className="divide-y divide-hairline">
        <SummaryItem
          label="Event codes"
          value={activeEvents.length ? activeEvents.map((e) => e.code).join(" · ") : "None yet"}
        />
        <SummaryItem label="Max events per player" value={String(form.maxCategoriesPerPlayer)} />
        <SummaryItem label="Timezone" value={form.basics.venueTimezone || "Not set"} />
        <SummaryItem label="Venue" value={form.basics.venueName.trim() || "Not set"} />
      </dl>
    </Panel>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="px-3 py-2.5 text-center">
      <p className="font-score text-xl font-semibold leading-none">{value}</p>
      <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-2">
      <dt className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate font-score text-xs" title={value}>
        {value}
      </dd>
    </div>
  );
}
