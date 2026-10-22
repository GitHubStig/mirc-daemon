/**
 * "Tell me when a message like this arrives."
 *
 * This is the primitive that keeps agent workflows sane. Without it an agent has
 * to poll `irc_read` in a loop, which is exactly the failure mode that makes long
 * prose instructions misbehave. One blocking call that returns the moment the bot
 * replies is both cheaper and far more reliable.
 *
 * A wait resolves in one of two ways, and the second is the one that matters:
 *
 *  1. A matching event arrives while we are subscribed.
 *  2. A matching event is *already in the log* past the caller's cursor.
 *
 * The second case closes a real race: a bot that answers 200 ms before the tool
 * call would otherwise mean waiting forever and timing out.
 */

import { type BridgeEvent, type EventKind, sameNetwork } from "./types.ts";
import type { EventBus } from "./bus.ts";
import type { EventLog } from "./buffers.ts";

export interface WaitMatcher {
  kind?: EventKind;
  net?: string;
  /** IRC window: channel or query nick. Matched case-insensitively. */
  buf?: string;
  /** Nick the event is *from*, matched case-insensitively. */
  nick?: string;
  /** Case-insensitive substring match across the event's text and raw line. */
  pattern?: string;
  /**
   * Only events addressed to us — a query, a notice or a CTCP — not channel
   * traffic. An XDCC bot advertises in its channel constantly, so waiting on
   * "anything from the bot" would take an advert for the reply.
   */
  direct?: boolean;
}

/** IRC channel prefixes; anything else in `buf` is a query nick. */
const CHANNEL_PREFIXES = "#&+!";

export function isChannelBuffer(buf: string | undefined): boolean {
  return buf !== undefined && buf.length > 0 && CHANNEL_PREFIXES.includes(buf[0]);
}

export function matchesWait(event: BridgeEvent, matcher: WaitMatcher): boolean {
  if (matcher.kind !== undefined && event.kind !== matcher.kind) return false;
  if (matcher.direct && isChannelBuffer(event.buf)) return false;
  if (matcher.net !== undefined && !sameNetwork(event.net, matcher.net)) return false;
  if (matcher.buf !== undefined && !sameIgnoreCase(event.buf, matcher.buf)) return false;
  if (matcher.nick !== undefined && !sameIgnoreCase(event.nick, matcher.nick)) return false;
  if (matcher.pattern !== undefined) {
    const haystack = searchableText(event);
    if (!haystack.includes(matcher.pattern.toLowerCase())) return false;
  }
  return true;
}

function sameIgnoreCase(value: string | undefined, expected: string): boolean {
  return (value ?? "").toLowerCase() === expected.toLowerCase();
}

/**
 * Everything worth searching in an event. Notices and CTCPs carry their payload
 * in `text`; raw lines carry it in `raw`; a few kinds stash it in `extra`.
 */
function searchableText(event: BridgeEvent): string {
  const parts = [event.text, event.raw];
  const extraText = event.extra?.text;
  if (typeof extraText === "string") parts.push(extraText);
  return parts.filter((p): p is string => typeof p === "string").join("\n").toLowerCase();
}

export interface WaitOptions {
  log: EventLog;
  bus: EventBus;
  matcher: WaitMatcher;
  /** Cursor to start from. Omit for "from now", ignoring backlog. */
  since?: number;
  timeoutMs?: number;
}

/**
 * Resolve with the first matching event, or `undefined` if none arrives within
 * `timeoutMs`. Timing out is not an error here — the caller knows whether "no
 * reply" means a bad bot name or merely a quiet channel, so it picks the code.
 */
export function waitForEvent(options: WaitOptions): Promise<BridgeEvent | undefined> {
  const { log, bus, matcher } = options;
  const cursor = options.since ?? log.cursor;

  // The backlog scan and the subscription happen in one synchronous block, so no
  // event can be appended between them and be missed by both.
  const backlog = log.findFirst(cursor, (event) => matchesWait(event, matcher));
  if (backlog) return Promise.resolve(backlog);

  return new Promise<BridgeEvent | undefined>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (event?: BridgeEvent) => {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      resolve(event);
    };

    // Declared after `finish` because `finish` closes over it; subscribing is
    // synchronous and never invokes the handler, so the ordering is safe.
    const unsubscribe = bus.on((event) => {
      // Already covered by the backlog scan above.
      if (event.seq <= cursor) return;
      if (matchesWait(event, matcher)) finish(event);
    });

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => finish(undefined), options.timeoutMs);
    }
  });
}
