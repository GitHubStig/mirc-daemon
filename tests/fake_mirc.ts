/**
 * A test double that speaks MBP.
 *
 * mIRC cannot run in CI, so this stands in for it: it dials in, identifies
 * itself, answers commands, and emits scripted IRC events. Because it speaks the
 * same wire the real `bridge.mrc` will, the whole daemon can be exercised
 * end-to-end without an IRC network.
 */

import { encodeFrame, LineDecoder, parseInbound } from "../src/core/wire.ts";
import type { CmdFrame, EventKind, NetworkState, WelcomeFrame } from "../src/core/types.ts";
import { PROTOCOL_VERSION } from "../src/core/types.ts";

/**
 * Undo the daemon's param encoding, as bridge.mrc's jparam does. It lives here
 * rather than in src/ because the daemon itself never decodes a command; the
 * real decoder is mSL.
 */
export function fromWireCommand(cmd: CmdFrame): CmdFrame {
  if (!cmd.params) return cmd;
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cmd.params)) {
    params[key] = typeof value === "string"
      ? new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)))
      : value;
  }
  return { ...cmd, params };
}

export interface CommandReply {
  ok: boolean;
  data?: Record<string, unknown>;
  code?: string;
  numeric?: number;
  err?: string;
  hint?: string;
  /** Never answer, so the caller's timeout path is exercised. */
  silent?: boolean;
  /** Answer after this delay, in milliseconds. */
  delayMs?: number;
}

export type CommandHandler = (cmd: CmdFrame, fake: FakeMirc) => CommandReply | void;

export interface FakeMircOptions {
  token?: string;
  nick?: string;
  mirc?: string;
  /** What a `state` command reports. */
  networks?: NetworkState[];
  onCommand?: CommandHandler;
  /** Connect but stay silent, to test the daemon's hello timeout. */
  skipHello?: boolean;
}

export interface EventFields {
  /** Defaults to the id of the network named by `net`. */
  cid?: number;
  net?: string;
  buf?: string;
  nick?: string;
  user?: string;
  text?: string;
  extra?: Record<string, unknown>;
}

export class FakeMirc {
  readonly received: CmdFrame[] = [];
  welcome?: WelcomeFrame;

  #conn: Deno.Conn;
  #decoder = new LineDecoder();
  #readTask: Promise<void>;
  #closed = false;
  #handler?: CommandHandler;
  #networks: NetworkState[];
  #net: string;

  private constructor(conn: Deno.Conn, options: FakeMircOptions) {
    this.#conn = conn;
    this.#handler = options.onCommand;
    this.#networks = options.networks ?? [];
    this.#net = this.#networks[0]?.name ?? "net1";
    this.#readTask = this.#read();
  }

  static async connect(
    hostname: string,
    port: number,
    options: FakeMircOptions = {},
  ): Promise<FakeMirc> {
    const conn = await Deno.connect({ hostname, port });
    const fake = new FakeMirc(conn, options);
    if (!options.skipHello) {
      fake.send({
        t: "hello",
        v: PROTOCOL_VERSION,
        token: options.token ?? "test-token",
        nick: options.nick ?? "me",
        mirc: options.mirc ?? "7.75",
      });
    }
    return fake;
  }

  send(frame: unknown): void {
    if (this.#closed) return;
    void this.#conn.write(encodeFrame(frame));
  }

  /** Emit an IRC event, defaulting the network to the first configured one. */
  emit(kind: EventKind, fields: EventFields = {}): void {
    const net = fields.net ?? this.#net;
    // Tag with the matching connection's id, as bridge.mrc's evp does.
    const cid = fields.cid ?? this.#networks.find((n) => n.name === net)?.cid ?? 1;
    this.send({
      t: "ev",
      kind,
      cid,
      net,
      buf: fields.buf,
      nick: fields.nick,
      user: fields.user,
      text: fields.text,
      extra: fields.extra,
    });
  }

  setNetworks(networks: NetworkState[]): void {
    this.#networks = networks;
  }

  setHandler(handler: CommandHandler | undefined): void {
    this.#handler = handler;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async close(): Promise<void> {
    this.#closed = true;
    try {
      this.#conn.close();
    } catch {
      // already closed
    }
    await this.#readTask;
  }

  /** Wait until the socket is torn down by the far end. */
  async waitForClose(): Promise<void> {
    await this.#readTask;
  }

  async #read(): Promise<void> {
    try {
      for await (const chunk of this.#conn.readable) {
        for (const line of this.#decoder.push(chunk).lines) {
          const frame = parseInbound(line) as Record<string, unknown>;
          if (frame.t === "welcome") {
            this.welcome = frame as unknown as WelcomeFrame;
          } else if (frame.t === "ping") {
            // As bridge.mrc does: every ping gets a pong.
            this.send({ t: "pong" });
          } else if (frame.t === "cmd") {
            // Decode params as bridge.mrc does, so tests assert on real values.
            this.#onCommand(fromWireCommand(frame as unknown as CmdFrame));
          }
        }
      }
    } catch {
      // socket closed
    }
  }

  #onCommand(cmd: CmdFrame): void {
    this.received.push(cmd);
    const custom = this.#handler?.(cmd, this);
    const reply: CommandReply = custom ?? this.#defaultReply(cmd);
    if (reply.silent) return;
    const send = () => this.#reply(cmd.id, reply);
    if (reply.delayMs && reply.delayMs > 0) setTimeout(send, reply.delayMs);
    else send();
  }

  #defaultReply(cmd: CmdFrame): CommandReply {
    // State in the two halves bridge.mrc gives it: the connection list, then
    // each connection's channels on request.
    if (cmd.action === "conns") {
      return {
        ok: true,
        data: {
          conns: this.#networks.map((n) => ({
            cid: n.cid,
            net: n.name,
            server: n.server ?? "",
            status: n.status,
            nick: n.nick,
          })),
          sreq: "auto",
        },
      };
    }
    if (cmd.action === "chans") {
      const net = this.#networks.find((n) => n.cid === cmd.params?.cid);
      if (!net) return { ok: false, numeric: 0, err: "no-such-connection" };
      return { ok: true, data: { channels: net.channels, members: net.members } };
    }
    return { ok: true };
  }

  #reply(id: string, reply: CommandReply): void {
    this.send({
      t: "res",
      id,
      ok: reply.ok,
      data: reply.data,
      code: reply.code,
      numeric: reply.numeric,
      err: reply.err,
      hint: reply.hint,
    });
  }
}

/** Poll until `predicate` holds, or fail after `timeoutMs`. */
export async function until(
  predicate: () => boolean,
  { timeoutMs = 2000, label = "condition" }: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** Wait for a fixed period. Used to assert that something does *not* happen. */
export function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
