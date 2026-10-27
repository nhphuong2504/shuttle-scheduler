import { PLACEMENT_TIERS } from "@/lib/tournament/competition-format";

/**
 * The key to "WW", "WL", "LW" and "LL": which placement record goes to which bracket.
 *
 * Placement and Knockout name the brackets by record, and the four codes were explained once,
 * in a sentence under the title, then used bare on every bracket below it. The legend is the
 * same table the format runs on (`PLACEMENT_TIERS`), so it cannot describe a mapping the app
 * does not use.
 */
export function PlacementTierLegend() {
  return (
    <dl
      aria-label="Placement records"
      className="mb-4 grid gap-x-4 gap-y-1.5 rounded-lg border border-hairline bg-surface px-3 py-2.5 text-sm sm:grid-cols-2 lg:grid-cols-4"
    >
      {PLACEMENT_TIERS.map((tier) => (
        <div key={tier.record} className="flex items-baseline gap-2">
          <dt className="w-8 shrink-0 font-score font-semibold">{tier.record}</dt>
          <dd className="min-w-0 text-muted-foreground">
            <span className="font-medium text-foreground">{tier.label}.</span>{" "}
            {tier.detail}
          </dd>
        </div>
      ))}
    </dl>
  );
}
