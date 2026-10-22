import { assertEquals } from "@std/assert";
import { EventLog, type NewEvent } from "../src/core/buffers.ts";

const at = (input: NewEvent) => input;

Deno.test("append assigns an increasing sequence and a timestamp", () => {
  const log = new EventLog();
  assertEquals(log.cursor, 0);
  const first = log.append(at({ kind: "text", net: "net1", text: "one" }));
  const second = log.append(at({ kind: "text", net: "net1", text: "two" }));
  assertEquals(first.seq, 1);
  assertEquals(second.seq, 2);
  assertEquals(log.cursor, 2);
  assertEquals(typeof first.ts, "number");
});

Deno.test("an explicit timestamp is preserved", () => {
  const log = new EventLog();
  const event = log.append(at({ kind: "text", net: "net1", ts: 1234 }));
  assertEquals(event.ts, 1234);
});

Deno.test("since returns only what is past the cursor, oldest first", () => {
  const log = new EventLog();
  log.append(at({ kind: "text", net: "net1", text: "a" }));
  const cursor = log.cursor;
  log.append(at({ kind: "text", net: "net1", text: "b" }));
  log.append(at({ kind: "text", net: "net1", text: "c" }));

  assertEquals(log.since(cursor).map((e) => e.text), ["b", "c"]);
  assertEquals(log.since(log.cursor), []);
  assertEquals(log.since(0).length, 3);
});

Deno.test("since filters by network, buffer and kind", () => {
  const log = new EventLog();
  log.append(at({ kind: "text", net: "net1", buf: "#a" }));
  log.append(at({ kind: "text", net: "net1", buf: "#b" }));
  log.append(at({ kind: "notice", net: "net1", buf: "#a" }));
  log.append(at({ kind: "text", net: "net2", buf: "#a" }));

  assertEquals(log.since(0, { net: "net1" }).length, 3);
  assertEquals(log.since(0, { buf: "#a" }).length, 3);
  assertEquals(log.since(0, { net: "net1", buf: "#a" }).length, 2);
  assertEquals(log.since(0, { kinds: ["notice"] }).length, 1);
});

Deno.test("limit keeps the newest matches, not the oldest", () => {
  const log = new EventLog();
  for (let i = 1; i <= 5; i++) log.append(at({ kind: "text", net: "net1", text: `m${i}` }));
  assertEquals(log.since(0, { limit: 2 }).map((e) => e.text), ["m4", "m5"]);
  assertEquals(log.since(0, { limit: 99 }).length, 5);
});

Deno.test("capacity trims the oldest events, and cursors keep moving", () => {
  const log = new EventLog(3);
  for (let i = 1; i <= 5; i++) log.append(at({ kind: "text", net: "net1", text: `m${i}` }));
  assertEquals(log.size, 3);
  assertEquals(log.cursor, 5);
  // The trimmed events are gone, but ids stay monotonic so a stale cursor is
  // still meaningful rather than aliasing newer events.
  assertEquals(log.since(0).map((e) => e.seq), [3, 4, 5]);
});

Deno.test("findFirst returns the earliest match after the cursor", () => {
  const log = new EventLog();
  log.append(at({ kind: "text", net: "net1", text: "one" }));
  log.append(at({ kind: "text", net: "net1", text: "two" }));
  log.append(at({ kind: "text", net: "net1", text: "three" }));

  assertEquals(log.findFirst(0, (e) => e.text === "two")?.seq, 2);
  assertEquals(log.findFirst(2, (e) => e.text === "two"), undefined);
  assertEquals(log.findFirst(0, (e) => e.text === "nope"), undefined);
});

Deno.test("clear empties the log without resetting the cursor", () => {
  const log = new EventLog();
  log.append(at({ kind: "text", net: "net1" }));
  const cursor = log.cursor;
  log.clear();
  assertEquals(log.size, 0);
  assertEquals(log.cursor, cursor);
});

Deno.test("a capacity below one is rejected rather than silently useless", () => {
  let threw = false;
  try {
    new EventLog(0);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("keep: oldest pages forward instead of skipping to the newest", () => {
  const log = new EventLog();
  for (let i = 1; i <= 5; i++) log.append(at({ kind: "text", net: "net1", text: `m${i}` }));
  assertEquals(log.since(1, { limit: 2, keep: "oldest" }).map((e) => e.text), ["m2", "m3"]);
  assertEquals(log.since(1, { limit: 2 }).map((e) => e.text), ["m4", "m5"]);
});
