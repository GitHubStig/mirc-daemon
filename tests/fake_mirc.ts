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
    this.send({
      t: "ev",
      kind,
      net: fields.net ?? this.#net,
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
          } else if (frame.t === "cmd") {
            this.#onCommand(frame as unknown as CmdFrame);
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
    if (cmd.action === "state") {
      return { ok: true, data: { networks: this.#networks } };
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
