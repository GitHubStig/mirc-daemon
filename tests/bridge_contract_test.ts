/**
 * Contract tests for the other half of the system.
 *
 * `mirc/bridge.mrc` cannot run here, but the frames it emits are deterministic
 * and hand-built. This test speaks those exact shapes over a raw socket, so a key
 * renamed on one side and not the other fails here rather than in mIRC — which is
 * exactly how the `res.data` mismatch was found.
 *
 * Command ids are read from the daemon's own frames rather than assumed, so the
 * tests do not depend on how many commands came before them.
 */

import { assertEquals } from "@std/assert";
import { nullLogger } from "../src/core/log.ts";
import { type RunningMircListener, startMircListener } from "../src/mirc/listener.ts";
import { until } from "./fake_mirc.ts";

const TOKEN = "test-token";

type Frame = Record<string, unknown>;

/** A raw socket client that writes and reads whole JSON lines. */
class RawMirc {
  #conn: Deno.Conn;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = "";
  #queue: string[] = [];
  #decoder = new TextDecoder();

  private constructor(conn: Deno.Conn) {
    this.#conn = conn;
    this.#reader = conn.readable.getReader();
  }

  static async connect(hostname: string, port: number): Promise<RawMirc> {
    return new RawMirc(await Deno.connect({ hostname, port }));
  }

  send(frame: unknown): void {
    void this.#conn.write(new TextEncoder().encode(JSON.stringify(frame) + "\n"));
  }

  /** Next frame from the daemon, or undefined if none arrives in time. */
  async next(timeoutMs = 2000): Promise<Frame | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const queued = this.#queue.shift();
      if (queued !== undefined) return JSON.parse(queued);

      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      const chunk = await Promise.race([
        this.#reader.read(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), remaining)),
      ]);
      if (!chunk || chunk.done) return undefined;
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
      let nl = this.#buffer.indexOf("\n");
      while (nl !== -1) {
        this.#queue.push(this.#buffer.slice(0, nl).trim());
        this.#buffer = this.#buffer.slice(nl + 1);
        nl = this.#buffer.indexOf("\n");
      }
    }
  }

  /** Read until a `cmd` frame arrives, so its id is the real one. */
  async nextCommand(action?: string): Promise<Frame> {
    for (;;) {
      const frame = await this.next();
      if (!frame) throw new Error(`no command${action ? ` for ${action}` : ""} arrived`);
      if (frame.t === "cmd" && (action === undefined || frame.action === action)) return frame;
    }
  }

  async close(): Promise<void> {
    try {
      await this.#reader.cancel();
    } catch {
      // already gone
    }
    try {
      this.#conn.close();
    } catch {
      // already closed
    }
  }
}

interface Harness {
  listener: RunningMircListener;
  mirc: RawMirc;
  session(): ReturnType<RunningMircListener["registry"]["get"]>;
  stop(): Promise<void>;
}

/** Attach, then answer the state query the daemon always issues on connect. */
async function attach(): Promise<Harness> {
  const listener = startMircListener({
    hostname: "127.0.0.1",
    port: 0,
    token: TOKEN,
    log: nullLogger(),
    maxInFlight: 1,
    defaultCommandTimeoutMs: 1000,
    helloTimeoutMs: 500,
  });

  const mirc = await RawMirc.connect(listener.addr.hostname, listener.addr.port);
  mirc.send({ t: "hello", v: 1, token: TOKEN, nick: "me", mirc: "7.75" });

  const welcome = await mirc.next();
  assertEquals(welcome?.t, "welcome");

  const stateCmd = await mirc.nextCommand("state");
  // The exact shape bridge.do.state builds, wrapped in `data` as the daemon reads it.
  mirc.send({
    t: "res",
    id: stateCmd.id,
    ok: true,
    data: {
      networks: [{
        name: "net1",
        status: "connected",
        nick: "me",
        channels: [],
        members: {},
      }],
    },
  });

  const session = listener.registry.get("s1")!;
  await until(() => session.state.networks().length === 1, { label: "state seeded" });

  return {
    listener,
    mirc,
    session: () => listener.registry.get("s1"),
    async stop() {
      await mirc.close();
      await listener.close();
    },
  };
}

