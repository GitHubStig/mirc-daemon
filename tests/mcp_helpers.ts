/**
 * The MCP test stack and fakes shared by the mcp_*_test.ts files: a real
 * mIRC listener, MCP server and HTTP door, driven by the SDK's own client.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type LogSink, nullLogger } from "../src/core/log.ts";
import type { NetworkState } from "../src/core/types.ts";
import { type RunningHttpServer, startHttpServer } from "../src/http/server.ts";
import { type RunningMcp, startMcp } from "../src/mcp/server.ts";
import { type RunningMircListener, startMircListener } from "../src/mirc/listener.ts";
import { FakeMirc, until } from "./fake_mirc.ts";

export const TOKEN = "test-token";

export function network(overrides: Partial<NetworkState> = {}): NetworkState {
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

export interface Stack {
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
export async function stack(
  options: {
    allowRaw?: boolean;
    log?: LogSink;
    connectWaitMs?: number;
    searchSettleMs?: number;
  } = {},
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
    // Searches join fresh channels in most tests: no 10 s pause before each.
    searchSettleMs: options.searchSettleMs ?? 0,
    // The live graces (5 s, 2.5 s) scaled down with the test bots' timelines.
    offerGraceMs: 500,
    resumeGraceMs: 200,
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

export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}

/**
 * A fake that grows a connection on `connect`, as /server -m does, and reports
 * it from then on. Returns the cid it handed out so tests can check routing.
 */
export function growOnConnect(s: Stack, cid: number, name: string): void {
  s.fake.setHandler((cmd, fake) => {
    if (cmd.action !== "connect") return undefined;
    fake.setNetworks([
      network(),
      network({ cid, name, server: String(cmd.params?.server), channels: [], members: {} }),
    ]);
    return { ok: true, data: { cid } };
  });
}

/** A raw reply as bridge.mrc mirrors it. */
export function emitRaw(s: Stack, line: string): void {
  s.fake.emit("raw", { raw: line, extra: { numeric: Number(line.split(" ")[0]) } });
}

/**
 * A fake whose connections behave like mIRC windows: connect without a cid
 * adds one (/server -m), connect with a cid reconnects that window in place,
 * and disconnect leaves the window there, disconnected.
 */
export function windowsLikeMirc(s: Stack, start: NetworkState[]): void {
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

/** A fake bot that is present and answers an `xdcc send` with `reply` after `ms`. */
export function botAnswers(s: Stack, reply: string | undefined, ms = 30): void {
  s.fake.setHandler((cmd, fake) => {
    if (cmd.action === "members") return { ok: true, data: { count: 50, present: true } };
    if (cmd.action === "msg" && reply !== undefined) {
      setTimeout(() => fake.emit("notice", { buf: "Bot", nick: "Bot", text: reply }), ms);
    }
    return undefined;
  });
}

export const fetchArgs = { channel: "#chan", bot: "Bot", pack: "6", notifyOnFailure: false };

/** A bot channel whose topic names another channel, and mIRC joining as asked. */
export function topicChannel(s: Stack, topic: string): void {
  s.fake.setHandler((cmd) => {
    if (cmd.action === "members") return { ok: true, data: { count: 50, present: true } };
    if (cmd.action === "join") {
      const ch = String(cmd.params?.channel);
      if (ch !== "#chan") {
        s.fake.emit("join", { buf: ch, nick: "me" });
        return { ok: true, data: { joined: ch, members: 30, topic: "" } };
      }
      return { ok: true, data: { joined: "#chan", members: 42, already: true, topic } };
    }
    return undefined;
  });
}

/** A join that lands in a channel of `members`, with `topic`; `already` if mIRC was in it. */
export function landIn(s: Stack, members: number, topic: string, already = false, botHere = true) {
  s.fake.setHandler((cmd) => {
    if (cmd.action === "join") {
      const ch = String(cmd.params?.channel);
      return { ok: true, data: { joined: ch, members, topic, ...(already ? { already } : {}) } };
    }
    if (cmd.action === "members") return { ok: true, data: { count: members, present: botHere } };
    return undefined;
  });
}

export const sent = (s: Stack, action: string) =>
  s.fake.received.filter((c) => c.action === action);

export const ISO = "ubuntu-mate-16.04.4-desktop-amd64.iso";

export const ISO_SIZE = 1746124800;

/**
 * A bot as irc.williamgattone.it's behaved, ten times faster: an Italian "sending you" line, the
 * offer 30 ms later (300 live), and, when `resumeFrom` is set (mIRC already has some of
 * the file), the bot's ACCEPT of mIRC's resume.
 */
export function italianBot(
  s: Stack,
  options: { resumeFrom?: number; finish?: boolean } = {},
): void {
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
    say(30, () =>
      fake.emit("ctcp", {
        nick: "Bot",
        extra: { ctcp: "DCC", text: `SEND ${ISO} 3281708755 42617 ${ISO_SIZE}` },
      }));
    if (options.resumeFrom !== undefined) {
      say(90, () =>
        fake.emit("ctcp", {
          nick: "Bot",
          extra: { ctcp: "DCC", text: `ACCEPT ${ISO} 42617 ${options.resumeFrom}` },
        }));
    }
    if (options.finish) {
      say(
        140,
        () =>
          fake.emit("dcc", { extra: { event: "complete", file: `F:\\DL\\${ISO}`, from: "Bot" } }),
      );
    }
    return undefined;
  });
}

export const pack39 = { channel: "#chan", bot: "Bot", pack: "39", timeoutMs: 5000 };
