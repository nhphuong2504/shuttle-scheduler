import { InfoNote } from "@/components/ui/info-note";
import { estimateCapacity } from "@/lib/tournament/capacity-estimate";
import { cn } from "@/lib/utils";

/**
 * "Will it fit?" - an advisory line on the Schedule page: the court time the entries need
 * against the court time the configured days offer.
 *
 * Both sides are real. The entries are the active field sizes and the court time comes from the
 * days, courts and breaks as the page has them, so there is nothing to type and nothing to keep
 * in step. It is advice only: the scheduler does not read it, and a tournament that does not fit
 * can still be built and simply runs past the hours.
 */
export function CapacityEstimate({
  entrantsPerEvent,
  courtHoursOffered,
  placementSlotMinutes,
  knockoutSlotMinutes,
  inline = false,
  className,
}: {
  /** Active entrants in each event that has any. */
  entrantsPerEvent: readonly number[];
  /** Court time the configured days offer, after breaks. */
  courtHoursOffered: number;
  /**
   * The tournament's own match lengths. Required: the defaults belong to a plan with no
   * settings yet, and pricing a configured tournament at them answered a different question.
   */
  placementSlotMinutes: number;
  knockoutSlotMinutes: number;
  /** Drawn as a row inside another panel instead of a box of its own. */
  inline?: boolean;
  className?: string;
}) {
  const estimate = estimateCapacity({
    entrantsPerEvent,
    courtHoursOffered,
    placementSlotMinutes,
    knockoutSlotMinutes,
  });
  const hours1 = (value: number) => (Math.round(value * 10) / 10).toString();

  return (
    <p
      role="status"
      data-testid="capacity-estimate"
      className={cn(
        "text-sm text-muted-foreground",
        inline ? "basis-full" : "rounded-lg border border-hairline bg-surface px-3 py-2.5",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="font-semibold text-foreground">Will it fit?</span>{" "}
        <span
          className={cn(
            estimate.verdict === "over" ? "font-semibold text-danger-foreground" : "",
            estimate.verdict === "tight" ? "font-semibold text-warn-foreground" : "",
          )}
        >
          About {estimate.placementMatches + estimate.knockoutMatches} matches need{" "}
          {hours1(estimate.courtHoursNeeded)} court-hours; the days offer{" "}
          {hours1(estimate.courtHoursAvailable)}.{" "}
          {estimate.verdict === "over"
            ? "That is not enough: add courts, hours or days, or cap the events."
            : estimate.verdict === "tight"
              ? "That is tight, with little room for a late start."
              : "That should fit."}
        </span>
        <InfoNote label="About this estimate" className="ml-1 inline-flex align-middle">
          <p>
            Advice only: the scheduler does not read it, and a tournament that does not fit can
            still be built and will run past the hours.
          </p>
          <p>
            Needed time counts the group-stage matches (each active entry plays two) and splits the
            knockout draws evenly, so the knockout figure is a guess until the draws are set. Each
            match is priced at the match length set for its stage.
          </p>
          <p>Offered time is each day&apos;s courts times its hours, less breaks.</p>
          <p>
            It compares totals only. It does not check each day on its own, players entered in
            several events (their matches cannot overlap and need rest between them), or rounds
            that must wait for the one before. A day can still run out of time when the totals
            fit.
          </p>
        </InfoNote>
      </span>
    </p>
  );
}
