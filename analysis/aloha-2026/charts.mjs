#!/usr/bin/env node
// Draws the report's figures from tournament.json + metrics.json. No dependencies.
//
// The timelines deliberately overlay two schedules: the plan as published on the morning of
// the day (hollow bar) and what actually happened (solid bar). Where the hollow bar has no
// solid bar over it, the plan was not followed; where a solid bar has no hollow bar, the match
// was not in the morning's plan at all.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(HERE, "tournament.json"), "utf8"));
const metrics = JSON.parse(readFileSync(join(HERE, "metrics.json"), "utf8"));
const TZ = data.tournament.venue_timezone || "America/Chicago";
const MIN = 60_000;
const t = (value) => new Date(value).getTime();

function zoned(date, clock) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = clock.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const shown = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(guess))
    .replace("T", " ");
  const [sd, sc] = shown.split(" ");
  const [sy, sm, sday] = sd.split("-").map(Number);
  return guess + (guess - Date.UTC(sy, sm - 1, sday, ...sc.split(":").map(Number)));
}

const localClock = (ms) =>
  new Date(ms).toLocaleTimeString("en-GB", {
    timeZone: TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
const localDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms));

const courtById = new Map(data.courts.map((c) => [c.id, c.number]));
const categoryById = new Map(data.categories.map((c) => [c.id, c.code]));
const drawById = new Map(data.tier_draws.map((d) => [d.id, d]));

const matches = [
  ...data.matches.map((m) => ({
    id: m.id,
    kind: "placement",
    label: `${categoryById.get(m.category_id)} ${m.stage} ${m.generation_key}`,
    courtId: m.court_id,
    scheduled: m.scheduled_time,
    started: m.started_at,
    ended: m.ended_at,
    status: m.status,
    slot: data.tournament.group_slot_minutes,
  })),
  ...data.tier_draw_matches.map((m) => {
    const draw = drawById.get(m.draw_id);
    return {
      id: m.id,
      kind: "knockout",
      label: `${categoryById.get(draw?.category_id)} ${draw?.tier} r${m.round} s${m.slot}`,
      courtId: m.court_id,
      scheduled: m.scheduled_time,
      started: m.started_at,
      ended: m.ended_at,
      status: m.status,
      slot: data.tournament.knockout_slot_minutes,
    };
  }),
];
const byId = new Map(matches.map((m) => [m.id, m]));

const COLORS = { placement: "#2563eb", knockout: "#ea580c", plan: "#94a3b8" };

