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
async function stack(
  options: { allowRaw?: boolean; log?: LogSink; connectWaitMs?: number } = {},
): Promise<Stack> {
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
    connectWaitMs: options.connectWaitMs,
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
        // An advert that looks like a refusal must not settle the job...
        setTimeout(
          () => fake.emit("text", { buf: "#chan", nick: "Bot", text: "** Invalid Pack Number" }),
          10,
        );
        // ...the bot's real answer, then its DCC offer, as iroffer sends them.
        setTimeout(() =>
          fake.emit("notice", {
            buf: "Bot",
            nick: "Bot",
            text: '** Sending you pack #42 ("pack042.iso"), which is 1MB.',
          }), 40);
        setTimeout(() =>
          fake.emit("ctcp", {
            nick: "Bot",
            extra: { ctcp: "DCC", text: "SEND pack042.iso 3232235777 5000 1048576" },
          }), 70);
      }
      return undefined;
    });
    const result = await s.client.callTool({
      name: "xdcc_fetch",
      arguments: { channel: "#chan", bot: "Bot", pack: "42", timeoutMs: 3000 },
    });
    const body = JSON.parse(textOf(result));
    // The "Sending you" reply alone settles the wait; the offer may land just after.
    assertEquals(body.job.requestedBy, { bot: "Bot", pack: "42" });
    assertEquals(body.job.file, "pack042.iso");
    assertEquals(body.mircAccepts, "auto");
    const job = s.mirc.registry.resolve()!.dcc.get(body.job.id)!;
    await until(() => job.state === "offered", { label: "offer" });
    assertEquals(job.size, 1048576);

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

// --- reusing the agent's own windows -----------------------------------------

/**
 * A fake whose connections behave like mIRC windows: connect without a cid
 * adds one (/server -m), connect with a cid reconnects that window in place,
 * and disconnect leaves the window there, disconnected.
 */
function windowsLikeMirc(s: Stack, start: NetworkState[]): void {
  let nets = start;
  let nextCid = 100;
  s.fake.setNetworks(nets);
  s.fake.setHandler((cmd, fake) => {
    const cid = cmd.params?.cid as number | undefined;
    if (cmd.action === "connect") {
      if (cid !== undefined) {
        nets = nets.map((n) => n.cid === cid ? { ...n, status: "connected" } : n);
      } else {
        nets = [
          ...nets,
          network({
            cid: nextCid,
            name: "Rizon",
            server: "irc.rizon.net",
            channels: [],
            members: {},
          }),
        ];
      }
      fake.setNetworks(nets);
      return { ok: true, data: { cid: cid ?? nextCid++ } };
    }
    if (cmd.action === "disconnect") {
      nets = nets.map((n) => n.cid === cid ? { ...n, status: "disconnected", channels: [] } : n);
      fake.setNetworks(nets);
      return { ok: true };
    }
    return undefined;
  });
}

Deno.test("the agent reconnects its own quit window instead of opening another", async () => {
  const s = await stack();
  try {
    windowsLikeMirc(s, [network()]);
    const args = { network: "Rizon", server: "irc.rizon.net" };
    const first = JSON.parse(
      textOf(await s.client.callTool({ name: "irc_ensure_connected", arguments: args })),
    );
    assertEquals(first.reusedWindow, false);
    await s.client.callTool({ name: "irc_disconnect", arguments: { network: "Rizon" } });

    const second = JSON.parse(
      textOf(await s.client.callTool({ name: "irc_ensure_connected", arguments: args })),
    );
    assertEquals(second.reusedWindow, "agent's");
    assertEquals(second.network.cid, first.network.cid);

    const connects = s.fake.received.filter((c) => c.action === "connect");
    assertEquals(connects.map((c) => c.params?.cid), [undefined, first.network.cid]);
    // Still just the user's window and the agent's one.
    const state = JSON.parse(
      textOf(await s.client.callTool({ name: "irc_get_state", arguments: {} })),
    );
    assertEquals(state.networks.length, 2);
  } finally {
    await s.stop();
  }
});

