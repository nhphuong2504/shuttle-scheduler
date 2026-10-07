import { Check, Plus, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TournamentEventInput } from "@/lib/tournament/actions";
import { effectiveRegistration, registrationProblems } from "./problems";
import { FieldError, SetupSection } from "./section";
import type { DraftForm } from "./types";

type EventGender = TournamentEventInput["gender"];

interface EventTemplate {
  code: string;
  name: string;
  entryType: "individual" | "pair";
  gender: EventGender;
}

/**
 * The standard badminton events, as one-click additions.
 *
 * Both the shape and who may enter are part of what the event *is*, so neither is
 * asked for: MS and WS are singles, MD, WD and XD are doubles, and each is open
 * to the gender in its name. They are carried into the stored event because entry
 * validation reads them.
 */
const EVENT_TEMPLATES: EventTemplate[] = [
  { code: "MS", name: "Men's Singles", entryType: "individual", gender: "men" },
  { code: "WS", name: "Women's Singles", entryType: "individual", gender: "women" },
  { code: "MD", name: "Men's Doubles", entryType: "pair", gender: "men" },
  { code: "WD", name: "Women's Doubles", entryType: "pair", gender: "women" },
  { code: "XD", name: "Mixed Doubles", entryType: "pair", gender: "mixed" },
];

const MAX_CATEGORIES_PER_PLAYER = 5;

/**
 * The second step: which events run, how many one player may enter, and when people may
 * register.
 *
 * The five standard events are a row of toggles: pressing one adds it and pressing it again
 * takes it away, and a pressed one says so with a tick as well as a fill. What was added is
 * listed below, where its name and entry cap can still be changed.
 *
 * Registration lives here rather than with the dates because it is a rule about who may enter
 * the events, even though its deadline is measured against the tournament's first date. That
 * is why its error can land on this step while the date that caused it sits on the previous
 * one: the message names both.
 *
 * `registrationOpened` is true once a stored opening time has passed. The opening time is
 * then fixed, because people have already relied on it. `registrationLocked` takes the whole
 * block away once the tournament has started.
 */
export function EventsStep({
  form,
  onChange,
  showErrors = false,
  registrationOpened = false,
  registrationLocked = false,
}: {
  form: DraftForm;
  onChange: (patch: Partial<DraftForm>) => void;
  showErrors?: boolean;
  registrationOpened?: boolean;
  registrationLocked?: boolean;
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
                      const raw = e.target.value.trim();
                      setEvent(event.code, {
                        maxEntries: raw === "" ? null : Number.parseInt(raw, 10),
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
            const selected = form.maxCategoriesPerPlayer === count;
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
            : `A player can enter at most ${form.maxCategoriesPerPlayer} of your ${events.length} event${events.length === 1 ? "" : "s"}. More than that is refused when they register.`}
        </p>
      </SetupSection>

      <RegistrationSection
        form={form}
        onChange={onChange}
        showErrors={showErrors}
        opened={registrationOpened}
        locked={registrationLocked}
      />
    </div>
  );
}

const DAY = 86_400_000;

/** "Open for 15 days", from two wall-clock strings in the same zone. */
function openFor(opensAt: string, closesAt: string): string | null {
  const gap = Date.parse(`${closesAt}:00Z`) - Date.parse(`${opensAt}:00Z`);
  if (!Number.isFinite(gap) || gap <= 0) return null;
  const days = Math.round(gap / DAY);
  if (days >= 1) return `Open for ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.round(gap / 3_600_000));
  return `Open for ${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * The registration window: a switch, and when it opens and closes.
 *
 * The times are the venue's wall clock, because that is where "23:59" means something. The
 * fields show what will be used when the host has not typed one - now for the opening time,
 * the end of the day before the tournament for the closing time - so nothing is decided
 * behind their back.
 */
function RegistrationSection({
  form,
  onChange,
  showErrors,
  opened,
  locked,
}: {
  form: DraftForm;
  onChange: (patch: Partial<DraftForm>) => void;
  showErrors: boolean;
  opened: boolean;
  locked: boolean;
}) {
  const registration = form.registration;
  const { opensAt, closesAt } = effectiveRegistration(form);
  const problems = showErrors ? registrationProblems(form) : [];
  const length = registration.enabled ? openFor(opensAt, closesAt) : null;

  const set = (patch: Partial<DraftForm["registration"]>) =>
    onChange({ registration: { ...registration, ...patch } });

  return (
    <SetupSection
      headingId="setup-registration"
      title="Registration"
      hint="Let players send entry requests from the tournament's page. Turn it off if you add players yourself."
    >
      <div className="flex items-center justify-between gap-4">
        <span className="text-base font-semibold" id="reg-switch-label">
          Accept registrations online
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={registration.enabled}
          aria-labelledby="reg-switch-label"
          aria-describedby={opened ? "reg-switch-note" : undefined}
          disabled={locked || opened}
          onClick={() => set({ enabled: !registration.enabled })}
          className="inline-flex min-h-11 items-center gap-2.5 rounded-lg px-1 font-semibold disabled:opacity-60"
        >
          <span
            aria-hidden="true"
            className={`relative inline-block h-[1.875rem] w-[3.25rem] rounded-full transition-colors ${
              registration.enabled ? "bg-primary" : "bg-border-control"
            }`}
          >
            <span
              className={`absolute top-[0.1875rem] size-6 rounded-full bg-white transition-all ${
                registration.enabled ? "right-[0.1875rem]" : "left-[0.1875rem]"
              }`}
            />
          </span>
          {registration.enabled ? "On" : "Off"}
        </button>
      </div>

      {opened ? (
        <p id="reg-switch-note" className="mt-2 text-sm text-muted-foreground">
          Registration has already opened, so it cannot be switched off. To stop taking requests,
          move the deadline to now.
        </p>
      ) : null}

      {registration.enabled ? (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="reg-open">Registration opens</Label>
              <Input
                id="reg-open"
                type="datetime-local"
                className="h-12"
                value={opensAt}
                disabled={locked || opened}
                onChange={(e) => set({ opensAt: e.target.value })}
              />
              {opened ? (
                <p className="text-sm text-muted-foreground">Already open, so this cannot move.</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reg-close">Registration closes</Label>
              <Input
                id="reg-close"
                type="datetime-local"
                className={problems.length ? "h-12 border-2 border-danger-foreground" : "h-12"}
                value={closesAt}
                disabled={locked}
                aria-invalid={problems.length > 0}
                aria-describedby={problems.length ? "reg-error" : undefined}
                onChange={(e) => set({ closesAt: e.target.value })}
              />
            </div>
          </div>

          {problems.length ? (
            <div id="reg-error">
              {problems.map((problem) => (
                <FieldError key={problem} id={`reg-error-${problems.indexOf(problem)}`}>
                  {problem}
                </FieldError>
              ))}
            </div>
          ) : null}

          {length ? (
            <p className="mt-3">
              <span className="inline-flex rounded-full bg-info-surface px-3.5 py-1.5 text-sm font-semibold text-info-foreground">
                {length}
              </span>
            </p>
          ) : null}

          <p className="mt-3 text-sm text-muted-foreground">
            {form.startsOn
              ? `Times are venue time (${form.basics.venueTimezone}). Registration has to close before the tournament starts, ${form.startsOn} at 00:00. You can extend the deadline later, up to that moment.`
              : "Pick the tournament dates on the first step: registration has to close before the first day starts."}
          </p>
        </>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          Nobody can send an entry request. You can still add players yourself.
        </p>
      )}
    </SetupSection>
  );
}
