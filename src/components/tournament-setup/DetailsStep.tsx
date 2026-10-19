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
import { countIsoDays, type BasicsForm, type DraftForm } from "./types";

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
 * The first step: a name, the tournament window and a timezone, then the venue, then the
 * contact details.
 *
 * Three blocks in the order a host thinks of them. The first is the only one a tournament
 * cannot exist without; the venue is optional; the organiser's contact and a note are
 * optional and folded away until asked for, because most hosts will not fill them in on
 * the first pass, and a long form of empty fields reads as work.
 *
 * The two dates are the *window*: what the public sees, and the bounds inside which playing
 * days are chosen later, on the Schedule page. There is no limit on how long it is, because
 * it is not how many days are played.
 *
 * Problems are shown beside the field only once the host has tried to continue
 * (`showErrors`). A name field that complains before anybody has typed in it is the form
 * telling the host they have already done something wrong.
 *
 * Once a tournament has started, `lock` takes away what can no longer move: the first date,
 * because the first-match gate and the registration deadline have been measured from it, and
 * the timezone, because every match time is read in it. Each lock says why.
 */
export interface DetailsLock {
  /** The whole form is read-only (a completed tournament). */
  all?: boolean;
  /** The first date cannot move. */
  start?: boolean;
  /** The timezone cannot change. */
  timezone?: boolean;
}

export function DetailsStep({
  form,
  onChange,
  isNew,
  showErrors = false,
  lock = {},
}: {
  form: DraftForm;
  onChange: (patch: Partial<DraftForm>) => void;
  isNew: boolean;
  showErrors?: boolean;
  lock?: DetailsLock;
}) {
  const basics = form.basics;
  const setBasics = (patch: Partial<BasicsForm>) => onChange({ basics: { ...basics, ...patch } });

  const start = form.startsOn;
  const end = form.endsOn;
  const span = start ? countIsoDays(start, end || start) : 0;

  /** Moving the first date never leaves the last one before it. */
  const setStart = (next: string) =>
    onChange({ startsOn: next, endsOn: !next ? "" : !end || end < next ? next : end });
  /** The last date is clamped to the first rather than rejected, so dragging never errors. */
  const setEnd = (next: string) => onChange({ endsOn: next && start && next < start ? start : next });

  const nameMissing = showErrors && !basics.name.trim();
  const windowMissing = showErrors && (!start || !end);
  const hasContact = Boolean(
    basics.organizerName || basics.organizerEmail || basics.organizerPhone || basics.notes,
  );

  return (
    <fieldset disabled={lock.all} className="m-0 min-w-0 space-y-5 border-0 p-0">
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
              <Label htmlFor="t-range-start">Tournament starts</Label>
              <PickerInput
                id="t-range-start"
                type="date"
                pickerLabel="Open the calendar for the first day"
                value={start}
                disabled={lock.all || lock.start}
                aria-describedby={lock.start ? "t-range-start-lock" : undefined}
                onChange={(e) => setStart(e.target.value)}
              />
              {lock.start ? (
                <p id="t-range-start-lock" className="text-sm text-muted-foreground">
                  The tournament has started, so its first day can no longer move.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-range-end">Tournament ends</Label>
              <PickerInput
                id="t-range-end"
                type="date"
                pickerLabel="Open the calendar for the last day"
                value={end}
                min={start || undefined}
                disabled={lock.all || !start}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>
          {windowMissing ? (
            <FieldError id="t-window-error">
              {!start ? "Pick the first day." : "Pick the last day."}
            </FieldError>
          ) : null}

          <div>
            {span ? (
              <p className="inline-flex rounded-full bg-info-surface px-3.5 py-1.5 text-sm font-semibold text-info-foreground">
                {span} day{span === 1 ? "" : "s"}, {dayLabel(start)}
                {end && end !== start ? ` – ${dayLabel(end)}` : ""}
              </p>
            ) : (
              <p className="text-sm font-semibold text-muted-foreground">Pick the first day.</p>
            )}
            <p className="mt-2 text-sm text-muted-foreground">
              These are the dates people see. You choose which days you actually play, and the
              court hours, on the Schedule page. They have to fall inside these dates.
            </p>
          </div>

          <div>
            <FieldHeading htmlFor="t-tz">Timezone</FieldHeading>
            <Select
              value={basics.venueTimezone}
              disabled={Boolean(lock.all || lock.timezone)}
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
              {lock.timezone
                ? "Fixed once the tournament has started: every match time is read in this zone."
                : "Every match time is shown in this zone to anyone looking at the tournament."}
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
    </fieldset>
  );
}
