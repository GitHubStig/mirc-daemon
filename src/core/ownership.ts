/**
 * Receipts for what the agent itself opened or joined.
 *
 * This records the daemon's own actions, never anything about the user: a
 * connection or channel without a receipt is, by definition, the user's. It is
 * what lets the agent tidy up after itself (leave the channel it joined for a
 * bot, close the connection it opened for a network) while still refusing to
 * leave the user's channels or drop the user's connections unless told to.
 *
 * It lives in memory only. mIRC can report every connection and channel after
 * a daemon restart, but not who opened it, and this is daemon policy rather
 * than mIRC state, so it is not pushed into bridge.mrc either. A restart
 * therefore forgets every receipt, and everything is treated as the user's
 * until an explicit confirmation says otherwise: the safe direction.
 */

import type { BridgeEvent } from "./types.ts";

export class OwnershipLedger {
  #connections = new Set<number>();
  /** cid → lowercased channel names the agent joined there. */
  #channels = new Map<number, Set<string>>();

  /** The agent opened this connection. */
  openedConnection(cid: number): void {
    this.#connections.add(cid);
  }

  /** The agent joined this channel (it was not already in it). */
  joinedChannel(cid: number, channel: string): void {
    let set = this.#channels.get(cid);
    if (!set) {
      set = new Set();
      this.#channels.set(cid, set);
    }
    set.add(channel.toLowerCase());
  }

  ownsConnection(cid: number): boolean {
    return this.#connections.has(cid);
  }

  ownsChannel(cid: number, channel: string): boolean {
    return this.#channels.get(cid)?.has(channel.toLowerCase()) ?? false;
  }

  /**
   * Keep receipts honest as things go away, whoever made them go: the agent,
   * the user in mIRC, or the server. `ourNick` is our nick on the event's
   * connection, so a part or kick can be recognised as ours.
   */
  applyEvent(event: BridgeEvent, ourNick: string | undefined): void {
    if (event.cid === undefined) return;
    switch (event.kind) {
      case "part":
      case "kick":
        if (event.buf && ourNick !== undefined && sameNick(event.nick, ourNick)) {
          this.#channels.get(event.cid)?.delete(event.buf.toLowerCase());
        }
        break;
      case "conn":
        // A dropped connection is out of every channel. The connection window
        // itself is still the agent's until it disappears from mIRC.
        if (event.extra?.event === "disconnected") this.#channels.delete(event.cid);
        break;
      default:
        break;
    }
  }

  /** Forget connections mIRC no longer has, e.g. a window the user closed. */
  retainOnly(liveCids: Iterable<number>): void {
    const live = new Set(liveCids);
    for (const cid of [...this.#connections]) if (!live.has(cid)) this.#connections.delete(cid);
    for (const cid of [...this.#channels.keys()]) if (!live.has(cid)) this.#channels.delete(cid);
  }
}

function sameNick(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}
