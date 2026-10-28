#!/usr/bin/env node
// Computes the schedule-quality metrics behind report.md from tournament.json.
//
// Read-only: it consumes the snapshot written by export.mjs and never touches Supabase.
// Re-running after a re-export is the intended workflow; every number in the report
// should be reproducible from `npm run analysis:aloha` (or `node analysis/aloha-2026/analyze.mjs`).
//
// The one non-obvious job is reconstructing a *plan* snapshot. `scheduled_time` is the last
// published time, i.e. the schedule after the live reflow has chased reality. To judge what
// the player was actually told, this replays desk_activity and rebuilds the published
// timetable as it stood at an instant. Only the scheduling actions move a match:
// court-moved, time-shifted and reset. started/reported carry the time for the audit trail
// but never change the plan.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(HERE, "tournament.json"), "utf8"));
const dataVN = JSON.parse(
  readFileSync(join(HERE, "..", "viet-nam-open-2026", "summary.json"), "utf8"),
);

const TZ = data.tournament.venue_timezone || "America/Chicago";
const MIN = 60_000;
const t = (value) => (value == null ? null : new Date(value).getTime());
const minutes = (from, to) => (t(to) - t(from)) / MIN;
const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;
const pct = (value) => round1(value * 100);

const LOCAL_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
const localDate = (iso) => LOCAL_DATE.format(new Date(iso));
const localClock = (iso) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
const localStamp = (iso) =>
  new Date(iso).toLocaleString("sv-SE", { timeZone: TZ, hour12: false }).replace("T", " ");

/** Local date + wall clock in TZ -> epoch ms. Handles the one DST rule the venue uses. */
function zoned(date, clock) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = clock.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  // Offset of the zone at that instant, measured the only portable way: format it back.
  const asLocal = new Date(guess);
  const shown = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(asLocal)
    .replace("T", " ");
  const [sd, sc] = shown.split(" ");
  const [sy, sm, sday] = sd.split("-").map(Number);
  const shownMs = Date.UTC(sy, sm - 1, sday, ...sc.split(":").map(Number));
  const offset = guess - shownMs;
  return guess + offset;
}

// ---------------------------------------------------------------------------------------------
// Lookups

const categoryById = new Map(data.categories.map((c) => [c.id, c]));
const categoryRank = new Map(data.categories.map((c, i) => [c.id, i]));
const courtById = new Map(data.courts.map((c) => [c.id, c]));
const teamById = new Map(data.teams.map((team) => [team.id, team]));
const playerById = new Map(data.players.map((p) => [p.id, p]));
const entrantById = new Map(data.entrants.map((e) => [e.id, e]));
const drawById = new Map(data.tier_draws.map((d) => [d.id, d]));

function teamLabel(team) {
  if (!team) return "";
  const one = playerById.get(team.player_1_id)?.name ?? "";
  const two = team.player_2_id ? playerById.get(team.player_2_id)?.name : null;
  return two ? `${one} / ${two}` : one;
}
const entrantLabel = (id) => {
  const entrant = entrantById.get(id);
  return entrant ? teamLabel(teamById.get(entrant.team_id)) : "";
};
const playerIdsOf = (entrantId) => {
  const entrant = entrantById.get(entrantId);
  const team = entrant ? teamById.get(entrant.team_id) : null;
  return team ? [team.player_1_id, team.player_2_id].filter(Boolean) : [];
};

// ---------------------------------------------------------------------------------------------
// Matches, normalised across the two tables

const matches = [
  ...data.matches.map((m) => ({
    id: m.id,
    table: "placement_matches",
    kind: "placement",
    createdAt: m.created_at,
    category: categoryById.get(m.category_id)?.code,
    stage: m.stage,
    key: m.generation_key,
    label: `${categoryById.get(m.category_id)?.code} ${m.stage} ${m.generation_key}`,
    courtId: m.court_id,
    scheduled: m.scheduled_time,
    started: m.started_at,
    ended: m.ended_at,
    status: m.status,
    slot: data.tournament.group_slot_minutes,
    entrantA: m.entrant_a_id,
    entrantB: m.entrant_b_id,
    prerequisites: m.prerequisite_ids ?? [],
    parents: [],
    round: null,
    draw: null,
    isMakeup: m.is_makeup,
    isCrossover: m.is_crossover,
    games: m.games ?? [],
  })),
  ...data.tier_draw_matches.map((m) => {
    const draw = drawById.get(m.draw_id);
    const category = draw ? categoryById.get(draw.category_id) : null;
    return {
      id: m.id,
      table: "tier_draw_matches",
      kind: "knockout",
      createdAt: m.created_at,
      category: category?.code,
      draw: draw?.tier,
      round: m.round,
      slotIndex: m.slot,
      stage: `r${m.round}`,
      key: `${draw?.tier ?? "?"}${m.round}-${m.slot}`,
      label: `${category?.code} ${draw?.tier} r${m.round} s${m.slot}`,
      courtId: m.court_id,
      scheduled: m.scheduled_time,
      started: m.started_at,
      ended: m.ended_at,
      status: m.status,
      slot: data.tournament.knockout_slot_minutes,
      entrantA: m.entrant_a_id,
      entrantB: m.entrant_b_id,
      prerequisites: [],
      parents: [m.parent_a_id, m.parent_b_id].filter(Boolean),
      isBye: m.is_bye || m.status === "bye",
      games: m.games ?? [],
    };
  }),
];

const byId = new Map(matches.map((m) => [m.id, m]));
const played = matches.filter((m) => m.started && m.ended);
const placements = matches.filter((m) => m.kind === "placement");
const knockouts = matches.filter((m) => m.kind === "knockout");

