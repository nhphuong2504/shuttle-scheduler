import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PickerInput } from "@/components/ui/picker-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FieldError, FieldHeading, SetupSection } from "./section";
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
 * A `YYYY-MM-DD` date as "Sat, Oct 24".
 *
 * The date is read as UTC and formatted as UTC, so the weekday is the one that date has
 * everywhere: a calendar date has no zone, and formatting it in the reader's own would shift
 * it a day for anybody west of Greenwich.
 */
function dayLabel(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}

/**
 * The first step: a name, the days and a timezone, then the venue, then the contact details.
 *
 * Three blocks in the order a host thinks of them. The first is the only one a tournament
 * cannot exist without; the venue is optional; the organiser's contact and a note are
 * optional and folded away until asked for, because most hosts will not fill them in on
 * the first pass, and a long form of empty fields reads as work.
 *
 * Problems are shown beside the field only once the host has tried to continue
 * (`showErrors`). A name field that complains before anybody has typed in it is the form
 * telling the host they have already done something wrong.
 */
export function DetailsStep({
  form,
  onChange,
  isNew,
  showErrors = false,
}: {
  form: DraftForm;
  onChange: (patch: Partial<DraftForm>) => void;
  isNew: boolean;
  showErrors?: boolean;
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

  const nameMissing = showErrors && !basics.name.trim();
  const hasContact = Boolean(
    basics.organizerName || basics.organizerEmail || basics.organizerPhone || basics.notes,
  );

  return (
    <div className="space-y-5">
      <SetupSection
        headingId="setup-basics"
        title="The basics"
        hint="What people will see in Explore."
      >
        <div className="space-y-5">
          <div>
            <FieldHeading htmlFor="t-name" required>
              Name
            </FieldHeading>
            <Input
              id="t-name"
              value={basics.name}
              placeholder="City Open 2026"
              autoFocus={isNew}
              aria-invalid={nameMissing}
              aria-describedby={nameMissing ? "t-name-error" : undefined}
              className={nameMissing ? "h-12 border-2 border-danger-foreground" : "h-12"}
              onChange={(e) => setBasics({ name: e.target.value })}
            />
            {nameMissing ? (
              <FieldError id="t-name-error">Give the tournament a name.</FieldError>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="t-range-start">First day</Label>
              <PickerInput
                id="t-range-start"
                type="date"
                pickerLabel="Open the calendar for the first day"
                value={start}
                onChange={(e) => applyRange(e.target.value, end)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-range-end">Last day</Label>
              <PickerInput
                id="t-range-end"
                type="date"
                pickerLabel="Open the calendar for the last day"
                value={end}
                min={start || undefined}
                max={lastAllowed}
                disabled={!start}
                onChange={(e) => applyRange(start, e.target.value)}
              />
            </div>
          </div>

          <div>
            {span ? (
              <p className="inline-flex rounded-full bg-info-surface px-3.5 py-1.5 text-sm font-semibold text-info-foreground">
                {span} day{span === 1 ? "" : "s"} · {dayLabel(start)}
                {end && end !== start ? ` – ${dayLabel(end)}` : ""}
              </p>
            ) : (
              <p className="text-sm font-semibold text-muted-foreground">Pick the first day.</p>
            )}
            <p className="mt-2 text-sm text-muted-foreground">
              Up to {MAX_TOURNAMENT_DAYS} days. Court hours and breaks are set later, on the
              Schedule page.
            </p>
          </div>

          <div>
            <FieldHeading htmlFor="t-tz">Timezone</FieldHeading>
            <Select
              value={basics.venueTimezone}
              onValueChange={(next) => setBasics({ venueTimezone: next })}
            >
              <SelectTrigger id="t-tz" className="h-12">
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
            <p className="mt-2 text-sm text-muted-foreground">
              Every match time is shown in this zone to anyone looking at the tournament.
            </p>
          </div>
        </div>
      </SetupSection>

      <SetupSection
        headingId="setup-venue"
        title="Venue"
        hint="Shown on the tournament's page so people know where to go."
        optional
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="t-venue">Venue</Label>
            <Input
              id="t-venue"
              value={basics.venueName}
              placeholder="Riverside Sports Hall"
              className="h-12"
              onChange={(e) => setBasics({ venueName: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-address">Address</Label>
            <Input
              id="t-address"
              value={basics.venueAddress}
              placeholder="12 River Road, Springfield"
              className="h-12"
              onChange={(e) => setBasics({ venueAddress: e.target.value })}
            />
          </div>
        </div>
      </SetupSection>

      <details
        open={hasContact}
        className="group rounded-2xl border border-hairline bg-surface px-5 shadow-panel sm:px-6"
      >
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 font-display text-lg font-bold [&::-webkit-details-marker]:hidden">
          <span>
            Organiser contact and note{" "}
            <span className="ml-2 font-body text-sm font-medium text-muted-foreground">
              Optional
            </span>
          </span>
          <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-180">
            ▾
          </span>
        </summary>
        <div className="grid gap-4 pb-6 pt-1 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="t-org">Organiser</Label>
            <Input
              id="t-org"
              value={basics.organizerName}
              placeholder="Dana Reed"
              className="h-12"
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
              className="h-12"
              onChange={(e) => setBasics({ organizerEmail: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-org-phone">Phone</Label>
            <Input
              id="t-org-phone"
              value={basics.organizerPhone}
              placeholder="+1 555 0100"
              className="h-12"
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
            <p className="text-right font-score text-sm text-muted-foreground">
              {basics.notes.length}/{NOTES_MAX_LENGTH}
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
