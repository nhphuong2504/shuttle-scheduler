import { describe, expect, it } from "vitest";

import type { ScheduleConflict, ScheduleConflictKind } from "./data";
import {
  CONFLICT_KIND_LABEL,
  CONFLICT_KIND_ORDER,
  conflictedMatchCount,
  conflictKindLabels,
  describeConflict,
  groupConflictsByMatch,
  groupConflictsForReview,
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
    related_match_table: null,
    related_match_id: null,
    player_id: null,
    minutes: null,
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

const wording = {
  matchLabel: (id: string) => ({ m1: "WS r2-1", m2: "XD r2-4", m3: "MS r2-2" })[id] ?? id,
  playerName: (id: string) => (id === "p1" ? "Bui Nguyet" : null),
};

describe("describeConflict", () => {
  it("says what is wrong, with whom and by how much", () => {
    expect(
      describeConflict(conflict("m2", "court_overlap", { related_match_id: "m1", minutes: 3 }), wording),
    ).toBe("Overlaps WS r2-1 on the same court by 3 min");
    expect(
      describeConflict(
        conflict("m2", "rest_shortfall", { related_match_id: "m1", player_id: "p1", minutes: 4 }),
        wording,
      ),
    ).toBe("Bui Nguyet would rest 4 min less than required after WS r2-1");
    expect(describeConflict(conflict("m2", "past_closing", { minutes: 6 }), wording)).toBe(
      "Ends 6 min after the courts close",
    );
    expect(describeConflict(conflict("m2", "break", { minutes: 5 }), wording)).toBe(
      "Runs 5 min into a break",
    );
    expect(
      describeConflict(
        conflict("m2", "before_prerequisite", { related_match_id: "m3", minutes: 2 }),
        wording,
      ),
    ).toBe("Starts 2 min before MS r2-2 is due to end");
  });

  it("names a player it cannot resolve generically, and falls back to the kind without details", () => {
    expect(
      describeConflict(
        conflict("m2", "rest_shortfall", { related_match_id: "m1", player_id: "p9", minutes: 1 }),
        wording,
      ),
    ).toBe("A player would rest 1 min less than required after WS r2-1");
    expect(describeConflict(conflict("m2", "court_overlap"), wording)).toBe(
      CONFLICT_KIND_LABEL.court_overlap,
    );
  });
});

describe("groupConflictsForReview", () => {
  it("gives one line per match, earliest first, with every reason beneath it", () => {
    const groups = groupConflictsForReview(
      [
        conflict("m1", "past_closing", { minutes: 6, scheduled_time: "2026-10-10T16:55:00.000Z" }),
        conflict("m2", "court_overlap", {
          scheduled_time: "2026-10-10T09:00:00.000Z",
          related_match_id: "m3",
          minutes: 1,
        }),
        conflict("m1", "court_overlap", {
          scheduled_time: "2026-10-10T16:55:00.000Z",
          related_match_id: "m2",
          minutes: 2,
        }),
      ],
      wording,
    );
    expect(groups.map((group) => group.matchId)).toEqual(["m2", "m1"]);
    expect(groups[1]?.reasons).toEqual([
      "Overlaps XD r2-4 on the same court by 2 min",
      "Ends 6 min after the courts close",
    ]);
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