function esc(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

function timeline(day, planRows, title, filename) {
  const windowStart = zoned(day.date, day.start_time);
  const windowEnd = zoned(day.date, day.end_time);
  const t0 = windowStart - 10 * MIN;
  const t1 = windowEnd + 5 * MIN;
  const width = 1360;
  const left = 74;
  const right = 22;
  const top = 78;
  const rowH = 28;
  const rowGap = 5;
  const plotW = width - left - right;
  const courtCount = data.courts.length;
  const height = top + courtCount * (rowH + rowGap) + 46;
  const x = (ms) => left + ((Math.min(Math.max(ms, t0), t1) - t0) / (t1 - t0)) * plotW;

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Helvetica, Arial, sans-serif">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="${left}" y="28" font-size="18" font-weight="600" fill="#0f172a">${esc(title)}</text>`);
  parts.push(`<text x="${left}" y="48" font-size="12" fill="#475569">Hollow bar = plan published that morning · solid bar = actual play · blue = placement · orange = knockout</text>`);
  // Legend
  parts.push(`<rect x="${width - right - 300}" y="16" width="12" height="10" fill="none" stroke="${COLORS.plan}" stroke-width="1.5"/>`);
  parts.push(`<text x="${width - right - 284}" y="25" font-size="11" fill="#475569">planned</text>`);
  parts.push(`<rect x="${width - right - 222}" y="16" width="12" height="10" fill="${COLORS.placement}"/>`);
  parts.push(`<text x="${width - right - 206}" y="25" font-size="11" fill="#475569">placement</text>`);
  parts.push(`<rect x="${width - right - 128}" y="16" width="12" height="10" fill="${COLORS.knockout}"/>`);
  parts.push(`<text x="${width - right - 112}" y="25" font-size="11" fill="#475569">knockout</text>`);

  // Window band
  parts.push(`<rect x="${x(windowStart)}" y="${top - 8}" width="${x(windowEnd) - x(windowStart)}" height="${courtCount * (rowH + rowGap) + 4}" fill="#f8fafc"/>`);

  // Hour grid
  const firstTick = Math.ceil((t0 + 1) / (30 * MIN)) * 30 * MIN;
  for (let at = firstTick; at <= t1; at += 30 * MIN) {
    const hour = (at - zoned(day.date, "00:00")) % (60 * MIN) === 0;
    parts.push(
      `<line x1="${x(at)}" y1="${top - 8}" x2="${x(at)}" y2="${top + courtCount * (rowH + rowGap) - 6}" stroke="${hour ? "#e2e8f0" : "#f1f5f9"}" stroke-width="1"/>`,
    );
    if (hour) {
      parts.push(`<text x="${x(at)}" y="${top - 14}" font-size="11" fill="#64748b" text-anchor="middle">${localClock(at)}</text>`);
    }
  }

  // Plan bars, behind the actual ones
  const planById = new Map(planRows.map((row) => [row.id, row]));
  for (const row of planRows) {
    const match = byId.get(row.id);
    if (!match) continue;
    const courtNumber = courtById.get(row.courtId);
    if (!courtNumber) continue;
    const y = top + (courtNumber - 1) * (rowH + rowGap);
    const start = t(row.planned);
    const barW = Math.max(1.5, (match.slot * MIN) / (t1 - t0) * plotW);
    parts.push(
      `<rect x="${x(start)}" y="${y}" width="${barW}" height="${rowH}" fill="none" stroke="${COLORS.plan}" stroke-width="1.3" rx="2"><title>${esc(match.label)} planned ${localClock(start)}</title></rect>`,
    );
  }

  // Court labels + actual bars
  for (let court = 1; court <= courtCount; court += 1) {
    const y = top + (court - 1) * (rowH + rowGap);
    parts.push(`<text x="${left - 12}" y="${y + rowH / 2 + 4}" font-size="12" fill="#334155" text-anchor="end">Court ${court}</text>`);
    parts.push(`<line x1="${left}" y1="${y + rowH}" x2="${left + plotW}" y2="${y + rowH}" stroke="#f1f5f9"/>`);
  }
  for (const match of matches) {
    if (!match.started) continue;
    if (localDate(t(match.started)) !== day.date) continue;
    const courtNumber = courtById.get(match.courtId);
    if (!courtNumber) continue;
    const y = top + (courtNumber - 1) * (rowH + rowGap) + 4;
    const start = t(match.started);
    const end = match.ended ? t(match.ended) : start + match.slot * MIN;
    const barW = Math.max(2, ((end - start) / (t1 - t0)) * plotW);
    parts.push(
      `<rect x="${x(start)}" y="${y}" width="${barW}" height="${rowH - 8}" fill="${COLORS[match.kind]}" fill-opacity="${match.ended ? 0.92 : 0.55}" rx="2"><title>${esc(match.label)} · ${localClock(start)}–${match.ended ? localClock(end) : "in progress"} (${Math.round((end - start) / MIN)} min)</title></rect>`,
    );
  }

  parts.push(`<text x="${left}" y="${height - 16}" font-size="11" fill="#64748b">${day.date} · configured window ${day.start_time.slice(0, 5)}–${day.end_time.slice(0, 5)} · ${data.courts.length} courts</text>`);
  parts.push("</svg>");
  writeFileSync(join(HERE, filename), parts.join("\n") + "\n");
}

const planRowsFor = (date) =>
  metrics.planSnapshots[date === "2026-10-26" ? "day1" : "day2"] ?? [];

for (const day of data.days) {
  const label =
    day.date === "2026-10-26"
      ? "Day 1 — round 1 plan vs actual play"
      : "Day 2 — morning plan vs actual play";
  timeline(day, planRowsFor(day.date), label, `timeline-${day.date}.svg`);
}

// ---------------------------------------------------------------------------------------------
// Duration distribution

function histogram() {
  const binSize = 2;
  const maxMinute = 40;
  const bins = Array.from({ length: maxMinute / binSize }, (_, index) => ({
    from: index * binSize,
    placement: 0,
    knockout: 0,
  }));
  const add = (kind, values) => {
    for (const value of values) {
      const index = Math.min(bins.length - 1, Math.max(0, Math.floor(value / binSize)));
      bins[index][kind] += 1;
    }
  };
  add("placement", data.matches.filter((m) => m.started_at && m.ended_at).map((m) => (t(m.ended_at) - t(m.started_at)) / MIN));
  add("knockout", data.tier_draw_matches.filter((m) => m.started_at && m.ended_at).map((m) => (t(m.ended_at) - t(m.started_at)) / MIN));

  const width = 900;
  const height = 360;
  const left = 54;
  const right = 18;
  const top = 58;
  const bottom = 44;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const maxCount = Math.max(...bins.map((bin) => Math.max(bin.placement, bin.knockout)));
  const barW = plotW / bins.length;
  const y = (count) => top + plotH - (count / maxCount) * plotH;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Helvetica, Arial, sans-serif">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="${left}" y="26" font-size="17" font-weight="600" fill="#0f172a">Actual match length vs configured slot</text>`);
  parts.push(`<text x="${left}" y="44" font-size="12" fill="#475569">${metrics.durations.placement.n} placement matches (slot ${data.tournament.group_slot_minutes} min) and ${metrics.durations.knockout.n} knockout matches (slot ${data.tournament.knockout_slot_minutes} min)</text>`);
  for (let count = 0; count <= maxCount; count += Math.ceil(maxCount / 4)) {
    parts.push(`<line x1="${left}" y1="${y(count)}" x2="${width - right}" y2="${y(count)}" stroke="#f1f5f9"/>`);
    parts.push(`<text x="${left - 8}" y="${y(count) + 4}" font-size="10" fill="#64748b" text-anchor="end">${count}</text>`);
  }
  bins.forEach((bin, index) => {
    const baseX = left + index * barW;
    const half = (barW - 2) / 2;
    parts.push(`<rect x="${baseX}" y="${y(bin.placement)}" width="${half}" height="${top + plotH - y(bin.placement)}" fill="${COLORS.placement}" fill-opacity="0.85"><title>${bin.from}–${bin.from + binSize} min: ${bin.placement} placement</title></rect>`);
    parts.push(`<rect x="${baseX + half}" y="${y(bin.knockout)}" width="${half}" height="${top + plotH - y(bin.knockout)}" fill="${COLORS.knockout}" fill-opacity="0.85"><title>${bin.from}–${bin.from + binSize} min: ${bin.knockout} knockout</title></rect>`);
  });
  const slotX = (minutes) => left + (minutes / maxMinute) * plotW;
  for (const [minutes, colour, text] of [
    [data.tournament.group_slot_minutes, COLORS.placement, "placement slot"],
    [data.tournament.knockout_slot_minutes, COLORS.knockout, "knockout slot"],
  ]) {
    parts.push(`<line x1="${slotX(minutes)}" y1="${top - 6}" x2="${slotX(minutes)}" y2="${top + plotH}" stroke="${colour}" stroke-width="1.6" stroke-dasharray="5 4"/>`);
    parts.push(`<text x="${slotX(minutes) + 4}" y="${top - 8}" font-size="10" fill="${colour}">${text}</text>`);
  }
  for (let minute = 0; minute <= maxMinute; minute += 4) {
    parts.push(`<text x="${left + (minute / maxMinute) * plotW}" y="${height - 16}" font-size="10" fill="#64748b" text-anchor="middle">${minute}</text>`);
  }
  parts.push(`<text x="${left + plotW / 2}" y="${height - 2}" font-size="11" fill="#475569" text-anchor="middle">minutes</text>`);
  parts.push("</svg>");
  writeFileSync(join(HERE, "durations.svg"), parts.join("\n") + "\n");
}

histogram();

console.log("Wrote timeline-2026-10-26.svg, timeline-2026-10-27.svg, durations.svg");
