import { Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TournamentEventInput } from "@/lib/tournament/actions";
import type { DraftForm } from "./types";

type EventGender = TournamentEventInput["gender"];

interface EventTemplate {
  code: string;
  name: string;
  entryType: "individual" | "pair";
  gender: EventGender;
}

/** The standard badminton events, as one-click additions. */
const EVENT_TEMPLATES: EventTemplate[] = [
  { code: "MS", name: "Men's Singles", entryType: "individual", gender: "men" },
  { code: "WS", name: "Women's Singles", entryType: "individual", gender: "women" },
  { code: "MD", name: "Men's Doubles", entryType: "pair", gender: "men" },
  { code: "WD", name: "Women's Doubles", entryType: "pair", gender: "women" },
  { code: "XD", name: "Mixed Doubles", entryType: "pair", gender: "mixed" },
];

const GENDER_LABEL: Record<EventGender, string> = {
  men: "Men",
  women: "Women",
  mixed: "Mixed",
  open: "Open",
};

const MAX_CATEGORIES_PER_PLAYER = 5;

export function EventsStep({
  form,
  onChange,
}: {
  form: DraftForm;
  onChange: (patch: Partial<DraftForm>) => void;
}) {
  const events = form.events;
  const present = new Set(events.map((event) => event.code));

  const addEvent = (template: EventTemplate) => {
    if (present.has(template.code)) return;
    onChange({
      events: [
        ...events,
        {
          code: template.code,
          name: template.name,
          entryType: template.entryType,
          gender: template.gender,
          sortOrder: events.length + 1,
          active: true,
          maxEntries: null,
        },
      ],
    });
  };

  const setEvent = (code: string, patch: Partial<TournamentEventInput>) =>
    onChange({
      events: events.map((event) => (event.code === code ? { ...event, ...patch } : event)),
    });

  const removeEvent = (code: string) =>
    onChange({ events: events.filter((event) => event.code !== code) });

  return (
    <div className="space-y-4">
      <Panel
        title="Add an event"
        right={
          <span className="font-score text-[11px] text-muted-foreground">
            {events.length} added
          </span>
        }
      >
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {EVENT_TEMPLATES.map((template) => {
            const added = present.has(template.code);
            return (
              <button
                key={template.code}
                type="button"
                disabled={added}
                onClick={() => addEvent(template)}
                className={`flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-all ${
                  added
                    ? "border-mint bg-mint/10"
                    : "border-hairline bg-surface hover:border-primary/50 hover:shadow-raise"
                }`}
              >
                <span className="flex w-full items-center justify-between">
                  <span className="font-score text-base font-bold">{template.code}</span>
                  <span className="font-score text-[11px] text-muted-foreground">
                    {added ? "✓" : "+"}
                  </span>
                </span>
                <span className="text-[11px] leading-snug text-muted-foreground">
                  {template.name}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Singles and doubles, and the gender the event is open to, are stored with each event so
          entry validation can use them.
        </p>
      </Panel>

      <Panel title="Events">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No events yet. Add at least one before activating the tournament.
          </p>
        ) : (
          <ul className="divide-y divide-hairline">
            {events.map((event) => (
              <li key={event.code} className="flex flex-wrap items-end gap-3 py-3">
                <div className="min-w-[160px] flex-1 space-y-1.5">
                  <Label htmlFor={`e-${event.code}-name`}>Name</Label>
                  <Input
                    id={`e-${event.code}-name`}
                    value={event.name}
                    onChange={(e) => setEvent(event.code, { name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`e-${event.code}-gender`}>Open to</Label>
                  <Select
                    value={event.gender}
                    onValueChange={(next) => {
                      const gender = next as EventGender;
                      setEvent(event.code, {
                        gender,
                        // Mixed only makes sense as a pair, so coerce the shape.
                        entryType: gender === "mixed" ? "pair" : event.entryType,
                      });
                    }}
                  >
                    <SelectTrigger id={`e-${event.code}-gender`} className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="men">{GENDER_LABEL.men}</SelectItem>
                      <SelectItem value="women">{GENDER_LABEL.women}</SelectItem>
                      <SelectItem value="mixed">{GENDER_LABEL.mixed}</SelectItem>
                      <SelectItem value="open">{GENDER_LABEL.open}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`e-${event.code}-shape`}>Format</Label>
                  <Select
                    value={event.entryType}
                    disabled={event.gender === "mixed"}
                    onValueChange={(next) =>
                      setEvent(event.code, { entryType: next as "individual" | "pair" })
                    }
                  >
                    <SelectTrigger id={`e-${event.code}-shape`} className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="individual">Singles</SelectItem>
                      <SelectItem value="pair">Doubles</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`e-${event.code}-cap`}>Entry cap</Label>
                  <Input
                    id={`e-${event.code}-cap`}
                    className="w-28"
                    inputMode="numeric"
                    placeholder="none"
                    value={event.maxEntries == null ? "" : String(event.maxEntries)}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      setEvent(event.code, {
                        maxEntries: raw === "" ? null : Number.parseInt(raw, 10),
                      });
                    }}
                  />
                </div>
                <Button size="sm" variant="ghost" onClick={() => removeEvent(event.code)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Entries per player">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="max-cats">Maximum events one player may enter</Label>
            <Input
              id="max-cats"
              type="number"
              min={1}
              max={MAX_CATEGORIES_PER_PLAYER}
              value={form.maxCategoriesPerPlayer}
              onChange={(e) =>
                onChange({ maxCategoriesPerPlayer: Number.parseInt(e.target.value, 10) || 1 })
              }
            />
            <p className="text-[11px] text-muted-foreground">
              Enforced when entries are added. Between 1 and {MAX_CATEGORIES_PER_PLAYER}.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
