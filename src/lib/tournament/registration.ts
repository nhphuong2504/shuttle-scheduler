import type { Category, Team } from "./data";
import {
  normalizeRegistrationDecision,
  type RegistrationDecision,
} from "./registration-state";
import { countText } from "./summary-format";

/**
 * The two rules a registration form needs, and nothing else.
 *
 * Both are *presentation* rules: they decide what the form offers and what it says about an
 * event, and neither is a gate. The gate is the RPC - it re-checks the cap, the per-player
 * limit, the window and the category's own state inside the transaction that writes the
 * request - so a browser that got one of these wrong would produce a refusal rather than an
 * illegal row. That is the reason they can be a plain function here rather than a read: a
 * number that is only an invitation may be derived, and the number that decides is not
 * derived anywhere.
 *
 * ## Why the cap counts `teams` and not the requests
 *
 * "Remaining capacity" is capacity at *approval*, which is what the S11 queue shows and what
 * the approval itself enforces. A pending request has not been approved, so counting it would
 * show an event as full while the host could still choose to decline the request and take
 * somebody else - and it would make the participant's own number move when an unrelated
 * request arrived. So the count is approved entries, and a pending request is neither counted
 * nor promised.
 */

/** What one event has taken, and what that leaves. */
export interface CategoryUsage {
  /** Entries counted against the cap: approved, and not withdrawn. */
  taken: number;
  /** The configured cap, or null when the event has none. */
  cap: number | null;
  /** How many more entries the event may take, or null when it is uncapped. */
  remaining: number | null;
  /** True only when a cap exists and it has been reached. */
  full: boolean;
}

/**
 * Every event's usage, keyed by category id.
 *
 * A map rather than a per-category function because the page draws every event at once: one
 * pass over the entries, one lookup per row, rather than a filter per row over the whole
 * entry list.
 *
 * A withdrawn entry does not count. The database's own cap trigger counts only
 * `withdrawn = false` rows, so counting the others would hide an event from the picker while
 * the RPC would still accept an entry for it.
 */
export function categoryUsage(
  categories: readonly Category[],
  teams: readonly Team[],
): Map<string, CategoryUsage> {
  const counted = new Map<string, number>();
  for (const team of teams) {
    if (team.withdrawn) continue;
    counted.set(team.category_id, (counted.get(team.category_id) ?? 0) + 1);
  }

  const usage = new Map<string, CategoryUsage>();
  for (const category of categories) {
    const taken = counted.get(category.id) ?? 0;
    const cap = category.max_entries ?? null;
    usage.set(category.id, {
      taken,
      cap,
      remaining: cap == null ? null : Math.max(0, cap - taken),
      full: cap != null && taken >= cap,
    });
  }
  return usage;
}

/**
 * The events a participant may choose: switched on, and not already full.
 *
 * In the stored order, which is the order the host arranged them in and the order the
 * operator's own page lists them in - the same list read two ways rather than two lists.
 */
export function choosableCategories(
  categories: readonly Category[],
  usage: ReadonlyMap<string, CategoryUsage>,
): Category[] {
  return categories.filter((category) => category.active && !usage.get(category.id)?.full);
}

/**
 * One requested event, as the form holds it.
 *
 * The partner fields are present for a singles event too, because a form that only sometimes
 * renders a field is a form whose field ordering changes under the reader. The RPC discards
 * them for a singles entry, so sending them is not an error - it is simply not stored.
 */
export interface RegistrationEntryInput {
  categoryId: string;
  partnerName?: string | null;
  partnerEmail?: string | null;
}

/**
 * The `p_entries` jsonb, built in one place.
 *
 * `category_id` is always sent; the partner keys are *omitted* rather than sent as empty
 * strings when there is nothing in them. The RPC treats an absent key and a blank one the
 * same way, but an omitted key is what makes the payload say what the person actually
 * filled in, and it is the shape a test can assert without counting whitespace.
 */
export function registrationEntriesPayload(
  entries: readonly RegistrationEntryInput[],
): Record<string, string>[] {
  return entries.map((entry) => {
    const partnerName = entry.partnerName?.trim();
    const partnerEmail = entry.partnerEmail?.trim();
    return {
      category_id: entry.categoryId,
      ...(partnerName ? { partner_name: partnerName } : {}),
      ...(partnerEmail ? { partner_email: partnerEmail } : {}),
    };
  });
}

/**
 * "Singles" or "Doubles", from the stored word rather than from the event's name.
 *
 * The database stores `entry_type`, and a name like "Mixed doubles" would be the wrong source:
 * a host may name an event anything. One reading for both the participant's picker and the
 * reviewer's queue, so the two cannot describe the same entry differently.
 */
