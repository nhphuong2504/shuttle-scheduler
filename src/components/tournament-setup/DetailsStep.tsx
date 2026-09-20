import { Panel } from "@/components/app-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_TOURNAMENT_DAYS,
  buildDayRange,
  countIsoDays,
  shiftIsoDate,
  type BasicsForm,
  type DraftForm,
} from "./types";

/** Matches the check constraint on `tournaments.notes`. */
const NOTES_MAX_LENGTH = 2000;

/** A short, curated list of IANA zones. Any valid zone is accepted by the database. */
const TIMEZONE_OPTIONS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
  "UTC",
];

/**
 * Everything the tournament needs to exist: a name, the dates and a timezone,
 * followed by the venue and organizer contact details shown on the same screen.
 */
export function DetailsStep({
  form,
  onChange,
  isNew,
}: {
  form: DraftForm;
  onChange: (patch: Partial<DraftForm>) => void;
  isNew: boolean;
}) {
  const basics = form.basics;
  const setBasics = (patch: Partial<BasicsForm>) => onChange({ basics: { ...basics, ...patch } });

  const days = form.days;
  const start = days[0]?.date ?? "";
  const end = days.length ? (days[days.length - 1]?.date ?? "") : "";
  const lastAllowed = start ? shiftIsoDate(start, MAX_TOURNAMENT_DAYS - 1) : undefined;
  const span = start ? countIsoDays(start, end || start) : 0;

  /** Clamps the range instead of rejecting it, so dragging dates never errors. */
  const applyRange = (nextStart: string, nextEnd: string) => {
    if (!nextStart) {
      onChange({ days: [] });
      return;
    }
    let nextLast = nextEnd || nextStart;
    if (nextLast < nextStart) nextLast = nextStart;
    const ceiling = shiftIsoDate(nextStart, MAX_TOURNAMENT_DAYS - 1);
    if (nextLast > ceiling) nextLast = ceiling;
    onChange({ days: buildDayRange(nextStart, nextLast) });
  };

  return (
    <div className="space-y-4">
      <Panel title="Tournament">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="t-name">Name</Label>
            <Input
              id="t-name"
              value={basics.name}
              placeholder="City Open 2026"
              autoFocus={isNew}
              onChange={(e) => setBasics({ name: e.target.value })}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="t-range-start">First day</Label>
              <Input
                id="t-range-start"
                type="date"
                value={start}
                onChange={(e) => applyRange(e.target.value, end)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-range-end">Last day</Label>
              <Input
                id="t-range-end"
                type="date"
                value={end}
                min={start || undefined}
                max={lastAllowed}
                disabled={!start}
                onChange={(e) => applyRange(start, e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-tz">Timezone</Label>
              <Select
                value={basics.venueTimezone}
                onValueChange={(next) => setBasics({ venueTimezone: next })}
              >
                <SelectTrigger id="t-tz">
                  <SelectValue placeholder="Choose a timezone" />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONE_OPTIONS.map((zone) => (
                    <SelectItem key={zone} value={zone}>
                      {zone}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {span
              ? `${span} day${span === 1 ? "" : "s"}, ${start}${end && end !== start ? ` to ${end}` : ""}.`
              : "Pick the first day."}{" "}
            Up to {MAX_TOURNAMENT_DAYS} days. Court hours and breaks are set later, on the Schedule
            page.
          </p>
        </div>
      </Panel>

      <Panel title="Venue and contact">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="t-venue">Venue</Label>
              <Input
                id="t-venue"
                value={basics.venueName}
                placeholder="Riverside Sports Hall"
                onChange={(e) => setBasics({ venueName: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-address">Address</Label>
              <Input
                id="t-address"
                value={basics.venueAddress}
                placeholder="12 River Road, Springfield"
                onChange={(e) => setBasics({ venueAddress: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-org">Organizer</Label>
              <Input
                id="t-org"
                value={basics.organizerName}
                placeholder="Dana Reed"
                onChange={(e) => setBasics({ organizerName: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-org-email">Email</Label>
              <Input
                id="t-org-email"
                type="email"
                value={basics.organizerEmail}
                placeholder="dana@example.com"
                onChange={(e) => setBasics({ organizerEmail: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-org-phone">Phone</Label>
              <Input
                id="t-org-phone"
                value={basics.organizerPhone}
                placeholder="+1 555 0100"
                onChange={(e) => setBasics({ organizerPhone: e.target.value })}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="t-notes">Note</Label>
              <Textarea
                id="t-notes"
                value={basics.notes}
                rows={3}
                maxLength={NOTES_MAX_LENGTH}
                placeholder="Parking is behind the hall. Warm-up courts open at 08:00."
                onChange={(e) => setBasics({ notes: e.target.value })}
              />
              <p className="text-right font-score text-[11px] text-muted-foreground">
                {basics.notes.length}/{NOTES_MAX_LENGTH}
              </p>
            </div>
          </div>
      </Panel>
    </div>
  );
}
