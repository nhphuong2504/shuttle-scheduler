import { Check, Plus, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import type { TournamentEventInput } from "@/lib/tournament/actions";
import { STANDARD_EVENTS, type StandardEvent } from "@/lib/tournament/event-order";
import { FieldError, SetupSection } from "./section";
import type { DraftForm } from "./types";

type EventGender = TournamentEventInput["gender"];

type EventTemplate = StandardEvent;

/**
 * The standard badminton events, as one-click additions.
 *
 * Both the shape and who may enter are part of what the event *is*, so neither is
 * asked for: MS and WS are singles, MD, WD and XD are doubles, and each is open
 * to the gender in its name. They are carried into the stored event because entry
 * validation reads them. The list itself lives in `event-order`, which is also the order
 * the placement stage lists events in - one list, so the two cannot disagree.
 */
const EVENT_TEMPLATES = STANDARD_EVENTS;

const MAX_CATEGORIES_PER_PLAYER = 5;

/**
 * The second step: which events run, and how many one player may enter.
 *
 * The five standard events are a row of toggles: pressing one adds it and pressing it again
 * takes it away, and a pressed one says so with a tick as well as a fill. What was added is
 * listed below, where its name and entry cap can still be changed.
 *
 * Registration used to live here too. It moved to the first step, beside the dates, because
 * its deadline is measured against the first date: with the two on different steps, an error
 * could land here while the date that caused it sat on the step before.
 */
export function EventsStep({
  form,
  onChange,
  showErrors = false,
}: {
  form: DraftForm;
  onChange: (patch: Partial<DraftForm>) => void;
  showErrors?: boolean;
}) {
  const events = form.events;
  const present = new Set(events.map((event) => event.code));

  const addEvent = (template: EventTemplate) => {
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

  /**
   * The limit as it works: a player cannot enter more events than there are, so a stored 3
   * with two events means 2, and that is what is selected and said. The stored value is left
   * alone, so adding the event back restores it.
   */
  const effectiveLimit =
    events.length > 0
      ? Math.min(form.maxCategoriesPerPlayer, events.length)
      : form.maxCategoriesPerPlayer;

  const toggle = (template: EventTemplate) =>
    present.has(template.code) ? removeEvent(template.code) : addEvent(template);

  const none = showErrors && events.length === 0;

  return (
    <div className="space-y-5">
      <SetupSection
        headingId="setup-pick"
        title="Choose the events"
        hint="Singles for MS and WS, doubles for MD, WD and XD. Each is open to the gender in its name. Press to add or remove."
      >
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          {EVENT_TEMPLATES.map((template) => {
            const added = present.has(template.code);
            return (
              <button
                key={template.code}
                type="button"
                aria-pressed={added}
                onClick={() => toggle(template)}
                className={`flex min-h-[5.25rem] flex-col items-start justify-between gap-1 rounded-xl border px-3.5 py-3 text-left transition-colors ${
                  added
                    ? "border-primary bg-info-surface"
                    : "border-border-control bg-surface hover:bg-muted"
                }`}
              >
                <span className="flex w-full items-center justify-between">
                  <span className="font-display text-xl font-bold">{template.code}</span>
                  {added ? (
                    <Check aria-hidden="true" className="size-5 text-info-foreground" />
                  ) : (
                    <Plus aria-hidden="true" className="size-5 text-muted-foreground" />
                  )}
                </span>
                <span className="text-sm text-muted-foreground">{template.name}</span>
              </button>
            );
          })}
        </div>
        {none ? <FieldError id="setup-pick-error">Add at least one event.</FieldError> : null}
      </SetupSection>

      <SetupSection headingId="setup-list" title="Your events">
        {events.length === 0 ? (
          <p className="text-base text-muted-foreground">
            No events yet. Choose at least one above before starting the tournament.
          </p>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="mb-1 hidden grid-cols-[3rem_minmax(0,1fr)_7rem_2.75rem] items-end gap-3 px-1 text-sm text-muted-foreground sm:grid"
            >
              <span />
              <span>Name</span>
              <span>Entry cap</span>
              <span />
            </div>
            <ul className="divide-y divide-hairline rounded-xl border border-hairline">
              {events.map((event) => (
                <li
                  key={event.code}
                  className="grid grid-cols-[3rem_minmax(0,1fr)_2.75rem] items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:grid-cols-[3rem_minmax(0,1fr)_7rem_2.75rem]"
                >
                  <span className="font-display text-lg font-bold">{event.code}</span>
                  <Input
                    aria-label={`${event.code} name`}
                    value={event.name}
                    className="h-11"
                    onChange={(e) => setEvent(event.code, { name: e.target.value })}
                  />
                  <Input
                    aria-label={`${event.code} entry cap`}
                    className="col-start-2 h-11 sm:col-start-auto"
                    inputMode="numeric"
                    placeholder="No cap"
                    value={event.maxEntries == null ? "" : String(event.maxEntries)}
                    onChange={(e) => {
                      // Digits only: anything else would parse to NaN, which the check below
                      // cannot see and the save would send as "no cap".
                      const digits = e.target.value.replace(/\D/g, "");
                      setEvent(event.code, {
                        maxEntries: digits === "" ? null : Number.parseInt(digits, 10),
                      });
                    }}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${event.code}`}
                    onClick={() => removeEvent(event.code)}
                    className="col-start-3 row-start-1 grid size-11 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:col-start-auto sm:row-start-auto"
                  >
                    <X aria-hidden="true" className="size-5" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </SetupSection>

      <SetupSection
        headingId="setup-cap"
        title="Entries per player"
        hint="How many of these events may one person enter?"
      >
        <div role="group" aria-label="Entries per player" className="flex flex-wrap gap-2">
          {Array.from({ length: MAX_CATEGORIES_PER_PLAYER }, (_, i) => i + 1).map((count) => {
            const selected = effectiveLimit === count;
            const tooMany = events.length > 0 && count > events.length;
            return (
              <button
                key={count}
                type="button"
                aria-pressed={selected}
                disabled={tooMany}
                onClick={() => onChange({ maxCategoriesPerPlayer: count })}
                className={`grid size-14 place-items-center rounded-xl border font-display text-xl font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border-control bg-surface hover:bg-muted"
                }`}
              >
                {count}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          {events.length === 0
            ? "Choose events above to see which limits make sense."
            : `A player can enter at most ${effectiveLimit} of your ${events.length} event${events.length === 1 ? "" : "s"}. More than that is refused when they register.`}
        </p>
      </SetupSection>
    </div>
  );
}