// ---------------------------------------------------------------------------------------------
// Replay: the published plan at an instant

const schedulingEvents = data.desk_activity
  .filter((row) => ["court-moved", "time-shifted", "reset"].includes(row.action))
  .sort((a, b) => t(a.occurred_at) - t(b.occurred_at) || a.id - b.id);

function planAt(instant) {
  const cut = t(instant);
  // A match enters the plan at its first scheduling event and not before: matches created
  // later (the knockout draws are built on day 2) must not appear in a day-1 snapshot.
  const state = new Map();
  for (const row of schedulingEvents) {
    if (t(row.occurred_at) > cut) break;
    const detail = row.details ?? {};
    const entry = state.get(row.match_id) ?? {
      time: detail.from_time ?? null,
      court: detail.from_court_id ?? null,
    };
    if (detail.to_time) entry.time = detail.to_time;
    if (detail.to_court_id) entry.court = detail.to_court_id;
    state.set(row.match_id, entry);
  }
  return state;
}

/** The courts actually assigned to a date; all courts when no assignment was recorded. */
function effectiveCourtsFor(date) {
  const day = data.days.find((row) => row.date === date);
  if (!day) return data.courts.length;
  const assigned = data.day_courts.filter((row) => row.day_id === day.id).length;
  return assigned || data.courts.length;
}

/** Plan rows joined back to the match, for matches the plan had not yet started. */
function planRows(instant) {
  const cut = t(instant);
  const state = planAt(instant);
  return matches
    .map((match) => {
      if (match.started && t(match.started) <= cut) return null;
      const entry = state.get(match.id);
      return entry?.time ? { ...match, planned: entry.time, plannedCourt: entry.court } : null;
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Statistics helpers

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return round1(sorted[index]);
}
function stats(values) {
  if (!values.length) return { n: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    mean: round1(sum / values.length),
    median: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    p95: quantile(values, 0.95),
    min: round1(Math.min(...values)),
    max: round1(Math.max(...values)),
    total: round1(sum),
  };
}

// ---------------------------------------------------------------------------------------------
// Plan feasibility and quality, evaluated per stage with slot-length durations

function evaluatePlan(rows, label) {
  const withTime = rows.filter((r) => r.planned);
  const byCourt = new Map();
  const byPlayer = new Map();
  for (const row of withTime) {
    const start = t(row.planned);
    const end = start + row.slot * MIN;
    const key = row.plannedCourt ?? "none";
    if (!byCourt.has(key)) byCourt.set(key, []);
    byCourt.get(key).push({ ...row, start, end });
    for (const player of [...playerIdsOf(row.entrantA), ...playerIdsOf(row.entrantB)]) {
      if (!byPlayer.has(player)) byPlayer.set(player, []);
      byPlayer.get(player).push({ ...row, start, end });
    }
  }

  const courtOverlaps = [];
  for (const [court, list] of byCourt) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i += 1) {
      if (list[i].start < list[i - 1].end) {
        courtOverlaps.push({
          court: courtById.get(court)?.number ?? court,
          a: list[i - 1].label,
          b: list[i].label,
          overlapMin: round1((list[i - 1].end - list[i].start) / MIN),
        });
      }
    }
  }

  const playerOverlaps = [];
  const restViolations = [];
  for (const [player, list] of byPlayer) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i += 1) {
      const previous = list[i - 1];
      const next = list[i];
      const gap = (next.start - previous.end) / MIN;
      if (gap < 0) {
        playerOverlaps.push({
          player: playerById.get(player)?.name,
          a: previous.label,
          b: next.label,
          overlapMin: round1(-gap),
        });
      } else {
        const required =
          next.kind === "knockout"
            ? data.tournament.knockout_rest_gap_minutes
            : data.tournament.group_rest_gap_minutes;
        if (gap + 1e-9 < required) {
          restViolations.push({
            player: playerById.get(player)?.name,
            a: previous.label,
            b: next.label,
            gapMin: round1(gap),
            required,
          });
        }
      }
    }
  }

  const dependencyViolations = [];
  for (const row of withTime) {
    if (!row.parents.length) continue;
    for (const parentId of row.parents) {
      const parent = byId.get(parentId);
      if (!parent) continue;
      if (!parent.ended) continue; // feeder not yet a real match; nothing to compare
      if (t(row.planned) < t(parent.ended)) {
        dependencyViolations.push({
          match: row.label,
          parent: parent.label,
          parentEnded: localStamp(parent.ended),
          planned: localStamp(row.planned),
          beforeMin: round1(minutes(row.planned, parent.ended)),
        });
      }
    }
  }

  const localDates = [...new Set(withTime.map((row) => localDate(row.planned)))].sort();
  const byDay = localDates.map((date) => {
    const day = withTime.filter((row) => localDate(row.planned) === date);
    const window = data.days.find((d) => d.date === date);
    const windowMinutes = window
      ? minutes(zoned(date, window.start_time), zoned(date, window.end_time))
      : null;
    const capacity = windowMinutes ? windowMinutes * effectiveCourtsFor(date) : null;
    const first = Math.min(...day.map((row) => t(row.planned)));
    const last = Math.max(...day.map((row) => t(row.planned) + row.slot * MIN));
    const used = day.reduce((sum, row) => sum + row.slot, 0);
    return {
      date,
      matches: day.length,
      firstLocal: localClock(new Date(first).toISOString()),
      lastEndLocal: localClock(new Date(last).toISOString()),
      windowLocal: window ? `${window.start_time.slice(0, 5)}–${window.end_time.slice(0, 5)}` : null,
      slotMinutes: used,
      capacityMinutes: capacity,
      utilisationPct: capacity ? pct(used / capacity) : null,
      outsideWindow: window
        ? day.filter(
            (row) =>
              t(row.planned) < zoned(date, window.start_time) ||
              t(row.planned) + row.slot * MIN > zoned(date, window.end_time),
          ).length
        : null,
    };
  });

  return {
    label,
    rowsWithTime: withTime.length,
    rowsWithoutTime: rows.length - withTime.length,
    unscheduledByKind: {
      placement: rows.filter((r) => r.kind === "placement" && !r.planned).length,
      knockout: rows.filter((r) => r.kind === "knockout" && !r.planned).length,
    },
    courtsInPlan: byCourt.size,
    firstStartLocal: withTime.length
      ? localStamp(new Date(Math.min(...withTime.map((r) => t(r.planned)))).toISOString())
      : null,
    lastEndLocal: withTime.length
      ? localStamp(
          new Date(
            Math.max(...withTime.map((r) => t(r.planned) + r.slot * MIN)),
          ).toISOString(),
        )
      : null,
    overlaps: {
      courtPairs: courtOverlaps.length,
      courtMinutes: round1(courtOverlaps.reduce((sum, row) => sum + row.overlapMin, 0)),
      playerPairs: playerOverlaps.length,
      playerMinutes: round1(playerOverlaps.reduce((sum, row) => sum + row.overlapMin, 0)),
      restViolations: restViolations.length,
      dependencyViolations: dependencyViolations.length,
    },
    examples: {
      courtOverlaps: courtOverlaps.slice(0, 3),
      playerOverlaps: playerOverlaps.slice(0, 3),
      restViolations: restViolations.slice(0, 3),
      dependencyViolations: dependencyViolations.slice(0, 3),
    },
    byDay,
  };
}

