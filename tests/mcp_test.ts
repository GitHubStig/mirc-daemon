import { assertEquals } from "@std/assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLogger, type LogSink, nullLogger } from "../src/core/log.ts";
import type { NetworkState } from "../src/core/types.ts";
import { type RunningHttpServer, startHttpServer } from "../src/http/server.ts";
import { type RunningMcp, startMcp } from "../src/mcp/server.ts";
import { type RunningMircListener, startMircListener } from "../src/mirc/listener.ts";
import { FakeMirc, until } from "./fake_mirc.ts";

const TOKEN = "test-token";

function network(overrides: Partial<NetworkState> = {}): NetworkState {
  return {
    cid: 1,
    name: "net1",
    server: "irc.example.net",
    port: 6667,
    status: "connected",
    nick: "me",
    channels: ["#chan"],
    members: { "#chan": 42 },
    ...overrides,
  };
}

interface Stack {
  mirc: RunningMircListener;
  mcp: RunningMcp;
  http: RunningHttpServer;
  fake: FakeMirc;
  client: Client;
  stop(): Promise<void>;
}

/**
 * The whole pipeline: a fake mIRC dialled in, the MCP surface mounted behind the
 * agent door, and the SDK's own client speaking to it over HTTP. This is the
 * closest thing to the real deployment that runs without mIRC present.
 */
