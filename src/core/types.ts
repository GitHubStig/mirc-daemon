/**
 * Shared vocabulary for the mIRC ↔ daemon bridge (MBP) and the daemon's internal model.
 *
 * Keep this file dependency-free: everything else imports from it.
 */

/**
 * Wire protocol version. Bumped only on a breaking frame-shape change.
 *
 * 2: string command params are base64. A v1 bridge.mrc would post the encoded
 *    text verbatim, so a mismatched hello is refused rather than tolerated.
 * 3: multi-connection. Events carry `cid`, commands name the connection they
 *    act on, and `state` is replaced by `conns` + `chans`. A v2 script would
 *    run every command on whichever window happened to be active.
 */
export const PROTOCOL_VERSION = 3;

/** mIRC's line limit is just under 4150 bytes; leave headroom. */
export const MAX_FRAME_BYTES = 3500;

// ---------------------------------------------------------------------------
// Error taxonomy (§10.2 of the plan)
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "connect_timeout"
  | "connect_failed"
  | "nick_in_use"
  | "join_failed"
  | "join_timeout"
  | "not_on_channel"
  | "unknown_network"
  | "ambiguous_network"
  | "nick_not_found"
  | "bot_not_in_channel"
  | "bot_no_response"
  | "bot_refused"
  | "dcc_failed"
  | "server_error"
  | "timeout"
  | "guard_denied"
  | "weak_match"
  | "too_long";

/** A structured failure. `hint` is written for an LLM to read and relay. */
export interface BridgeError {
  code: ErrorCode;
  /** Raw IRC numeric, when the failure came from one. */
  numeric?: number;
  /** What the server or mIRC said. */
  detail?: string;
  hint: string;
}

export function bridgeError(
  code: ErrorCode,
  hint: string,
  extra: { numeric?: number; detail?: string } = {},
): BridgeError {
  return { code, hint, ...extra };
}

/** An Error carrying a BridgeError, for throwing inside the core. */
export class BridgeFailure extends Error {
  readonly error: BridgeError;
  constructor(error: BridgeError) {
    super(error.hint);
    this.name = "BridgeFailure";
    this.error = error;
  }
}

// ---------------------------------------------------------------------------
// State model
// ---------------------------------------------------------------------------

export type NetworkStatus = "connected" | "connecting" | "disconnected";

/**
 * Network names compare case-insensitively. Each server announces its own
 * spelling in ISUPPORT, and they disagree within one network: EFNet reached
 * through one server and EFnet through irc.efnet.org. Matching exactly turned
 * a reconnect into `unknown_network` for an agent holding the old spelling.
 */