// ---------------------------------------------------------------------------------------------
// Actual execution

const daySummaries = data.days.map((day) => {
  const onDay = played.filter((m) => localDate(m.started) === day.date);
  const windowStart = zoned(day.date, day.start_time);
  const windowEnd = zoned(day.date, day.end_time);
  const windowMinutes = (windowEnd - windowStart) / MIN;
  const assignedCourtIds = data.day_courts
    .filter((row) => row.day_id === day.id)
    .map((row) => row.court_id);
  const effectiveCourtCount = assignedCourtIds.length || data.courts.length;
  const capacity = windowMinutes * effectiveCourtCount;
  const used = onDay.reduce((sum, m) => sum + minutes(m.started, m.ended), 0);
  const courtNumbers = data.courts.map((c) => c.id);
  const byCourt = courtNumbers.map((courtId) => {
    const list = onDay
      .filter((m) => m.courtId === courtId)
      .sort((a, b) => t(a.started) - t(b.started));
    const busy = list.reduce((sum, m) => sum + minutes(m.started, m.ended), 0);
    const gaps = [];
    for (let i = 1; i < list.length; i += 1) {
      gaps.push(round1(minutes(list[i - 1].ended, list[i].started)));
    }
    const leading = list.length ? round1(minutes(new Date(windowStart).toISOString(), list[0].started)) : null;
    const trailing = list.length
      ? round1(minutes(list.at(-1).ended, new Date(windowEnd).toISOString()))
      : null;
    return {
      court: courtById.get(courtId)?.number,
      matches: list.length,
      courtMinutes: round1(busy),
      firstStartLocal: list.length ? localClock(list[0].started) : null,
      lastEndLocal: list.length ? localClock(list.at(-1).ended) : null,
      gaps,
      gapCount: gaps.filter((gap) => gap > 1).length,
      gapMinutes: round1(gaps.filter((gap) => gap > 1).reduce((sum, gap) => sum + gap, 0)),
      largestGapMin: gaps.length ? Math.max(...gaps) : null,
      leadingIdleMin: leading,
      trailingIdleMin: trailing,
    };
  });
  const onCourt = onDay.flatMap((m) => [
    { at: t(m.started), delta: 1 },
    { at: t(m.ended), delta: -1 },
  ]);  onCourt.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let running = 0;
  let maxConcurrent = 0;
  const concurrency = [];
  for (const event of onCourt) {
    running += event.delta;
    maxConcurrent = Math.max(maxConcurrent, running);
    concurrency.push({ at: event.at, running });
  }
  const busyCourtMinutes = round1(used);
  return {
    date: day.date,
    windowLocal: `${day.start_time.slice(0, 5)}–${day.end_time.slice(0, 5)}`,
    windowMinutes,
    courts: data.courts.length,
    effectiveCourts: effectiveCourtCount,
    capacityMinutes: capacity,
    matches: onDay.length,
    byKind: {
      placement: onDay.filter((m) => m.kind === "placement").length,
      knockout: onDay.filter((m) => m.kind === "knockout").length,
    },
    firstStartLocal: onDay.length ? localClock(onDay.map((m) => m.started).sort()[0]) : null,
    lastStartLocal: onDay.length ? localClock(onDay.map((m) => m.started).sort().at(-1)) : null,
    lastEndLocal: onDay.length ? localClock(onDay.map((m) => m.ended).sort().at(-1)) : null,
    courtMinutes: busyCourtMinutes,
    utilisationPct: pct(busyCourtMinutes / capacity),
    activeSpanMinutes: onDay.length
      ? round1(minutes(onDay.map((m) => m.started).sort()[0], onDay.map((m) => m.ended).sort().at(-1)))
      : null,
    activeUtilisationPct: onDay.length
      ? pct(busyCourtMinutes / (minutes(onDay.map((m) => m.started).sort()[0], onDay.map((m) => m.ended).sort().at(-1)) * data.courts.length))
      : null,
    maxConcurrentCourts: maxConcurrent,
    meanConcurrentCourts: round1(
      onDay.reduce((sum, m) => sum + minutes(m.started, m.ended), 0) /
        (onDay.length ? minutes(onDay.map((m) => m.started).sort()[0], onDay.map((m) => m.ended).sort().at(-1)) : 1),
    ),
    courtsUsed: new Set(onDay.map((m) => m.courtId)).size,
    courts: byCourt,
    gaps: {
      leadingIdleMin: round1(
        byCourt.reduce((sum, row) => sum + (row.leadingIdleMin ?? 0), 0),
      ),
      trailingIdleMin: round1(
        byCourt.reduce((sum, row) => sum + (row.trailingIdleMin ?? 0), 0),
      ),
      betweenMatchesMin: round1(byCourt.reduce((sum, row) => sum + row.gapMinutes, 0)),
      betweenMatchesCount: byCourt.reduce((sum, row) => sum + row.gapCount, 0),
      largestMin: round1(Math.max(...byCourt.flatMap((row) => row.gaps), 0)),
    },
  };
});

