import { describe, expect, it } from "vitest";

import { countText, dateRangeText, instantText } from "./summary-format";

/**
 * How a summary row reads, in words.
 *
 * The expectations here are derived in the *test's own* timezone rather than written as
 * literal strings, and that is deliberate rather than lazy. The suite pins no TZ, and the
 * formatters use the browser's (here: the runner's) zone on purpose - the summary carries no
 * venue timezone, so the honest thing is to print the zone the reader is in. A literal
 * "Sep 18, 9:00 AM CDT" would therefore be a test that passes in Chicago and fails in CI,
 * which is a worse test than one that states the rule.
 *
 * So what is pinned is the rule: an absent range is a sentence, a start without an end is
 * "Starts …", and a range prints the end's date only when it is a different day.
 */

const START = "2026-09-18T09:00:00Z";
const SAME_DAY_END = "2026-09-18T17:00:00Z";
const OTHER_DAY_END = "2026-09-20T17:00:00Z";

/** The end of a range, formatted the way the range prints an end on a different day. */
const timeOnly = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));

describe("dateRangeText", () => {
  it("says there are no playing days rather than printing nothing", () => {
    // An upcoming tournament legitimately has no days yet, and an empty line reads as a
    // rendering fault rather than as a state.
    expect(dateRangeText(null, null)).toBe("No playing days yet");
  });

  it("says a tournament starts when it has a first day and no last one", () => {
    expect(dateRangeText(START, null)).toBe(`Starts ${instantText(START)}`);
  });

  it("prints a same-day range as the day once, then the time", () => {
    const start = new Date(START);
    const end = new Date(SAME_DAY_END);
    // Guarded rather than assumed: the two instants are only a same-day pair in some zones,
    // and this assertion is about the same-day branch. A zone where they straddle midnight
    // falls to the test below instead.
    if (start.toDateString() !== end.toDateString()) return;

    expect(dateRangeText(START, SAME_DAY_END)).toBe(`${instantText(START)} → ${timeOnly(SAME_DAY_END)}`);
  });

  it("prints both days when the range crosses one", () => {
    expect(dateRangeText(START, OTHER_DAY_END)).toBe(
      `${instantText(START)} → ${instantText(OTHER_DAY_END)}`,
    );
    // And the two branches are genuinely two: a cross-day range is not the same sentence as
    // a same-day one whatever the zone does to those instants.
    expect(dateRangeText(START, OTHER_DAY_END)).not.toBe(dateRangeText(START, SAME_DAY_END));
  });
});

describe("instantText", () => {
  it("prints the zone the time is shown in", () => {
    // The point of the formatter rather than a detail of it: the summary deliberately carries
    // no venue timezone, so a bare local time would present the reader's own zone as if it
    // were the venue's. The assertion is against the same format without the zone name, which
    // is zone-agnostic and still proves the abbreviation is really there.
    const withoutZone = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(START));

    expect(instantText(START)).toContain(withoutZone);
    expect(instantText(START)).not.toBe(withoutZone);
  });
});

describe("countText", () => {
  it("agrees with its noun in number", () => {
    expect(countText(0, "entry", "entries")).toBe("0 entries");
    expect(countText(1, "entry", "entries")).toBe("1 entry");
    expect(countText(2, "entry", "entries")).toBe("2 entries");
  });
});
