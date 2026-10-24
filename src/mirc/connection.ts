/**
 * The mIRC door: one TCP socket, one session.
 *
 * mIRC dials in, identifies itself with `hello`, and then holds the connection
 * open. Its lifetime is tied to this socket and to nothing else — an agent
 * attaching or quitting never touches it, which is what guarantees that quitting
 * an agent cannot drop an IRC session.
 */

import { encodeFrame, LineDecoder, parseInbound, toWireCommand } from "../core/wire.ts";
import { Session, type SessionRegistry } from "../core/sessions.ts";
import type { EventFrame, HelloFrame, InboundFrame, ResFrame } from "../core/types.ts";
import { PROTOCOL_VERSION } from "../core/types.ts";
import type { LogSink } from "../core/log.ts";

export interface ConnectionOptions {
  token: string;
  registry: SessionRegistry;
  log: LogSink;
  maxInFlight: number;
  defaultCommandTimeoutMs: number;
  bufferCapacity?: number;
  /** How long to wait for `hello` before deciding the socket is a stray probe. */
  helloTimeoutMs?: number;
  /** Kinds of message the daemon will relay. */
  relayedKinds?: readonly string[];
  /**
   * How often to ping mIRC, so `daemon_status` can say when it has gone quiet.
   * The link is never closed over a missed ping: mIRC may only be busy, and
   * closing would throw away the session's DCC jobs and receipts.
   */
  heartbeatMs?: number;
}

const HEARTBEAT_MS = 30_000;

/**
 * Serializes writes onto the socket. `CommandDispatcher` writes synchronously, so
 * frames are queued and flushed in order rather than interleaved.
 *
 * Encoding happens eagerly, which is deliberate: an oversized frame throws here,
 * at the call site, instead of being discovered by the client. See wire.ts.
 */
class SocketWriter {
  #conn: Deno.Conn;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #log: LogSink;

  constructor(conn: Deno.Conn, log: LogSink) {
    this.#conn = conn;
    this.#log = log;
  }

