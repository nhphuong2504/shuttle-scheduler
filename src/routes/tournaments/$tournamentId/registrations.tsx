import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  EmptyState,
  Page,
  Panel,
  RegistrationDecisionPill,
} from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { decideTournamentRegistration } from "@/lib/tournament/actions";
import {
  keys,
  useCategories,
  useTeams,
  useTournamentContext,
  useTournamentRegistrationQueue,
} from "@/lib/tournament/data";
import {
  capacityText,
  categoryUsage,
  entryTypeLabel,
  type CategoryUsage,
  type RegistrationQueue,
  type ReviewRegistration,
} from "@/lib/tournament/registration";
import { countText, instantText } from "@/lib/tournament/summary-format";

const REGISTRATIONS_DESCRIPTION =
  "Review the registration requests people have filed for this tournament.";

export const Route = createFileRoute("/tournaments/$tournamentId/registrations")({
  head: () => ({
    meta: [
      { title: "Registrations | Tournova Tournament Ops" },
      { name: "description", content: REGISTRATIONS_DESCRIPTION },
      { property: "og:title", content: "Registrations | Tournova Tournament Ops" },
      { property: "og:description", content: REGISTRATIONS_DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "twitter:card", content: "summary" },
    ],
  }),
  component: RegistrationsPage,
});

/**
 * Re-reads what a decision changes: the queue itself, and the entries the approval creates.
 *
 * Not a blanket invalidation. A decision can add `teams` rows - which move every event's
 * capacity line - and it changes the request's own state, and it can change the registration
 * counts the tournament cards show. Everything else on this page is a read of the same two
 * things, and refetching more would only be traffic on venue wifi.
 */
function invalidateAfterDecision(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: keys.registrationQueue });
  void queryClient.invalidateQueries({ queryKey: keys.teams });
  void queryClient.invalidateQueries({ queryKey: keys.tournamentSummaries });
}

/**
 * The queue of registration requests, for whoever may decide them.
 *
 * This is the organiser's page and not the moderator's: it is about the tournament's entries
 * as a set rather than about one court in real time, and it is where the bridge from a request
 * to an entrant happens. It is editor-gated in the database (the read refuses a caller who
 * cannot edit), and this page does not issue the read at all for a viewer - a request that can
 * only be refused is not worth making on venue wifi.
 *
 * ## Capacity is shown as it will be at approval, not as it stands today
 *
 * Each entry says what its event has taken and what is left, counted over approved entries
 * only - the same number the participant saw when choosing, and the same number the approval
 * itself re-checks. A pending request is deliberately *not* counted: it is not in the draw
 * until a person files the decision, and counting it here would show an event as full while
 * the host could still decline the request. When an event is already full, the line says so;
 * the reviewer learns the outcome from the refusal rather than from this page pre-judging it,
 * which is why the buttons stay enabled and the RPC's sentence is surfaced verbatim.
 *
 * ## The note belongs to the decision and not to the request
 *
 * The note field is per request and is sent with whichever button is pressed, so a reviewer can
 * write the reason and then choose. It is optional for both outcomes: a decline usually needs a
 * reason, and an approval sometimes does too ("you are in, but we moved you to Saturday"). An
 * empty note is sent as null rather than as whitespace.
 */
function RegistrationsPage() {
  const { tournamentId, access } = useTournamentContext();
  const canEdit = access.can_edit;

  const queueQuery = useTournamentRegistrationQueue(tournamentId, { enabled: canEdit });
  const categoriesQuery = useCategories();
  const teamsQuery = useTeams();

  const queue = queueQuery.data ?? null;
  const categories = useMemo(() => categoriesQuery.data ?? [], [categoriesQuery.data]);
  const teams = useMemo(() => teamsQuery.data ?? [], [teamsQuery.data]);
  const usage = useMemo(() => categoryUsage(categories, teams), [categories, teams]);

  if (!tournamentId) {
    return (
      <Page title="Registrations" subtitle={REGISTRATIONS_DESCRIPTION}>
        <EmptyState
          title="No tournament selected"
          hint="Choose or create a tournament on the setup page first."
        />
      </Page>
    );
  }

  if (!canEdit) {
    return (
      <Page title="Registrations" subtitle={REGISTRATIONS_DESCRIPTION}>
        <div className="rounded-lg border border-warn-border bg-warn-surface px-3 py-2 text-sm font-medium text-warn-foreground">
          {/* Said plainly rather than shown as a locked list: a viewer who followed a link
              needs to know who can decide these, and "not authorized" would not tell them. */}
          Only the people who can edit this tournament can decide registration requests. You can
          ask an editor or the owner to review them.
        </div>
      </Page>
    );
  }

  return (
    <Page
      title="Registrations"
      subtitle="Requests people have filed to enter this tournament."
    >
      <div className="space-y-4">
        <PendingPanel queue={queue} usage={usage} loading={queueQuery.isLoading} />
        <DecidedPanel queue={queue} />
      </div>
    </Page>
  );
}

