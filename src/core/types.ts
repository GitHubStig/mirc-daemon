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
 */
export const PROTOCOL_VERSION = 2;

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

export interface NetworkState {
  name: string;
  server?: string;
  port?: number;
  status: NetworkStatus;
  /** Our current nick on this network. Authoritative; see §8. */
  nick: string;
  channels: string[];
  /** Channel name → member count, as reported by the `state` action. */
  members: Record<string, number>;
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
 * Shape of `res.data` for the `state` action: what mIRC reports about itself.
 * Carried inside the normal command reply rather than as a bespoke frame, so the
 * dispatcher has exactly one reply mechanism and one correlation path.
 */
export interface StatePayload {
  networks: NetworkState[];
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
  net: string;
  buf?: string;
  nick?: string;
  user?: string;
  text?: string;
  /** The whole server line, for `kind === "raw"`. */
  raw?: string;
  /** kind-specific payload: nick change, conn state, dcc outcome, etc. */
  extra?: Record<string, unknown>;
}

export type InboundFrame = HelloFrame | ResFrame | PongFrame | EventFrame;

// ---------------------------------------------------------------------------
// Wire frames: daemon → mIRC
// ---------------------------------------------------------------------------

export type ActionName =
  | "state"
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
  | "quit";

/** Actions that can change the world outside this process. Gated (§7 / ADR-0006). */
export const GATED_ACTIONS: ReadonlySet<ActionName> = new Set<ActionName>(["raw", "quit"]);

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
  net: string;
  /** IRC window: a channel (`#chan`) or a query (a nick). */
  buf?: string;
  nick?: string;
  user?: string;
  text?: string;
  /** The raw server line, for `kind === "raw"`. */
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

export type DccState = "in_flight" | "complete" | "failed";

export interface DccJob {
  id: string;
  net: string;
  /** Unknown until mIRC reports the transfer, since there is no pre-transfer hook. */
  file?: string;
  size?: number;
  state: DccState;
  startedTs: number;
  endedTs?: number;
  secs?: number;
  detail?: string;
  /** Set when the job was opened by a tool call that asked for it. */
  requestedBy?: { bot: string; pack?: string };
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