// Duration / overrun per kind and category
const durationRows = [...new Set(matches.map((m) => m.category))].sort(
  (a, b) =>
    categoryRank.get(data.categories.find((c) => c.code === a)?.id) -
    categoryRank.get(data.categories.find((c) => c.code === b)?.id),
);
const durationByCategory = durationRows.map((code) => {
  const placement = placements.filter((m) => m.category === code && m.started && m.ended);
  const knockout = knockouts.filter((m) => m.category === code && m.started && m.ended);
  const pDur = placement.map((m) => minutes(m.started, m.ended));
  const kDur = knockout.map((m) => minutes(m.started, m.ended));
  return {
    category: code,
    placement: {
      played: pDur.length,
      ...stats(pDur),
      overrunMean: round1(pDur.reduce((sum, d) => sum + (d - data.tournament.group_slot_minutes), 0) / (pDur.length || 1)),
      overrunSharePct: pct(pDur.filter((d) => d > data.tournament.group_slot_minutes).length / (pDur.length || 1)),
    },
    knockout: {
      played: kDur.length,
      ...stats(kDur),
      overrunMean: round1(kDur.reduce((sum, d) => sum + (d - data.tournament.knockout_slot_minutes), 0) / (kDur.length || 1)),
      overrunSharePct: pct(kDur.filter((d) => d > data.tournament.knockout_slot_minutes).length / (kDur.length || 1)),
    },
  };
});

const allPlacementDurations = placements
  .filter((m) => m.started && m.ended)
  .map((m) => minutes(m.started, m.ended));
const allKnockoutDurations = knockouts
  .filter((m) => m.started && m.ended)
  .map((m) => minutes(m.started, m.ended));

// ---------------------------------------------------------------------------------------------
// Players: wait, rest, court changes

const perPlayer = new Map();
for (const match of played) {
  for (const player of new Set([
    ...playerIdsOf(match.entrantA),
    ...playerIdsOf(match.entrantB),
  ])) {
    if (!perPlayer.has(player)) perPlayer.set(player, []);
    perPlayer.get(player).push(match);
  }
}

const waits = [];
const restViolationsActual = [];
const playerSummaries = [];
for (const [player, list] of perPlayer) {
  list.sort((a, b) => t(a.started) - t(b.started));
  let courtChanges = 0;
  let waitTotal = 0;
  const gaps = [];
  for (let i = 1; i < list.length; i += 1) {
    const previous = list[i - 1];
    const next = list[i];
    if (localDate(previous.ended) !== localDate(next.started)) continue;
    const gap = minutes(previous.ended, next.started);
    gaps.push(gap);
    waits.push(gap);
    waitTotal += gap;
    if (previous.courtId !== next.courtId) courtChanges += 1;
    const required =
      next.kind === "knockout"
        ? data.tournament.knockout_rest_gap_minutes
        : data.tournament.group_rest_gap_minutes;
    if (gap < required - 1e-9) {
      restViolationsActual.push({
        player: playerById.get(player)?.name,
        from: previous.label,
        to: next.label,
        gapMin: round1(gap),
        required,
      });
    }
  }
  playerSummaries.push({
    player: playerById.get(player)?.name,
    matches: list.length,
    categories: [...new Set(list.map((m) => m.category))].join("/"),
    waitTotal: round1(waitTotal),
    minGap: gaps.length ? round1(Math.min(...gaps)) : null,
    maxGap: gaps.length ? round1(Math.max(...gaps)) : null,
    courtChanges,
    restViolations: gaps.filter((gap, index) => {
      const next = list[index + 1];
      const required =
        next.kind === "knockout"
          ? data.tournament.knockout_rest_gap_minutes
          : data.tournament.group_rest_gap_minutes;
      return gap < required - 1e-9;
    }).length,
  });
}

const playerLoads = [...perPlayer.values()].map((list) => list.length);

// Court changes per player between consecutive same-day matches, and total.
const totalCourtChanges = playerSummaries.reduce((sum, row) => sum + row.courtChanges, 0);

// ---------------------------------------------------------------------------------------------
// Churn: how often the published plan moved, and how close to the start

