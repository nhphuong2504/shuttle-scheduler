/**
 * Time helpers shared by the core: window normalization, break avoidance and the
 * availability/open-window arithmetic every solver and validator uses.
 *
 * All instants are epoch milliseconds. A window is half-open, `[start, end)`.
 */

import type { ScheduleResource, TimeWindow } from "./domain";

/** A window play may not run through, e.g. a lunch break. */
export type BreakWindow = TimeWindow;

/**
 * Normalises configured breaks into sorted, merged windows.
 *
 * Merging matters because two touching breaks would otherwise need two passes to step over, and
 * an overlapping pair could leave a match starting inside one. Breaks beginning at or after the
 * planned end are dropped: matches are allowed to overrun the plan, so a break past the end would
 * only delay work needlessly.
 */
export function normalizeBreaks(
  breaks: readonly BreakWindow[] | undefined,
  planningEnd: number,
): TimeWindow[] {
  const usable = (breaks ?? [])
    .filter((brk) => Number.isFinite(brk.start) && Number.isFinite(brk.end) && brk.end > brk.start)
    .filter((brk) => brk.start < planningEnd);
  return mergeWindows(usable);
}

/**
 * Pushes a start time forward until a run of `durationMs` no longer overlaps a break. A match
 * cannot be paused part-way, so one that would straddle a break moves wholly after it.
 *
 * Looping because clearing one break can land inside the next. The bound is the break count
 * because each pass clears at least one and never moves backwards.
 */
export function startAfterBreaks(
  start: number,
  durationMs: number,
  breaks: readonly BreakWindow[],
): number {
  let time = start;
  for (let pass = 0; pass <= breaks.length; pass++) {
    const overlapping = breaks.find((brk) => time < brk.end && time + durationMs > brk.start);
    if (!overlapping) return time;
    time = overlapping.end;
  }
  return time;
}

/** Sorts and merges overlapping or touching windows. */
export function mergeWindows(windows: readonly TimeWindow[]): TimeWindow[] {
  const usable = windows
    .filter((w) => Number.isFinite(w.start) && w.end > w.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TimeWindow[] = [];
  for (const window of usable) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end) {
      last.end = Math.max(last.end, window.end);
    } else {
      merged.push({ start: window.start, end: window.end });
    }
  }
  return merged;
}

/** Removes every cut window from the base windows. `base` must already be merged and sorted. */
export function subtractWindows(
  base: readonly TimeWindow[],
  cuts: readonly TimeWindow[],
): TimeWindow[] {
  const mergedCuts = mergeWindows(cuts);
  if (!mergedCuts.length) return base.map((w) => ({ start: w.start, end: w.end }));
  const result: TimeWindow[] = [];
  for (const window of base) {
    let cursor = window.start;
    for (const cut of mergedCuts) {
      if (cut.end <= cursor) continue;
      if (cut.start >= window.end) break;
      if (cut.start > cursor) result.push({ start: cursor, end: Math.min(cut.start, window.end) });
      cursor = Math.max(cursor, cut.end);
      if (cursor >= window.end) break;
    }
    if (cursor < window.end) result.push({ start: cursor, end: window.end });
  }
  return result.filter((w) => w.end > w.start);
}

/** Intersects two window lists. Neither needs to be pre-merged. */
export function intersectWindows(
  a: readonly TimeWindow[],
  b: readonly TimeWindow[],
): TimeWindow[] {
  const left = mergeWindows(a);
  const right = mergeWindows(b);
  const result: TimeWindow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const l = left[i]!;
    const r = right[j]!;
    const start = Math.max(l.start, r.start);
    const end = Math.min(l.end, r.end);
    if (end > start) result.push({ start, end });
    if (l.end <= r.end) i++;
    else j++;
  }
  return result;
}

/**
 * The globally open windows: the horizon minus the problem's unavailable windows. Open-ended in
 * the future, because a run is allowed to overrun `planningEnd` freely.
 */
export function globalOpenWindows(
  horizonStart: number,
  unavailable: readonly TimeWindow[] | undefined,
): TimeWindow[] {
  return subtractWindows([{ start: horizonStart, end: Number.POSITIVE_INFINITY }], unavailable ?? []);
}

/** The open windows of one resource: its availability intersected with the global open set. */
export function resourceOpenWindows(
  resource: ScheduleResource,
  globalOpen: readonly TimeWindow[],
): TimeWindow[] {
  const availability = resource.availability ?? [];
  if (!availability.length) return globalOpen.map((w) => ({ start: w.start, end: w.end }));
  return intersectWindows(availability, globalOpen);
}

/** True when `[start, start + durationMs)` fits wholly inside one open window. */
export function fitsInWindows(
  start: number,
  durationMs: number,
  windows: readonly TimeWindow[],
): boolean {
  const end = start + durationMs;
  return windows.some((w) => start >= w.start && end <= w.end);
}

/**
 * The earliest `t >= start` where `[t, t + durationMs)` fits inside one open window, or null when
 * no window is long enough. `durationMs` of 0 fits at a window's start.
 */
export function nextWindowStartAtOrAfter(
  start: number,
  durationMs: number,
  windows: readonly TimeWindow[],
): number | null {
  let best: number | null = null;
  for (const window of windows) {
    if (window.end - window.start < durationMs) continue;
    const candidate = Math.max(start, window.start);
    if (candidate + durationMs > window.end) continue;
    if (best == null || candidate < best) best = candidate;
  }
  return best;
}

/** As `nextWindowStartAtOrAfter`, but strictly after `start`. */
export function nextWindowStartStrictlyAfter(
  start: number,
  durationMs: number,
  windows: readonly TimeWindow[],
): number | null {
  let best: number | null = null;
  for (const window of windows) {
    if (window.end - window.start < durationMs) continue;
    const candidate = Math.max(start, window.start);
    if (candidate <= start) continue;
    if (candidate + durationMs > window.end) continue;
    if (best == null || candidate < best) best = candidate;
  }
  return best;
}

/** Merged minutes covered by a set of intervals, summed per resource. */
export function mergedOccupancyMinutes(
  intervalsByResource: ReadonlyMap<string, TimeWindow[]>,
): number {
  let total = 0;
  for (const intervals of intervalsByResource.values()) {
    for (const window of mergeWindows(intervals)) total += window.end - window.start;
  }
  return total / 60_000;
}

/**
 * `start` on the next multiple of `granularityMs`, or unchanged when no grid applies.
 *
 * Rounded up, never to nearest: a solver only ever reaches a candidate by advancing past whatever
 * blocked it, so rounding down could step back into the blocking interval.
 */
export function alignUp(start: number, granularityMs: number | null | undefined): number {
  if (!granularityMs || granularityMs <= 0) return start;
  return Math.ceil(start / granularityMs) * granularityMs;
}