Deno.test("the user's quit window is reconnected, and stays the user's", async () => {
  const s = await stack();
  try {
    // The user quit Rizon themselves: their window, no receipt.
    windowsLikeMirc(s, [
      network(),
      network({
        cid: 5,
        name: "Rizon",
        server: "irc.rizon.net",
        status: "disconnected",
        channels: [],
      }),
    ]);
    // Let the daemon see the window, as a refresh or mIRC's events would.
    await s.mirc.registry.resolve()!.refreshState();
    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "irc_ensure_connected",
        arguments: { network: "Rizon", server: "irc.rizon.net" },
      }),
    ));
    assertEquals(body.reusedWindow, "user's");
    assertEquals(s.fake.received.find((c) => c.action === "connect")?.params?.cid, 5);

    // Back up, but still theirs: no receipt, so disconnecting needs confirmation.
    const state = JSON.parse(
      textOf(await s.client.callTool({ name: "irc_get_state", arguments: { network: "Rizon" } })),
    );
    assertEquals(state.networks[0].openedByAgent, false);
    const refused = await s.client.callTool({
      name: "irc_disconnect",
      arguments: { network: "Rizon" },
    });
    assertEquals(textOf(refused).startsWith("guard_denied:"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("the agent's own quit window is preferred over the user's", async () => {
  const s = await stack();
  try {
    // Two quit Rizon windows: the user's (5) listed first, and the agent's (9).
    windowsLikeMirc(s, [
      network(),
      network({ cid: 5, name: "Rizon", status: "disconnected", channels: [] }),
      network({ cid: 9, name: "Rizon", status: "disconnected", channels: [] }),
    ]);
    const session = s.mirc.registry.resolve()!;
    await session.refreshState();
    session.owned.openedConnection(9);

    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "irc_ensure_connected",
        arguments: { network: "Rizon", server: "irc.rizon.net" },
      }),
    ));
    assertEquals(body.reusedWindow, "agent's");
    assertEquals(body.network.cid, 9);
  } finally {
    await s.stop();
  }
});

Deno.test("GET and DELETE on /mcp are 405, so no endless event stream is ever opened", async () => {
  const s = await stack();
  try {
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`http://127.0.0.1:${s.http.addr.port}/mcp`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
      });
      await response.body?.cancel();
      assertEquals(response.status, 405, method);
      assertEquals(response.headers.get("allow"), "POST");
    }
    // The SDK client copes: tools still work after its GET was refused.
    const result = await s.client.callTool({ name: "daemon_status", arguments: {} });
    assertEquals(JSON.parse(textOf(result)).mircAttached, true);
  } finally {
    // Shutdown used to be able to hang here, waiting on that stream.
    const started = Date.now();
    await s.stop();
    assertEquals(Date.now() - started < 2000, true);
  }
});

// --- XDCC jobs through MCP -----------------------------------------------------

/** A fake bot that is present and answers an `xdcc send` with `reply` after `ms`. */
function botAnswers(s: Stack, reply: string | undefined, ms = 30): void {
  s.fake.setHandler((cmd, fake) => {
    if (cmd.action === "members") return { ok: true, data: { count: 50, present: true } };
    if (cmd.action === "msg" && reply !== undefined) {
      setTimeout(() => fake.emit("notice", { buf: "Bot", nick: "Bot", text: reply }), ms);
    }
    return undefined;
  });
}

const fetchArgs = { channel: "#chan", bot: "Bot", pack: "6", notifyOnFailure: false };