const firstStartAt = Math.min(...played.map((m) => t(m.started)));
const liveSchedulingEvents = data.desk_activity.filter(
  (row) =>
    t(row.occurred_at) > firstStartAt &&
    ["court-moved", "time-shifted", "reset"].includes(row.action),
);
const courtOverlapsActual = (() => {
  const byCourt = new Map();
  for (const match of played) {
    if (!match.courtId) continue;
    if (!byCourt.has(match.courtId)) byCourt.set(match.courtId, []);
    byCourt.get(match.courtId).push(match);
  }
  const overlaps = [];
  for (const [court, list] of byCourt) {
    list.sort((a, b) => t(a.started) - t(b.started));
    for (let i = 1; i < list.length; i += 1) {
      if (t(list[i].started) < t(list[i - 1].ended)) {
        overlaps.push({
          court: courtById.get(court)?.number,
          a: list[i - 1].label,
          b: list[i].label,
          overlapMin: round1(minutes(list[i].started, list[i - 1].ended)),
        });
      }
    }
  }
  return overlaps;
})();

const churnPerMatch = new Map();
for (const row of data.desk_activity) {
  const live = t(row.occurred_at) > firstStartAt;
  if (!churnPerMatch.has(row.match_id)) {
    churnPerMatch.set(row.match_id, {
      shifts: 0,
      movedMinutes: 0,
      moves: 0,
      liveShifts: 0,
      liveMovedMinutes: 0,
      times: new Set(),
    });
  }
  const entry = churnPerMatch.get(row.match_id);
  const detail = row.details ?? {};
  if (row.action === "time-shifted" && detail.from_time && detail.to_time) {
    const delta = Math.abs(minutes(detail.from_time, detail.to_time));
    entry.shifts += 1;
    entry.movedMinutes += delta;
    if (live) {
      entry.liveShifts += 1;
      entry.liveMovedMinutes += delta;
    }
    entry.times.add(detail.to_time);
  }
  if (row.action === "court-moved") {
    entry.moves += 1;
    if (detail.to_time) entry.times.add(detail.to_time);
  }
}

const nearStartChanges = [];
for (const row of data.desk_activity) {
  if (row.action !== "time-shifted") continue;
  const detail = row.details ?? {};
  if (!detail.from_time || !detail.to_time) continue;
  const match = byId.get(row.match_id);
  if (!match?.started) continue;
  const delta = minutes(detail.from_time, detail.to_time);
  if (Math.abs(delta) < 1) continue;
  const beforeStart = minutes(row.occurred_at, match.started);
  if (beforeStart >= 0 && beforeStart <= 30) {
    nearStartChanges.push({
      match: match.label,
      atLocal: localStamp(row.occurred_at),
      minutesBeforeStart: round1(beforeStart),
      pushMin: round1(delta),
    });
  }
}

