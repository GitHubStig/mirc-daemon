/**
 * Reading the server's numeric replies for the tools that compose their answer
 * from them (irc_mode, irc_whois, irc_topic).
 *
 * bridge.mrc only sends these commands and mirrors whatever comes back as raw
 * events; deciding what the replies mean happens here, where it can be tested,
 * so the script stays a relay. A raw event's line is mIRC's view of it: the
 * numeric, then the parameters starting with our own nick, with no server
 * prefix and no colon before the last one, e.g.
 * "311 me nick user host * Real Name".
 */

import type { BridgeEvent } from "./types.ts";

/** The words of a raw line: [numeric, our nick, ...params]. */
export function rawWords(event: BridgeEvent): string[] {
  return (event.raw ?? "").split(" ").filter((w) => w.length > 0);
}

/** The numeric of a raw event, or undefined for anything else. */
export function numericOf(event: BridgeEvent): number | undefined {
  if (event.kind !== "raw") return undefined;
  const n = event.extra?.numeric;
  return typeof n === "number" ? n : Number(rawWords(event)[0]) || undefined;
}

/** True when the raw line's first parameter after our nick is `target`. */
export function isAbout(event: BridgeEvent, target: string): boolean {
  return (rawWords(event)[2] ?? "").toLowerCase() === target.toLowerCase();
}

/**
 * Refusals a MODE or TOPIC can draw. 482 not a channel operator, 442 not on
 * that channel, 403 no such channel, 472 unknown mode letter, 467 key already
 * set, 501 unknown user mode, 477 needs a registered nick.
 */
export const CHANNEL_CHANGE_REFUSALS: ReadonlySet<number> = new Set([
  403,
  442,
  467,
  472,
  477,
  482,
  501,
]);

/** WHOIS replies about one nick, ended by 318 (or 401 when there is no such nick). */
export const WHOIS_NUMERICS: ReadonlySet<number> = new Set([
  301,
  311,
  312,
  313,
  317,
  318,
  319,
  330,
  338,
  401,
  671,
]);

export interface WhoisInfo {
  nick: string;
  user?: string;
  host?: string;
  realName?: string;
  server?: string;
  serverInfo?: string;
  /** Channels the server shows, with any @ or + prefix kept. */
  channels?: string[];
  idleSecs?: number;
  signonTs?: number;
  /** The services account the nick is logged in as. */
  account?: string;
  away?: string;
  operator?: boolean;
  secure?: boolean;
}

/** Fold the WHOIS replies about one nick into fields. */
export function parseWhois(nick: string, events: readonly BridgeEvent[]): WhoisInfo {
  const info: WhoisInfo = { nick };
  for (const event of events) {
    const w = rawWords(event);
    const rest = (from: number) => w.slice(from).join(" ");
    switch (numericOf(event)) {
      case 311: // nick user host * real name
        info.nick = w[2] ?? nick;
        info.user = w[3];
        info.host = w[4];
        info.realName = rest(6);
        break;
      case 312: // nick server server info
        info.server = w[3];
        info.serverInfo = rest(4);
        break;
      case 313:
        info.operator = true;
        break;
      case 317: { // nick idle signon seconds idle, signon time
        const idle = Number(w[3]);
        const signon = Number(w[4]);
        if (Number.isFinite(idle)) info.idleSecs = idle;
        if (Number.isFinite(signon) && signon > 0) info.signonTs = signon * 1000;
        break;
      }
      case 319: // nick @#chan +#other #third (several lines possible)
        info.channels = [...(info.channels ?? []), ...w.slice(3)];
        break;
      case 330: // nick account is logged in as
        info.account = w[3];
        break;
      case 301: // nick away message
        info.away = rest(3);
        break;
      case 671:
        info.secure = true;
        break;
    }
  }
  return info;
}

/** The modes a 324 reply reports: "324 me #chan +tnk key" → "+tnk key". */
export function modesFrom324(event: BridgeEvent): string {
  return rawWords(event).slice(3).join(" ");
}