Deno.test("xdcc_fetch: a refusal is bot_refused with the bot's words and the reason", async () => {
  const s = await stack();
  try {
    botAnswers(s, "** Invalid Pack Number, Try Again");
    const result = await s.client.callTool({
      name: "xdcc_fetch",
      arguments: { ...fetchArgs, timeoutMs: 3000 },
    });
    assertEquals(textOf(result).startsWith("bot_refused:"), true);
    assertEquals(textOf(result).includes("no such pack"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_fetch: a queued request returns the position and keeps the job open", async () => {
  const s = await stack();
  try {
    botAnswers(
      s,
      '** All Slots Full, Added you to the main queue for pack 6 ("x.iso") in position 4.',
    );
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: { ...fetchArgs, timeoutMs: 3000 } }),
    ));
    assertEquals(body.job.state, "queued");
    assertEquals(body.job.position, 4);
    assertEquals(body.next.includes("position 4"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_fetch: no answer yet is not an error, and irc_dcc_watch catches the late one", async () => {
  const s = await stack();
  try {
    botAnswers(s, undefined);
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: { ...fetchArgs, timeoutMs: 600 } }),
    ));
    assertEquals(body.job.state, "requested");
    assertEquals(body.next.includes("keeps listening"), true);

    // The bot answers minutes later, as AxA-MP1 did; here, while a watch waits.
    const watching = s.client.callTool({
      name: "irc_dcc_watch",
      arguments: { job: body.job.id, timeoutMs: 3000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    s.fake.emit("notice", {
      buf: "Bot",
      nick: "Bot",
      text: "** You have been queued in position 2",
    });
    const watched = JSON.parse(textOf(await watching));
    assertEquals(watched.changed, true);
    assertEquals(watched.from, "requested");
    assertEquals(watched.job.state, "queued");

    const status = JSON.parse(textOf(
      await s.client.callTool({ name: "irc_dcc_status", arguments: { job: body.job.id } }),
    ));
    assertEquals(status.job.position, 2);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_fetch: mIRC set to ignore DCC sends is refused before asking the bot", async () => {
  const s = await stack();
  try {
    s.mirc.registry.resolve()!.sreq = "ignore";
    botAnswers(s, "never asked");
    const result = await s.client.callTool({ name: "xdcc_fetch", arguments: fetchArgs });
    assertEquals(textOf(result).startsWith("dcc_failed:"), true);
    assertEquals(textOf(result).includes("IGNORE"), true);
    assertEquals(s.fake.received.some((c) => c.action === "msg"), false);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_list: 'XDCC LIST Denied' is bot_refused, not a pack list", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action === "msg") {
        // AxA-MP1's real reply, 2026-10-22.
        setTimeout(
          () =>
            fake.emit("notice", { buf: "Bot", nick: "Bot", text: "** XDCC LIST Denied. Nope!" }),
          20,
        );
      }
      return undefined;
    });
    const result = await s.client.callTool({
      name: "xdcc_list",
      arguments: { bot: "Bot", timeoutMs: 3000, quietMs: 200 },
    });
    assertEquals(textOf(result).startsWith("bot_refused:"), true);
    assertEquals(textOf(result).includes("website"), true);
  } finally {
    await s.stop();
  }
});

// --- connecting that fails, and TLS ---------------------------------------------

Deno.test("tls: true goes to mIRC as a plain number flag", async () => {
  const s = await stack();
  try {
    growOnConnect(s, 7, "Libera");
    await s.client.callTool({
      name: "irc_ensure_connected",
      arguments: { network: "Libera", server: "irc.libera.chat", tls: true },
    });
    const connect = s.fake.received.find((c) => c.action === "connect");
    assertEquals(connect?.params?.tls, 1);
    assertEquals(connect?.params?.port, undefined);
  } finally {
    await s.stop();
  }
});

Deno.test("a connect that fails still leaves the agent owning the window it opened", async () => {
  const s = await stack();
  try {
    // As seen live: mIRC opens the window, cannot reach the server, and keeps
    // retrying. CONNECTFAIL answers the command with mIRC's reason.
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action !== "connect") return undefined;
      fake.setNetworks([
        network(),
        network({
          cid: 50,
          name: "",
          server: "irc.dead.example",
          status: "connecting",
          channels: [],
          members: {},
        }),
      ]);
      return { ok: false, numeric: 0, err: "Unable to connect to server (Connection timed out)" };
    });
    const result = await s.client.callTool({
      name: "irc_connect",
      arguments: { server: "irc.dead.example" },
    });
    const text = textOf(result);
    assertEquals(text.startsWith("connect_failed:"), true);
    assertEquals(text.includes("Connection timed out"), true);
    assertEquals(text.includes("cid 50"), true);

    // The retrying window is the agent's, so it may stop it without confirm.
    s.fake.setHandler(undefined);
    const stopped = await s.client.callTool({
      name: "irc_disconnect",
      arguments: { network: "irc.dead.example" },
    });
    assertEquals(stopped.isError ?? false, false);
    assertEquals(s.fake.received.find((c) => c.action === "disconnect")?.params?.cid, 50);
  } finally {
    await s.stop();
  }
});