function PendingPanel({
  queue,
  usage,
  loading,
}: {
  queue: RegistrationQueue | null;
  usage: ReadonlyMap<string, CategoryUsage>;
  loading: boolean;
}) {
  const pending = queue?.pending ?? [];

  return (
    <Panel
      title="Awaiting a decision"
      right={
        <span className="font-score text-t2 text-muted-foreground">
          {countText(pending.length, "request", "requests")}
        </span>
      }
      bodyClassName="p-0"
    >
      {loading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading the queue…</p>
      ) : pending.length === 0 ? (
        <div className="p-4">
          <EmptyState
            title="Nothing is waiting"
            hint="When somebody asks to enter, their request appears here for you to approve or decline."
          />
        </div>
      ) : (
        <ul className="divide-y divide-hairline">
          {pending.map((request) => (
            <li key={request.id}>
              <PendingRequest request={request} usage={usage} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * One request, with its own note field and its two decisions.
 *
 * A component rather than a row inside the list's map, because the note is local state: it
 * belongs to the request being decided, and keeping it here means typing in one request's note
 * cannot re-render - or clear - another's.
 */
function PendingRequest({
  request,
  usage,
}: {
  request: ReviewRegistration;
  usage: ReadonlyMap<string, CategoryUsage>;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");

  const decide = useMutation({
    mutationFn: (decision: "approved" | "rejected") =>
      decideTournamentRegistration({ registrationId: request.id, decision, note }),
    onSuccess: (_data, decision) => {
      toast.success(decision === "approved" ? "Request approved" : "Request declined");
      invalidateAfterDecision(queryClient);
    },
    onError: (error) => {
      // The RPC's own refusal is shown verbatim. It knows things this page cannot - whether
      // the request was decided in another tab, and which event was full - and rewording it
      // here would only hide the sentence the reviewer needs.
      toast.error(error instanceof Error ? error.message : "Could not record that decision");
    },
  });

  const busy = decide.isPending;

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 truncate text-sm font-semibold">
          {request.email || "Unknown requester"}
        </span>
        <span className="text-sm text-muted-foreground">
          Asked {instantText(request.createdAt)}
        </span>
      </div>

      <RequestEntries entries={request.entries} usage={usage} />

      <div className="space-y-1.5">
        <label
          className="text-sm font-medium text-muted-foreground"
          htmlFor={`note-${request.id}`}
        >
          Note for the requester (optional)
        </label>
        <Textarea
          id={`note-${request.id}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Why this decision, if there is something they should know."
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={() => decide.mutate("approved")}>
          {busy ? "Recording…" : "Approve"}
        </Button>
        {/*
          Declining is outlined rather than destructive: red in this system means an act that
          destroys competition data, and a decline creates nothing and takes nothing away - it
          is the request that is closed, not an entrant that is removed.
        */}
        <Button variant="outline" disabled={busy} onClick={() => decide.mutate("rejected")}>
          Decline
        </Button>
      </div>
    </div>
  );
}

function DecidedPanel({ queue }: { queue: RegistrationQueue | null }) {
  const decided = queue?.decided ?? [];
  if (decided.length === 0) return null;

  return (
    <Panel
      title="Decided"
      right={
        <span className="font-score text-t2 text-muted-foreground">
          {countText(decided.length, "request", "requests")}
        </span>
      }
      bodyClassName="p-0"
    >
      <ul className="divide-y divide-hairline">
        {decided.map((request) => (
          <li key={request.id} className="space-y-2 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-sm">{request.email || "Unknown requester"}</span>
                <RegistrationDecisionPill decision={request.status} />
              </span>
              <span className="text-sm text-muted-foreground">
                {request.decidedAt ? `Decided ${instantText(request.decidedAt)}` : null}
              </span>
            </div>
            <RequestEntries entries={request.entries} usage={null} />
            {request.decisionNote ? (
              <p className="text-sm">
                <span className="font-semibold">Note sent:</span> {request.decisionNote}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * The events one request asked for.
 *
 * `usage` is passed only for the pending list. A decided request's entries are already in or
 * out of the draw, so showing a capacity line beside them would be a number about a decision
 * that has been made rather than about one that is waiting.
 */
function RequestEntries({
  entries,
  usage,
}: {
  entries: ReviewRegistration["entries"];
  usage: ReadonlyMap<string, CategoryUsage> | null;
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No events were named.</p>;
  }

  return (
    <ul className="space-y-1 text-sm">
      {entries.map((entry) => {
        const usageLine = usage && entry.categoryId ? capacityText(usage.get(entry.categoryId)) : "";
        return (
          <li key={entry.entryId ?? entry.categoryId} className="min-w-0">
            <span className="truncate">
              {entry.categoryName ?? "Event"}
              {entry.partnerName ? ` with ${entry.partnerName}` : ""}
            </span>
            <span className="text-muted-foreground">
              {" · "}
              {entryTypeLabel(entry.entryType)}
              {usageLine ? ` · ${usageLine}` : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
