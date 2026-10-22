/**
 * What the daemon believes about mIRC's connection state.
 *
 * Seeded from a full `state` reply when mIRC attaches, then kept current by the
 * event stream so it does not go stale between refreshes. Compound commands read
 * this before acting, which is what lets "connect, join, message" collapse into
 * "just message" when mIRC is already there.
 *
 * This is deliberately a *model*, not the truth: mIRC owns the truth. When the
 * model is older than the freshness threshold the tool layer re-queries before
 * acting rather than trusting it.
 */

import { bridgeError, type BridgeEvent, BridgeFailure, type NetworkState } from "./types.ts";

export const DEFAULT_FRESHNESS_MS = 5000;

export class StateModel {
  #networks = new Map<string, NetworkState>();
  #lastRefreshTs?: number;

  /** When the full state was last confirmed by mIRC, or undefined if never. */
  get lastRefreshTs(): number | undefined {
    return this.#lastRefreshTs;
  }

  /** Replace the whole picture from a `state` reply. */
  applyStateFrame(networks: readonly NetworkState[]): void {
    this.#networks.clear();
    for (const net of networks) {
      this.#networks.set(networkKey(net.name), {
        ...net,
        channels: [...net.channels],
        members: { ...(net.members ?? {}) },
      });
    }
    this.#lastRefreshTs = Date.now();
  }

  /**
   * Fold one event into the model. Events for an unknown network are ignored
   * rather than inventing a network, because a later `state` refresh will
   * describe it properly.
   */
  applyEvent(event: BridgeEvent): void {
    const net = this.#networks.get(networkKey(event.net));
    if (!net) return;

    switch (event.kind) {
      case "conn": {
        const what = event.extra?.event;
        if (what === "connected") {
          net.status = "connected";
        } else if (what === "disconnected" || what === "connect_failed") {
          net.status = "disconnected";
          net.channels = [];
          net.members = {};
        }
        break;
      }
      case "selfnick": {
        const next = event.extra?.new;
        if (typeof next === "string" && next.length > 0) net.nick = next;
        break;
      }
      case "join": {
        if (!event.buf) break;
        if (event.nick === net.nick) {
          // Channel names are case-insensitive on IRC but their display casing is
          // meaningful, so match loosely and keep whatever we already have.
          if (!findChannel(net, event.buf)) net.channels.push(event.buf);
        } else {
          const key = findMemberKey(net, event.buf) ?? event.buf;
          net.members[key] = (net.members[key] ?? 0) + 1;
        }
        break;
      }
      case "part":
      case "kick": {
        if (!event.buf) break;
        if (event.nick === net.nick) {
          const existing = findChannel(net, event.buf);
          if (existing) net.channels = net.channels.filter((c) => c !== existing);
          const memberKey = findMemberKey(net, event.buf);
          if (memberKey) delete net.members[memberKey];
        } else {
          const key = findMemberKey(net, event.buf);
          if (key && net.members[key] > 0) net.members[key] -= 1;
        }
        break;
      }
      default:
        break;
    }
  }

  networks(): NetworkState[] {
    return [...this.#networks.values()];
  }

  find(name: string): NetworkState | undefined {
    return this.#networks.get(networkKey(name));
  }

  /**
   * Pick the network a command refers to. Inference is only allowed when it is
   * unambiguous: guessing wrong would send commands to the wrong server, so an
   * ambiguous call fails loudly and naming an absent network fails too.
   */
  resolve(name?: string): NetworkState {
    if (name !== undefined) {
      const net = this.#networks.get(networkKey(name));
      if (net) return net;
      throw new BridgeFailure(
        bridgeError(
          "unknown_network",
          this.#networks.size === 0
            ? `mIRC is not connected to any network, so "${name}" does not exist.`
            : `no network named "${name}". Connected: ${
              this.networks().map((n) => n.name).join(", ")
            }.`,
        ),
      );
    }

    const all = this.networks();
    if (all.length === 0) {
      throw new BridgeFailure(
        bridgeError("unknown_network", "mIRC is not connected to any network yet."),
      );
    }
    if (all.length === 1) return all[0];

    throw new BridgeFailure(
      bridgeError(
        "ambiguous_network",
        `${all.length} networks are connected (${all.map((n) => n.name).join(", ")}); ` +
          "name one explicitly.",
      ),
    );
  }

  isStale(thresholdMs: number = DEFAULT_FRESHNESS_MS): boolean {
    if (this.#lastRefreshTs === undefined) return true;
    return Date.now() - this.#lastRefreshTs > thresholdMs;
  }

  isConnected(net: NetworkState): boolean {
    return net.status === "connected";
  }

  isJoined(net: NetworkState, channel: string): boolean {
    return net.channels.some((c) => c.toLowerCase() === channel.toLowerCase());
  }

  /** Member count for a channel, when mIRC has reported one. */
  memberCount(net: NetworkState, channel: string): number | undefined {
    const key = findMemberKey(net, channel);
    return key === undefined ? undefined : net.members[key];
  }
}

/**
 * Map key for a network: its name lowercased, since servers on one network
 * disagree on its spelling (see sameNetwork). The stored record keeps the
 * spelling mIRC reported, for display.
 */
function networkKey(name: string): string {
  return name.toLowerCase();
}

/** The stored channel name matching `channel`, ignoring case. */
function findChannel(net: NetworkState, channel: string): string | undefined {
  for (const existing of net.channels) {
    if (existing.toLowerCase() === channel.toLowerCase()) return existing;
  }
  return undefined;
}

/** The stored member-count key matching `channel`, ignoring case. */
function findMemberKey(net: NetworkState, channel: string): string | undefined {
  for (const existing of Object.keys(net.members)) {
    if (existing.toLowerCase() === channel.toLowerCase()) return existing;
  }
  return undefined;
}
