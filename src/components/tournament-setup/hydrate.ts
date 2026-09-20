import type { TournamentEventInput } from "@/lib/tournament/actions";
import type {
  Category,
  Court,
  Tournament,
  TournamentDay,
  TournamentDayBreak,
  TournamentDayCourt,
} from "@/lib/tournament/data";
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

/** Rebuilds the wizard form from a persisted draft. */
export function hydrateForm(
  tournament: Tournament,
  days: TournamentDay[],
  courts: Court[],
  dayCourts: TournamentDayCourt[],
  dayBreaks: TournamentDayBreak[],
  categories: Category[],
): DraftForm {
  const numberById = new Map(courts.map((court) => [court.id, court.number]));
  const courtsByDay = new Map<string, number[]>();
  for (const row of dayCourts) {
    const number = numberById.get(row.court_id);
    if (number == null) continue;
    const list = courtsByDay.get(row.day_id) ?? [];
    list.push(number);
    courtsByDay.set(row.day_id, list);
  }

  const breaksByDay = new Map<string, TournamentDayBreak[]>();
  for (const row of dayBreaks) {
    const list = breaksByDay.get(row.day_id) ?? [];
    list.push(row);
    breaksByDay.set(row.day_id, list);
  }

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
    days: days.map((day) => ({
      date: day.date.slice(0, 10),
      startTime: day.start_time.slice(0, 5),
      endTime: day.end_time.slice(0, 5),
      courts: (courtsByDay.get(day.id) ?? []).sort((a, b) => a - b),
      breaks: (breaksByDay.get(day.id) ?? []).map((br) => ({
        label: br.label ?? "",
        startTime: br.start_time.slice(0, 5),
        endTime: br.end_time.slice(0, 5),
      })),
    })),
    events: eventsFrom(categories),
    maxCategoriesPerPlayer: tournament.max_categories_per_player,
  };
}
