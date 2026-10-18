import { describe, expect, it } from "vitest";

import type { ScheduleConflict, ScheduleConflictKind } from "./data";
import {
  CONFLICT_KIND_LABEL,
  CONFLICT_KIND_ORDER,
  conflictedMatchCount,
  conflictKindLabels,
  groupConflictsByKind,
  groupConflictsByMatch,
  sortConflicts,
  summarizeConflicts,
} from "./schedule-conflicts";

function conflict(
  matchId: string,
  kind: ScheduleConflictKind,
  extra: Partial<ScheduleConflict> = {},
): ScheduleConflict {
  return {
    match_table: "tier_draw_matches",
    match_id: matchId,
    court_id: null,
    scheduled_time: "2026-10-10T10:00:00.000Z",
    ended_at: null,
    conflict_kind: kind,
    detail: "",
    ...extra,
  };
}

describe("conflict kind labels", () => {
  it("names every kind the RPC can return, with the wording the UI reads", () => {
    expect(CONFLICT_KIND_ORDER).toEqual([
      "court_overlap",
      "rest_shortfall",
      "break",
      "past_closing",
      "before_prerequisite",
    ]);
    expect(CONFLICT_KIND_LABEL).toEqual({
      court_overlap: "Same court and time as another match",
      rest_shortfall: "A player won't have had full rest",
      break: "Scheduled during a break",
      past_closing: "Ends after the courts close",
      before_prerequisite: "Scheduled before a match it depends on",
    });
  });

  it("returns distinct reasons in the canonical kind order, never a database id", () => {
    const labels = conflictKindLabels([
      conflict("m1", "past_closing"),
      conflict("m1", "court_overlap"),
      // A second overlap is the same reason, not a second one.
      conflict("m1", "court_overlap"),
    ]);
    expect(labels).toEqual([
      "Same court and time as another match",
      "Ends after the courts close",
    ]);
    expect(labels.join(" ")).not.toContain("m1");
  });
});

describe("sortConflicts", () => {
  it("orders by kind, then published time, then match id", () => {
    const rows = sortConflicts([
      conflict("m2", "rest_shortfall", { scheduled_time: "2026-10-10T09:00:00.000Z" }),
      conflict("m1", "court_overlap", { scheduled_time: "2026-10-10T11:00:00.000Z" }),
      conflict("m3", "court_overlap", { scheduled_time: "2026-10-10T08:00:00.000Z" }),
      conflict("m0", "court_overlap", { scheduled_time: "2026-10-10T08:00:00.000Z" }),
    ]);
    expect(rows.map((row) => `${row.match_id}:${row.conflict_kind}`)).toEqual([
      "m0:court_overlap",
      "m3:court_overlap",
      "m1:court_overlap",
      "m2:rest_shortfall",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [conflict("b", "past_closing"), conflict("a", "court_overlap")];
    const before = [...input];
    sortConflicts(input);
    expect(input).toEqual(before);
  });
});

describe("groupConflictsByMatch", () => {
  it("keys every conflict under its match, leaving a clean match with no key", () => {
    const grouped = groupConflictsByMatch([
      conflict("m1", "break"),
      conflict("m1", "past_closing"),
      conflict("m2", "court_overlap"),
    ]);
    expect([...grouped.keys()].sort()).toEqual(["m1", "m2"]);
    expect(grouped.get("m1")?.map((row) => row.conflict_kind)).toEqual([
      "break",
      "past_closing",
    ]);
    expect(grouped.get("m3")).toBeUndefined();
  });
});

describe("summarizeConflicts", () => {
  it("caps at two reasons and counts the rest as a +N tail", () => {
    const summary = summarizeConflicts([
      conflict("m1", "past_closing"),
      conflict("m1", "break"),
      conflict("m1", "rest_shortfall"),
      conflict("m1", "court_overlap"),
    ]);
    expect(summary.reasons).toEqual([
      "Same court and time as another match",
      "A player won't have had full rest",
    ]);
    expect(summary.more).toBe(2);
    expect(summary.text).toBe(
      "Same court and time as another match; A player won't have had full rest +2",
    );
  });

  it("has no tail and no text for a match with no conflict", () => {
    const summary = summarizeConflicts([]);
    expect(summary.reasons).toEqual([]);
    expect(summary.more).toBe(0);
    expect(summary.text).toBe("");
  });
});

describe("groupConflictsByKind", () => {
  it("groups in the canonical order and drops kinds with no conflicts", () => {
    const groups = groupConflictsByKind([
      conflict("m1", "past_closing"),
      conflict("m2", "court_overlap", { scheduled_time: "2026-10-10T09:00:00.000Z" }),
      conflict("m1", "court_overlap"),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["court_overlap", "past_closing"]);
    expect(groups[0]?.label).toBe("Same court and time as another match");
    expect(groups[0]?.conflicts.map((row) => row.match_id)).toEqual(["m2", "m1"]);
    expect(groups[1]?.conflicts).toHaveLength(1);
  });
});

describe("conflictedMatchCount", () => {
  it("counts distinct matches, not rows", () => {
    expect(
      conflictedMatchCount([
        conflict("m1", "court_overlap"),
        conflict("m1", "break"),
        conflict("m2", "past_closing"),
      ]),
    ).toBe(2);
  });

  it("restricts to the given match ids when a scope is passed", () => {
    const within = new Set(["m1"]);
    expect(
      conflictedMatchCount(
        [
          conflict("m1", "court_overlap"),
          conflict("m2", "past_closing"),
        ],
        within,
      ),
    ).toBe(1);
    expect(conflictedMatchCount([conflict("m2", "past_closing")], within)).toBe(0);
  });
});
