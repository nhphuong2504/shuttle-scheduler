import { describe, expect, it } from "vitest";

import { buildResultsCsv, csvField, resultCounts, RESULTS_CSV_HEADER } from "./results-export";

/** Rows carry only the columns the export reads. */
const rows = <T>(value: unknown[]) => value as unknown as T[];

const input = {
  categories: rows<never>([{ id: "c1", code: "MS", name: "Men's Singles", sort_order: 1 }]),
  players: rows<never>([
    { id: "p1", name: "Ana" },
    { id: "p2", name: "Bo, Jr." },
    { id: "p3", name: "Cy" },
  ]),
  teams: rows<never>([
    { id: "t1", player_1_id: "p1", player_2_id: null },
    { id: "t2", player_1_id: "p2", player_2_id: null },
    { id: "t3", player_1_id: "p3", player_2_id: null },
  ]),
  entrants: rows<never>([
    { id: "e1", team_id: "t1" },
    { id: "e2", team_id: "t2" },
    { id: "e3", team_id: "t3" },
  ]),
  placementMatches: rows<never>([
    {
      id: "m1", category_id: "c1", stage: "round1", generation_key: "r1-1",
      entrant_a_id: "e1", entrant_b_id: "e2", winner_id: "e1", status: "reported",
      games: [{ a: 21, b: 15 }],
    },
    {
      id: "m2", category_id: "c1", stage: "round2", generation_key: "r2-1",
      entrant_a_id: "e1", entrant_b_id: "e3", winner_id: null, status: "scheduled",
      games: [],
    },
  ]),
  draws: rows<never>([{ id: "d1", category_id: "c1", tier: "A", bracket_size: 2, champion_id: "e1" }]),
  tierMatches: rows<never>([
    // A waiting slot and a bye are not matches anyone played.
    { id: "x1", draw_id: "d1", round: 1, slot: 1, is_bye: false, entrant_a_id: "e1", entrant_b_id: null, status: "scheduled", games: [], winner_id: null },
    { id: "x2", draw_id: "d1", round: 1, slot: 2, is_bye: true, entrant_a_id: "e3", entrant_b_id: null, status: "scheduled", games: [], winner_id: null },
    { id: "x3", draw_id: "d1", round: 1, slot: 3, is_bye: false, entrant_a_id: "e1", entrant_b_id: "e3", status: "walkover", games: [], winner_id: "e1" },
  ]),
};

describe("csvField", () => {
  it("quotes a field holding a comma, quote or line break, and leaves the rest alone", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("Bo, Jr.")).toBe('"Bo, Jr."');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a\nb")).toBe('"a\nb"');
  });
});

describe("buildResultsCsv", () => {
  const lines = buildResultsCsv(input as never).split("\r\n");

  it("starts with the header", () => {
    expect(lines[0]).toBe(RESULTS_CSV_HEADER.join(","));
  });

  it("writes placement matches with score, winner and status", () => {
    expect(lines[1]).toBe('MS Men\'s Singles,Placement,Round 1,Ana,"Bo, Jr.",21-15,Ana,Played');
    expect(lines[2]).toBe("MS Men's Singles,Placement,Round 2,Ana,Cy,,,Not played");
  });

  it("writes a bracket's played matches only, skipping byes and waiting slots", () => {
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("MS Men's Singles,Draw A Cup,Final,Ana,Cy,,Ana,Walkover");
  });
});

describe("resultCounts", () => {
  it("counts the matches the CSV lists, by what became of them", () => {
    expect(resultCounts(input as never)).toEqual({ played: 1, walkovers: 1, unplayed: 1 });
  });
});