Deno.test("the state reply shape bridge.mrc emits is understood", async () => {
  const h = await attach();
  try {
    const session = h.session()!;
    const refreshed = session.refreshState();
    const cmd = await h.mirc.nextCommand("state");
    h.mirc.send({
      t: "res",
      id: cmd.id,
      ok: true,
      data: {
        networks: [{
          name: "net1",
          status: "connected",
          nick: "me",
          channels: ["#chan", "#other"],
          members: { "#chan": 3, "#other": 1 },
        }],
      },
    });
    assertEquals(await refreshed, undefined);

    const net = session.state.resolve();
    assertEquals(net.name, "net1");
    assertEquals(net.status, "connected");
    assertEquals(net.nick, "me");
    assertEquals(session.state.isJoined(net, "#chan"), true);
    assertEquals(session.state.memberCount(net, "#chan"), 3);
  } finally {
    await h.stop();
  }
});

Deno.test("a join reply carrying members, and one carrying a numeric, are both read", async () => {
  const h = await attach();
  try {
    const session = h.session()!;

    const joined = session.commands.send("join", { channel: "#chan" }, { context: "join" });
    const okCmd = await h.mirc.nextCommand("join");
    h.mirc.send({ t: "res", id: okCmd.id, ok: true, data: { joined: "#chan", members: 7 } });
    const okOutcome = await joined;
    assertEquals(okOutcome.ok, true);
    if (okOutcome.ok) assertEquals(okOutcome.data?.members, 7);

    const refused = session.commands.send("join", { channel: "#secret" }, { context: "join" });
    const failCmd = await h.mirc.nextCommand("join");
    h.mirc.send({
      t: "res",
      id: failCmd.id,
      ok: false,
      numeric: 473,
      err: "Cannot join channel (+i)",
    });
    const failOutcome = await refused;
    assertEquals(failOutcome.ok, false);
    if (!failOutcome.ok) {
      assertEquals(failOutcome.error.code, "join_failed");
      assertEquals(failOutcome.error.numeric, 473);
    }
  } finally {
    await h.stop();
  }
});

Deno.test("the event shapes bridge.mrc emits land in the right places", async () => {
  const h = await attach();
  try {
    const session = h.session()!;

    h.mirc.send({
      t: "ev",
      kind: "text",
      net: "net1",
      buf: "#chan",
      nick: "someone",
      user: "someone!u@host",
      text: "hello there",
    });
    await until(() => session.log.size >= 1, { label: "text event" });
    const text = session.log.snapshot()[0];
    assertEquals(text.kind, "text");
    assertEquals(text.buf, "#chan");
    assertEquals(text.text, "hello there");

    // Our own join, before any rename, so the nick still matches.
    h.mirc.send({ t: "ev", kind: "join", net: "net1", buf: "#chan", nick: "me" });
    await until(() => session.state.isJoined(session.state.resolve(), "#chan"), {
      label: "join applied",
    });

    h.mirc.send({ t: "ev", kind: "selfnick", net: "net1", extra: { old: "me", new: "me_" } });
    await until(() => session.state.resolve().nick === "me_", { label: "nick adopted" });

    h.mirc.send({
      t: "ev",
      kind: "raw",
      net: "net1",
      raw: ":server 401 me nobody :No such nick",
    });
    await until(() => session.log.snapshot().some((e) => e.kind === "raw"), {
      label: "raw event",
    });
  } finally {
    await h.stop();
  }
});

Deno.test("DCC outcome shapes close a job as complete or failed", async () => {
  const h = await attach();
  try {
    const session = h.session()!;

    session.dcc.start({ net: "net1", bot: "XDCC-Bot", pack: "42" });
    h.mirc.send({
      t: "ev",
      kind: "dcc",
      net: "net1",
      extra: { event: "complete", file: "pack042.mkv", from: "XDCC-Bot" },
    });
    await until(() => session.dcc.latest()?.state === "complete", { label: "complete" });
    assertEquals(session.dcc.latest()?.file, "pack042.mkv");

    session.dcc.start({ net: "net1", bot: "XDCC-Bot", pack: "43" });
    h.mirc.send({
      t: "ev",
      kind: "dcc",
      net: "net1",
      extra: { event: "getfail", file: "pack043.mkv", from: "XDCC-Bot" },
    });
    await until(() => session.dcc.latest()?.state === "failed", { label: "failed" });
    assertEquals(session.dcc.recentFailures().length, 1);
  } finally {
    await h.stop();
  }
});
