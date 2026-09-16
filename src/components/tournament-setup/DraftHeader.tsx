import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/app-shell";
import { courtPoolSize, dateRangeLabel, type DraftForm } from "./types";

/**
 * A one-glance summary of the draft that stays visible while the host moves
 * between steps, so the consequences of each choice are always in view.
 */
export function DraftHeader({ form, isDraft }: { form: DraftForm; isDraft: boolean }) {
  const activeEvents = form.events.filter((event) => event.active !== false);
  const courts = courtPoolSize(form.days);

  return (
    <Panel title="Draft summary">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-base font-semibold">
            {form.basics.name.trim() || "Untitled tournament"}
          </span>
          <Badge variant={isDraft ? "secondary" : "outline"}>
            {isDraft ? "Draft" : "In progress"}
          </Badge>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <SummaryItem label="Dates" value={dateRangeLabel(form.days)} />
          <SummaryItem label="Days" value={String(form.days.length)} />
          <SummaryItem label="Courts" value={courts ? String(courts) : "None"} />
          <SummaryItem
            label="Events"
            value={activeEvents.length ? activeEvents.map((e) => e.code).join(", ") : "None"}
          />
          <SummaryItem label="Max events per player" value={String(form.maxCategoriesPerPlayer)} />
          <SummaryItem label="Timezone" value={form.basics.venueTimezone || "Not set"} />
        </dl>
      </div>
    </Panel>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate font-score text-sm" title={value}>
        {value}
      </dd>
    </div>
  );
}
