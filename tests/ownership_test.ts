import { assertEquals } from "@std/assert";
import { OwnershipLedger } from "../src/core/ownership.ts";
import type { BridgeEvent } from "../src/core/types.ts";

function ev(fields: Partial<BridgeEvent> & Pick<BridgeEvent, "kind">): BridgeEvent {
  return { seq: 1, ts: 0, net: "Rizon", cid: 7, ...fields };
}

Deno.test("nothing is the agent's until it opens or joins it", () => {
  const ledger = new OwnershipLedger();
  assertEquals(ledger.ownsConnection(1), false);
  assertEquals(ledger.ownsChannel(1, "#home!"), false);
});

Deno.test("receipts are per connection, and channel names ignore case", () => {
  const ledger = new OwnershipLedger();
  ledger.openedConnection(7);
  ledger.joinedChannel(7, "#XDCC");
  assertEquals(ledger.ownsConnection(7), true);
  assertEquals(ledger.ownsChannel(7, "#xdcc"), true);
  // The same channel name on the user's connection is not the agent's.
  assertEquals(ledger.ownsChannel(1, "#xdcc"), false);
});

Deno.test("our own part or kick clears the channel receipt; someone else's does not", () => {
  const ledger = new OwnershipLedger();
  ledger.joinedChannel(7, "#xdcc");
  ledger.applyEvent(ev({ kind: "part", buf: "#xdcc", nick: "Somebody" }), "me");
  assertEquals(ledger.ownsChannel(7, "#xdcc"), true);
  ledger.applyEvent(ev({ kind: "kick", buf: "#XDCC", nick: "ME" }), "me");
  assertEquals(ledger.ownsChannel(7, "#xdcc"), false);
});

Deno.test("a dropped connection loses its channels but stays the agent's window", () => {
  const ledger = new OwnershipLedger();
  ledger.openedConnection(7);
  ledger.joinedChannel(7, "#xdcc");
  ledger.applyEvent(ev({ kind: "conn", extra: { event: "disconnected" } }), "me");
  assertEquals(ledger.ownsChannel(7, "#xdcc"), false);
  assertEquals(ledger.ownsConnection(7), true);
});

Deno.test("receipts for connections mIRC no longer has are dropped on refresh", () => {
  const ledger = new OwnershipLedger();
  ledger.openedConnection(7);
  ledger.joinedChannel(7, "#xdcc");
  ledger.openedConnection(9);
  // The user closed connection 7's window in mIRC.
  ledger.retainOnly([1, 9]);
  assertEquals(ledger.ownsConnection(7), false);
  assertEquals(ledger.ownsChannel(7, "#xdcc"), false);
  assertEquals(ledger.ownsConnection(9), true);
});

Deno.test("an event without a connection id changes nothing", () => {
  const ledger = new OwnershipLedger();
  ledger.joinedChannel(7, "#xdcc");
  ledger.applyEvent(ev({ kind: "part", cid: undefined, buf: "#xdcc", nick: "me" }), "me");
  assertEquals(ledger.ownsChannel(7, "#xdcc"), true);
});
