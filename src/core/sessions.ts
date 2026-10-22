/**
 * A session is one attached mIRC client and everything the daemon knows because
 * of it: connection state, recent events, DCC jobs, and the command channel.
 *
 * Sessions are deliberately disposable. Agents attach and detach freely, and the
 * daemon's lifetime is tied to the mIRC socket, not to any agent — which is why
 * quitting an agent can never drop an IRC session.
 */

import { EventBus } from "./bus.ts";
import { EventLog, type NewEvent } from "./buffers.ts";
import { DccTracker } from "./dcc.ts";
import { OwnershipLedger } from "./ownership.ts";
import { CommandDispatcher } from "./commands.ts";
import { StateModel } from "./state.ts";
import {
  type BridgeError,
  bridgeError,
  type BridgeEvent,
  type ChansPayload,
  type CmdFrame,
  type ConnsPayload,
  type NetworkState,
  type NetworkStatus,
  type SessionInfo,
} from "./types.ts";

/** mIRC's $status has a fourth value, "loggingon", which is still connecting. */
function toStatus(status: string): NetworkStatus {
  if (status === "connected" || status === "disconnected") return status;
  return "connecting";
}
import type { LogSink } from "./log.ts";

export interface SessionOptions {
  id: string;
  nick: string;
  mirc?: string;
  write: (frame: CmdFrame) => void;
  log?: LogSink;
  maxInFlight?: number;
  defaultCommandTimeoutMs?: number;
  bufferCapacity?: number;
}

export class Session {
  readonly id: string;
  readonly connectedTs = Date.now();
  readonly state = new StateModel();
  readonly log: EventLog;
  readonly bus: EventBus;
  readonly dcc = new DccTracker();
  /** What the agent opened or joined itself; see ownership.ts. */
  readonly owned = new OwnershipLedger();
  readonly commands: CommandDispatcher;
  nick: string;
  mirc?: string;
  /** mIRC's DCC send-request setting ($sreq) as of the last refresh, if reported. */
  sreq?: string;
  #closed = new AbortController();

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.nick = options.nick;
    this.mirc = options.mirc;
    this.log = new EventLog(options.bufferCapacity);
    this.bus = new EventBus((err, event) => {
      options.log?.error("bus.handler-failed", {
        kind: event.kind,
        message: (err as Error).message,
      });
    });
    this.commands = new CommandDispatcher({
      write: options.write,
      maxInFlight: options.maxInFlight,
      defaultTimeoutMs: options.defaultCommandTimeoutMs,
      log: options.log,
    });
  }

  /**
   * Record an inbound event. One path for all of them — append to the log, fold
   * into the state model, update DCC jobs, then fan out — so a subscriber can
   * never observe an event the log or the state model has not seen.
   */
  record(input: NewEvent): BridgeEvent {
    const event = this.log.append(input);
    // The hello nick goes stale the first time services or a collision rename us.
    if (event.kind === "selfnick" && typeof event.extra?.new === "string" && event.extra.new) {
      this.nick = event.extra.new;
    }
    // Before the state model, which may drop the channel; the nick is unaffected.
    const ours = event.cid === undefined ? undefined : this.state.byCid(event.cid)?.nick;
    this.owned.applyEvent(event, ours);
    this.state.applyEvent(event);
    this.dcc.applyEvent(event);
    this.bus.emit(event);
    return event;
  }

  /**
   * Ask mIRC what it is doing and adopt the answer. Called once when mIRC
   * attaches, and again by the tool layer before a compound command when the
   * model has gone stale — so nothing acts on a picture of mIRC that has drifted.
   */
  async refreshState(timeoutMs?: number): Promise<BridgeError | undefined> {
    const outcome = await this.commands.send("conns", undefined, { timeoutMs });
    if (!outcome.ok) return outcome.error;

    const payload = outcome.data as ConnsPayload | undefined;
    if (!payload || !Array.isArray(payload.conns)) {
      return bridgeError("server_error", "mIRC replied to `conns` without a connection list.");
    }
    if (typeof payload.sreq === "string") this.sreq = payload.sreq;

    // Channels are fetched per connection rather than all at once, so that no
    // single frame has to describe everything mIRC is in. Only a connected
    // connection can be in a channel, so the rest cost no round trip.
    const networks: NetworkState[] = [];
    for (const conn of payload.conns) {
      if (typeof conn.cid !== "number") continue;
      const status = toStatus(conn.status);
      const net: NetworkState = {
        cid: conn.cid,
        name: conn.net || conn.server || `cid ${conn.cid}`,
        server: conn.server || undefined,
        status,
        nick: conn.nick,
        channels: [],
        members: {},
      };
      if (status === "connected") {
        const chans = await this.commands.send("chans", { cid: conn.cid }, { timeoutMs });
        if (!chans.ok) return chans.error;
        const data = chans.data as Partial<ChansPayload> | undefined;
        net.channels = Array.isArray(data?.channels) ? data.channels : [];
        net.members = data?.members ?? {};
      }
      networks.push(net);
    }
    this.state.applyStateFrame(networks);
    this.owned.retainOnly(networks.map((n) => n.cid));
    return undefined;
  }

  info(): SessionInfo {
    return {
      id: this.id,
      nick: this.nick,
      mirc: this.mirc,
      connectedTs: this.connectedTs,
    };
  }

  /**
   * Aborted when this session's mIRC link drops. Waits listen for it, so an
   * agent waiting on a reply hears "the link dropped" rather than silence:
   * after a reconnect, events go to a new session this wait knows nothing of.
   */
  get closed(): AbortSignal {
    return this.#closed.signal;
  }

  close(reason: string): void {
    this.commands.close(reason);
    this.#closed.abort(reason);
  }
}

/**
 * Every attached mIRC client. In practice there is one, but nothing in the core
 * assumes that: commands name a session when more than one is attached and are
 * refused rather than guessed at when that is ambiguous.
 */
export class SessionRegistry {
  #sessions = new Map<string, Session>();
  #seq = 0;

  nextId(): string {
    this.#seq += 1;
    return `s${this.#seq}`;
  }

  add(session: Session): void {
    this.#sessions.set(session.id, session);
  }

  remove(id: string): void {
    this.#sessions.delete(id);
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  list(): Session[] {
    return [...this.#sessions.values()];
  }

  get size(): number {
    return this.#sessions.size;
  }

  /**
   * Resolve a session by id, or infer it when exactly one is attached. Returns
   * undefined when the id is unknown, or when the caller omitted it and more than
   * one session exists — the caller turns that into a clear error rather than
   * acting on the wrong mIRC.
   */
  resolve(id?: string): Session | undefined {
    if (id !== undefined) return this.#sessions.get(id);
    if (this.#sessions.size === 1) return this.list()[0];
    return undefined;
  }
}
