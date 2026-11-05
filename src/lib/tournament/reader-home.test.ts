import { describe, expect, it } from "vitest";

import {
  OPERATOR_HOME,
  READER_HOME_NOW,
  READER_HOME_PLAYERS,
  readerHomeFor,
  tournamentHomeFor,
} from "./reader-home";

describe("readerHomeFor", () => {
  it("opens an upcoming tournament on Players, since nothing is on court yet", () => {
    expect(readerHomeFor("upcoming")).toBe(READER_HOME_PLAYERS);
  });

  it("opens a tournament on Now once a match has started, and after it completes", () => {
    expect(readerHomeFor("in_progress")).toBe(READER_HOME_NOW);
    expect(readerHomeFor("completed")).toBe(READER_HOME_NOW);
  });

  it("reads an unknown status the way the app normalises it", () => {
    expect(readerHomeFor(undefined)).toBe(readerHomeFor(null));
  });
});

describe("tournamentHomeFor", () => {
  it("opens the Desk for anyone who may operate the tournament", () => {
    for (const access_level of ["admin", "owner", "editor"]) {
      expect(tournamentHomeFor({ status: "upcoming", access_level })).toBe(OPERATOR_HOME);
    }
  });

  it("opens the reader's home for a viewer or a visitor", () => {
    expect(tournamentHomeFor({ status: "in_progress", access_level: "viewer" })).toBe(
      READER_HOME_NOW,
    );
    expect(tournamentHomeFor({ status: "upcoming", access_level: null })).toBe(READER_HOME_PLAYERS);
  });
});