Deno.test("a connect still going when the wait runs out says mIRC is still trying", async () => {
  // As seen live on EFnet: mIRC works through server after server, each TCP
  // attempt timing out at 21 s, and the window reads "connecting" throughout.
  const s = await stack({ connectWaitMs: 300 });
  try {
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action !== "connect") return undefined;
      fake.setNetworks([
        network(),
        network({
          cid: 60,
          name: "",
          server: "irc.efnet.org",
          status: "connecting",
          channels: [],
          members: {},
        }),
      ]);
      return { ok: true, silent: true };
    });
    const result = await s.client.callTool({
      name: "irc_connect",
      arguments: { server: "irc.efnet.org" },
    });
    const text = textOf(result);
    assertEquals(text.startsWith("connect_timeout:"), true);
    assertEquals(text.includes("still trying"), true);
    assertEquals(text.includes("irc_disconnect {cid: 60}"), true);
  } finally {
    await s.stop();
  }
});

// --- what is being downloaded, and stopping it ----------------------------------

Deno.test("xdcc_fetch tells the user which file the pack actually is", async () => {
  const s = await stack();
  try {
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action === "members") return { ok: true, data: { count: 50, present: true } };
      if (cmd.action === "msg") {
        setTimeout(() =>
          fake.emit("ctcp", {
            nick: "Bot",
            extra: { ctcp: "DCC", text: "SEND not-what-you-wanted.mkv 3232235777 5000 734003200" },
          }), 30);
      }
      return undefined;
    });
    const body = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_fetch",
        arguments: { channel: "#chan", bot: "Bot", pack: "1", timeoutMs: 3000 },
      }),
    ));
    assertEquals(body.downloading, 'pack #1 is "not-what-you-wanted.mkv" (700.0 MB)');
    assertEquals(body.tellTheUser.includes("xdcc_cancel"), true);
    assertEquals(body.tellTheUser.includes(body.job.id), true);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_cancel: queued asks the bot to REMOVE; transferring CANCELs and closes it", async () => {
  const s = await stack();
  try {
    const session = s.mirc.registry.resolve()!;
    const queued = session.dcc.start({ cid: 1, net: "net1", bot: "Bot", pack: "1" });
    session.dcc.applyEvent({
      seq: 1,
      ts: Date.now(),
      kind: "notice",
      cid: 1,
      net: "net1",
      buf: "Bot",
      nick: "Bot",
      text: "** You have been queued in position 3",
    });
    const q = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_cancel", arguments: { job: queued.id } }),
    ));
    assertEquals(q.job.state, "cancelled");
    assertEquals(s.fake.received.filter((c) => c.action === "msg").map((c) => c.params?.text), [
      "XDCC REMOVE",
    ]);

    const sending = session.dcc.start({ cid: 1, net: "net1", bot: "Bot", pack: "2" });
    session.dcc.applyEvent({
      seq: 2,
      ts: Date.now(),
      kind: "ctcp",
      cid: 1,
      net: "net1",
      nick: "Bot",
      extra: { ctcp: "DCC", text: "SEND b.iso 1 2 10" },
    });
    await s.client.callTool({ name: "xdcc_cancel", arguments: { job: sending.id } });
    assertEquals(
      s.fake.received.filter((c) => c.action === "msg").at(-1)?.params?.text,
      "XDCC CANCEL",
    );
    const stop = s.fake.received.find((c) => c.action === "dccstop");
    assertEquals(stop?.params?.nick, "Bot");
    assertEquals(sending.state, "cancelled");
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_cancel on a transfer the user started needs confirm", async () => {
  const s = await stack();
  try {
    const session = s.mirc.registry.resolve()!;
    const theirs = session.dcc.applyEvent({
      seq: 1,
      ts: Date.now(),
      kind: "ctcp",
      cid: 1,
      net: "net1",
      nick: "Friend",
      extra: { ctcp: "DCC", text: "SEND theirs.zip 1 2 10" },
    })!;
    const refused = await s.client.callTool({ name: "xdcc_cancel", arguments: { job: theirs.id } });
    assertEquals(textOf(refused).startsWith("guard_denied:"), true);
    const allowed = await s.client.callTool({
      name: "xdcc_cancel",
      arguments: { job: theirs.id, confirm: true },
    });
    assertEquals(allowed.isError ?? false, false);
    assertEquals(s.fake.received.find((c) => c.action === "dccstop")?.params?.nick, "Friend");
    // Nothing was said to the sender: the user's own transfer, not a bot request.
    assertEquals(s.fake.received.some((c) => c.action === "msg"), false);
  } finally {
    await s.stop();
  }
});

