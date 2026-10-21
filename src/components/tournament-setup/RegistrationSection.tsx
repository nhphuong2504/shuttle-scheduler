import { PickerInput } from "@/components/ui/picker-input";
import { Label } from "@/components/ui/label";
import { effectiveRegistration, registrationProblems } from "./problems";
import { FieldError, SetupSection } from "./section";
import type { DraftForm } from "./types";

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
export function RegistrationSection({
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
              <PickerInput
                id="reg-open"
                type="datetime-local"
                pickerLabel="Open the calendar and time picker for registration opening"
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
              <PickerInput
                id="reg-close"
                type="datetime-local"
                pickerLabel="Open the calendar and time picker for registration closing"
                className="h-12"
                inputClassName={problems.length ? "border-2 border-danger-foreground" : undefined}
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
