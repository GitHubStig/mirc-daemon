/**
 * The failure taxonomy: turning what IRC and mIRC say into a stable code plus a
 * hint an LLM can act on.
 *
 * This mapping lives here, in testable TypeScript, rather than in the mSL script.
 * `bridge.mrc` stays dumb: it reports the numeric it saw and the daemon decides
 * what that means.
 */

import {
  type BridgeError,
  bridgeError,
  type ErrorCode,
  type NetworkState,
  type ResFrame,
} from "./types.ts";

/** What the command was trying to do, used to interpret unmodelled numerics. */
export type OutcomeContext = "connect" | "join" | "message" | "generic";

export type CommandOutcome =
  | { ok: true; data?: Record<string, unknown> }
  | { ok: false; error: BridgeError };

interface NumericRule {
  code: ErrorCode;
  hint: (detail?: string) => string;
}

/**
 * Numerics we can explain. Anything absent falls back to a context-appropriate
 * code with the raw numeric and the server's own wording preserved, so an
 * unmodelled reply is still actionable rather than generic.
 */
const NUMERIC_RULES: Record<number, NumericRule> = {
  401: {
    code: "nick_not_found",
    hint: () =>
      "that nick does not exist on this network — check the spelling, or the bot may be offline.",
  },
  403: {
    code: "join_failed",
    hint: () =>
      "no such channel — the name may be wrong, or the channel is not on this network (a channel name is not shared between networks).",
  },
  404: {
    code: "server_error",
    hint: () => "cannot send to that channel — you may be muted, or the channel is moderated.",
  },
  405: {
    code: "server_error",
    hint: () => "you have joined too many channels on this network.",
  },
  432: {
    code: "server_error",
    hint: () => "the server rejected that nick as invalid (characters or length).",
  },
  433: {
    code: "nick_in_use",
    hint: () => "that nick is already in use on this network; pick another.",
  },
  437: {
    code: "server_error",
    hint: () =>
      "that nick or channel is temporarily unavailable (held by the network after recent use); " +
      "try again later or pick another.",
  },
  438: {
    code: "server_error",
    hint: () => "the server says nick changes are too fast; wait a little and try again.",
  },
  464: { code: "connect_failed", hint: () => "the server rejected the password for this network." },
  465: { code: "connect_failed", hint: () => "you are banned from this server." },
  466: { code: "connect_failed", hint: () => "you are banned from this server." },
  471: { code: "join_failed", hint: () => "the channel is full." },
  473: { code: "join_failed", hint: () => "the channel is invite-only." },
  474: { code: "join_failed", hint: () => "you are banned from that channel." },
  475: { code: "join_failed", hint: () => "the channel requires a key." },
  477: { code: "join_failed", hint: () => "the channel requires a registered nick." },
  472: {
    code: "server_error",
    hint: () => "this server does not support that mode letter; check the network's modes.",
  },
  482: { code: "server_error", hint: () => "you are not a channel operator there." },
};

const CONTEXT_FALLBACK: Record<OutcomeContext, ErrorCode> = {
  connect: "connect_failed",
  join: "join_failed",
  message: "server_error",
  generic: "server_error",
};

const KNOWN_CODES = new Set<string>([
  "connect_timeout",
  "connect_failed",
  "nick_in_use",
  "join_failed",
  "join_timeout",
  "not_on_channel",
  "unknown_network",
  "ambiguous_network",
  "nick_not_found",
  "bot_not_in_channel",
  "bot_no_response",
  "bot_refused",
  "dcc_failed",
  "server_error",
  "timeout",
  "guard_denied",
  "weak_match",
  "too_long",
]);

export function classifyNumeric(
  numeric: number,
  context: OutcomeContext = "generic",
  detail?: string,
): BridgeError {
  const rule = NUMERIC_RULES[numeric];
  if (rule) {
    return bridgeError(rule.code, rule.hint(detail), { numeric, detail });
  }
  const suffix = detail ? ` The server said: "${detail}".` : "";
  return bridgeError(
    CONTEXT_FALLBACK[context],
    `the server refused that with numeric ${numeric}.${suffix}`,
    { numeric, detail },
  );
}

