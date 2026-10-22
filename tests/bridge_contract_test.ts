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
import { toWireCommand } from "../src/core/wire.ts";
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
    this.sendLine(JSON.stringify(frame));
  }

  /**
   * Send a line exactly as given. `send` goes through JSON.stringify, which can
   * never produce the malformed JSON a hand-built mSL frame can — so on its own
   * it hid the escaping bugs this file exists to catch.
   */
  sendLine(line: string): void {
    void this.#conn.write(new TextEncoder().encode(line + "\r\n"));
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
  mirc.send({ t: "hello", v: 2, token: TOKEN, nick: "me", mirc: "7.75" });

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
    // The line itself must survive, not just the fact that one arrived.
    const raw = session.log.snapshot().find((e) => e.kind === "raw");
    assertEquals(raw?.raw, ":server 401 me nobody :No such nick");
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

// ---------------------------------------------------------------------------
// String escaping, both directions.
//
// These are TypeScript ports of jstr, jval and jparam in bridge.mrc, kept
// step-for-step so a change to one has an obvious twin in the other. A port
// cannot prove mSL behaves the same -- /bridge.diag's b64-test does that inside
// mIRC -- but it pins down the algorithm and feeds each side real bytes.
// ---------------------------------------------------------------------------

/** bridge.mrc `jstr`: escape and quote. */
function mslJstr(input: string, { escapeControls = true } = {}): string {
  let s = input
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  if (escapeControls) {
    for (let i = 1; i < 32; i++) {
      // $base(%i, 10, 16, 2) is upper-case hex, which JSON accepts.
      const hex = i.toString(16).toUpperCase().padStart(2, "0");
      s = s.replaceAll(String.fromCharCode(i), "\\u00" + hex);
    }
  }
  return `"${s}"`;
}

/** bridge.mrc `jval`: up to the next quote, no unescaping. */
function mslJval(frame: string, key: string): string | undefined {
  return new RegExp(`"${key}":"([^"]*)"`).exec(frame)?.[1];
}

/** bridge.mrc `jparam`: jval, then base64 into a binvar, read back as UTF-8. */
function mslJparam(frame: string, key: string): string | undefined {
  const b64 = mslJval(frame, key);
  if (b64 === undefined || b64 === "") return undefined;
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

const COLOURED = "\x02** 3 packs **\x02 \x0304#1\x03 \x1fpack.mkv\x1f\x0f";

Deno.test("coloured IRC text, escaped as bridge.mrc escapes it, arrives intact", async () => {
  const h = await attach();
  try {
    const session = h.session()!;
    h.mirc.sendLine(
      `{"t":"ev","kind":"notice","net":"net1","buf":"XDCC-Bot","nick":"XDCC-Bot","text":${
        mslJstr(COLOURED)
      }}`,
    );
    await until(() => session.log.size >= 1, { label: "notice event" });
    assertEquals(session.log.snapshot()[0].text, COLOURED);
  } finally {
    await h.stop();
  }
});

Deno.test("a frame with raw control characters still parses, should jstr ever regress", async () => {
  // Defence in depth: jstr escapes these, but if that ever breaks, the failure
  // would be every coloured line silently dropped.
  const h = await attach();
  try {
    const session = h.session()!;
    h.mirc.sendLine(
      `{"t":"ev","kind":"text","net":"net1","buf":"#chan","nick":"bot","text":${
        mslJstr(COLOURED, { escapeControls: false })
      }}`,
    );
    await until(() => session.log.size >= 1, { label: "text event" });
    assertEquals(session.log.snapshot()[0].text, COLOURED);
  } finally {
    await h.stop();
  }
});

Deno.test("jparam recovers what the daemon sends, quotes and backslashes included", () => {
  const cases: Array<[string, string]> = [
    ['say "hi"', 'say "hi"'],
    ["C:\\dir\\new", "C:\\dir\\new"],
    ["ends in a backslash \\", "ends in a backslash \\"],
    ["\\n is not a newline", "\\n is not a newline"],
    ["tab\there", "tab\there"],
    ["\x02bold\x02 and \x0304colour", "\x02bold\x02 and \x0304colour"],
    ["ünïcode ✓", "ünïcode ✓"],
    // A real line break must not reach IRC as one: it would start a new command.
    ["line1\nline2\r\nQUIT", "line1 line2 QUIT"],
    // Text that looks like another key must not be mistaken for it.
    ['x","target":"#evil', 'x","target":"#evil'],
  ];
  for (const [text, expected] of cases) {
    // The daemon's real encoding; encodeFrame then adds only CRLF.
    const line = JSON.stringify(
      toWireCommand({ t: "cmd", id: "c1", action: "msg", params: { target: "#x", text } }),
    );
    assertEquals(mslJparam(line, "text"), expected, `text: ${JSON.stringify(text)}`);
    assertEquals(mslJparam(line, "target"), "#x", `target beside: ${JSON.stringify(text)}`);
    // The envelope stays plain, which is what lets jval read it without decoding.
    assertEquals(mslJval(line, "action"), "msg");
  }
});

Deno.test("a command on the socket carries base64 params that jparam decodes", async () => {
  const h = await attach();
  try {
    const sent = h.session()!.commands.send("msg", { target: "#chan", text: 'say "hi" ü' });
    const cmd = await h.mirc.nextCommand("msg");
    const params = cmd.params as Record<string, string>;
    assertEquals(params.text.includes('"'), false);
    assertEquals(mslJparam(JSON.stringify(cmd), "text"), 'say "hi" ü');
    h.mirc.send({ t: "res", id: cmd.id, ok: true });
    assertEquals((await sent).ok, true);
  } finally {
    await h.stop();
  }
});

Deno.test("the diag self-test vector in bridge.mrc is the daemon's real encoding", async () => {
  // /bridge.diag decodes this literal inside mIRC; if the encoding ever changes,
  // the literal has to change with it or the in-client check proves nothing.
  const mrc = await Deno.readTextFile(new URL("../mirc/bridge.mrc", import.meta.url));
  const vector = /\$kvo\(text, \$jstr\(([A-Za-z0-9+/=]+)\)\)/.exec(mrc)?.[1];
  const wire = toWireCommand({
    t: "cmd",
    id: "c1",
    action: "echo",
    params: { text: 'say "hi" C:\\dir \u00fc\u0002b' },
  });
  assertEquals(vector, (wire.params as Record<string, string>).text);
});

Deno.test("a v1 bridge.mrc is refused with a reason, not served", async () => {
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
  try {
    mirc.send({ t: "hello", v: 1, token: TOKEN, nick: "me", mirc: "7.75" });
    const bye = await mirc.next();
    assertEquals(bye?.t, "bye");
    assertEquals(String(bye?.reason).includes("bridge.mrc"), true);
    // Plain ASCII without quotes, because jval reads it undecoded.
    assertEquals(/["\\]/.test(String(bye?.reason)), false);
    assertEquals(await mirc.next(500), undefined);
    assertEquals(listener.registry.size, 0);
  } finally {
    await mirc.close();
    await listener.close();
  }
});

Deno.test("jstr output is valid JSON that decodes to the original", () => {
  for (const text of [COLOURED, 'q"uote', "back\\slash", "a\tb", "\x01ACTION waves\x01"]) {
    assertEquals(JSON.parse(mslJstr(text)), text);
  }
});