Deno.test("xdcc_cancel: mIRC reporting the abort before acknowledging it still ends cancelled", async () => {
  // The order seen live: dccstop sent, GETFAIL for the closed download, then the ok.
  const s = await stack();
  try {
    const session = s.mirc.registry.resolve()!;
    const saved = String.raw`D:\Downloads\x\big.iso`;
    s.fake.setHandler((cmd, fake) => {
      if (cmd.action !== "dccstop") return undefined;
      fake.emit("dcc", { cid: 1, extra: { event: "getfail", file: saved, from: "Friend" } });
      return { ok: true, delayMs: 20 };
    });
    const job = session.dcc.applyEvent({
      seq: 1,
      ts: Date.now(),
      kind: "ctcp",
      cid: 1,
      net: "net1",
      nick: "Friend",
      extra: { ctcp: "DCC", text: "SEND big.iso 1 2 314572800" },
    })!;
    await s.client.callTool({ name: "xdcc_cancel", arguments: { job: job.id, confirm: true } });
    await until(() => job.savedAs !== undefined, { label: "getfail absorbed" });
    assertEquals(job.state, "cancelled");
    assertEquals(job.savedAs, saved);
    // The abort did not turn into a separate failed job.
    assertEquals(session.dcc.list().length, 1);
  } finally {
    await s.stop();
  }
});

// --- asking again, resumes and progress (seen live, 2026-10-23) ------------------

const ISO = "ubuntu-mate-16.04.4-desktop-amd64.iso";
const ISO_SIZE = 1746124800;

/**
 * A bot as irc.williamgattone.it's behaved: an Italian "sending you" line, the
 * offer 300 ms later, and, when `resumeFrom` is set (mIRC already has some of
 * the file), the bot's ACCEPT of mIRC's resume.
 */
function italianBot(s: Stack, options: { resumeFrom?: number; finish?: boolean } = {}): void {
  s.fake.setHandler((cmd, fake) => {
    if (cmd.action === "members") return { ok: true, data: { count: 232, present: true } };
    if (cmd.action !== "msg") return undefined;
    const say = (ms: number, f: () => void) => setTimeout(f, ms);
    say(10, () =>
      fake.emit("notice", {
        buf: "Bot",
        nick: "Bot",
        text: `** Ti sto inviando il pack #39 ("${ISO}"), che ha grandezza 1.6GB.`,
      }));
    say(300, () =>
      fake.emit("ctcp", {
        nick: "Bot",
        extra: { ctcp: "DCC", text: `SEND ${ISO} 3281708755 42617 ${ISO_SIZE}` },
      }));
    if (options.resumeFrom !== undefined) {
      say(900, () =>
        fake.emit("ctcp", {
          nick: "Bot",
          extra: { ctcp: "DCC", text: `ACCEPT ${ISO} 42617 ${options.resumeFrom}` },
        }));
    }
    if (options.finish) {
      say(
        1400,
        () =>
          fake.emit("dcc", { extra: { event: "complete", file: `F:\\DL\\${ISO}`, from: "Bot" } }),
      );
    }
    return undefined;
  });
}

const pack39 = { channel: "#chan", bot: "Bot", pack: "39", timeoutMs: 5000 };

