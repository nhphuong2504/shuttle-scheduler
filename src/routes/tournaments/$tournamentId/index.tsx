import { Link, createFileRoute, useLocation } from "@tanstack/react-router";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  Page,
  Panel,
  RegistrationDecisionPill,
  RegistrationStatePill,
  TournamentStatusPill,
} from "@/components/app-shell";
import { tournamentPhase } from "@/lib/tournament/phase";
import { compareEventOrder } from "@/lib/tournament/event-order";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/hooks/useSession";
import { normalizeTournamentStatus } from "@/lib/auth/authorization";
import { signInSearch } from "@/lib/routing/redirect";
import {
  submitTournamentRegistration,
  withdrawTournamentRegistration,
} from "@/lib/tournament/actions";
import {
  keys,
  useCategories,
  useMyTournamentRegistration,
  useTeams,
  useTournamentContext,
  useTournamentRegistrationState,
  useTournamentSummary,
  type Category,
  type MyRegistrationEntry,
} from "@/lib/tournament/data";
import {
  capacityText,
  categoryUsage,
  choosableCategories,
  entryTypeLabel,
  type CategoryUsage,
  type RegistrationEntryInput,
} from "@/lib/tournament/registration";
import {
  isRegistrationOpen,
  registrationDecisionHint,
  registrationStateHint,
} from "@/lib/tournament/registration-state";
import { countText, dateRangeText, instantText } from "@/lib/tournament/summary-format";
import { cn } from "@/lib/utils";
import { TournamentResults } from "@/components/tournament-results";

/**
 * One tournament, for the person deciding whether to enter it.
 *
 * This is the address a card links to, in Explore, in My Tournaments and on the front door,
 * and it is the only surface in the app written for a *participant* rather than for an
 * operator. That is why it states three things and stops: what the tournament is, whether
 * the window is open, and where this caller's own request stands. Nothing here is an
 * operator's fact - no readiness configuration, no seed order, no match board - so the
 * page is readable by somebody who has never held edit rights.
 *
 * ## The window is the database's answer, never this page's arithmetic
 *
 * `tournament_registration_state` is the read the Register panel renders from, and it is
 * computed from the same predicates `submit_tournament_registration` consults. A page that
 * derived "open" from the two timestamps and its own clock would disagree with the RPC that
 * refused the submission in exactly the cases a person complains about, and the person it
 * disagrees with is standing at a desk with a participant in front of them. The pill, the
 * sentence under it and whether the form is drawn at all come from that one word.
 *
 * ## The counts are capacity *at approval*, and the pending request is not in them
 *
 * The picker shows each event's cap and what is left, counted over approved entries only.
 * A pending request has not been approved, so counting it would show an event as full while
 * the host could still decline the request and take somebody else - and it would make the
 * participant's own number move when an unrelated request arrived. The arithmetic lives in
 * [`registration.ts`](../../../lib/tournament/registration.ts) and is unit-tested there;
 * this page only draws it.
 *
 * ## Why the picker is a list of pressed buttons and not checkboxes
 *
 * Pressed buttons are this app's vocabulary for "a set of choices, all visible, each one
 * answering what am I looking at now" (the Explore status filter is the other instance),
 * and a checked checkbox in this codebase would be the only one. It also puts the event's
 * own facts - type, cap, what is left - inside the control's own label, where a screen
 * reader reads them as the reason for the choice rather than as loose text beside it.
 */

export const Route = createFileRoute("/tournaments/$tournamentId/")({
  head: () => ({
    meta: [
      { title: "Tournament | Tournova Tournament Ops" },
      {
        name: "description",
        content:
          "A badminton tournament's events, its registration window and your own entry request.",
      },
      { property: "og:title", content: "Tournament | Tournova Tournament Ops" },
      {
        property: "og:description",
        content:
          "A badminton tournament's events, its registration window and your own entry request.",
      },
      { property: "og:type", content: "website" },
      { property: "twitter:card", content: "summary" },
    ],
  }),
  component: TournamentPage,
});

/**
 * Re-reads the three things a registration write can change.
 *
 * Not a blanket invalidation: the caller's own request, the window word (a submission can
 * move nothing here, but the panel is the same read and a stale one is a lie), and the
 * summary, because the card counts belong to the same tournament a person may have open in
 * another tab. Everything else on this page - the events, the approved entries - is
 * unchanged by filing a request, and refetching it would only be traffic on venue wifi.
 */
function invalidateRegistration(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: keys.myRegistration });
  void queryClient.invalidateQueries({ queryKey: keys.registrationState });
  void queryClient.invalidateQueries({ queryKey: keys.tournamentSummaries });
}

