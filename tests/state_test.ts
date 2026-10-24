import { assertEquals, assertThrows } from "@std/assert";
import { StateModel } from "../src/core/state.ts";
import { BridgeFailure, type NetworkState } from "../src/core/types.ts";

function network(overrides: Partial<NetworkState> = {}): NetworkState {
  return {
    cid: 1,
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
  state.applyStateFrame([network(), network({ cid: 2, name: "net2" })]);
  const err = assertThrows(() => state.resolve(), BridgeFailure) as BridgeFailure;
  assertEquals(err.error.code, "ambiguous_network");
  // Naming one is always fine.
  assertEquals(state.resolve("net2").name, "net2");
});

Deno.test("the refusal says where the channel is joined, and still picks nothing", () => {
  // Live: three networks up and a channel joined on one; the hint only said
  // "name one explicitly", four times over.
  const state = new StateModel();
  state.applyStateFrame([
    network({ cid: 1, name: "EFNet", channels: ["#home!"] }),
    network({ cid: 16881, name: "Rizon", channels: ["#files-chat"] }),
  ]);
  const err = assertThrows(
    () => state.resolve(undefined, "#FILES-CHAT"),
    BridgeFailure,
  ) as BridgeFailure;
  assertEquals(err.error.code, "ambiguous_network");
  assertEquals(err.error.hint.includes("joined only on Rizon (cid 16881)"), true);
  assertEquals(err.error.hint.includes('pass network: "Rizon"'), true);

  const nowhere = assertThrows(
    () => state.resolve(undefined, "#other"),
    BridgeFailure,
  ) as BridgeFailure;
  assertEquals(nowhere.error.hint.includes("not in #other on any of them"), true);
});

Deno.test("the refusal says cid when the channel's network has two connections", () => {
  const state = new StateModel();
  state.applyStateFrame([
    network({ cid: 1, name: "EFnet", channels: ["#home!"] }),
    network({ cid: 4, name: "EFNet", channels: [] }),
  ]);
  const err = assertThrows(
    () => state.resolve(undefined, "#home!"),
    BridgeFailure,
  ) as BridgeFailure;
  assertEquals(err.error.hint.includes("pass cid: 1"), true);
});

Deno.test("resolve reports an unknown network with the list of real ones", () => {
  const state = new StateModel();
  state.applyStateFrame([network(), network({ cid: 2, name: "net2" })]);
  const err = assertThrows(() => state.resolve("nope"), BridgeFailure) as BridgeFailure;
  assertEquals(err.error.code, "unknown_network");
  assertEquals(err.error.hint.includes("net1"), true);
  assertEquals(err.error.hint.includes("net2"), true);
  // The next step, not just the fact: a small model gave up on the fact alone.
  assertEquals(err.error.hint.includes('irc_connect {network: "nope"}'), true);
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
  assertEquals(state.resolve("net1").status, "disconnected");
  assertEquals(state.resolve("net1").channels, []);
  assertEquals(state.resolve("net1").members, {});
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

Deno.test("two connections to one network: the connected one wins, two connected is ambiguous", () => {
  const state = new StateModel();
  state.applyStateFrame([
    network({ cid: 1, name: "EFnet", status: "disconnected", channels: [] }),
    network({ cid: 4, name: "EFNet" }),
  ]);
  // A leftover disconnected window does not make the name ambiguous.
  assertEquals(state.resolve("efnet").cid, 4);
  assertEquals(state.find("EFNET")?.cid, 4);

  state.applyStateFrame([network({ cid: 1, name: "EFnet" }), network({ cid: 4, name: "EFNet" })]);
  const err = assertThrows(() => state.resolve("EFnet"), BridgeFailure) as BridgeFailure;
  assertEquals(err.error.code, "ambiguous_network");
  // The hint names both connections so a person can tell them apart.
  assertEquals(err.error.hint.includes("cid 1") && err.error.hint.includes("cid 4"), true);
});

Deno.test("events are applied to the connection their cid names, not by network name", () => {
  const state = new StateModel();
  state.applyStateFrame([
    network({ cid: 1, name: "EFnet", nick: "me", channels: [] }),
    network({ cid: 4, name: "EFnet", nick: "me", channels: [] }),
  ]);
  state.applyEvent({ seq: 1, ts: 0, kind: "join", cid: 4, net: "EFnet", buf: "#x", nick: "me" });
  assertEquals(state.byCid(4)?.channels, ["#x"]);
  assertEquals(state.byCid(1)?.channels, []);
});

Deno.test("a connection learns its network name when it finishes connecting", () => {
  // Until registration completes, mIRC only knows the server it dialled.
  const state = new StateModel();
  state.applyStateFrame([
    network({ cid: 3, name: "irc.rizon.net", status: "connecting", channels: [] }),
  ]);
  state.applyEvent({
    seq: 1,
    ts: 0,
    kind: "conn",
    cid: 3,
    net: "Rizon",
    extra: { event: "connected" },
  });
  assertEquals(state.resolve("rizon").cid, 3);
  assertEquals(state.resolve("rizon").status, "connected");
});

Deno.test("findByServer matches the server a connection dialled, ignoring case", () => {
  const state = new StateModel();
  state.applyStateFrame([network({ cid: 2, name: "Rizon", server: "irc.rizon.net" })]);
  assertEquals(state.findByServer("IRC.Rizon.net")?.cid, 2);
  assertEquals(state.findByServer("irc.efnet.org"), undefined);
});
