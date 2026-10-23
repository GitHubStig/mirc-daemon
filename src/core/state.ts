/**
 * What the daemon believes about mIRC's connections.
 *
 * Seeded from `conns` + `chans` replies when mIRC attaches, then kept current by
 * the event stream so it does not go stale between refreshes. Compound commands
 * read this before acting, which is what lets "connect, join, message" collapse
 * into "just message" when mIRC is already there.
 *
 * Connections are keyed by mIRC's connection id, not by network name: a name is
 * not unique (two connections can share a network), servers on one network spell
 * it differently, and a connection has no network name at all until the server
 * announces one. Agents still address connections by network name; `resolve`
 * turns a name into exactly one connection or refuses.
 *
 * This is deliberately a *model*, not the truth: mIRC owns the truth. When the
 * model is older than the freshness threshold the tool layer re-queries before
 * acting rather than trusting it.
 */

import {
  bridgeError,
  type BridgeEvent,
  BridgeFailure,
  type NetworkState,
  sameNetwork,
} from "./types.ts";

export const DEFAULT_FRESHNESS_MS = 5000;

export class StateModel {
  #connections = new Map<number, NetworkState>();
  #lastRefreshTs?: number;

  /** When the full state was last confirmed by mIRC, or undefined if never. */
  get lastRefreshTs(): number | undefined {
    return this.#lastRefreshTs;
  }

  /**
   * Replace the whole picture from a refresh. The rename record is the one
   * thing mIRC cannot report, so it is carried over for a connection that is
   * still there.
   */
  applyStateFrame(networks: readonly NetworkState[]): void {
    const previous = this.#connections;
    this.#connections = new Map();
    for (const net of networks) {
      this.#connections.set(net.cid, {
        ...net,
        channels: [...net.channels],
        members: { ...(net.members ?? {}) },
        renamed: net.renamed ?? previous.get(net.cid)?.renamed,
      });
    }
    this.#lastRefreshTs = Date.now();
  }

  /**
   * Fold one event into the model. Events for an unknown connection are ignored
   * rather than inventing one, because a later refresh will describe it
   * properly — and a connection mIRC has only just opened has no name yet.
   */
  applyEvent(event: BridgeEvent): void {
    const net = event.cid !== undefined
      ? this.#connections.get(event.cid)
      : this.#onlyNamed(event.net);
    if (!net) return;

    switch (event.kind) {
      case "conn": {
        const what = event.extra?.event;
        if (what === "connected") {
          net.status = "connected";
          // The server has now announced the network's real name.
          if (event.net) net.name = event.net;
        } else if (what === "disconnected" || what === "connect_failed") {
          net.status = "disconnected";
          net.channels = [];
          net.members = {};
        }
        break;
      }
      case "selfnick": {
        const next = event.extra?.new;
        if (typeof next === "string" && next.length > 0) {
          const from = typeof event.extra?.old === "string" ? event.extra.old : net.nick;
          net.renamed = { from, to: next, ts: event.ts };
          net.nick = next;
        }
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
    return [...this.#connections.values()];
  }

  byCid(cid: number): NetworkState | undefined {
    return this.#connections.get(cid);
  }

  /**
   * The connection for a network name, preferring a connected one. When the
   * user already has a connection to a network, the agent reuses it rather than
   * opening a second, so this is the lookup that decides "already there".
   */
  find(name: string): NetworkState | undefined {
    const matches = this.networks().filter((n) => sameNetwork(n.name, name));
    return matches.find((n) => n.status === "connected") ?? matches[0];
  }

  /** A connection whose server hostname is `server`, ignoring case. */
  findByServer(server: string): NetworkState | undefined {
    return this.networks().find((n) =>
      n.server !== undefined && n.server.toLowerCase() === server.toLowerCase()
    );
  }

  /**
   * Pick the connection a command refers to. Inference is only allowed when it
   * is unambiguous: guessing wrong would send commands to the wrong server, so
   * an ambiguous call fails loudly and naming an absent network fails too.
   *
   * With no name, only connected connections count, so a leftover disconnected
   * status window does not make every call ambiguous.
   */
  resolve(name?: string): NetworkState {
    if (name !== undefined) {
      const matches = this.networks().filter((n) => sameNetwork(n.name, name));
      if (matches.length === 1) return matches[0];
      if (matches.length === 0) {
        // Said as the next step. Seen with a small local model: told only "no
        // network named Rizon" with the one it was on, it gave up and asked the
        // user, when connecting was all that was missing.
        throw new BridgeFailure(
          bridgeError(
            "unknown_network",
            `mIRC is not on "${name}" yet` +
              (this.#connections.size === 0 ? "" : ` (it is on ${describe(this.networks())})`) +
              `. Connect first with irc_connect {network: "${name}"}, then call this again ` +
              "with the same network.",
          ),
        );
      }
      const connected = matches.filter((n) => n.status === "connected");
      if (connected.length === 1) return connected[0];
      throw new BridgeFailure(
        bridgeError(
          "ambiguous_network",
          `mIRC has ${matches.length} connections to "${name}" (${describe(matches)}). ` +
            "Pass cid to pick one, or ask the user which to use.",
        ),
      );
    }

    const connected = this.networks().filter((n) => n.status === "connected");
    if (connected.length === 1) return connected[0];
    if (connected.length === 0) {
      throw new BridgeFailure(
        bridgeError("unknown_network", "mIRC is not connected to any network yet."),
      );
    }
    throw new BridgeFailure(
      bridgeError(
        "ambiguous_network",
        `${connected.length} networks are connected (${describe(connected)}); ` +
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

  /** For events without a cid: only safe when exactly one connection has the name. */
  #onlyNamed(name: string): NetworkState | undefined {
    const matches = this.networks().filter((n) => sameNetwork(n.name, name));
    return matches.length === 1 ? matches[0] : undefined;
  }
}

/** "EFnet (cid 1, connected), Rizon (cid 3, connecting)" — for hints. */
function describe(networks: readonly NetworkState[]): string {
  return networks.map((n) => `${n.name} (cid ${n.cid}, ${n.status})`).join(", ");
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
