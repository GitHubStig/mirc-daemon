import { assertEquals } from "@std/assert";
import { CommandDispatcher } from "../src/core/commands.ts";
import { FrameTooLargeError } from "../src/core/wire.ts";
import type { CmdFrame, ResFrame } from "../src/core/types.ts";

/** Let queued microtasks run so a send reaches the wire. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: { maxInFlight?: number; defaultTimeoutMs?: number } = {}) {
  const written: CmdFrame[] = [];
  const dispatcher = new CommandDispatcher({
    write: (frame) => written.push(frame),
    ...options,
  });
  const reply = (id: string, overrides: Partial<ResFrame> = {}) =>
    dispatcher.handleRes({ t: "res", id, ok: true, ...overrides });
  return { written, dispatcher, reply };
}

Deno.test("a command that mIRC answers resolves with its data", async () => {
  const { written, dispatcher, reply } = harness();
  const pending = dispatcher.send("join", { channel: "#chan" });
  await tick();

  assertEquals(written.length, 1);
  assertEquals(written[0].action, "join");
  assertEquals(written[0].params, { channel: "#chan" });

  reply(written[0].id, { ok: true, data: { joined: "#chan", members: 42 } });
  const outcome = await pending;
  assertEquals(outcome.ok, true);
  if (outcome.ok) assertEquals(outcome.data, { joined: "#chan", members: 42 });
});

Deno.test("a refusal comes back as a code from the taxonomy", async () => {
  const { written, dispatcher, reply } = harness();
  const pending = dispatcher.send("join", { channel: "#secret" }, { context: "join" });
  await tick();
  reply(written[0].id, { ok: false, numeric: 473, err: "Cannot join channel (+i)" });

  const outcome = await pending;
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.error.code, "join_failed");
    assertEquals(outcome.error.numeric, 473);
  }
});

Deno.test("silence becomes a timeout, never a hang", async () => {
  const { dispatcher } = harness({ defaultTimeoutMs: 20 });
  const outcome = await dispatcher.send("join");
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.error.code, "timeout");
});

Deno.test("one credit at a time: the second command waits for the first answer", async () => {
  const { written, dispatcher, reply } = harness({ maxInFlight: 1 });
  const first = dispatcher.send("msg");
  const second = dispatcher.send("say");

  await tick();
  assertEquals(written.length, 1);
  assertEquals(dispatcher.queueDepth, 1);
  assertEquals(dispatcher.outstanding, 1);

  reply(written[0].id);
  await first;
  await tick();
  assertEquals(written.length, 2);

  reply(written[1].id);
  await second;
  assertEquals(dispatcher.outstanding, 0);
});

Deno.test("a pending connect holds up no quick command, and no join", async () => {
  // Live, an EFnet connect took 50 s, and every tool call waited behind it.
  const { written, dispatcher, reply } = harness({ maxInFlight: 1 });
  const connect = dispatcher.send("connect", { server: "irc.efnet.org" });
  const state = dispatcher.send("conns");
  const join = dispatcher.send("join", { channel: "#elsewhere" });
  await tick();
  assertEquals(written.map((f) => f.action), ["connect", "conns", "join"]);

  reply(written[1].id);
  reply(written[2].id);
  assertEquals((await state).ok, true);
  assertEquals((await join).ok, true);
  reply(written[0].id);
  assertEquals((await connect).ok, true);
});

Deno.test("two of one deferred kind never overlap: bridge.mrc has one slot for each", async () => {
  const { written, dispatcher, reply } = harness({ maxInFlight: 3 });
  const first = dispatcher.send("join", { channel: "#a" });
  const second = dispatcher.send("join", { channel: "#b" });
  await tick();
  assertEquals(written.length, 1);
  assertEquals(dispatcher.queueDepth, 1);

  reply(written[0].id);
  await first;
  await tick();
  assertEquals(written.map((f) => f.params?.channel), ["#a", "#b"]);
  reply(written[1].id);
  await second;
});

Deno.test("with more credits, commands are in flight together", async () => {
  const { written, dispatcher, reply } = harness({ maxInFlight: 3 });
  const first = dispatcher.send("join");
  const second = dispatcher.send("say");
  await tick();

  assertEquals(written.length, 2);
  assertEquals(dispatcher.outstanding, 2);

  reply(written[0].id);
  reply(written[1].id);
  assertEquals((await first).ok, true);
  assertEquals((await second).ok, true);
});

Deno.test("each answer goes to the command that asked for it", async () => {
  const { written, dispatcher, reply } = harness({ maxInFlight: 2 });
  const join = dispatcher.send("join", { channel: "#a" });
  const say = dispatcher.send("say", { channel: "#b", text: "hi" });
  await tick();

  // Answer out of order on purpose; correlation is by id, not by arrival.
  reply(written[1].id, { ok: true, data: { which: "say" } });
  reply(written[0].id, { ok: true, data: { which: "join" } });

  const joinOutcome = await join;
  const sayOutcome = await say;
  assertEquals(joinOutcome.ok && joinOutcome.data?.which, "join");
  assertEquals(sayOutcome.ok && sayOutcome.data?.which, "say");
});

Deno.test("an answer that arrives after the timeout is ignored", async () => {
  const { written, dispatcher, reply } = harness({ defaultTimeoutMs: 20 });
  const outcome = await dispatcher.send("join");
  assertEquals(outcome.ok, false);

  // Must not throw, and must not resurrect the dead promise.
  reply(written[0].id);
  assertEquals(dispatcher.outstanding, 0);
});

Deno.test("an unknown answer id is ignored", () => {
  const { dispatcher } = harness();
  dispatcher.handleRes({ t: "res", id: "never-sent", ok: true });
  assertEquals(dispatcher.outstanding, 0);
});

Deno.test("a dropped connection fails everything in flight with a clear reason", async () => {
  const { written, dispatcher } = harness({ maxInFlight: 2 });
  const first = dispatcher.send("join");
  const second = dispatcher.send("say");
  await tick();
  assertEquals(written.length, 2);

  dispatcher.close("socket closed");
  const outcomes = await Promise.all([first, second]);
  for (const outcome of outcomes) {
    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.error.code, "connect_failed");
      assertEquals(outcome.error.detail, "socket closed");
    }
  }
});

Deno.test("after the connection drops, new commands fail immediately", async () => {
  const { dispatcher } = harness();
  dispatcher.close("gone");
  const outcome = await dispatcher.send("join");
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.error.code, "connect_failed");
});

Deno.test("a command queued behind a drop fails rather than hanging", async () => {
  const { written, dispatcher } = harness({ maxInFlight: 1 });
  const first = dispatcher.send("msg");
  const queued = dispatcher.send("say");
  await tick();
  assertEquals(written.length, 1);

  // The socket dies while the second command is still waiting for a credit.
  dispatcher.close("socket closed");
  const queuedOutcome = await queued;
  assertEquals(queuedOutcome.ok, false);
  if (!queuedOutcome.ok) assertEquals(queuedOutcome.error.code, "connect_failed");
  await first;
});

Deno.test("a frame that cannot be encoded fails the command instead of the process", async () => {
  const dispatcher = new CommandDispatcher({
    write: () => {
      throw new Error("frame is 9999 bytes, over the 3500-byte limit");
    },
  });
  const outcome = await dispatcher.send("say", { text: "x".repeat(9999) });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.error.code, "connect_failed");
    assertEquals(outcome.error.hint.includes("could not send"), true);
  }
  assertEquals(dispatcher.outstanding, 0);
});

Deno.test("a frame too large to send is too_long, not a dropped connection", async () => {
  const dispatcher = new CommandDispatcher({
    write: () => {
      throw new FrameTooLargeError(9000, 3500);
    },
    defaultTimeoutMs: 1000,
  });
  const outcome = await dispatcher.send("msg", { target: "#x", text: "long" });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.error.code, "too_long");
    assertEquals(outcome.error.hint.includes("9000 bytes"), true);
  }
  // The credit is returned, so the next command is not stuck behind it.
  assertEquals(dispatcher.outstanding, 0);
});

Deno.test("an unanswered command asks mIRC for a sign of life, and its timeout says why", async () => {
  const probes: number[] = [];
  const dispatcher = new CommandDispatcher({
    write: () => {},
    defaultTimeoutMs: 80,
    liveness: {
      probe: () => probes.push(Date.now()),
      explainSilence: () => "mIRC has sent nothing for 9 s, not even an answer to a ping.",
    },
  });
  const outcome = await dispatcher.send("join", { channel: "#chan" });
  assertEquals(probes.length, 1);
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.error.code, "timeout");
    assertEquals(outcome.error.hint.endsWith("not even an answer to a ping."), true);
  }
});

Deno.test("an answered command is never probed", async () => {
  let probes = 0;
  const written: CmdFrame[] = [];
  const dispatcher = new CommandDispatcher({
    write: (frame) => written.push(frame),
    defaultTimeoutMs: 200,
    liveness: { probe: () => probes++, explainSilence: () => undefined },
  });
  const pending = dispatcher.send("join", { channel: "#chan" });
  await tick();
  dispatcher.handleRes({ t: "res", id: written[0].id, ok: true });
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assertEquals(probes, 0);
});
