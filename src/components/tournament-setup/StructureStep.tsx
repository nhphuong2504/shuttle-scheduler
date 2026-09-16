import { Panel } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { SUPPORTED_FORMAT, placementRuleSummary } from "@/lib/tournament/competition-format";

/**
 * Read-only presentation of the one competition format this app runs. There is
 * deliberately no format picker: the engine only implements this structure.
 */
export function StructureStep() {
  const format = SUPPORTED_FORMAT;

  return (
    <div className="space-y-4">
      <Panel title="Competition format">
        <p className="font-display text-base font-semibold">{format.name}</p>
        <p className="mt-1 text-sm text-muted-foreground">{format.summary}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge variant="secondary">Only format</Badge>
          <Badge variant="outline">{format.placement.rounds} placement rounds</Badge>
          <Badge variant="outline">{format.knockout.elimination}</Badge>
        </div>
      </Panel>

      <Panel title="Stage 1 — Placement">
        <p className="text-sm text-muted-foreground">{format.placement.detail}</p>
        <ol className="mt-4 space-y-2">
          <li className="flex items-start gap-3">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              1
            </span>
            <span className="text-sm">
              <span className="font-semibold">Round one.</span>{" "}
              <span className="text-muted-foreground">Entrants are paired. One match each.</span>
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              2
            </span>
            <span className="text-sm">
              <span className="font-semibold">Round two.</span>{" "}
              <span className="text-muted-foreground">
                Winners play winners, losers play losers. A second match each.
              </span>
            </span>
          </li>
        </ol>
        <p className="mt-4 text-xs text-muted-foreground">
          The two results give every entrant a placement record, which decides their draw.
        </p>
      </Panel>

      <Panel title="Stage 2 — Knockout draws">
        <p className="text-sm text-muted-foreground">{format.knockout.detail}</p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {format.tiers.map((tier) => (
            <li key={tier.tier} className="rounded-md border border-hairline p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-display text-sm font-semibold">{tier.label}</span>
                <Badge variant="outline" className="font-score">
                  {tier.record}
                </Badge>
              </div>
              <p className="mt-1 text-xs font-semibold text-foreground">{tier.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{tier.detail}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          Placement rule:{" "}
          <span className="font-score text-foreground">{placementRuleSummary()}</span>
        </p>
      </Panel>

      <Panel title="Not built yet">
        <p className="text-xs text-muted-foreground">
          This pass captures and stores the structure. Generating placement matches, deriving
          placement records and building the A/B/C/D brackets is the next piece of engine work, so
          the schedule stays off while it is being built.
        </p>
      </Panel>
    </div>
  );
}
