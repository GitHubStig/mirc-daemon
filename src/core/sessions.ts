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
import { DccTracker, humanSize } from "./dcc.ts";
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
  type DccGet,
  type DccJob,
  type DccState,
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
  /** How often to ask mIRC about open downloads while a transfer runs. */
  progressIntervalMs?: number;
  /** No new bytes for this long and a download counts as stalled. */
  stallAfterMs?: number;
  /** Send mIRC a ping frame; bridge.mrc answers each with a pong. */
  ping?: () => void;
}

/**
 * A ping unanswered this long means mIRC is not running scripts. Pongs came
 * back in milliseconds live, and kept coming with mIRC's Options dialog open.
 */
const SILENT_AFTER_MS = 5_000;

/**
 * Often enough that a stall shows within the minute it takes to call it one,
 * rarely enough that the frames are noise next to IRC traffic.
 */
const PROGRESS_INTERVAL_MS = 15_000;

/** mIRC's `gets` answer, trusting no field: an older script may not send it. */
function toGets(data: Record<string, unknown> | undefined): DccGet[] {
  const list = Array.isArray(data?.gets) ? data.gets : [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return list
    .filter((g): g is Record<string, unknown> => typeof g === "object" && g !== null)
    .filter((g) => typeof g.nick === "string" && typeof g.file === "string")
    .map((g) => {
      const size = num(g.size);
      const rcvd = num(g.rcvd);
      // mIRC keeps a finished get's window, and $get().done did not say so live
      // (0 for a window at full size), so a full count is what marks it done.
      return {
        nick: g.nick as string,
        file: g.file as string,
        size,
        rcvd,
        cps: num(g.cps),
        done: g.done === true || g.done === 1 || (size > 0 && rcvd >= size),
      };
    });
}

/** What to tell the agent when mIRC has gone quiet, pings included. */
export function silenceHint(silentMs: number): string {
  return `mIRC has sent nothing for ${Math.round(silentMs / 1000)} s, not even an answer to a ` +
    "ping, so it is not running its scripts: it may be frozen or busy, or the link to it may " +
    "be dead without having closed. Ask the user to check mIRC (/bridge.diag shows the " +
    "bridge's state), then try again.";
}

export class Session {
  readonly id: string;
  readonly connectedTs = Date.now();
  readonly state = new StateModel();
  readonly log: EventLog;
  readonly bus: EventBus;
  readonly dcc: DccTracker;
  /** What the agent opened or joined itself; see ownership.ts. */
  readonly owned = new OwnershipLedger();
  readonly commands: CommandDispatcher;
  nick: string;
  mirc?: string;
  /** mIRC's DCC send-request setting ($sreq) as of the last refresh, if reported. */
  sreq?: string;
  #closed = new AbortController();
  #progressIntervalMs: number;
  #progressTimer?: ReturnType<typeof setInterval>;
  #polling = false;
  #sendPing?: () => void;
  /** When mIRC last sent anything at all: a reply, an event or a pong. */
  #heardTs = Date.now();
  /** When the oldest still-unanswered ping went out. */
  #pingSentTs?: number;

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.nick = options.nick;
    this.mirc = options.mirc;
    this.dcc = new DccTracker({ stallAfterMs: options.stallAfterMs });
    this.#progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    this.#sendPing = options.ping;
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
      liveness: options.ping
        ? { probe: () => this.ping(), explainSilence: (since) => this.explainSilence(since) }
        : undefined,
    });
    this.#noteDccChanges();
  }

  /**
   * Tell the user, in mIRC's @bridge window, what the agent just did. Best
   * effort by design: a note never delays or fails what it describes, so it is
   * not awaited. Its outcome is still logged like any command's.
   */
  note(text: string): void {
    if (this.#closed.signal.aborted) return;
    void this.commands.send("note", { text: text.slice(0, 400) });
  }

  /**
   * Note a requested transfer's turns as they happen, in the background: an
   * offer, completion, failure, a stall, a refusal. Progress polls are not
   * noted; they change nothing anyone needs to hear about.
   */
  #noteDccChanges(): void {
    const seen = new Map<string, DccState>();
    this.dcc.onChange((job) => {
      if (!job.requestedBy || seen.get(job.id) === job.state) return;
      seen.set(job.id, job.state);
      const pack = `pack #${(job.requestedBy.pack ?? "?").replace(/^#/, "")}`;
      const size = humanSize(job.size);
      const what = job.file ? `${pack}, "${job.file}"${size ? ` (${size})` : ""}` : pack;
      const from = job.requestedBy.bot;
      switch (job.state) {
        case "offered":
          this.note(`${from} is sending ${what}`);
          break;
        case "complete":
          this.note(`received ${what}${job.savedAs ? `, saved as ${job.savedAs}` : ""}`);
          break;
        case "failed":
          this.note(`transfer from ${from} failed: ${what}`);
          break;
        case "stalled":
          this.note(`transfer from ${from} has stalled (no data for a minute): ${what}`);
          break;
        case "refused":
          this.note(`${from} refused ${pack}: ${job.detail ?? ""}`);
          break;
        case "cancelled":
          this.note(`cancelled the transfer from ${from}: ${what}`);
          break;
      }
    });
  }

  /** mIRC sent something: it is running scripts. */
  heard(now = Date.now()): void {
    this.#heardTs = now;
    this.#pingSentTs = undefined;
  }

  /** Ask mIRC for a sign of life. Any frame back counts, not just the pong. */
  ping(now = Date.now()): void {
    this.#pingSentTs ??= now;
    this.#sendPing?.();
  }

  /**
   * How long mIRC has failed to answer a ping, once that is long enough to
   * mean something; undefined while it is answering.
   */
  silentForMs(now = Date.now()): number | undefined {
    if (this.#pingSentTs === undefined) return undefined;
    const owed = now - this.#pingSentTs;
    return owed >= SILENT_AFTER_MS ? now - this.#heardTs : undefined;
  }

  /** For a command sent at `sinceTs` that got no answer: was mIRC there at all? */
  explainSilence(sinceTs: number, now = Date.now()): string | undefined {
    if (this.#heardTs >= sinceTs || this.silentForMs(now) === undefined) return undefined;
    return silenceHint(now - this.#heardTs);
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
    this.#syncProgressPolling();
    this.bus.emit(event);
    return event;
  }

  /**
   * Ask mIRC about its open downloads and fold the answer into the jobs.
   * Runs on a timer while any transfer is open; callable directly too. A
   * failed ask changes nothing: an older bridge.mrc without `gets` just means
   * no progress, as before.
   */
  async pollTransfers(): Promise<DccJob[]> {
    if (this.#polling) return [];
    // A job can end outside the event stream (xdcc_cancel), so the timer
    // stops itself here rather than ticking on with nothing to do.
    if (this.dcc.transferring().length === 0) {
      this.#syncProgressPolling();
      return [];
    }
    this.#polling = true;
    try {
      const outcome = await this.commands.send("gets", undefined, { timeoutMs: 5000 });
      if (!outcome.ok) return [];
      return this.dcc.applyProgress(toGets(outcome.data));
    } finally {
      this.#polling = false;
      this.#syncProgressPolling();
    }
  }

  /** Poll only while there is something to poll for. */
  #syncProgressPolling(): void {
    const wanted = !this.#closed.signal.aborted && this.dcc.transferring().length > 0;
    if (wanted && this.#progressTimer === undefined) {
      this.#progressTimer = setInterval(() => void this.pollTransfers(), this.#progressIntervalMs);
    } else if (!wanted && this.#progressTimer !== undefined) {
      clearInterval(this.#progressTimer);
      this.#progressTimer = undefined;
    }
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
    this.#syncProgressPolling();
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
