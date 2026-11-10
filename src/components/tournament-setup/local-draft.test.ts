// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearLocalDraft,
  hasLocalDraft,
  loadLocalDraft,
  offerTournamentName,
  saveLocalDraft,
  takeOfferedTournamentName,
} from "./local-draft";
import { defaultForm } from "./types";

beforeEach(() => window.sessionStorage.clear());
afterEach(() => window.sessionStorage.clear());

describe("the create flow's local draft", () => {
  it("has nothing to give back before anything was typed", () => {
    expect(loadLocalDraft()).toBeNull();
    expect(hasLocalDraft()).toBe(false);
  });

  it("gives back exactly what was saved", () => {
    const form = defaultForm();
    form.basics.name = "City Open";
    form.startsOn = "2026-10-20";
    form.endsOn = "2026-10-30";
    form.registration = { enabled: true, opensAt: "2026-10-08T09:00", closesAt: "" };
    saveLocalDraft(form);
    expect(loadLocalDraft()).toEqual(form);
    expect(hasLocalDraft()).toBe(true);
  });

  it("is gone once cleared, which is what creating or discarding does", () => {
    saveLocalDraft({ ...defaultForm(), startsOn: "2026-10-20" });
    clearLocalDraft();
    expect(loadLocalDraft()).toBeNull();
  });

  it("does not count the defaults as a draft worth mentioning", () => {
    saveLocalDraft(defaultForm());
    expect(hasLocalDraft()).toBe(false);
  });

  it("fills in what an older or damaged save is missing instead of crashing", () => {
    window.sessionStorage.setItem(
      "tournova:new-tournament:v1",
      JSON.stringify({ basics: { name: "Old" }, startsOn: "2026-10-20" }),
    );
    const loaded = loadLocalDraft();
    expect(loaded?.basics.name).toBe("Old");
    expect(loaded?.basics.venueTimezone).toBe("America/Chicago");
    expect(loaded?.events).toEqual([]);
    expect(loaded?.registration.enabled).toBe(true);
  });

  it("ignores a save that is not JSON", () => {
    window.sessionStorage.setItem("tournova:new-tournament:v1", "{not json");
    expect(loadLocalDraft()).toBeNull();
  });
});

describe("a name offered from the front door", () => {
  it("is given to the create flow once, trimmed", () => {
    offerTournamentName("  City Open  ");
    expect(takeOfferedTournamentName()).toBe("City Open");
    expect(takeOfferedTournamentName()).toBeNull();
  });

  it("is not offered when nothing was typed", () => {
    offerTournamentName("   ");
    expect(takeOfferedTournamentName()).toBeNull();
  });

  it("leaves the draft itself alone", () => {
    offerTournamentName("City Open");
    expect(loadLocalDraft()).toBeNull();
  });
});