const bursts = (() => {
  const groups = new Map();
  for (const row of data.desk_activity) {
    if (!["time-shifted", "court-moved"].includes(row.action)) continue;
    const key = `${row.occurred_at}|${row.action}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length >= 20)
    .map(([key, rows]) => {
      const [at, action] = key.split("|");
      const pushes = rows
        .map((row) =>
          row.details?.from_time && row.details?.to_time
            ? minutes(row.details.from_time, row.details.to_time)
            : null,
        )
        .filter((value) => value != null && Number.isFinite(value) && Math.abs(value) < 24 * 60);
      return {
        atLocal: localStamp(at),
        date: localDate(at),
        action,
        matches: new Set(rows.map((row) => row.match_id)).size,
        rows: rows.length,
        totalPushedMin: round1(pushes.reduce((sum, value) => sum + Math.abs(value), 0)),
        largestPushMin: pushes.length ? round1(Math.max(...pushes.map(Math.abs))) : null,
      };
    })
    .sort((a, b) => a.atLocal.localeCompare(b.atLocal));
})();

const finalScheduleVsDayStart = (() => {
  const startOfDay1 = planAt(new Date(zoned("2026-10-26", "12:29")).toISOString());
  const startOfDay2 = planAt(new Date(zoned("2026-10-27", "09:55")).toISOString());
  const rows = [];
  for (const match of played) {
    if (!match.scheduled) continue;
    const before =
      localDate(match.started) === "2026-10-26" ? startOfDay1.get(match.id) : startOfDay2.get(match.id);
    if (!before?.time) continue;
    rows.push({
      match: match.label,
      kind: match.kind,
      plannedLocal: localStamp(before.time),
      publishedLocal: localStamp(match.scheduled),
      startedLocal: localStamp(match.started),
      movedMin: round1(minutes(before.time, match.scheduled)),
      courtChanged: before.court && match.courtId ? before.court !== match.courtId : null,
    });
  }
  return rows;
})();

// ---------------------------------------------------------------------------------------------
// Notice: how long before the start the player was given the time they actually played

const schedulingById = new Map();
for (const row of schedulingEvents) {
  if (!schedulingById.has(row.match_id)) schedulingById.set(row.match_id, []);
  schedulingById.get(row.match_id).push(row);
}

const noticeRows = [];
for (const match of matches) {
  if (!match.started || !match.scheduled) continue;
  const events = (schedulingById.get(match.id) ?? []).filter((row) => row.details?.to_time);
  const finalMinute = Math.floor(t(match.scheduled) / MIN);
  // When the time that was actually played was first published.
  const firstFinal = events.find((row) => Math.floor(t(row.details.to_time) / MIN) === finalMinute);
  // When the match first appeared on the board at all.
  const firstPublishedAt = events.length ? t(events[0].occurred_at) : t(match.createdAt);
  const publishedAt = firstFinal ? t(firstFinal.occurred_at) : t(match.createdAt);
  // The last time the published time changed at all before the start.
  const changes = events
    .filter(
      (row) =>
        t(row.occurred_at) <= t(match.started) &&
        row.details.from_time &&
        Math.abs(minutes(row.details.from_time, row.details.to_time)) >= 1,
    )
    .sort((a, b) => t(a.occurred_at) - t(b.occurred_at));
  const lastChange = changes.at(-1);
  noticeRows.push({
    match: match.label,
    kind: match.kind,
    date: localDate(match.started),
    firstNoticeMin: round1((t(match.started) - firstPublishedAt) / MIN),
    noticeMin: round1((t(match.started) - publishedAt) / MIN),
    minutesSinceLastChange: lastChange ? round1((t(match.started) - t(lastChange.occurred_at)) / MIN) : null,
    timeChanges: changes.length,
  });
}

const notice = {
  matches: noticeRows.length,
  firstNotice: stats(noticeRows.map((row) => row.firstNoticeMin)),
  notice: stats(noticeRows.map((row) => row.noticeMin)),
  under5Min: noticeRows.filter((row) => row.noticeMin < 5).length,
  under15Min: noticeRows.filter((row) => row.noticeMin < 15).length,
  under30Min: noticeRows.filter((row) => row.noticeMin < 30).length,
  sinceLastChange: stats(
    noticeRows.map((row) => row.minutesSinceLastChange).filter((value) => value != null),
  ),
  lastChangeUnder5Min: noticeRows.filter(
    (row) => row.minutesSinceLastChange != null && row.minutesSinceLastChange < 5,
  ).length,
  lastChangeUnder15Min: noticeRows.filter(
    (row) => row.minutesSinceLastChange != null && row.minutesSinceLastChange < 15,
  ).length,
  tightest: [...noticeRows].sort((a, b) => a.noticeMin - b.noticeMin).slice(0, 8),
  byDay: [...new Set(noticeRows.map((row) => row.date))].map((date) => {
    const rows = noticeRows.filter((row) => row.date === date);
    return {
      date,
      matches: rows.length,
      medianNoticeMin: quantile(rows.map((row) => row.noticeMin), 0.5),
      medianFirstNoticeMin: quantile(rows.map((row) => row.firstNoticeMin), 0.5),
      under15Min: rows.filter((row) => row.noticeMin < 15).length,
    };
  }),
};

// ---------------------------------------------------------------------------------------------
// Stage progression

const stageGroups = new Map();
function stageKey(m) {
  return m.kind === "placement" ? `${m.category} ${m.stage}` : `${m.category} draw ${m.draw} r${m.round}`;
}
for (const match of played) {
  const key = stageKey(match);
  if (!stageGroups.has(key)) stageGroups.set(key, []);
  stageGroups.get(key).push(match);
}
const stages = [...stageGroups.entries()]
  .map(([stage, list]) => ({
    stage,
    matches: list.length,
    firstStartLocal: localClock(list.map((m) => m.started).sort()[0]),
    firstStartDate: localDate(list.map((m) => m.started).sort()[0]),
    lastEndLocal: localClock(list.map((m) => m.ended).sort().at(-1)),
    lastEndDate: localDate(list.map((m) => m.ended).sort().at(-1)),
    spanMin: round1(minutes(list.map((m) => m.started).sort()[0], list.map((m) => m.ended).sort().at(-1))),
    courtMinutes: round1(list.reduce((sum, m) => sum + minutes(m.started, m.ended), 0)),
    meanDuration: round1(
      list.reduce((sum, m) => sum + minutes(m.started, m.ended), 0) / list.length,
    ),
  }))
  .sort((a, b) => `${a.firstStartDate} ${a.firstStartLocal}`.localeCompare(`${b.firstStartDate} ${b.firstStartLocal}`));

// Knockout wait for feeders: when a dependent started relative to the later feeder's end.
const feederWaits = [];
for (const match of knockouts) {
  if (!match.parents.length || !match.started) continue;
  const parents = match.parents.map((id) => byId.get(id)).filter((parent) => parent?.ended);
  if (parents.length !== match.parents.length) continue;
  const readyAt = parents.map((parent) => t(parent.ended)).sort().at(-1);
  feederWaits.push({
    match: match.label,
    readyLocal: localStamp(new Date(readyAt).toISOString()),
    startLocal: localStamp(match.started),
    waitMin: round1((t(match.started) - readyAt) / MIN),
    publishedWaitMin: match.scheduled ? round1((t(match.scheduled) - readyAt) / MIN) : null,
  });
}

// Byes and bracket efficiency
const drawRows = data.tier_draws.map((draw) => {
  const list = knockouts.filter((m) => m.draw === draw.tier && m.category === categoryById.get(draw.category_id)?.code);
  return {
    category: categoryById.get(draw.category_id)?.code,
    draw: draw.tier,
    bracketSize: draw.bracket_size,
    entrants: draw.entrant_count,
    byes: list.filter((m) => m.isBye).length,
    played: list.filter((m) => m.started).length,
    byePctOfBracket: pct(list.filter((m) => m.isBye).length / (list.length || 1)),
  };
});

// ---------------------------------------------------------------------------------------------
// Comparison with the completed Viet Nam Open snapshot

const comparison = {
  aloha: {
    name: data.tournament.name,
    status: data.tournament.status,
    entrants: data.entrants.length,
    matchesPlayed: played.length,
    days: data.days.length,
    courts: data.courts.length,
    courtMinutes: round1(played.reduce((sum, m) => sum + minutes(m.started, m.ended), 0)),
    capacityMinutes: daySummaries.reduce((sum, day) => sum + day.capacityMinutes, 0),
    utilisationPct: pct(
      played.reduce((sum, m) => sum + minutes(m.started, m.ended), 0) /
        daySummaries.reduce((sum, day) => sum + day.capacityMinutes, 0),
    ),
    playerWaitTotal: round1(waits.reduce((sum, gap) => sum + gap, 0)),
    playerWaitP95: quantile(waits, 0.95),
    playerWaitMedian: quantile(waits, 0.5),
    restViolations: restViolationsActual.length,
    placementMeanDuration: round1(
      allPlacementDurations.reduce((a, b) => a + b, 0) / (allPlacementDurations.length || 1),
    ),
    knockoutMeanDuration: round1(
      allKnockoutDurations.reduce((a, b) => a + b, 0) / (allKnockoutDurations.length || 1),
    ),
  },
  vietNamOpen: {
    name: dataVN.source.name,
    matchesPlayed: dataVN.total.matchesPlayed,
    courts: dataVN.settings.courts,
    courtMinutes: dataVN.total.courtMinutes,
    capacityMinutes: dataVN.total.courtCapacityMinutes,
    utilisationPct: pct(dataVN.total.utilization),
    playerWaitMedian: dataVN.restGaps?.medianMin ?? null,
    playerWaitTurnarounds: dataVN.restGaps?.sameDayPlayerTurnarounds ?? null,
    restUnder10: dataVN.restGaps?.underTenMinutes ?? null,
    placementMeanDuration: dataVN.stages?.placement?.duration?.meanMin ?? null,
    knockoutMeanDuration: dataVN.stages?.knockout?.duration?.meanMin ?? null,
  },
};

// ---------------------------------------------------------------------------------------------
// Assemble

const totals = {
  matchesScheduled: matches.filter((m) => m.scheduled).length,
  matchesPlayed: played.length,
  placementPlayed: placements.filter((m) => m.started).length,
  knockoutPlayed: knockouts.filter((m) => m.started).length,
  byes: knockouts.filter((m) => m.isBye).length,
  inProgress: matches.filter((m) => m.started && !m.ended).length,
  courts: data.courts.length,
  dayWindows: data.days.map((d) => `${d.date} ${d.start_time.slice(0, 5)}–${d.end_time.slice(0, 5)}`),
  capacityMinutes: daySummaries.reduce((sum, day) => sum + day.capacityMinutes, 0),
  courtMinutes: round1(played.reduce((sum, m) => sum + minutes(m.started, m.ended), 0)),
};

const metrics = {
  generatedAt: new Date().toISOString(),
  source: { tournament: data.tournament.name, id: data.tournament.id, exportedAt: data.exportedAt },
  totals,
  utilisationPct: pct(totals.courtMinutes / totals.capacityMinutes),
  settings: {
    venueTimezone: TZ,
    placementSlot: data.tournament.group_slot_minutes,
    placementRest: data.tournament.group_rest_gap_minutes,
    knockoutSlot: data.tournament.knockout_slot_minutes,
    knockoutRest: data.tournament.knockout_rest_gap_minutes,
    maxCategoriesPerPlayer: data.tournament.max_categories_per_player,
  },
  days: daySummaries,
  durations: {
    placement: {
      ...stats(allPlacementDurations),
      overrunMean:
        round1(
          allPlacementDurations.reduce((sum, d) => sum + (d - data.tournament.group_slot_minutes), 0) /
            (allPlacementDurations.length || 1),
        ),
      overrunSharePct: pct(
        allPlacementDurations.filter((d) => d > data.tournament.group_slot_minutes).length /
          (allPlacementDurations.length || 1),
      ),
      impliedSlot: quantile(allPlacementDurations, 0.9),
    },
    knockout: {
      ...stats(allKnockoutDurations),
      overrunMean:
        round1(
          allKnockoutDurations.reduce((sum, d) => sum + (d - data.tournament.knockout_slot_minutes), 0) /
            (allKnockoutDurations.length || 1),
        ),
      overrunSharePct: pct(
        allKnockoutDurations.filter((d) => d > data.tournament.knockout_slot_minutes).length /
          (allKnockoutDurations.length || 1),
      ),
      impliedSlot: quantile(allKnockoutDurations, 0.9),
    },
    byCategory: durationByCategory,
  },
  plans: {
    day1: evaluatePlan(planRows(new Date(zoned("2026-10-26", "12:29")).toISOString()), "day 1 at 12:29 (round 1 published)"),
    day1Rebuild: evaluatePlan(planRows(new Date(zoned("2026-10-26", "13:29")).toISOString()), "day 1 at 13:29 (round 2 inserted)"),
    day2: evaluatePlan(planRows(new Date(zoned("2026-10-27", "09:55")).toISOString()), "day 2 at 09:55"),
    day2Mid: evaluatePlan(planRows(new Date(zoned("2026-10-27", "13:00")).toISOString()), "day 2 at 13:00"),
  },
  planSnapshots: {
    day1: planRows(new Date(zoned("2026-10-26", "12:29")).toISOString()).map((row) => ({
      id: row.id,
      planned: row.planned,
      courtId: row.plannedCourt,
    })),
    day2: planRows(new Date(zoned("2026-10-27", "09:55")).toISOString()).map((row) => ({
      id: row.id,
      planned: row.planned,
      courtId: row.plannedCourt,
    })),
  },
  execution: {
    courtOverlaps: courtOverlapsActual,
    courtOverlapCount: courtOverlapsActual.length,
    restViolationCount: restViolationsActual.length,
    restViolations: restViolationsActual,
    inProgress: matches
      .filter((m) => m.started && !m.ended)
      .map((m) => ({ match: m.label, startedLocal: localStamp(m.started) })),
    notStarted: matches
      .filter((m) => !m.started && m.status !== "bye")
      .map((m) => ({
        match: m.label,
        status: m.status,
        scheduledLocal: m.scheduled ? localStamp(m.scheduled) : null,
      })),
  },
  players: {
    distinct: perPlayer.size,
    matchesPerPlayer: stats(playerLoads),
    waitGaps: stats(waits),
    sameDayTurnarounds: waits.length,
    underFiveMin: waits.filter((gap) => gap < 5).length,
    underTenMin: waits.filter((gap) => gap < 10).length,
    underThirtyMin: waits.filter((gap) => gap < 30).length,
    restViolations: restViolationsActual,
    restViolationCount: restViolationsActual.length,
    courtChangesBetweenMatches: totalCourtChanges,
    playersWithMaxCategories: [...perPlayer.entries()].filter(([, list]) => new Set(list.map((m) => m.category)).size >= data.tournament.max_categories_per_player).length,
  },
  churn: {
    timeShiftRows: data.desk_activity.filter((row) => row.action === "time-shifted").length,
    courtMoveRows: data.desk_activity.filter((row) => row.action === "court-moved").length,
    liveSchedulingEvents: liveSchedulingEvents.length,
    liveTimeShifts: liveSchedulingEvents.filter((row) => row.action === "time-shifted").length,
    liveCourtMoves: liveSchedulingEvents.filter((row) => row.action === "court-moved").length,
    firstStartLocal: localStamp(new Date(firstStartAt).toISOString()),
    byDay: data.days.map((day) => {
      const rows = data.desk_activity.filter((row) => localDate(row.occurred_at) === day.date);
      return {
        date: day.date,
        timeShifts: rows.filter((row) => row.action === "time-shifted").length,
        courtMoves: rows.filter((row) => row.action === "court-moved").length,
        started: rows.filter((row) => row.action === "started").length,
        reported: rows.filter((row) => row.action === "reported").length,
      };
    }),
    perMatch: (() => {
      const vals = [...churnPerMatch.values()];
      return {
        matches: vals.length,
        shifts: stats(vals.map((v) => v.shifts)),
        movedMinutes: stats(vals.map((v) => v.movedMinutes)),
        courtMoves: stats(vals.map((v) => v.moves)),
        maxShifts: Math.max(...vals.map((v) => v.shifts)),
        maxMovedMinutes: round1(Math.max(...vals.map((v) => v.movedMinutes))),
        liveShifts: stats(vals.map((v) => v.liveShifts)),
        liveMovedMinutes: stats(vals.map((v) => v.liveMovedMinutes)),
        liveMaxMovedMinutes: round1(Math.max(...vals.map((v) => v.liveMovedMinutes))),
        liveMaxShifts: Math.max(...vals.map((v) => v.liveShifts)),
      };
    })(),
    nearStart: {
      count: nearStartChanges.length,
      matches: new Set(nearStartChanges.map((row) => row.match)).size,
      examples: nearStartChanges.sort((a, b) => b.pushMin - a.pushMin).slice(0, 8),
      pushes: stats(nearStartChanges.map((row) => row.pushMin)),
    },
    bursts,
    finalVsDayStart: {
      matches: finalScheduleVsDayStart.length,
      movedOverOneHour: finalScheduleVsDayStart.filter((row) => Math.abs(row.movedMin) >= 60).length,
      movedLater: finalScheduleVsDayStart.filter((row) => row.movedMin > 1).length,
      courtChanged: finalScheduleVsDayStart.filter((row) => row.courtChanged).length,
      movedMinutes: stats(finalScheduleVsDayStart.map((row) => row.movedMin)),
      examples: finalScheduleVsDayStart
        .map((row) => ({ ...row }))
        .sort((a, b) => b.movedMin - a.movedMin)
        .slice(0, 8),
    },
  },
  stages,
  notice,
  feederWaits: {
    samples: feederWaits.length,
    ...stats(feederWaits.map((row) => row.waitMin)),
    underTenMin: feederWaits.filter((row) => row.waitMin < 10).length,
    underThirtyMin: feederWaits.filter((row) => row.waitMin < 30).length,
    tightest: [...feederWaits].sort((a, b) => a.waitMin - b.waitMin).slice(0, 5),
    longest: [...feederWaits].sort((a, b) => b.waitMin - a.waitMin).slice(0, 8),
  },
  draws: drawRows,
  comparison,
};

writeFileSync(join(HERE, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");

console.log(
  JSON.stringify(
    {
      planDay1: metrics.plans.day1,
      planDay2: metrics.plans.day2,
      days: metrics.days.map((d) => ({
        date: d.date,
        utilisationPct: d.utilisationPct,
        matches: d.matches,
        firstStartLocal: d.firstStartLocal,
        lastEndLocal: d.lastEndLocal,
        gaps: d.gaps,
        maxConcurrentCourts: d.maxConcurrentCourts,
      })),
      durations: metrics.durations.placement,
      knockoutDurations: metrics.durations.knockout,
      players: {
        distinct: metrics.players.distinct,
        waitGaps: metrics.players.waitGaps,
        restViolationCount: metrics.players.restViolationCount,
      },
      churn: metrics.churn,
      feederWaits: metrics.feederWaits,
      utilisationPct: metrics.utilisationPct,
      comparison: metrics.comparison,
    },
    null,
    1,
  ),
);
