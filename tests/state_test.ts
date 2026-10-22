import { assertEquals, assertThrows } from "@std/assert";
import { StateModel } from "../src/core/state.ts";
import { BridgeFailure, type NetworkState } from "../src/core/types.ts";

function network(overrides: Partial<NetworkState> = {}): NetworkState {
  return {
    name: "net1",
    server: "irc.example.net",
    port: 6667,
    status: "connected",
    nick: "me",
    channels: [],
    members: {},
    ...overrides,
  };
}

Deno.test("resolve infers the network when exactly one is connected", () => {
  const state = new StateModel();
  state.applyStateFrame([network()]);
  assertEquals(state.resolve().name, "net1");
  assertEquals(state.resolve("net1").nick, "me");
});

Deno.test("resolve refuses to guess when several networks are connected", () => {
  const state = new StateModel();
  state.applyStateFrame([network(), network({ name: "net2" })]);
  const err = assertThrows(() => state.resolve(), BridgeFailure) as BridgeFailure;
  assertEquals(err.error.code, "ambiguous_network");
  // Naming one is always fine.
  assertEquals(state.resolve("net2").name, "net2");
});

Deno.test("resolve reports an unknown network with the list of real ones", () => {
  const state = new StateModel();
  state.applyStateFrame([network(), network({ name: "net2" })]);
  const err = assertThrows(() => state.resolve("nope"), BridgeFailure) as BridgeFailure;
  assertEquals(err.error.code, "unknown_network");
  assertEquals(err.error.hint.includes("net1"), true);
  assertEquals(err.error.hint.includes("net2"), true);
});

Deno.test("resolve explains an empty daemon rather than pretending a network exists", () => {
  const state = new StateModel();
  const err = assertThrows(() => state.resolve(), BridgeFailure) as BridgeFailure;
  assertEquals(err.error.code, "unknown_network");
  // Naming a network makes no difference when there are none at all.
  assertThrows(() => state.resolve("anything"), BridgeFailure);
});

Deno.test("a join from our own nick adds the channel; someone else's only counts", () => {
  const state = new StateModel();
  state.applyStateFrame([network({ members: { "#chan": 5 } })]);
  state.applyEvent({ seq: 1, ts: 0, kind: "join", net: "net1", buf: "#chan", nick: "other" });
  assertEquals(state.memberCount(state.resolve(), "#chan"), 6);
  assertEquals(state.isJoined(state.resolve(), "#chan"), false);

  state.applyEvent({ seq: 2, ts: 0, kind: "join", net: "net1", buf: "#chan", nick: "me" });
  assertEquals(state.isJoined(state.resolve(), "#chan"), true);
  // Our own join must not inflate the member count as well.
  assertEquals(state.memberCount(state.resolve(), "#chan"), 6);
});

Deno.test("part and kick drop us from the channel, case-insensitively", () => {
  const state = new StateModel();
  state.applyStateFrame([network({ channels: ["#Chan"], members: { "#Chan": 3 } })]);
  assertEquals(state.isJoined(state.resolve(), "#chan"), true);

  state.applyEvent({ seq: 1, ts: 0, kind: "part", net: "net1", buf: "#chan", nick: "me" });
  assertEquals(state.isJoined(state.resolve(), "#chan"), false);
  assertEquals(state.memberCount(state.resolve(), "#chan"), undefined);
});

Deno.test("a part by someone else only decrements the count", () => {
  const state = new StateModel();
  state.applyStateFrame([network({ channels: ["#chan"], members: { "#chan": 2 } })]);
  state.applyEvent({ seq: 1, ts: 0, kind: "part", net: "net1", buf: "#chan", nick: "other" });
  assertEquals(state.memberCount(state.resolve(), "#chan"), 1);
  assertEquals(state.isJoined(state.resolve(), "#chan"), true);
});

Deno.test("selfnick updates our identity, and other nick changes do not", () => {
  const state = new StateModel();
  state.applyStateFrame([network({ nick: "me" })]);
  state.applyEvent({
    seq: 1,
    ts: 0,
    kind: "nick",
    net: "net1",
    buf: "#chan",
    nick: "someone",
    extra: { new: "someone_else" },
  });
  assertEquals(state.resolve().nick, "me");

  state.applyEvent({
    seq: 2,
    ts: 0,
    kind: "selfnick",
    net: "net1",
    extra: { old: "me", new: "me_", reason: "in-use" },
  });
  assertEquals(state.resolve().nick, "me_");
});

Deno.test("disconnect clears channels so we never command a dead network", () => {
  const state = new StateModel();
  state.applyStateFrame([network({ channels: ["#a"], members: { "#a": 4 } })]);
  state.applyEvent({
    seq: 1,
    ts: 0,
    kind: "conn",
    net: "net1",
    extra: { event: "disconnected" },
  });
  assertEquals(state.resolve().status, "disconnected");
  assertEquals(state.resolve().channels, []);
  assertEquals(state.resolve().members, {});
});

Deno.test("events for an unknown network are ignored rather than inventing one", () => {
  const state = new StateModel();
  state.applyStateFrame([network()]);
  state.applyEvent({ seq: 1, ts: 0, kind: "join", net: "ghost", buf: "#x", nick: "me" });
  assertEquals(state.networks().length, 1);
  assertThrows(() => state.resolve("ghost"), BridgeFailure);
});

Deno.test("freshness reflects whether mIRC has confirmed the picture recently", () => {
  const state = new StateModel();
  assertEquals(state.isStale(1000), true);

  state.applyStateFrame([network()]);
  assertEquals(state.isStale(1000), false);
  assertEquals(state.isStale(-1), true);
  assertEquals(typeof state.lastRefreshTs, "number");
});

Deno.test("network names match regardless of the spelling a server announces", () => {
  // Seen live: one EFNet server says "EFNet", irc.efnet.org says "EFnet".
  const model = new StateModel();
  model.applyStateFrame([network({ name: "EFNet", channels: [] })]);

  const net = model.resolve("EFnet");
  // mIRC's own spelling is kept for display.
  assertEquals(net.name, "EFNet");
  assertEquals(model.find("efnet")?.name, "EFNet");

  // Events tagged with the other spelling still update the same network.
  model.applyEvent({ seq: 1, ts: 0, kind: "join", net: "EFnet", buf: "#chan", nick: net.nick });
  assertEquals(model.isJoined(model.resolve("EFNET"), "#chan"), true);
});