async function stack(options: { allowRaw?: boolean; log?: LogSink } = {}): Promise<Stack> {
  const mirc = startMircListener({
    hostname: "127.0.0.1",
    port: 0,
    token: TOKEN,
    log: nullLogger(),
    maxInFlight: 1,
    defaultCommandTimeoutMs: 500,
    helloTimeoutMs: 500,
  });

  const fake = await FakeMirc.connect(mirc.addr.hostname, mirc.addr.port, {
    token: TOKEN,
    networks: [network()],
  });
  await until(() => mirc.registry.size === 1, { label: "mIRC attached" });

  const mcp = startMcp({
    registry: mirc.registry,
    log: options.log ?? nullLogger(),
    startedTs: Date.now(),
    stateFreshnessMs: 5000,
    allowRaw: options.allowRaw ?? false,
  });

  const http = startHttpServer({
    hostname: "127.0.0.1",
    port: 0,
    token: TOKEN,
    registry: mirc.registry,
    log: nullLogger(),
    startedTs: Date.now(),
    mcp,
  });

  const client = new Client({ name: "mirc-daemon-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${http.addr.port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } },
  );
  await client.connect(transport);

  return {
    mirc,
    mcp,
    http,
    fake,
    client,
    async stop() {
      await client.close();
      await http.close();
      await mcp.close();
      await fake.close();
      await mirc.close();
    },
  };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

Deno.test("every tool call is logged with its name, duration and outcome", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const log = createLogger({ dir, mirrorToConsole: false });
    const s = await stack({ log });
    try {
      await s.client.callTool({ name: "daemon_status", arguments: {} });

      s.fake.setHandler((cmd) =>
        cmd.action === "join"
          ? { ok: false, numeric: 473, err: "Cannot join channel (+i)" }
          : undefined
      );
      await s.client.callTool({ name: "irc_join", arguments: { channel: "#secret" } });

      // A credential passed as a tool argument must be redacted like any other.
      await s.client.callTool({
        name: "irc_connect",
        arguments: { server: "irc.example.net", password: "hunter2" },
      });
    } finally {
      await s.stop();
      await log.close();
    }

    const file = [...Deno.readDirSync(dir)].map((e) => `${dir}/${e.name}`)[0];
    const raw = await Deno.readTextFile(file);
    const calls = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((record) => record.kind === "tool.call");

    const status = calls.find((r) => r.tool === "daemon_status");
    assertEquals(status?.ok, true);
    assertEquals(typeof status?.ms, "number");

    const refused = calls.find((r) => r.tool === "irc_join");
    assertEquals(refused?.ok, false);
    assertEquals(refused?.code, "join_failed");

    const connect = calls.find((r) => r.tool === "irc_connect");
    assertEquals(connect?.args?.password, "<redacted>");
    assertEquals(raw.includes("hunter2"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the MCP surface advertises the tools an agent needs", async () => {
  const s = await stack();
  try {
    const { tools } = await s.client.listTools();
    const listed = tools as Array<{ name: string; description?: string }>;
    const names = listed.map((t) => t.name).sort();

    for (
      const expected of [
        "daemon_status",
        "irc_connect",
        "irc_dcc_status",
        "irc_ensure_connected",
        "irc_ensure_joined",
        "irc_get_state",
        "irc_ison",
        "irc_join",
        "irc_members",
        "irc_notice",
        "irc_notify",
        "irc_part",
        "irc_raw",
        "irc_read",
        "irc_send",
        "irc_wait_for",
        "xdcc_fetch",
        "xdcc_list",
      ]
    ) {
      assertEquals(names.includes(expected), true, `missing tool: ${expected}`);
    }

    // Descriptions are model-facing, so an empty one is a defect.
    for (const tool of listed) {
      assertEquals((tool.description ?? "").length > 10, true, `thin description: ${tool.name}`);
    }
  } finally {
    await s.stop();
  }
});

Deno.test("daemon_status reports the attached mIRC", async () => {
  const s = await stack();
  try {
    const result = await s.client.callTool({ name: "daemon_status", arguments: {} });
    const body = JSON.parse(textOf(result));
    assertEquals(body.mircAttached, true);
    assertEquals(body.sessions, 1);
    assertEquals(body.nick, "me");
    // An agent that sees no tools needs to be able to tell "daemon down" from
    // "nothing to do", so the instruction text must be present too.
    const instructions = s.client.getInstructions();
    assertEquals((instructions ?? "").includes("mirc-daemon"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("irc_get_state reflects what mIRC reported at attach time", async () => {
  const s = await stack();
  try {
    const result = await s.client.callTool({ name: "irc_get_state", arguments: {} });
    const body = JSON.parse(textOf(result));
    assertEquals(body.networks.length, 1);
    assertEquals(body.networks[0].name, "net1");
    assertEquals(body.networks[0].nick, "me");
    assertEquals(body.networks[0].channels.includes("#chan"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("a tool command reaches mIRC and the answer comes back through MCP", async () => {
  const s = await stack();
  try {
    const result = await s.client.callTool({
      name: "irc_join",
      arguments: { channel: "#new" },
    });
    assertEquals(result.isError ?? false, false);

    const join = s.fake.received.find((c) => c.action === "join");
    assertEquals(join?.params?.channel, "#new");
  } finally {
    await s.stop();
  }
});

Deno.test("a refusal is surfaced as a code, not a success", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd) =>
      cmd.action === "join"
        ? { ok: false, numeric: 473, err: "Cannot join channel (+i)" }
        : undefined
    );
    const result = await s.client.callTool({
      name: "irc_join",
      arguments: { channel: "#secret" },
    });
    assertEquals(result.isError, true);
    assertEquals(textOf(result).startsWith("join_failed:"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("irc_wait_for returns the bot's reply as it arrives", async () => {
  const s = await stack();
  try {
    const pending = s.client.callTool({
      name: "irc_wait_for",
      arguments: { nick: "XDCC-Bot", pattern: "pack", timeoutMs: 3000 },
    });
    // Give the call time to reach the server and subscribe before emitting.
    await until(() => true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    s.fake.emit("notice", { buf: "me", nick: "XDCC-Bot", text: "sending pack042" });

    const body = JSON.parse(textOf(await pending));
    assertEquals(body.matched, true);
    assertEquals(body.event.nick, "XDCC-Bot");
  } finally {
    await s.stop();
  }
});

Deno.test("irc_wait_for reports a miss rather than hanging or throwing", async () => {
  const s = await stack();
  try {
    const result = await s.client.callTool({
      name: "irc_wait_for",
      arguments: { nick: "nobody", timeoutMs: 150 },
    });
    const body = JSON.parse(textOf(result));
    assertEquals(body.matched, false);
  } finally {
    await s.stop();
  }
});

Deno.test("irc_raw is denied by default and permitted only when enabled", async () => {
  const closed = await stack();
  try {
    const result = await closed.client.callTool({
      name: "irc_raw",
      arguments: { line: "QUIT :bye", confirm: true },
    });
    assertEquals(result.isError, true);
    assertEquals(textOf(result).startsWith("guard_denied:"), true);
    assertEquals(closed.fake.received.some((c) => c.action === "raw"), false);
  } finally {
    await closed.stop();
  }

  const open = await stack({ allowRaw: true });
  try {
    const result = await open.client.callTool({
      name: "irc_raw",
      arguments: { line: "PING :x", confirm: true },
    });
    assertEquals(result.isError ?? false, false);
    assertEquals(open.fake.received.some((c) => c.action === "raw"), true);
  } finally {
    await open.stop();
  }
});

Deno.test("a missing token is refused at the door, before MCP sees it", async () => {
  const s = await stack();
  try {
    const response = await fetch(`http://127.0.0.1:${s.http.addr.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assertEquals(response.status, 401);
  } finally {
    await s.stop();
  }
});

Deno.test("the daemon survives an agent disconnecting and reconnecting", async () => {
  const s = await stack();
  try {
    // The agent goes away; mIRC must notice nothing.
    await s.client.close();
    assertEquals(s.mirc.registry.size, 1);

    const second = new Client({ name: "again", version: "0.0.0" });
    await second.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${s.http.addr.port}/mcp`),
        { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } },
      ),
    );
    const result = await second.callTool({ name: "daemon_status", arguments: {} });
    assertEquals(JSON.parse(textOf(result)).mircAttached, true);
    await second.close();
  } finally {
    // client already closed above; stop() tolerates a second close.
    await s.stop();
  }
});

Deno.test("irc_read pages forward from a cursor without skipping anything", async () => {
  const s = await stack();
  try {
    const session = s.mirc.registry.resolve()!;
    const start = session.log.cursor;
    for (let i = 1; i <= 5; i++) s.fake.emit("text", { buf: "#chan", nick: "x", text: `m${i}` });
    await until(() => session.log.cursor >= start + 5, { label: "five events" });

    const seen: string[] = [];
    let cursor = start;
    for (;;) {
      const result = await s.client.callTool({
        name: "irc_read",
        arguments: { since: cursor, limit: 2 },
      });
      const body = JSON.parse(textOf(result));
      seen.push(...body.events.map((e: { text: string }) => e.text));
      cursor = body.cursor;
      if (!body.more) break;
    }
    assertEquals(seen, ["m1", "m2", "m3", "m4", "m5"]);
  } finally {
    await s.stop();
  }
});

Deno.test("a misspelt event kind is refused instead of waiting out its timeout", async () => {
  const s = await stack();
  try {
    const startedTs = Date.now();
    const result = await s.client.callTool({
      name: "irc_wait_for",
      arguments: { kind: "msg", timeoutMs: 5000 },
    });
    assertEquals(result.isError, true);
    assertEquals(Date.now() - startedTs < 2000, true);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_list collects the whole burst and skips the bot's channel adverts", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action === "msg") {
        // An advert in the channel first, then the reply proper, spread over time.
        setTimeout(() => fake.emit("text", { buf: "#chan", nick: "Bot", text: "advert" }), 10);
        setTimeout(() => fake.emit("notice", { buf: "Bot", nick: "Bot", text: "line 1" }), 30);
        setTimeout(() => fake.emit("notice", { buf: "Bot", nick: "Bot", text: "line 2" }), 150);
        setTimeout(() => fake.emit("notice", { buf: "Bot", nick: "Bot", text: "line 3" }), 300);
      }
      return undefined;
    });
    const result = await s.client.callTool({
      name: "xdcc_list",
      arguments: { bot: "Bot", timeoutMs: 5000, quietMs: 400 },
    });
    const body = JSON.parse(textOf(result));
    assertEquals(body.replies.map((e: { text: string }) => e.text), ["line 1", "line 2", "line 3"]);
    assertEquals(body.complete, true);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_fetch asks about the one bot, and an advert is not taken for its reply", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action === "members") return { ok: true, data: { count: 4000, present: true } };
      if (cmd.action === "msg") {
        setTimeout(() => fake.emit("text", { buf: "#chan", nick: "Bot", text: "advert" }), 10);
        setTimeout(() => fake.emit("notice", { buf: "Bot", nick: "Bot", text: "Sending" }), 60);
      }
      return undefined;
    });
    const result = await s.client.callTool({
      name: "xdcc_fetch",
      arguments: { channel: "#chan", bot: "Bot", pack: "42", timeoutMs: 3000 },
    });
    const body = JSON.parse(textOf(result));
    assertEquals(body.reply.text, "Sending");

    const members = s.fake.received.find((c) => c.action === "members");
    assertEquals(members?.params?.nick, "Bot");
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_fetch stops early when mIRC says the bot is absent", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd) =>
      cmd.action === "members" ? { ok: true, data: { count: 10, present: false } } : undefined
    );
    const result = await s.client.callTool({
      name: "xdcc_fetch",
      arguments: { channel: "#chan", bot: "Gone", pack: "1", notifyOnFailure: false },
    });
    assertEquals(textOf(result).startsWith("bot_not_in_channel:"), true);
    assertEquals(s.fake.received.some((c) => c.action === "msg"), false);
  } finally {
    await s.stop();
  }
});

Deno.test("irc_ison sends nicks as one string, so bracketed nicks survive mSL", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd) =>
      cmd.action === "ison" ? { ok: true, data: { present: ["[XDCC]Bot"] } } : undefined
    );
    const result = await s.client.callTool({
      name: "irc_ison",
      arguments: { nicks: ["[XDCC]Bot", "absent"] },
    });
    const body = JSON.parse(textOf(result));
    assertEquals(body.present, ["[XDCC]Bot"]);
    assertEquals(body.absent, ["absent"]);
    assertEquals(
      s.fake.received.find((c) => c.action === "ison")?.params?.list,
      "[XDCC]Bot absent",
    );
  } finally {
    await s.stop();
  }
});

// --- multi-connection --------------------------------------------------------

/**
 * A fake that grows a connection on `connect`, as /server -m does, and reports
 * it from then on. Returns the cid it handed out so tests can check routing.
 */
function growOnConnect(s: Stack, cid: number, name: string): void {
  s.fake.setHandler((cmd, fake) => {
    if (cmd.action !== "connect") return undefined;
    fake.setNetworks([
      network(),
      network({ cid, name, server: String(cmd.params?.server), channels: [], members: {} }),
    ]);
    return { ok: true, data: { cid } };
  });
}

Deno.test("irc_ensure_connected adds a connection and leaves the existing one alone", async () => {
  const s = await stack();
  try {
    growOnConnect(s, 7, "Rizon");
    const result = await s.client.callTool({
      name: "irc_ensure_connected",
      arguments: { network: "Rizon", server: "irc.rizon.net" },
    });
    const body = JSON.parse(textOf(result));
    assertEquals(body.skipped, false);
    assertEquals(body.network.cid, 7);

    // Both connections are now known, and the original was never told anything.
    const state = JSON.parse(
      textOf(await s.client.callTool({ name: "irc_get_state", arguments: {} })),
    );
    assertEquals(state.networks.map((n: { name: string }) => n.name).sort(), ["Rizon", "net1"]);
    assertEquals(s.fake.received.filter((c) => c.action === "connect").length, 1);
  } finally {
    await s.stop();
  }
});

Deno.test("an existing connection is reused, by network name or by server", async () => {
  const s = await stack();
  try {
    // The user's own connection: net1 on irc.example.net.
    for (
      const args of [
        { network: "NET1", server: "irc.elsewhere.net" },
        { network: "SomethingElse", server: "IRC.example.net" },
      ]
    ) {
      const body = JSON.parse(
        textOf(await s.client.callTool({ name: "irc_ensure_connected", arguments: args })),
      );
      assertEquals(body.skipped, true, JSON.stringify(args));
      assertEquals(body.network.cid, 1);
    }
    const direct = JSON.parse(textOf(
      await s.client.callTool({ name: "irc_connect", arguments: { server: "irc.example.net" } }),
    ));
    assertEquals(direct.skipped, true);
    assertEquals(s.fake.received.some((c) => c.action === "connect"), false);
  } finally {
    await s.stop();
  }
});

Deno.test("commands go to the connection their network names", async () => {
  const s = await stack();
  try {
    growOnConnect(s, 7, "Rizon");
    await s.client.callTool({
      name: "irc_ensure_connected",
      arguments: { network: "Rizon", server: "irc.rizon.net" },
    });
    s.fake.setHandler(undefined);

    await s.client.callTool({
      name: "irc_send",
      arguments: { network: "rizon", target: "Bot", text: "xdcc list" },
    });
    await s.client.callTool({
      name: "irc_send",
      arguments: { network: "net1", target: "#chan", text: "hi" },
    });
    const sends = s.fake.received.filter((c) => c.action === "msg");
    assertEquals(sends.map((c) => c.params?.cid), [7, 1]);

    // With two connected, naming none is refused rather than guessed.
    const vague = await s.client.callTool({
      name: "irc_send",
      arguments: { target: "#chan", text: "which one?" },
    });
    assertEquals(textOf(vague).startsWith("ambiguous_network:"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("a bot's reply only counts if it comes from the bot's own connection", async () => {
  const s = await stack();
  try {
    growOnConnect(s, 7, "Rizon");
    await s.client.callTool({
      name: "irc_ensure_connected",
      arguments: { network: "Rizon", server: "irc.rizon.net" },
    });
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action !== "msg") return undefined;
      // Same nick, wrong network first; then the real reply.
      setTimeout(
        () =>
          fake.emit("notice", { cid: 1, net: "net1", buf: "Bot", nick: "Bot", text: "impostor" }),
        10,
      );
      setTimeout(
        () =>
          fake.emit("notice", { cid: 7, net: "Rizon", buf: "Bot", nick: "Bot", text: "pack list" }),
        60,
      );
      return undefined;
    });
    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_list",
        arguments: { network: "Rizon", bot: "Bot", timeoutMs: 3000, quietMs: 200 },
      }),
    ));
    assertEquals(body.replies.map((e: { text: string }) => e.text), ["pack list"]);
  } finally {
    await s.stop();
  }
});

