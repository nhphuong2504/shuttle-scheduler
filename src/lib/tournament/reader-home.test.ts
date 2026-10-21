import { describe, expect, it } from "vitest";

import { READER_HOME_ENTRIES, READER_HOME_SCORES, readerHomeFor } from "./reader-home";

describe("readerHomeFor", () => {
  it("opens an upcoming tournament on Entries, since there are no scores yet", () => {
    expect(readerHomeFor("upcoming")).toBe(READER_HOME_ENTRIES);
  });

  it("opens a tournament on Scores once a match has started, and after it completes", () => {
    expect(readerHomeFor("in_progress")).toBe(READER_HOME_SCORES);
    expect(readerHomeFor("completed")).toBe(READER_HOME_SCORES);
  });

  it("reads an unknown status the way the app normalises it", () => {
    expect(readerHomeFor(undefined)).toBe(readerHomeFor(null));
  });
});
