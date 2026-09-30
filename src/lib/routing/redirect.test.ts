import { describe, expect, it } from "vitest";

import { localRedirect, signedInDestination, signInSearch } from "./redirect";

/**
 * The return address is a query parameter, so these are the rules that stand between a
 * hand-edited link and an open redirect. They are asserted here rather than only in the
 * rendered suite because they are pure string rules: every case below runs in
 * microseconds, and the interesting ones - a tab, a backslash, a protocol-relative pair
 * of slashes - are exactly the cases a browser-driven test would have to be *told* to
 * try.
 */
describe("localRedirect accepts a path in this app", () => {
  it.each([
    ["/", "the front door"],
    ["/explore", "a plain page"],
    ["/tournaments/00000000-0000-4000-8000-00000000ffff/desk", "a scoped workspace page"],
    ["/explore?q=final&status=upcoming", "a filter in the address"],
    ["/draws#top", "a fragment"],
    ["/tournaments/new?step=events", "a wizard step"],
  ])("keeps %s (%s)", (value) => {
    expect(localRedirect(value)).toBe(value);
  });

  it("drops everything that is not a path, rather than repairing it", () => {
    // The list is the argument: every rejected shape is a way of leaving the origin, and
    // the answer to all of them is the same - no return address, so the caller lands on
    // Home, which is a page this app chose.
    expect(localRedirect("https://evil.example/auth")).toBeUndefined();
    expect(localRedirect("//evil.example/auth")).toBeUndefined();
    expect(localRedirect("/\\evil.example")).toBeUndefined();
    expect(localRedirect("/\t/evil.example")).toBeUndefined();
    expect(localRedirect("/\n/evil.example")).toBeUndefined();
    expect(localRedirect("/explore\u0000")).toBeUndefined();
    expect(localRedirect("javascript:alert(1)")).toBeUndefined();
    expect(localRedirect("explore")).toBeUndefined();
    expect(localRedirect("")).toBeUndefined();
  });

  it("refuses the sign-in page itself, which is a loop rather than a return", () => {
    // `/auth` is the one address this app's own shells would otherwise produce, because
    // the "Sign in" affordance is rendered on the sign-in page too.
    expect(localRedirect("/auth")).toBeUndefined();
    expect(localRedirect("/auth?redirect=/explore")).toBeUndefined();
    // A different route whose name merely starts the same way is a real page.
    expect(localRedirect("/authors")).toBe("/authors");
  });

  it("rejects anything that is not a string", () => {
    for (const value of [undefined, null, 42, {}, ["/explore"]]) {
      expect(localRedirect(value)).toBeUndefined();
    }
  });
});

describe("signInSearch writes only what the route would accept", () => {
  it("carries the page the reader is on", () => {
    expect(signInSearch("/explore?q=final")).toEqual({ redirect: "/explore?q=final" });
  });

  it("carries nothing when there is nothing usable to carry", () => {
    // Which is the difference between "return to where you were" and "return to a page
    // somebody else composed": the second is dropped, and the caller lands on Home.
    expect(signInSearch("//evil.example")).toEqual({});
    expect(signInSearch("/auth")).toEqual({});
  });
});

describe("signedInDestination", () => {
  it("is the return address when there is one", () => {
    expect(signedInDestination({ redirect: "/explore" })).toBe("/explore");
  });

  it("is Home when there is not", () => {
    // Home, and not a flat operational path: it resumes whatever the caller was working
    // in, and it exists for a session that has not chosen a tournament yet.
    expect(signedInDestination({})).toBe("/");
  });
});