export function sameNetwork(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * One mIRC connection. The name says "network" because that is how agents
 * address it, but the identity is `cid`: two connections can share a network,
 * and a connection has no network name until the server announces one.
 */
export interface NetworkState {
  /** mIRC's connection id ($cid). Stable for as long as the connection window exists. */
  cid: number;
  /** The network name ($network), or the server name until the network is known. */
  name: string;
  server?: string;
  port?: number;
  status: NetworkStatus;
  /** Our current nick on this network. Authoritative; see §8. */
  nick: string;
  channels: string[];
  /** Channel name → member count, as reported by the `chans` action. */
  members: Record<string, number>;
  /**
   * The last time our nick changed on this connection, whoever changed it: the
   * user, an agent, or the network's services. A services rename (NickServ
   * turning a registered nick into Guest12345) is the usual reason a channel
   * later refuses us with 477, so the agent needs to be able to see it.
   */
  renamed?: { from: string; to: string; ts: number };
}

// ---------------------------------------------------------------------------
// Wire frames: mIRC → daemon
// ---------------------------------------------------------------------------

export interface HelloFrame {
  t: "hello";
  v: number;
  token: string;
  nick: string;
  mirc?: string;
}

export interface ResFrame {
  t: "res";
  id: string;
  ok: boolean;
  data?: Record<string, unknown>;
  code?: string;
  numeric?: number;
  err?: string;
  hint?: string;
}

/**
 * Shape of `res.data` for the `conns` action: every connection mIRC has, one
 * line each. Channels come separately, per connection, from `chans`, so that
 * no single frame has to describe everything mIRC is in. Both are carried in
 * the normal command reply, so the dispatcher keeps one reply mechanism and
 * one correlation path.
 */
export interface ConnsPayload {
  conns: Array<{ cid: number; net?: string; server?: string; status: string; nick: string }>;
  /** mIRC's DCC send-request setting ($sreq): "auto", "ask" or "ignore". */
  sreq?: string;
}

/** Shape of `res.data` for the `chans` action: one connection's channels. */
export interface ChansPayload {
  channels: string[];
  members: Record<string, number>;
}

export interface PongFrame {
  t: "pong";
}

/**
 * Kinds of IRC activity the daemon mirrors. `nick` is somebody else renaming;
 * `selfnick` is *us* being renamed by the server or services (§8).
 */
export const EVENT_KINDS = [
  "raw",
  "text",
  "notice",
  "ctcp",
  "nick",
  "selfnick",
  "join",
  "part",
  "quit",
  "kick",
  "topic",
  "conn",
  "error",
  "dcc",
] as const;

/**
 * Held as a runtime list as well as a type, so the tool layer can reject a
 * misspelt kind outright. A free-form string that matches nothing turns a typo
 * into a wait that silently runs to its timeout.
 */
export type EventKind = typeof EVENT_KINDS[number];

export interface EventFrame {
  t: "ev";
  kind: EventKind;
  /** The connection the event happened on. The network name alone is ambiguous. */
  cid?: number;
  net: string;
  buf?: string;
  nick?: string;
  user?: string;
  text?: string;
  /**
   * For `kind === "raw"`: the numeric, then its parameters as mIRC hands them to
   * a raw event — starting with our nick, with no server prefix and no colon
   * before the last parameter, e.g. "401 me nobody No such nick". The numeric is
   * also in `extra.numeric`.
   */
  raw?: string;
  /** kind-specific payload: nick change, conn state, dcc outcome, etc. */
  extra?: Record<string, unknown>;
}

export type InboundFrame = HelloFrame | ResFrame | PongFrame | EventFrame;

// ---------------------------------------------------------------------------
// Wire frames: daemon → mIRC
// ---------------------------------------------------------------------------

export type ActionName =
  | "conns"
  | "chans"
  | "connect"
  | "join"
  | "part"
  | "say"
  | "msg"
  | "notice"
  | "members"
  | "ison"
  | "whois"
  | "echo"
  | "raw"
  | "nick"
  | "disconnect"
  | "dccstop"
  /** mIRC's open downloads ($get), polled while a transfer runs. */
  | "gets";

export interface CmdFrame {
  t: "cmd";
  id: string;
  action: ActionName;
  params?: Record<string, unknown>;
}

export interface WelcomeFrame {
  t: "welcome";
  session: string;
  maxInFlight: number;
}

export interface PingFrame {
  t: "ping";
}

/** Sent before the daemon closes a connection it will not serve, so mIRC can say why. */
export interface ByeFrame {
  t: "bye";
  reason: string;
}

export type OutboundFrame = CmdFrame | WelcomeFrame | PingFrame | ByeFrame;

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

/** A normalized piece of IRC activity, as the daemon reasons about it. */
export interface BridgeEvent {
  /** Monotonic position assigned when buffered; also the cursor value. */
  seq: number;
  ts: number;
  kind: EventKind;
  /** mIRC's connection id; absent only from frames that predate protocol v3. */
  cid?: number;
  net: string;
  /** IRC window: a channel (`#chan`) or a query (a nick). */
  buf?: string;
  nick?: string;
  user?: string;
  text?: string;
  /** For `kind === "raw"`: the numeric then its parameters; see EventFrame. */
  raw?: string;
  /** kind-specific payload. */
  extra?: Record<string, unknown>;
}

export interface SessionInfo {
  id: string;
  nick: string;
  mirc?: string;
  connectedTs: number;
}

/**
 * Where a transfer stands. A requested pack moves requested → (queued) →
 * offered → downloading → complete, or ends refused or failed. Everything
 * before the end is "active". Tracked in the background, because a busy bot
 * can take minutes to answer and no tool call can wait that long (clients give
 * up after ~60 s).
 */
export type DccState =
  | "requested"
  | "queued"
  | "offered"
  /** mIRC reports bytes arriving (polled with `gets`). */
  | "downloading"
  /** Still open in mIRC, but no bytes for a while: GETFAIL may never come. */
  | "stalled"
  | "complete"
  | "refused"
  | "failed"
  /** Stopped on request (xdcc_cancel), e.g. because it was the wrong file. */
  | "cancelled";

export const ACTIVE_DCC_STATES: ReadonlySet<DccState> = new Set([
  "requested",
  "queued",
  "offered",
  "downloading",
  "stalled",
]);

/** The active states in which mIRC has (or should have) a download open. */
export const TRANSFER_DCC_STATES: ReadonlySet<DccState> = new Set([
  "offered",
  "downloading",
  "stalled",
]);

/**
 * One of mIRC's open downloads, as `gets` reports it ($get(N)). `rcvd` counts
 * from the start of the file, so a resumed transfer starts high.
 */
export interface DccGet {
  nick: string;
  file: string;
  size: number;
  rcvd: number;
  /** Bytes per second, as mIRC measures it. */
  cps: number;
  /** True once mIRC considers the get finished (its window stays open). */
  done: boolean;
}

export interface DccJob {
  id: string;
  /** The connection the request went out on, and where replies count from. */
  cid?: number;
  net: string;
  /**
   * The file's name, from the bot's reply or its DCC offer; unknown until one
   * of them says. Surfaced to the user because a pack number from an outdated
   * website can point at the wrong file.
   */
  file?: string;
  size?: number;
  /** Where mIRC saved it: FILERCVD/GETFAIL report the full local path. */
  savedAs?: string;
  state: DccState;
  startedTs: number;
  /** When the state last changed. */
  updatedTs: number;
  endedTs?: number;
  secs?: number;
  /** Queue position, while `queued`. */
  position?: number;
  /**
   * Where a resumed transfer picked up, from the bot's `DCC ACCEPT`. mIRC
   * resumes whenever the file already exists, so asking again for a pack
   * after a broken transfer continues it; for a file already complete, this
   * is 8 KB short of the size (mIRC re-checks the tail) and it ends at once.
   */
  resumedFrom?: number;
  /** Bytes on disk so far, from mIRC's last `gets` answer. */
  rcvd?: number;
  /** Transfer rate in bytes per second, from the same answer. */
  cps?: number;
  /** When `rcvd` last grew: what a stall is measured from. */
  progressTs?: number;
  /** The bot's last reply, formatting removed: what to show a person. */
  lastReply?: string;
  /**
   * What the daemon made of `lastReply` ("queued", "denied", ...), or
   * "unknown" when no pattern matched: then only reading it tells.
   */
  lastReplyKind?: string;
  /** When `lastReply` arrived, so a waiter can tell a new reply from an old one. */
  lastReplyTs?: number;
  /** Why it was refused or failed, in the bot's or mIRC's words. */
  detail?: string;
  /** Set when the job was opened by a tool call that asked for it. */
  requestedBy?: { bot: string; pack?: string };
  /** Who offered or sent it, for a transfer nobody here requested. */
  sender?: string;
}

/** Snapshot of everything an agent can ask about, for `daemon_status`. */
export interface DaemonStatus {
  uptimeSecs: number;
  sessions: number;
  /** True when at least one mIRC client is attached. */
  mircAttached: boolean;
  sessionId?: string;
  nick?: string;
  agentsAttached: number;
  lastStateRefreshTs?: number;
  dccJobs: number;
}