/**
 * Failure tokens bridge.mrc sends in `err` when no numeric is involved. mSL has
 * no cheap way to emit a `code` field, so the mapping lives here instead.
 */
const ERR_TOKENS: Record<string, { code: ErrorCode; hint: string }> = {
  "not-on-channel": {
    code: "not_on_channel",
    hint: "mIRC is not in that channel. Join it first with irc_join.",
  },
  "join-timeout": {
    code: "join_timeout",
    hint: "the server never confirmed the join. The channel may forward elsewhere, or the " +
      "server sent a refusal mIRC does not recognise; check irc_read for a raw numeric.",
  },
  "ison-timeout": { code: "timeout", hint: "the server did not answer the ISON query." },
  "connection-busy": {
    code: "connect_failed",
    hint: "mIRC refused to reconnect that window because it is not disconnected. Check " +
      "irc_get_state; the connection may already be back.",
  },
  "nick-timeout": {
    code: "timeout",
    hint: "the server never confirmed the nick change. Check irc_get_state for the current nick.",
  },
  "disconnect-timeout": {
    code: "timeout",
    hint:
      "mIRC did not report the connection closing. Check irc_get_state before assuming either " +
      "way.",
  },
  "part-timeout": {
    code: "timeout",
    hint: "the server never confirmed leaving the channel. Check irc_get_state before " +
      "assuming either way.",
  },
  "connection-failed": {
    code: "connect_failed",
    hint: "mIRC lost or could not establish the connection to that server.",
  },
};

/**
 * Interpret mIRC's reply to one command. mIRC reports the outcome it observed,
 * so for `join` this already reflects the join echo or the error numeric.
 */
export function normalizeRes(
  frame: ResFrame,
  context: OutcomeContext = "generic",
): CommandOutcome {
  if (frame.ok) {
    return frame.data === undefined ? { ok: true } : { ok: true, data: frame.data };
  }

  // bridge.mrc sends numeric 0 to mean "no numeric", since mSL always fills the field.
  if (typeof frame.numeric === "number" && frame.numeric > 0) {
    const error = classifyNumeric(frame.numeric, context, frame.err);
    // mSL may know a more specific hint than we can infer from the numeric alone.
    return { ok: false, error: frame.hint ? { ...error, hint: frame.hint } : error };
  }

  if (typeof frame.code === "string" && KNOWN_CODES.has(frame.code)) {
    return {
      ok: false,
      error: bridgeError(frame.code as ErrorCode, frame.hint ?? "the command failed.", {
        detail: frame.err,
      }),
    };
  }

  const token = frame.err ? ERR_TOKENS[frame.err] : undefined;
  if (token) {
    return {
      ok: false,
      error: bridgeError(token.code, frame.hint ?? token.hint, { detail: frame.err }),
    };
  }

  return {
    ok: false,
    error: bridgeError(
      CONTEXT_FALLBACK[context],
      frame.hint ?? `mIRC could not complete that: ${frame.err ?? "no reason given"}.`,
      { detail: frame.err },
    ),
  };
}

/**
 * A *warning*, not a failure: a channel with almost nobody in it is probably the
 * wrong channel, but empty channels are legitimate, so the agent gets the fact
 * plus the suspicion and decides what to do about it.
 */
export function emptyChannelWarning(
  channel: string,
  memberCount: number | undefined,
  threshold = 2,
): BridgeError | undefined {
  if (memberCount === undefined || memberCount > threshold) return undefined;
  return bridgeError(
    "weak_match",
    `${channel} has only ${memberCount} member${memberCount === 1 ? "" : "s"} — ` +
      "this may be the wrong channel.",
  );
}

/** True when a network is in a state where commands can actually be sent. */
export function networkUsable(net: NetworkState): boolean {
  return net.status === "connected";
}