// --- ownership: what the agent may leave on its own ---------------------------

Deno.test("the user's channel is not left without confirm; with it, it is", async () => {
  const s = await stack();
  try {
    // #chan is in the starting state, so the agent never joined it: the user's.
    const refused = await s.client.callTool({ name: "irc_part", arguments: { channel: "#chan" } });
    assertEquals(textOf(refused).startsWith("guard_denied:"), true);
    assertEquals(textOf(refused).includes("confirm: true"), true);
    assertEquals(s.fake.received.some((c) => c.action === "part"), false);

    const confirmed = await s.client.callTool({
      name: "irc_part",
      arguments: { channel: "#chan", confirm: true },
    });
    assertEquals(confirmed.isError ?? false, false);
    assertEquals(s.fake.received.some((c) => c.action === "part"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("a channel the agent joined itself can be left freely", async () => {
  const s = await stack();
  try {
    // As in mIRC: our own JOIN event, then the reply.
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action !== "join") return undefined;
      fake.emit("join", { buf: "#bots", nick: "me" });
      return { ok: true, data: { joined: "#bots", members: 10 }, delayMs: 20 };
    });
    await s.client.callTool({ name: "irc_ensure_joined", arguments: { channel: "#bots" } });
    s.fake.setHandler(undefined);
    const state = JSON.parse(
      textOf(await s.client.callTool({ name: "irc_get_state", arguments: {} })),
    );
    // Only the channel the agent joined is marked; the user's #chan is not.
    assertEquals(state.networks[0].joinedByAgent, ["#bots"]);
    const left = await s.client.callTool({ name: "irc_part", arguments: { channel: "#bots" } });
    assertEquals(left.isError ?? false, false);
  } finally {
    await s.stop();
  }
});

Deno.test("joining a channel the user is already in leaves it the user's", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd) =>
      cmd.action === "join"
        ? { ok: true, data: { joined: "#chan", members: 42, already: true } }
        : undefined
    );
    await s.client.callTool({ name: "irc_join", arguments: { channel: "#chan" } });
    s.fake.setHandler(undefined);
    const refused = await s.client.callTool({ name: "irc_part", arguments: { channel: "#chan" } });
    assertEquals(textOf(refused).startsWith("guard_denied:"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("the agent's own connection can be closed; the user's needs confirm", async () => {
  const s = await stack();
  try {
    growOnConnect(s, 7, "Rizon");
    await s.client.callTool({
      name: "irc_ensure_connected",
      arguments: { network: "Rizon", server: "irc.rizon.net" },
    });
    s.fake.setHandler(undefined);

    const mine = await s.client.callTool({ name: "irc_get_state", arguments: {} });
    const flags = JSON.parse(textOf(mine)).networks.map((
      n: { name: string; openedByAgent: boolean },
    ) => [n.name, n.openedByAgent]);
    assertEquals(flags.sort(), [["Rizon", true], ["net1", false]]);

    const users = await s.client.callTool({
      name: "irc_disconnect",
      arguments: { network: "net1" },
    });
    assertEquals(textOf(users).startsWith("guard_denied:"), true);

    const agents = await s.client.callTool({
      name: "irc_disconnect",
      arguments: { network: "Rizon" },
    });
    assertEquals(agents.isError ?? false, false);
    const sent = s.fake.received.filter((c) => c.action === "disconnect");
    assertEquals(sent.map((c) => c.params?.cid), [7]);
    // No message given: none is sent, so mIRC quits with its own default.
    assertEquals(sent[0].params?.message, undefined);
  } finally {
    await s.stop();
  }
});

Deno.test("irc_nick needs confirm on the user's connection and reports the confirmed nick", async () => {
  const s = await stack();
  try {
    const refused = await s.client.callTool({ name: "irc_nick", arguments: { nick: "other" } });
    assertEquals(textOf(refused).startsWith("guard_denied:"), true);

    s.fake.setHandler((cmd) =>
      cmd.action === "nick" ? { ok: true, data: { nick: "other" } } : undefined
    );
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "irc_nick", arguments: { nick: "other", confirm: true } }),
    ));
    assertEquals(body.nick, "other");

    s.fake.setHandler((cmd) =>
      cmd.action === "nick"
        ? { ok: false, numeric: 433, err: "other Nickname is already in use" }
        : undefined
    );
    const taken = await s.client.callTool({
      name: "irc_nick",
      arguments: { nick: "taken", confirm: true },
    });
    assertEquals(textOf(taken).startsWith("nick_in_use:"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("a 477 refusal after a services rename tells the agent what to tell the user", async () => {
  const s = await stack();
  try {
    // NickServ renamed us, as Rizon did live.
    s.fake.emit("selfnick", { extra: { old: "me", new: "Guest28669" } });
    await until(() => s.mirc.registry.resolve()!.state.resolve().nick === "Guest28669", {
      label: "rename applied",
    });
    s.fake.setHandler((cmd) =>
      cmd.action === "join"
        ? { ok: false, numeric: 477, err: "#locked Cannot join channel (+r)" }
        : undefined
    );
    const result = await s.client.callTool({ name: "irc_join", arguments: { channel: "#locked" } });
    const text = textOf(result);
    assertEquals(text.startsWith("join_failed:"), true);
    assertEquals(text.includes('"Guest28669"'), true);
    assertEquals(text.includes('renamed you from "me"'), true);
    assertEquals(text.includes("irc_nick"), true);
    assertEquals(text.includes("Tell the user"), true);

    // And the rename is visible in state, surviving a refresh.
    const state = JSON.parse(
      textOf(await s.client.callTool({ name: "irc_get_state", arguments: {} })),
    );
    assertEquals(state.networks[0].renamed.to, "Guest28669");
  } finally {
    await s.stop();
  }
});
