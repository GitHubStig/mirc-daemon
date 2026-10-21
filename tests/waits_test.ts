import { assertEquals } from "@std/assert";
import { EventBus } from "../src/core/bus.ts";
import { EventLog, type NewEvent } from "../src/core/buffers.ts";
import { matchesWait, waitForEvent } from "../src/core/waits.ts";
import type { BridgeEvent } from "../src/core/types.ts";

/** A log and bus wired together exactly as a Session wires them. */
function harness() {
  const log = new EventLog();
  const bus = new EventBus();
  const record = (input: NewEvent): BridgeEvent => {
    const event = log.append(input);
    bus.emit(event);
    return event;
  };
  return { log, bus, record };
}

Deno.test("a wait resolves from backlog when the reply already arrived", async () => {
  const { log, bus, record } = harness();
  // The bot answered before the caller asked — the race this exists to close.
  record({ kind: "notice", net: "net1", buf: "#chan", nick: "bot", text: "sending pack 42" });

  const match = await waitForEvent({
    log,
    bus,
    matcher: { kind: "notice", nick: "bot" },
    since: 0,
    timeoutMs: 50,
  });
  assertEquals(match?.text, "sending pack 42");
});

Deno.test("a wait resolves from a live event when nothing is buffered yet", async () => {
  const { log, bus, record } = harness();
  const pending = waitForEvent({
    log,
    bus,
    matcher: { kind: "notice", nick: "bot" },
    since: 0,
    timeoutMs: 500,
  });
  record({ kind: "notice", net: "net1", buf: "#chan", nick: "bot", text: "here you go" });
  assertEquals((await pending)?.text, "here you go");
});

Deno.test("omitting `since` ignores backlog and waits for what comes next", async () => {
  const { log, bus, record } = harness();
  record({ kind: "notice", net: "net1", nick: "bot", text: "old" });

  const pending = waitForEvent({
    log,
    bus,
    matcher: { kind: "notice", nick: "bot" },
    timeoutMs: 500,
  });
  record({ kind: "notice", net: "net1", nick: "bot", text: "new" });
  assertEquals((await pending)?.text, "new");
});

Deno.test("a wait with no match resolves undefined rather than throwing", async () => {
  const { log, bus } = harness();
  const result = await waitForEvent({
    log,
    bus,
    matcher: { kind: "notice" },
    timeoutMs: 20,
  });
  assertEquals(result, undefined);
});

Deno.test("a wait unsubscribes once it resolves", async () => {
  const { log, bus, record } = harness();
  assertEquals(bus.subscriberCount, 0);
  const pending = waitForEvent({ log, bus, matcher: { kind: "notice" }, timeoutMs: 500 });
  assertEquals(bus.subscriberCount, 1);
  record({ kind: "notice", net: "net1" });
  await pending;
  assertEquals(bus.subscriberCount, 0);
});

Deno.test("a timed-out wait also unsubscribes", async () => {
  const { log, bus } = harness();
  await waitForEvent({ log, bus, matcher: { kind: "notice" }, timeoutMs: 20 });
  assertEquals(bus.subscriberCount, 0);
});

Deno.test("matchers are case-insensitive on buffer and nick", () => {
  const event: BridgeEvent = {
    seq: 1,
    ts: 0,
    kind: "text",
    net: "net1",
    buf: "#Chan",
    nick: "Bot",
    text: "hello",
  };
  assertEquals(matchesWait(event, { buf: "#chan" }), true);
  assertEquals(matchesWait(event, { nick: "bot" }), true);
  assertEquals(matchesWait(event, { nick: "other" }), false);
});

Deno.test("pattern matches text, raw and extra payloads", () => {
  const notice: BridgeEvent = {
    seq: 1,
    ts: 0,
    kind: "notice",
    net: "net1",
    text: "Pack 42 not found",
  };
  assertEquals(matchesWait(notice, { pattern: "not found" }), true);
  assertEquals(matchesWait(notice, { pattern: "PACK 42" }), true);
  assertEquals(matchesWait(notice, { pattern: "pack 43" }), false);

  const raw: BridgeEvent = {
    seq: 2,
    ts: 0,
    kind: "raw",
    net: "net1",
    raw: ":server 401 me bot :No such nick",
  };
  assertEquals(matchesWait(raw, { pattern: "no such nick" }), true);

  const ctcp: BridgeEvent = {
    seq: 3,
    ts: 0,
    kind: "ctcp",
    net: "net1",
    extra: { ctcp: "DCC", text: "SEND file.mkv" },
  };
  assertEquals(matchesWait(ctcp, { pattern: "send file" }), true);
});

Deno.test("kind and network filters exclude non-matching events", () => {
  const event: BridgeEvent = { seq: 1, ts: 0, kind: "text", net: "net1" };
  assertEquals(matchesWait(event, { kind: "notice" }), false);
  assertEquals(matchesWait(event, { net: "net2" }), false);
  assertEquals(matchesWait(event, {}), true);
});

Deno.test("a wait ignores events at or before its cursor", async () => {
  const { log, bus, record } = harness();
  const cursor = log.cursor;
  record({ kind: "notice", net: "net1", text: "before" });

  // Even though a matching event exists, it is behind the cursor, so it must be
  // treated as already seen rather than resolving the wait.
  const result = await waitForEvent({
    log,
    bus,
    matcher: { kind: "notice" },
    since: cursor + 1,
    timeoutMs: 20,
  });
  assertEquals(result, undefined);
});