function TournamentPage() {
  const { tournamentId, tournament } = useTournamentContext();
  const summaryQuery = useTournamentSummary(tournamentId);
  const windowQuery = useTournamentRegistrationState(tournamentId);
  const categoriesQuery = useCategories();
  const teamsQuery = useTeams();
  const registrationQuery = useMyTournamentRegistration(tournamentId);
  const { signedIn } = useSession();
  const queryClient = useQueryClient();
  const href = useLocation({ select: (location) => location.href });

  const summary = summaryQuery.data ?? null;
  const state = windowQuery.data ?? null;
  const registration = registrationQuery.data ?? null;
  const categories = useMemo(() => categoriesQuery.data ?? [], [categoriesQuery.data]);
  const teams = useMemo(() => teamsQuery.data ?? [], [teamsQuery.data]);

  const usage = useMemo(() => categoryUsage(categories, teams), [categories, teams]);
  const choosable = useMemo(() => choosableCategories(categories, usage), [categories, usage]);
  const selectableIds = useMemo(() => new Set(choosable.map((c) => c.id)), [choosable]);
  /**
   * The events on offer: switched on, and in the standard order rather than the order they were
   * added in.
   *
   * `categories` arrives ordered by `sort_order`, which records the order the setup toggles were
   * pressed. That is a fact about how the tournament was configured, not about the tournament: a
   * host who switched WS on before MS would show a participant Women's Singles first, while the
   * organiser's own pages list MS first. A participant reads this list to find an event, so it
   * uses the same order everywhere else does.
   *
   * Events that are already full are included and drawn disabled rather than omitted. Hiding one
   * would send a participant looking for the event they came for - "where is Mixed Doubles?" -
   * when the honest answer, which the panel can give, is that it is full.
   */
  const events = useMemo(
    () => categories.filter((c) => c.active).sort(compareEventOrder),
    [categories],
  );
  const cap = tournament?.max_categories_per_player ?? null;

  const open = state !== null && isRegistrationOpen(state);
  const withdraw = useMutation({
    mutationFn: (registrationId: string) => withdrawTournamentRegistration(registrationId),
    onSuccess: () => {
      toast.success("Request withdrawn");
      invalidateRegistration(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not withdraw the request");
    },
  });

  const name = summary?.name ?? tournament?.name ?? "Tournament";
  const venue = summary?.venue_name ?? tournament?.venue_name ?? "";
  const range = summary ? dateRangeText(summary.starts_at, summary.ends_at) : null;

  /**
   * Whether the picker can be drawn from complete data.
   *
   * The form seeds itself from both the events and the caller's own request, so rendering it
   * before either has arrived would seed it from an empty list and then never re-seed - the
   * prefill is initial state, not a derived value, precisely so that typing in the partner
   * fields cannot be overwritten by a background refetch. So it waits, and says so.
   */
  const formReady =
    categoriesQuery.isSuccess && teamsQuery.isSuccess && registrationQuery.isSuccess;

  return (
    <Page
      title={name}
      // An empty venue is left out rather than announced: "Venue not set" was the first thing
      // a visitor read about a tournament that had already been played.
      subtitle={[venue, range].filter(Boolean).join(", ")}
      actions={
        summary ? (
          <TournamentStatusPill
            status={normalizeTournamentStatus(summary.status)}
            phase={tournamentPhase(summary)}
          />
        ) : null
      }
    >
      <div className="space-y-4">
        {tournamentId ? <TournamentResults tournamentId={tournamentId} /> : null}

        {/*
          Once the tournament is completed there is nothing to register for, and the panel only
          repeated the status the header already gives; it stays for someone with a request.
        */}
        {summary?.status === "completed" && !registration ? null : (
        <Panel title="Registration" right={state ? <RegistrationStatePill state={state} /> : null}>
          <p className="text-sm text-muted-foreground">
            {state === null
              ? "Checking whether registration is open…"
              : registrationStateHint(state)}
          </p>

          {open && signedIn && registration?.status === "approved" ? (
            <p className="mt-3 text-sm">
              You are already registered for this tournament, so there is nothing to ask for.
              The organiser places approved entries in the draw.
            </p>
          ) : null}

          {open && signedIn && registration?.status !== "approved" ? (
            formReady ? (
              <RegisterForm
                // Keyed on the request it seeds from, so a withdrawal or a decision swaps the
                // seed rather than leaving a stale selection in the fields.
                key={registration?.status === "pending" ? registration.id : "new"}
                tournamentId={tournamentId ?? ""}
                events={events}
                usage={usage}
                selectableIds={selectableIds}
                cap={cap}
                initial={registration?.status === "pending" ? registration.entries : []}
                replacing={registration?.status === "pending"}
              />
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Loading the events…</p>
            )
          ) : null}

          {/* The signed-out reading of the same affordance: the trip that changes what a
              visitor can do, carrying this page as the place to come back to. Offered only
              while the window is open, because a sign-in that leads to a closed form is a
              longer way round to a refusal.

              The errand is named too, so the sign-in page can say where this ends - which
              matters most here, because the caller is standing on the destination already and
              the useful thing to know is that they come back to it. Explore's Register
              control offers the same trip with the same word. */}
          {open && !signedIn ? (
            <div className="mt-3">
              <Button asChild>
                <Link to="/auth" search={signInSearch(href, "register")}>
                  Sign in to register
                </Link>
              </Button>
            </div>
          ) : null}
        </Panel>
        )}

        {signedIn && registration ? (
          <Panel
            title="Your registration"
            right={<RegistrationDecisionPill decision={registration.status} />}
          >
            <p className="text-sm text-muted-foreground">
              {registrationDecisionHint(registration.status)}
            </p>
            {registration.decisionNote ? (
              <p className="mt-2 text-sm">
                <span className="font-semibold">Note from the organisers:</span>{" "}
                {registration.decisionNote}
              </p>
            ) : null}

            {registration.entries.length > 0 ? (
              <ul className="mt-3 space-y-1 text-sm">
                {registration.entries.map((entry) => (
                  <li key={entry.entryId ?? entry.categoryId} className="min-w-0 truncate">
                    {entry.categoryName ?? "Event"}
                    {entry.partnerName ? ` with ${entry.partnerName}` : ""}
                    <span className="text-muted-foreground">
                      {" ("}
                      {entryTypeLabel(entry.entryType)}
                      {")"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="mt-3 text-sm text-muted-foreground">
              Sent {instantText(registration.createdAt)}
            </p>

            {/*
              Withdrawing is the requester's own act on their own unanswered request, and it is
              reversible - the form above is still there to file it again - so it takes no
              confirmation. It is outlined rather than destructive for the same reason: red in
              this system means an act that destroys competition data, and this deletes an
              untreated request and nothing else.
            */}
            {registration.status === "pending" ? (
              <div className="mt-4">
                <Button
                  variant="outline"
                  disabled={withdraw.isPending}
                  onClick={() => withdraw.mutate(registration.id)}
                >
                  {withdraw.isPending ? "Withdrawing…" : "Withdraw request"}
                </Button>
              </div>
            ) : null}
          </Panel>
        ) : null}
      </div>
    </Page>
  );
}

/**
 * The event picker, as one form.
 *
 * State is initial, not derived. The seed is whatever the caller's pending request asked
 * for, and after that the selection belongs to whoever is typing - which is what keeps a
 * background refetch from overwriting a half-typed partner's email. The page keys this
 * component on the request it seeded from, so a withdrawal or a decision remounts it rather
 * than leaving a selection that describes a request that no longer exists.
 *
 * Nothing here is a gate. The completeness rules below are about this form - an entry with
 * an empty partner is not a thing the person meant to send - while every rule about the
 * tournament (the cap, the window, the per-player limit, whether the event is open) is
 * re-checked by the RPC in the transaction that writes the request, and its refusal is
 * surfaced as it arrives.
 */
function RegisterForm({
  tournamentId,
  events,
  usage,
  selectableIds,
  cap,
  initial,
  replacing,
}: {
  tournamentId: string;
  events: readonly Category[];
  usage: ReadonlyMap<string, CategoryUsage>;
  /** The events this form may offer, which is the active and not-yet-full subset. */
  selectableIds: ReadonlySet<string>;
  cap: number | null;
  initial: readonly MyRegistrationEntry[];
  /** True when a pending request already exists and this submission replaces it. */
  replacing: boolean;
}) {
  type Picked = Record<string, { partnerName: string; partnerEmail: string }>;

  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Picked>(() => {
    const seed: Picked = {};
    for (const entry of initial) {
      // An entry whose event has since closed or filled is dropped rather than seeded: it
      // cannot be drawn as a choice, so keeping it would send something the form never
      // showed. The RPC replaces the whole set on a resubmit, which is what makes dropping
      // it honest rather than silent.
      if (!entry.categoryId || !selectableIds.has(entry.categoryId)) continue;
      seed[entry.categoryId] = {
        partnerName: entry.partnerName ?? "",
        partnerEmail: entry.partnerEmail ?? "",
      };
    }
    return seed;
  });

  const submit = useMutation({
    mutationFn: (entries: RegistrationEntryInput[]) =>
      submitTournamentRegistration(tournamentId, entries),
    onSuccess: () => {
      toast.success(replacing ? "Registration request updated" : "Registration request sent");
      invalidateRegistration(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Could not send the request");
    },
  });

  const chosenCount = Object.keys(picked).length;
  const atCap = cap !== null && chosenCount >= cap;
  const partnerIncomplete = events.some((event) => {
    const choice = picked[event.id];
    if (!choice) return false;
    if (event.entry_type !== "pair") return false;
    return choice.partnerName.trim().length === 0 || choice.partnerEmail.trim().length === 0;
  });

  const toggle = (category: Category) => {
    setPicked((previous) => {
      const next = { ...previous };
      if (next[category.id]) delete next[category.id];
      else next[category.id] = { partnerName: "", partnerEmail: "" };
      return next;
    });
  };

  const setPartner = (categoryId: string, patch: Partial<{ partnerName: string; partnerEmail: string }>) => {
    setPicked((previous) => ({
      ...previous,
      [categoryId]: { ...(previous[categoryId] ?? { partnerName: "", partnerEmail: "" }), ...patch },
    }));
  };

  /**
   * The payload, built in the host's own event order rather than in click order.
   *
   * Two participants who chose the same events must produce the same request, and the stored
   * `sort_order` is the one order both the host and the operator's page already use. The
   * partner fields are omitted for singles rather than sent empty: the RPC discards them
   * either way, and an omitted key is what makes the payload say what was actually filled in.
   */
  const entries: RegistrationEntryInput[] = useMemo(
    () =>
      events
        .filter((event) => picked[event.id])
        .map((event) => {
          const choice = picked[event.id];
          const isPair = event.entry_type === "pair";
          return {
            categoryId: event.id,
            partnerName: isPair ? (choice?.partnerName ?? null) : null,
            partnerEmail: isPair ? (choice?.partnerEmail ?? null) : null,
          };
        }),
    [events, picked],
  );

  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (entries.length === 0 || partnerIncomplete) return;
        submit.mutate(entries);
      }}
    >
      <ul className="space-y-2">
        {events.map((event) => {
          const choice = picked[event.id];
          const selectable = selectableIds.has(event.id);
          const isPair = event.entry_type === "pair";
          const disabled = !selectable || (!choice && atCap);
          const reason = !selectable
            ? "This event is full."
            : !choice && atCap
              ? `You have chosen the maximum of ${countText(cap ?? 0, "event", "events")}.`
              : undefined;
          return (
            <li key={event.id} className="rounded-lg border border-hairline p-3">
              <button
                type="button"
                aria-pressed={!!choice}
                disabled={disabled}
                onClick={() => toggle(event)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md border p-2 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  // The pressed state carries a fill *and* a ring, and the ring is the part
                  // that matters: the tint alone measures about 1.1:1 against
                  // the panel behind it, which is a selected state that is not a shape at
                  // all. `--border-selected` is the token solved for exactly this pair.
                  choice
                    ? "border-border-selected bg-primary/10"
                    : "border-hairline enabled:hover:bg-muted",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-display text-sm font-semibold">
                    {event.name}
                  </span>
                  <span className="mt-0.5 block text-t4 text-muted-foreground">
                    {entryTypeLabel(event.entry_type)}, {capacityText(usage.get(event.id))}
                    {reason ? `. ${reason}` : ""}
                  </span>
                </span>
              </button>

              {isPair && choice ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`partner-name-${event.id}`}>Partner's name</Label>
                    <Input
                      id={`partner-name-${event.id}`}
                      value={choice.partnerName}
                      // Autofill would offer the entrant's own details as the partner's, and
                      // this tournament's own rule is that the two must differ - so the field
                      // asks the browser not to guess.
                      autoComplete="off"
                      onChange={(input) =>
                        setPartner(event.id, { partnerName: input.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`partner-email-${event.id}`}>Partner's email</Label>
                    <Input
                      id={`partner-email-${event.id}`}
                      type="email"
                      value={choice.partnerEmail}
                      autoComplete="off"
                      onChange={(input) =>
                        setPartner(event.id, { partnerEmail: input.target.value })
                      }
                    />
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This tournament has no events open for registration yet.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={entries.length === 0 || partnerIncomplete || submit.isPending}>
          {submit.isPending
            ? "Sending…"
            : replacing
              ? "Update request"
              : "Send registration request"}
        </Button>
        <p className="text-sm text-muted-foreground">
          {entries.length === 0
            ? "Choose at least one event."
            : partnerIncomplete
              ? "A doubles event needs your partner's name and email."
              : `${countText(entries.length, "event", "events")} selected${
                  cap === null ? "" : `, up to ${cap} per player`
                }`}
        </p>
      </div>
    </form>
  );
}
