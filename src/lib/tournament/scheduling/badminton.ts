/**
 * Badminton rules and venue configuration.
 *
 * This is the only place that knows badminton has group and knockout stages with different
 * durations, and that the day is played on courts. Everything it produces is a generic core type.
 */

import type {
  ScheduleResource,
  SportRules,
  TimeWindow,
  TimingRule,
  TournamentConfig,
} from "@/lib/scheduling";

/** Timing buckets keyed by a format-owned key, e.g. "group", "knockout", "placement". */
export interface BadmintonTimings {
  defaultKey: string;
  byKey: Readonly<Record<string, TimingRule>>;
}

export function createBadmintonRules(timings: BadmintonTimings): SportRules {
  const timingFor = (timingKey: string | undefined): TimingRule => {
    const key = timingKey ?? timings.defaultKey;
    return timings.byKey[key] ?? timings.byKey[timings.defaultKey]!;
  };
  return {
    id: "badminton",
    defaultTimingKey: timings.defaultKey,
    // Format participant refs are already concrete participant ids: the join from teams to players
    // happens where the tournament rows are read, because only that layer knows the schema.
    resolveParticipants(refs) {
      const participantIds = refs.filter((ref): ref is string => ref != null);
      return { participantIds, participantsKnown: refs.every((ref) => ref != null) };
    },
    timingFor,
    // This venue has no court capabilities: every court can host any badminton match.
    resourceRequirementsFor: () => [],
  };
}

export function badmintonRulesFromTournament(tournament: {
  group_slot_minutes: number;
  group_rest_gap_minutes: number;
  knockout_slot_minutes: number;
  knockout_rest_gap_minutes: number;
}): SportRules {
  return createBadmintonRules({
    defaultKey: "group",
    byKey: {
      group: {
        durationMinutes: tournament.group_slot_minutes,
        restAfterMinutes: tournament.group_rest_gap_minutes,
      },
      knockout: {
        durationMinutes: tournament.knockout_slot_minutes,
        restAfterMinutes: tournament.knockout_rest_gap_minutes,
      },
    },
  });
}

export interface TournamentConfigInput {
  id: string;
  courts: readonly { id: string; number: number }[];
  horizonStart: number;
  planningEnd: number;
  hardEnd?: number | null | undefined;
  floor: number;
  unavailable?: readonly TimeWindow[] | undefined;
  /** Per-court availability, for a day where only some courts are open for part of the day. */
  availabilityByCourtId?: ReadonlyMap<string, readonly TimeWindow[]> | undefined;
}

export function tournamentConfig(input: TournamentConfigInput): TournamentConfig {
  const resources: ScheduleResource[] = input.courts.map((court) => {
    const availability = input.availabilityByCourtId?.get(court.id);
    return {
      id: court.id,
      order: court.number,
      label: `Court ${court.number}`,
      ...(availability && availability.length ? { availability } : {}),
    };
  });
  return {
    id: input.id,
    resources,
    horizonStart: input.horizonStart,
    planningEnd: input.planningEnd,
    hardEnd: input.hardEnd ?? null,
    floor: input.floor,
    ...(input.unavailable ? { unavailable: input.unavailable } : {}),
  };
}