Deno.test("xdcc_fetch waits past a reply it cannot read for the offer that follows", async () => {
  const s = await stack();
  try {
    italianBot(s);
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    assertEquals(body.job.state, "offered");
    assertEquals(body.downloading, `pack #39 is "${ISO}" (1.6 GB)`);
  } finally {
    await s.stop();
  }
});

Deno.test("asking again for a pack still in progress sends nothing and returns that job", async () => {
  const s = await stack();
  try {
    italianBot(s);
    const first = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    const again = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: { ...pack39, pack: "#39" } }),
    ));
    assertEquals(again.skipped, true);
    assertEquals(again.job.id, first.job.id);
    assertEquals(s.fake.received.filter((c) => c.action === "msg").length, 1);
  } finally {
    await s.stop();
  }
});

Deno.test("asking again after a transfer ended is sent, so mIRC can resume it", async () => {
  const s = await stack();
  try {
    italianBot(s, { resumeFrom: 524279808 });
    const first = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    await s.client.callTool({ name: "xdcc_cancel", arguments: { job: first.job.id } });
    const again = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    assertEquals(again.skipped, undefined);
    assertEquals(again.job.id !== first.job.id, true);
    assertEquals(again.job.resumedFrom, 524279808);
    assertEquals(again.next.includes("resume"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("asking for a file mIRC already has says so instead of 'starting'", async () => {
  const s = await stack();
  try {
    italianBot(s, { resumeFrom: ISO_SIZE - 8192, finish: true });
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    assertEquals(body.job.state, "complete");
    assertEquals(body.next.includes("already had this whole file"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("irc_dcc_status asks mIRC for progress and reports a running transfer", async () => {
  const s = await stack();
  try {
    italianBot(s);
    const fetched = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    s.fake.setHandler((cmd) =>
      cmd.action === "gets"
        ? {
          ok: true,
          data: {
            gets: [{
              nick: "Bot",
              file: ISO,
              size: ISO_SIZE,
              rcvd: 873062400,
              cps: 2000000,
              done: 0,
            }],
          },
        }
        : undefined
    );
    const status = JSON.parse(textOf(
      await s.client.callTool({ name: "irc_dcc_status", arguments: { job: fetched.job.id } }),
    ));
    assertEquals(status.job.state, "downloading");
    assertEquals(status.progress, "832.6 MB of 1.6 GB (50%), 1.9 MB/s");
    assertEquals(status.next.includes("irc_dcc_watch"), true);
  } finally {
    await s.stop();
  }
});

Deno.test("an older bridge.mrc without gets just means no progress", async () => {
  const s = await stack();
  try {
    italianBot(s);
    const fetched = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: pack39 }),
    ));
    s.fake.setHandler((cmd) =>
      cmd.action === "gets" ? { ok: false, numeric: 0, err: "unknown-action-gets" } : undefined
    );
    const status = await s.client.callTool({
      name: "irc_dcc_status",
      arguments: { job: fetched.job.id },
    });
    assertEquals(status.isError ?? false, false);
    assertEquals(JSON.parse(textOf(status)).job.state, "offered");
  } finally {
    await s.stop();
  }
});

Deno.test("a reply the daemon cannot read wakes irc_dcc_watch and is handed to the agent", async () => {
  const s = await stack();
  try {
    botAnswers(s, undefined);
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: { ...fetchArgs, timeoutMs: 600 } }),
    ));
    const watching = s.client.callTool({
      name: "irc_dcc_watch",
      arguments: { job: body.job.id, timeoutMs: 3000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A refusal, in Portuguese.
    s.fake.emit("notice", {
      buf: "Bot",
      nick: "Bot",
      text: "** Pedido recusado, tente mais tarde",
    });
    const watched = JSON.parse(textOf(await watching));
    assertEquals(watched.changed, true);
    assertEquals(watched.why, "bot replied");
    assertEquals(watched.job.state, "requested");
    assertEquals(watched.botSaid, {
      text: "** Pedido recusado, tente mais tarde",
      understood: false,
    });
    assertEquals(watched.readIt.includes("tellBot: false"), true);

    // The agent read it as a refusal and closes the job without messaging the bot.
    const closed = JSON.parse(textOf(
      await s.client.callTool({
        name: "xdcc_cancel",
        arguments: { job: body.job.id, tellBot: false },
      }),
    ));
    assertEquals(closed.job.state, "cancelled");
    assertEquals(s.fake.received.filter((c) => c.action === "msg").length, 1);
  } finally {
    await s.stop();
  }
});

Deno.test("a reply the daemon understands says so, and gives no reading advice", async () => {
  const s = await stack();
  try {
    botAnswers(s, "** You have been queued in position 2");
    const body = JSON.parse(textOf(
      await s.client.callTool({ name: "xdcc_fetch", arguments: { ...fetchArgs, timeoutMs: 3000 } }),
    ));
    assertEquals(body.botSaid.understood, true);
    assertEquals(body.botSaid.as, "queued");
    assertEquals(body.readIt, undefined);
  } finally {
    await s.stop();
  }
});

Deno.test("two connections on one network: cid picks one, the name alone is refused", async () => {
  const s = await stack();
  try {
    // The user's EFnet and a second EFnet connection the agent opened.
    s.fake.setNetworks([network(), network({ cid: 1751, channels: [], members: {} })]);
    const session = s.mirc.registry.resolve()!;
    await session.refreshState();
    session.owned.openedConnection(1751);

    const vague = await s.client.callTool({
      name: "irc_disconnect",
      arguments: { network: "net1" },
    });
    assertEquals(textOf(vague).startsWith("ambiguous_network:"), true);
    assertEquals(textOf(vague).includes("Pass cid"), true);

    const unnamed = await s.client.callTool({ name: "irc_disconnect", arguments: {} });
    assertEquals(textOf(unnamed).startsWith("unknown_network:"), true);

    const mismatch = await s.client.callTool({
      name: "irc_disconnect",
      arguments: { network: "Rizon", cid: 1751 },
    });
    assertEquals(textOf(mismatch).includes('is on "net1"'), true);

    const exact = await s.client.callTool({
      name: "irc_disconnect",
      arguments: { cid: 1751, message: "i'm not a bot" },
    });
    assertEquals(exact.isError ?? false, false);
    const sent = s.fake.received.filter((c) => c.action === "disconnect");
    assertEquals(sent.length, 1);
    assertEquals(sent[0].params?.cid, 1751);
    assertEquals(sent[0].params?.message, "i'm not a bot");
  } finally {
    await s.stop();
  }
});

Deno.test("irc_part carries a part message when given, and none otherwise", async () => {
  const s = await stack();
  try {
    await s.client.callTool({
      name: "irc_part",
      arguments: { channel: "#chan", message: "bye all", confirm: true },
    });
    await s.client.callTool({ name: "irc_part", arguments: { channel: "#chan", confirm: true } });
    const parts = s.fake.received.filter((c) => c.action === "part");
    assertEquals(parts.map((c) => c.params?.message), ["bye all", undefined]);
  } finally {
    await s.stop();
  }
});

Deno.test("a wait whose mIRC link drops says so at once instead of going deaf", async () => {
  const s = await stack();
  try {
    const started = Date.now();
    const waiting = s.client.callTool({
      name: "irc_wait_for",
      arguments: { nick: "Bot", timeoutMs: 20_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // mIRC's script disconnects, e.g. mIRC restarting.
    await s.fake.close();
    const text = textOf(await waiting);
    assertEquals(text.startsWith("connect_failed:"), true);
    assertEquals(text.includes("link to the daemon dropped"), true);
    assertEquals(Date.now() - started < 5000, true);
  } finally {
    await s.stop();
  }
});

Deno.test("irc_dcc_watch also reports a dropped link rather than 'no change'", async () => {
  const s = await stack();
  try {
    const job = s.mirc.registry.resolve()!.dcc.start({ cid: 1, net: "net1", bot: "Bot" });
    const watching = s.client.callTool({
      name: "irc_dcc_watch",
      arguments: { job: job.id, timeoutMs: 20_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await s.fake.close();
    assertEquals(textOf(await watching).startsWith("connect_failed:"), true);
  } finally {
    await s.stop();
  }
});
