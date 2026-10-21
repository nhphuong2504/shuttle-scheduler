// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CallNextButton, CallNextDialog, type CallNextPlayer } from "@/components/desk/call-next";
import type { PlayerReach } from "@/lib/tournament/call-next";

/**
 * The Call next layout, rendered with the data the sending feature will supply.
 *
 * The Desk passes no contact details and no notified time yet, so the browser suite can only
 * see the "not connected" dialog. The states that need them - channel icons, "No contact",
 * who a send reaches, "Notified" - are drawn here from injected props.
 */

afterEach(cleanup);

const T = new Date(2026, 9, 18, 14, 32).getTime();
const players: CallNextPlayer[] = [
  { id: "a", name: "Ryan Lewis", status: { kind: "free" } },
  { id: "b", name: "Adam Grant", status: { kind: "resting", readyAt: T + 9 * 60_000 } },
  { id: "c", name: "Chris Bell", status: { kind: "on-court", matchId: "m5", courtId: "c5" } },
  { id: "d", name: "Dan Ortiz", status: { kind: "free" } },
];
const reach: ReadonlyMap<string, PlayerReach> = new Map([
  ["a", { sms: true, email: true }],
  ["b", { sms: false, email: true }],
  ["c", { sms: true, email: false }],
]);

function renderDialog(over: Partial<Parameters<typeof CallNextDialog>[0]> = {}) {
  const onSend = vi.fn();
  render(
    <CallNextDialog
      open
      onOpenChange={() => {}}
      matchId="m2"
      courtNumber={2}
      courtId="c2"
      context="MD R2, scheduled 14:25, Court 2 still playing, 37′ on court"
      players={players}
      courtNumberFor={(id) => (id === "c5" ? 5 : "?")}
      reach={reach}
      notifiedAt={null}
      initialMessage="Tournova: your match is next on Court 2 at 14:25 (MD R2)."
      paused={false}
      onSend={onSend}
      returnFocusTo={null}
      {...over}
    />,
  );
  return { onSend, dialog: screen.getByRole("dialog") };
}

describe("CallNextDialog", () => {
  it("shows each player's channels, or that there is none, and who a send reaches", () => {
    const { dialog } = renderDialog();
    const row = (name: string) => within(dialog).getByRole("rowheader", { name }).closest("tr")!;
    expect(within(row("Ryan Lewis")).getByText("SMS")).toBeTruthy();
    expect(within(row("Ryan Lewis")).getByText("Email")).toBeTruthy();
    expect(within(row("Adam Grant")).queryByText("SMS")).toBeNull();
    expect(within(row("Dan Ortiz")).getByText("No contact")).toBeTruthy();
    expect(within(dialog).getByText("Sends to 3 of 4 players")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });

  it("words each player's whereabouts as the tile does", () => {
    const { dialog } = renderDialog();
    expect(within(dialog).getByText(/^Resting until \d{1,2}:\d{2}$/)).toBeTruthy();
    expect(within(dialog).getByText("On Court 5")).toBeTruthy();
    expect(within(dialog).getAllByText("Free")).toHaveLength(2);
    expect(within(dialog).getByText(/is on Court 5\.$/).textContent).toBe("Chris Bell is on Court 5.");
  });

  it("sends the edited message, trimmed", () => {
    const { dialog, onSend } = renderDialog({ initialMessage: "  Come now.  " });
    within(dialog).getByRole("button", { name: "Send" }).click();
    expect(onSend).toHaveBeenCalledWith("Come now.");
  });

  it("offers Send again once the players were notified", () => {
    const { dialog } = renderDialog({ notifiedAt: T });
    expect(within(dialog).getByText(/^Notified \d{1,2}:\d{2}\./)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Send again" })).toBeTruthy();
  });

  it("cannot send while paused, or when nobody can be reached", () => {
    let { dialog } = renderDialog({ paused: true });
    expect(within(dialog).getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    cleanup();
    ({ dialog } = renderDialog({ reach: new Map() }));
    expect(within(dialog).getByText("Sends to 0 of 4 players")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  it("says sending is not connected, and drops the reach column, without contact data", () => {
    const { dialog } = renderDialog({ reach: null });
    expect(within(dialog).getByText("Sending is not connected yet.")).toBeTruthy();
    expect(within(dialog).queryByRole("columnheader", { name: "Reach by" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("CallNextButton", () => {
  const base = { courtNumber: 4, notifiedAt: null, paused: false, onOpen: () => {} };

  it("draws nothing when nothing is queued", () => {
    const { container } = render(<CallNextButton {...base} availability={{ kind: "none" }} />);
    expect(container.innerHTML).toBe("");
  });

  it("is locked while the teams are not known, and says why", () => {
    render(<CallNextButton {...base} availability={{ kind: "locked" }} />);
    const button = screen.getByRole("button", { name: "Call next, Court 4, the teams are not known yet" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("stays usable, with a reason in its name, when a player is elsewhere", () => {
    render(<CallNextButton {...base} availability={{ kind: "warn", busyPlayerIds: ["c"] }} />);
    const button = screen.getByRole("button", { name: "Call next, Court 4, a player is on another court" });
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("names when the players were notified", () => {
    render(<CallNextButton {...base} notifiedAt={T} availability={{ kind: "ready" }} />);
    expect(screen.getByRole("button", { name: /^Notified \d{1,2}:\d{2}, Court 4$/ })).toBeTruthy();
  });

  it("is locked while the Desk is offline", () => {
    render(<CallNextButton {...base} paused availability={{ kind: "ready" }} />);
    expect(screen.getByRole("button", { name: "Call next, Court 4, no connection" }).hasAttribute("disabled")).toBe(true);
  });
});
