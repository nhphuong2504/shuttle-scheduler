import type { TournamentEventInput } from "@/lib/tournament/actions";
import type { Category, Tournament } from "@/lib/tournament/data";
import { instantToZoned } from "@/lib/tournament/zoned-time";
import type { DraftForm } from "./types";

function eventsFrom(categories: Category[]): TournamentEventInput[] {
  return categories.map((category) => ({
    code: category.code,
    name: category.name,
    entryType: category.entry_type === "pair" ? "pair" : "individual",
    gender:
      category.gender === "men" || category.gender === "women" || category.gender === "mixed"
        ? category.gender
        : "open",
    sortOrder: category.sort_order,
    active: category.active,
    maxEntries: category.max_entries,
  }));
}

/**
 * The registration window as stored, for comparing with what the host has typed.
 *
 * The form holds wall-clock strings to the minute; the database holds instants to the
 * microsecond. Converting a stored instant to a string and back loses the seconds, so when
 * the host has not touched a field the stored instant is what must be sent, or the opening
 * time would appear to have changed by a few seconds and be refused. This keeps both forms
 * side by side so the wizard can tell "unchanged" from "edited".
 */
export interface RegistrationOrigin {
  opensAt: string | null;
  closesAt: string | null;
  opensLocal: string;
  closesLocal: string;
}

export function registrationOrigin(tournament: Tournament): RegistrationOrigin {
  const zone = tournament.venue_timezone;
  const local = (iso: string | null) => (iso ? (instantToZoned(iso, zone) ?? "") : "");
  return {
    opensAt: tournament.registration_opens_at,
    closesAt: tournament.registration_closes_at,
    opensLocal: local(tournament.registration_opens_at),
    closesLocal: local(tournament.registration_closes_at),
  };
}

/** Rebuilds the wizard form from a stored tournament. */
export function hydrateForm(tournament: Tournament, categories: Category[]): DraftForm {
  const origin = registrationOrigin(tournament);
  return {
    basics: {
      name: tournament.name,
      notes: tournament.notes ?? "",
      venueName: tournament.venue_name ?? "",
      venueAddress: tournament.venue_address ?? "",
      venueTimezone: tournament.venue_timezone,
      organizerName: tournament.organizer_name ?? "",
      organizerEmail: tournament.organizer_email ?? "",
      organizerPhone: tournament.organizer_phone ?? "",
    },
    startsOn: tournament.starts_on ? String(tournament.starts_on).slice(0, 10) : "",
    endsOn: tournament.ends_on ? String(tournament.ends_on).slice(0, 10) : "",
    events: eventsFrom(categories),
    maxCategoriesPerPlayer: tournament.max_categories_per_player,
    registration: {
      enabled: Boolean(origin.opensAt && origin.closesAt),
      opensAt: origin.opensLocal,
      closesAt: origin.closesLocal,
    },
  };
}