  /** `wire` is what is sent when it differs from what is worth logging (encoded params). */
  write(frame: unknown, wire: unknown = frame): void {
    if (this.#closed) throw new Error("socket closed");
    const bytes = encodeFrame(wire);
    // Log the decoded frame rather than the bytes: the file sink is the wire
    // trace, redaction works on fields rather than raw buffers, and a base64
    // password would sail straight past the redactor.
    this.#log.debug("mbp.out", { frame });
    this.#queue = this.#queue
      .then(async () => {
        await this.#conn.write(bytes);
      })
      .catch((err) => {
        this.#log.debug("mbp.write-failed", { message: (err as Error).message });
      });
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  close(): void {
    this.#closed = true;
  }
}

export async function handleMircConnection(
  conn: Deno.Conn,
  options: ConnectionOptions,
): Promise<void> {
  const { log, registry } = options;
  const decoder = new LineDecoder();
  const remote = describe(conn);
  const connectionLog = log.child({ remote });
  // The connection's logger, not the door's, so outbound frames carry `remote`
  // like inbound ones and both directions of one socket can be read together.
  const writer = new SocketWriter(conn, connectionLog);

  let session: Session | undefined;
  let closed = false;

  const close = (reason: string): void => {
    if (closed) return;
    closed = true;
    clearTimeout(helloTimer);
    clearInterval(heartbeat);
    session?.close(reason);
    if (session) registry.remove(session.id);
    writer.close();
    try {
      conn.close();
    } catch {
      // already gone
    }
    connectionLog.info("mirc.disconnect", { session: session?.id, reason });
  };

  // A probe that never says hello must not hold a slot open forever.
  const helloTimer = setTimeout(() => {
    if (!session) {
      connectionLog.warn("mirc.hello-timeout", {
        afterMs: options.helloTimeoutMs ?? 5000,
      });
      close("no hello received");
    }
  }, options.helloTimeoutMs ?? 5000);

  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const onFrame = (frame: InboundFrame): void => {
    // Anything at all from mIRC shows its scripts are running.
    session?.heard();
    switch (frame.t) {
      case "hello":
        return onHello(frame);
      case "res":
        return onRes(frame);
      case "ev":
        return onEvent(frame);
      case "pong":
        return;
      default:
        connectionLog.warn("mbp.unknown-frame", { frame });
    }
  };

  const onHello = (frame: HelloFrame): void => {
    if (session) return; // duplicate hello; ignore rather than re-identify
    if (frame.token !== options.token) {
      // Never log the token itself, only the fact that it was wrong.
      connectionLog.warn("guard.deny", { reason: "bad token" });
      close("bad token");
      return;
    }
    if (frame.v !== PROTOCOL_VERSION) {
      // Refused, not tolerated: a bridge.mrc on another version may read
      // base64 params as plain text, and post the encoded string into a
      // channel verbatim, or act on the wrong connection.
      connectionLog.warn("mirc.protocol-mismatch", {
        theirs: frame.v,
        ours: PROTOCOL_VERSION,
      });
      writer.write({
        t: "bye",
        reason: `protocol v${frame.v} is not supported; this daemon speaks v${PROTOCOL_VERSION}. ` +
          "Copy the bridge.mrc from this repo into the mIRC folder and reload it.",
      });
      void writer.flush().then(() => close("protocol mismatch"));
      return;
    }

    clearTimeout(helloTimer);
    const id = registry.nextId();
    session = new Session({
      id,
      nick: frame.nick,
      mirc: frame.mirc,
      write: (cmd) => writer.write(cmd, toWireCommand(cmd)),
      log: connectionLog.child({ session: id }),
      maxInFlight: options.maxInFlight,
      defaultCommandTimeoutMs: options.defaultCommandTimeoutMs,
      bufferCapacity: options.bufferCapacity,
      ping: () => {
        try {
          writer.write({ t: "ping" });
        } catch {
          // the socket is closing; close() reports it
        }
      },
    });
    registry.add(session);
    const live = session;
    heartbeat = setInterval(() => live.ping(), options.heartbeatMs ?? HEARTBEAT_MS);

    writer.write({
      t: "welcome",
      session: id,
      maxInFlight: options.maxInFlight,
    });

    connectionLog.info("mirc.connect", {
      session: id,
      nick: frame.nick,
      mirc: frame.mirc,
    });

    // Seed state immediately, before any agent exists, so the daemon knows what
    // mIRC is doing from the outset.
    void session.refreshState().then((error) => {
      if (error) {
        connectionLog.warn("state.seed-failed", { code: error.code, hint: error.hint });
      }
    });
  };

  const onRes = (frame: ResFrame): void => {
    if (!session) {
      connectionLog.warn("mbp.res-before-hello", { id: frame.id });
      return;
    }
    session.commands.handleRes(frame);
  };

  const onEvent = (frame: EventFrame): void => {
    if (!session) {
      connectionLog.warn("mbp.ev-before-hello", { kind: frame.kind });
      return;
    }
    if (frame.kind === "dropped") {
      connectionLog.warn("mirc.events-dropped", { count: frame.extra?.count });
    }
    session.record({
      kind: frame.kind,
      cid: typeof frame.cid === "number" ? frame.cid : undefined,
      net: frame.net,
      buf: frame.buf,
      nick: frame.nick,
      user: frame.user,
      text: frame.text,
      raw: frame.raw,
      extra: frame.extra,
    });
  };

  try {
    for await (const chunk of conn.readable) {
      const { lines, dropped } = decoder.push(chunk);
      if (dropped > 0) connectionLog.warn("mbp.dropped-overlong", { count: dropped });
      for (const line of lines) {
        connectionLog.debug("mbp.in", { line });
        let frame: unknown;
        try {
          frame = parseInbound(line);
        } catch (err) {
          connectionLog.warn("mbp.bad-frame", { error: (err as Error).message });
          // A reply that does not parse still names its command near the start,
          // and bridge.mrc writes every reply as {"t":"res","id":"cN",...}.
          const id = /^\{"t":"res","id":"(c\d+)"/.exec(line)?.[1];
          if (id) session?.commands.rejectUnreadable(id, (err as Error).message);
          continue;
        }
        onFrame(frame as InboundFrame);
      }
    }
  } catch (err) {
    connectionLog.warn("mirc.read-error", { message: (err as Error).message });
  } finally {
    await writer.flush();
    close("socket closed");
  }
}

function describe(conn: Deno.Conn): string {
  const addr = conn.remoteAddr as Deno.NetAddr | undefined;
  if (!addr) return "unknown";
  return `${addr.hostname}:${addr.port}`;
}
