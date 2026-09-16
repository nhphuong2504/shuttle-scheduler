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
import type { BasicsForm } from "./types";

/**
 * A short, curated list of IANA zones. The database accepts any valid zone, so
 * this is a convenience, not a restriction.
 */
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

export function BasicsStep({
  value,
  onChange,
  isNew,
}: {
  value: BasicsForm;
  onChange: (patch: Partial<BasicsForm>) => void;
  isNew: boolean;
}) {
  return (
    <div className="space-y-4">
      <Panel title="Identity">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="t-name">Tournament name</Label>
            <Input
              id="t-name"
              value={value.name}
              placeholder="City Open 2026"
              autoFocus={isNew}
              onChange={(e) => onChange({ name: e.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">
              The name is shown on every screen and on the scoreboard.
            </p>
          </div>
        </div>
      </Panel>

      <Panel title="Venue">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="t-venue">Venue name</Label>
            <Input
              id="t-venue"
              value={value.venueName}
              placeholder="Riverside Sports Hall"
              onChange={(e) => onChange({ venueName: e.target.value })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="t-address">Address</Label>
            <Input
              id="t-address"
              value={value.venueAddress}
              placeholder="12 River Road, Springfield"
              onChange={(e) => onChange({ venueAddress: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-tz">Timezone</Label>
            <Select
              value={value.venueTimezone}
              onValueChange={(next) => onChange({ venueTimezone: next })}
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
            <p className="text-[11px] text-muted-foreground">
              Court times and the schedule are read in this zone.
            </p>
          </div>
        </div>
      </Panel>

      <Panel title="Organizer">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="t-org">Contact name</Label>
            <Input
              id="t-org"
              value={value.organizerName}
              placeholder="Dana Reed"
              onChange={(e) => onChange({ organizerName: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-org-email">Contact email</Label>
            <Input
              id="t-org-email"
              type="email"
              value={value.organizerEmail}
              placeholder="dana@example.com"
              onChange={(e) => onChange({ organizerEmail: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-org-phone">Contact phone</Label>
            <Input
              id="t-org-phone"
              value={value.organizerPhone}
              placeholder="+1 555 0100"
              onChange={(e) => onChange({ organizerPhone: e.target.value })}
            />
          </div>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Organizer details are for the host&apos;s reference. This version has no public
          registration, so nothing is published to entrants.
        </p>
      </Panel>
    </div>
  );
}
