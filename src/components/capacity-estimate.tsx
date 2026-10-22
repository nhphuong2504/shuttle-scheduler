import { useId, useMemo, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { estimateCapacity } from "@/lib/tournament/capacity-estimate";
import { cn } from "@/lib/utils";

/**
 * "Will it fit?" - an advisory estimate of court time needed against court time available.
 *
 * Nothing here is saved or enforced: the courts, hours and (before there are entries) the
 * players per event are the organiser's own planning numbers, held in this panel only, so the
 * create flow still writes nothing until its last step. The real courts and hours are set on
 * the Schedule page, where the scheduler reads them; this just tells an organiser, before
 * registration opens, whether the plan is plausible.
 *
 * Pass `entrantsPerEvent` when the entries exist (the Entries page); otherwise pass
 * `eventCount` and the panel asks for the expected players per event.
 */
export function CapacityEstimate({
  eventCount,
  entrantsPerEvent,
  days,
  collapsible = false,
  className,
}: {
  eventCount: number;
  entrantsPerEvent?: readonly number[];
  /** The tournament window's length, as the starting point for the playing days. */
  days: number;
  /** Drawn closed behind its heading, for a page whose own work should come first. */
  collapsible?: boolean;
  className?: string;
}) {
  const ids = useId();
  const [players, setPlayers] = useState("");
  const [courts, setCourts] = useState("");
  const [hours, setHours] = useState("");
  const [daysText, setDaysText] = useState(days > 0 ? String(days) : "");

  const number = (text: string) => {
    const value = Number(text);
    return text.trim() !== "" && Number.isFinite(value) && value > 0 ? value : null;
  };
  const known = entrantsPerEvent !== undefined;
  const perEvent = known ? null : number(players);
  const courtCount = number(courts);
  const hourCount = number(hours);
  const dayCount = number(daysText);

  const estimate = useMemo(() => {
    const fields =
      (known ? entrantsPerEvent.length > 0 : perEvent !== null && eventCount > 0) &&
      courtCount !== null &&
      hourCount !== null &&
      dayCount !== null;
    if (!fields) return null;
    return estimateCapacity({
      entrantsPerEvent: known
        ? entrantsPerEvent
        : Array.from({ length: eventCount }, () => perEvent as number),
      courts: courtCount,
      hoursPerDay: hourCount,
      days: dayCount,
    });
  }, [known, entrantsPerEvent, perEvent, eventCount, courtCount, hourCount, dayCount]);

  const field = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div className="min-w-[8rem] flex-1">
      <Label htmlFor={`${ids}-${id}`}>{label}</Label>
      <Input
        id={`${ids}-${id}`}
        inputMode="decimal"
        value={value}
        onChange={(event) => set(event.target.value)}
      />
    </div>
  );

  const hours1 = (value: number) => (Math.round(value * 10) / 10).toString();

  const inner = (
    <>
      <p className="mt-0.5 text-sm text-muted-foreground">
        A rough check of court time, from your own planning numbers. Nothing here is saved; the
        real courts and hours are set on the Schedule page.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        {known ? null : field("players", "Expected players per event", players, setPlayers)}
        {field("courts", "Courts", courts, setCourts)}
        {field("hours", "Hours per day", hours, setHours)}
        {field("days", "Playing days", daysText, setDaysText)}
      </div>
      <p
        role="status"
        className={cn(
          "mt-4 text-base",
          estimate?.verdict === "over" ? "font-semibold text-danger-foreground" : "",
          estimate?.verdict === "tight" ? "font-semibold text-warn-foreground" : "",
        )}
      >
        {estimate
          ? `About ${estimate.placementMatches + estimate.knockoutMatches} matches need ${hours1(
              estimate.courtHoursNeeded,
            )} court-hours; you have ${hours1(estimate.courtHoursAvailable)}. ${
              estimate.verdict === "over"
                ? "That is not enough: add courts, hours or days, or cap the events."
                : estimate.verdict === "tight"
                  ? "That is tight, with little room for a late start."
                  : "That should fit."
            }`
          : known
            ? "Enter courts, hours and days to see the estimate."
            : "Enter the players per event, courts, hours and days to see the estimate."}
      </p>
    </>
  );

  const shell = "rounded-2xl border border-hairline bg-surface p-5 shadow-panel";

  if (collapsible) {
    return (
      <details
        data-testid="capacity-estimate"
        className={cn(shell, "group", className)}
      >
        <summary className="flex min-h-11 cursor-pointer items-center font-display text-lg font-bold">
          Will it fit?
          <span className="ml-3 text-sm font-normal text-muted-foreground">
            Check the court time
          </span>
        </summary>
        {inner}
      </details>
    );
  }

  return (
    <section aria-label="Will it fit?" data-testid="capacity-estimate" className={cn(shell, className)}>
      <h3 className="font-display text-lg font-bold">Will it fit?</h3>
      {inner}
    </section>
  );
}