export function entryTypeLabel(entryType: string | null | undefined): string {
  return entryType === "pair" ? "Doubles" : "Singles";
}

/**
 * What one event has taken, and what is left, as one line.
 *
 * One wording for two readers - the participant choosing an event and the reviewer deciding a
 * request - because both are asking the same question about the same number, and two phrasings
 * would be two chances to disagree about whether an event is full. An uncapped event says how
 * many entries it holds rather than "unlimited", because the number is the fact a person can
 * use and "no cap" is a promise about somebody else's decision; a full event says so instead,
 * which is the line the picker draws for the events it cannot offer.
 */
export function capacityText(usage: CategoryUsage | undefined): string {
  if (!usage) return "";
  if (usage.cap === null) return `${countText(usage.taken, "entry", "entries")} so far`;
  if (usage.full) return `Full, ${usage.cap} of ${usage.cap} taken`;
  return `${usage.taken} of ${usage.cap} taken, ${countText(usage.remaining ?? 0, "place", "places")} left`;
}

/**
 * `review_tournament_registrations`' row, in the wire shape the RPC returns.
 *
 * One row per requested entry, with the request's own columns repeated - the same shape
 * `my_tournament_registration` returns, deliberately, so the reviewer's queue and the
 * participant's own panel fold the same answer the same way. Declared here rather than read
 * from the generated types for the same reason as `MyRegistrationRow`: a `RETURNS TABLE` marks
 * every column non-null in `types.ts`, while a pending request genuinely has no `decided_at`
 * and a request with no entries genuinely has null entry columns.
 */
export interface ReviewRegistrationRow {
  registration_id: string;
  profile_id: string | null;
  email: string | null;
  status: string;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  entry_id: string | null;
  category_id: string | null;
  category_code: string | null;
  category_name: string | null;
  entry_type: string | null;
  partner_name: string | null;
  partner_email: string | null;
  player_id: string | null;
  partner_player_id: string | null;
}

/** One requested event, as the reviewer's queue draws it. */
export interface ReviewRegistrationEntry {
  entryId: string | null;
  categoryId: string | null;
  categoryCode: string | null;
  categoryName: string | null;
  entryType: string | null;
  partnerName: string | null;
  partnerEmail: string | null;
}

/** One request awaiting or holding a decision, with its entries gathered. */
export interface ReviewRegistration {
  id: string;
  profileId: string | null;
  email: string | null;
  status: RegistrationDecision;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  entries: ReviewRegistrationEntry[];
}

/** The queue, in the two groups a reviewer works with. */
export interface RegistrationQueue {
  /** Requests with no decision yet: the work. */
  pending: ReviewRegistration[];
  /** Requests already decided, approved or declined, for context. */
  decided: ReviewRegistration[];
}

/**
 * The queue, split into what needs a decision and what already has one.
 *
 * One fold over the RPC's row-per-entry answer. The two groups are one list rather than two
 * reads: the reviewer needs to see what they have already decided as well as what is waiting,
 * and the request's own state is what separates them. Order is preserved from the RPC - newest
 * request first, and the host's own event order within a request - because that is the order a
 * person works a queue in.
 *
 * A request with no entries still produces one item: a row whose entry columns are all null is
 * a real request, and dropping it would silently hide a participant who asked for nothing.
 */
export function toRegistrationQueue(rows: readonly ReviewRegistrationRow[]): RegistrationQueue {
  const byId = new Map<string, ReviewRegistration>();
  const order: string[] = [];

  for (const row of rows) {
    let request = byId.get(row.registration_id);
    if (!request) {
      request = {
        id: row.registration_id,
        profileId: row.profile_id,
        email: row.email,
        status: normalizeRegistrationDecision(row.status),
        decidedAt: row.decided_at,
        decisionNote: row.decision_note,
        createdAt: row.created_at,
        entries: [],
      };
      byId.set(row.registration_id, request);
      order.push(row.registration_id);
    }
    if (row.entry_id == null) continue;
    request.entries.push({
      entryId: row.entry_id,
      categoryId: row.category_id,
      categoryCode: row.category_code,
      categoryName: row.category_name,
      entryType: row.entry_type,
      partnerName: row.partner_name,
      partnerEmail: row.partner_email,
    });
  }

  const all = order.map((id) => byId.get(id) as ReviewRegistration);
  return {
    pending: all.filter((request) => request.status === "pending"),
    decided: all.filter((request) => request.status !== "pending"),
  };
}
