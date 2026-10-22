/**
 * The tool surface an agent sees.
 *
 * Every handler is thin on purpose: the core already owns state, waiting, command
 * dispatch and the failure taxonomy. What happens here is argument resolution,
 * pre-flight checks, and turning core outcomes into MCP results an LLM can act
 * on — a stable code plus a hint, never a bare stack trace.
 *
 * Each tool declares its schema as a `z.object` and derives the handler's argument
 * type from it. The SDK's own generic inference does not work here: its `tool` and
 * `registerTool` overloads take `Args | ToolAnnotations` (and `InputArgs |
 * undefined`) as union-typed parameters, which TypeScript will not infer through,
 * so handlers would silently receive `any`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type BridgeError,
  bridgeError,
  type BridgeEvent,
  BridgeFailure,
  type DaemonStatus,
  EVENT_KINDS,
  type NetworkState,
  sameNetwork,
} from "../core/types.ts";
import type { Session, SessionRegistry } from "../core/sessions.ts";
import { emptyChannelWarning } from "../core/outcomes.ts";
import { waitForEvent, type WaitMatcher } from "../core/waits.ts";
import type { LogSink } from "../core/log.ts";

export interface ToolOptions {
  registry: SessionRegistry;
  log: LogSink;
  startedTs: number;
  /** Age at which the state model is re-queried before a compound operation. */
  stateFreshnessMs: number;
  /** ADR-0006: raw server lines are denied unless explicitly allowed. */
  allowRaw: boolean;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const TEXT = "text" as const;

function json(data: unknown): ToolResult {
  return { content: [{ type: TEXT, text: JSON.stringify(data, null, 2) }] };
}

function failure(error: BridgeError): ToolResult {
  // Code first so an agent can branch on it, then the hint written for prose.
  return { content: [{ type: TEXT, text: `${error.code}: ${error.hint}` }], isError: true };
}

/** Run a handler, turning thrown BridgeFailures into tool errors. */
async function guarded(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BridgeFailure) return failure(err.error);
    return failure(
      bridgeError("server_error", `the daemon hit an unexpected error: ${(err as Error).message}`),
    );
  }
}

type Outcome = Awaited<ReturnType<Session["commands"]["send"]>>;

/**
 * `failure()` prefixes its text with the code, so the wrapper can recover it for
 * the log without every handler having to report it separately.
 */
function codeFrom(result: ToolResult): string | undefined {
  if (!result.isError) return undefined;
  const text = result.content[0]?.text ?? "";
  return /^([a-z_]+):/.exec(text)?.[1];
}

/** Tool metadata and handler shapes, kept local so the wrapper stays typed. */
type ToolConfig = { description: string; inputSchema: Record<string, z.ZodType> };
type ToolHandler<Args> = (args: Args) => Promise<ToolResult> | ToolResult;

/** Fold a command outcome into a tool result, preserving warnings. */
function fromOutcome(outcome: Outcome, warnings: BridgeError[] = []): ToolResult {
  if (!outcome.ok) return failure(outcome.error);
  return json({ ok: true, data: outcome.data ?? {}, warnings });
}

function sessionOf(registry: SessionRegistry, id?: string): Session {
  const session = registry.resolve(id);
  if (session) return session;

  const all = registry.list();
  if (all.length === 0) {
    throw new BridgeFailure(
      bridgeError(
        "connect_failed",
        "mIRC is not attached to the daemon. Load mirc/bridge.mrc in mIRC and check it " +
          "connected; the daemon log will show the attempt.",
      ),
    );
  }
  throw new BridgeFailure(
    bridgeError(
      "server_error",
      `${all.length} mIRC clients are attached (${all.map((s) => s.id).join(", ")}); ` +
        "pass `session` to say which one.",
    ),
  );
}

/** Refresh state before acting if the model has gone stale. */
async function freshen(session: Session, thresholdMs: number): Promise<void> {
  if (!session.state.isStale(thresholdMs)) return;
  const error = await session.refreshState();
  if (error) throw new BridgeFailure(error);
}

/**
 * The connection a command acts on, by network name. Every per-connection
 * command carries the resulting `cid`, and bridge.mrc switches to that
 * connection before acting: without it, mIRC runs the command on whichever
 * window happens to be active, which is how a message meant for one network
 * goes out on another.
 */
async function targetOf(
  session: Session,
  network: string | undefined,
  thresholdMs: number,
): Promise<NetworkState> {
  await freshen(session, thresholdMs);
  return session.state.resolve(network);
}

/** The refusal for touching something the agent did not open or join itself. */
function usersOwn(what: string, net: NetworkState): ToolResult {
  return failure(
    bridgeError(
      "guard_denied",
      `${what} on ${net.name} belongs to the user: the agent did not open or join it. Only do ` +
        "this if the user explicitly asked; then repeat the call with confirm: true.",
    ),
  );
}

/**
 * A 477 ("you need a registered nick") is usually not about the channel at
 * all: it means we are not identified, very often because the network's
 * services renamed us to Guest12345. Say who we are there, whether we were
 * renamed, and what the user can do, so the agent can relay it.
 */
function explainJoinRefusal(error: BridgeError, net: NetworkState): BridgeError {
  if (error.numeric !== 477) return error;
  const renamed = net.renamed && net.renamed.to.toLowerCase() === net.nick.toLowerCase()
    ? ` The network renamed you from "${net.renamed.from}" to "${net.renamed.to}", usually ` +
      `NickServ enforcing a registered nick.`
    : "";
  return {
    ...error,
    hint: `${error.hint} You are "${net.nick}" on ${net.name}.${renamed} Tell the user: they can ` +
      `identify (irc_send to NickServ: IDENTIFY <password>) or switch to a nick they own with ` +
      `irc_nick, then try again.`,
  };
}

// Shared argument pieces.
const sessionArg = z
  .string()
  .optional()
  .describe("Which attached mIRC client; omit when only one is.");
const networkArg = z
  .string()
  .optional()
  .describe("Network name; omit when only one is connected.");

// Schemas. Declared as objects so `z.infer` can type each handler.
const emptySchema = z.object({});
const getStateSchema = z.object({ session: sessionArg, network: networkArg });
const readSchema = z.object({
  session: sessionArg,
  network: networkArg,
  buffer: z.string().optional().describe("Channel or query nick."),
  since: z
    .int()
    .nonnegative()
    .optional()
    .describe("Cursor from a previous read. With it, pages forward oldest first."),
  limit: z
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("At most N matches (default 50): the newest N when `since` is omitted."),
  kinds: z.array(z.enum(EVENT_KINDS)).optional().describe('Event kinds, e.g. ["text","notice"].'),
});
const membersSchema = z.object({
  session: sessionArg,
  network: networkArg,
  channel: z.string(),
});
const isonSchema = z.object({
  session: sessionArg,
  network: networkArg,
  nicks: z.array(z.string()).min(1),
});
const connectSchema = z.object({
  session: sessionArg,
  server: z.string(),
  port: z.int().min(1).max(65535).optional(),
  password: z.string().optional().describe("Server password, if required. Not logged."),
});
const ensureConnectedSchema = z.object({
  session: sessionArg,
  network: z.string().describe("Network name, e.g. Rizon. Matched case-insensitively."),
  server: z
    .string()
    .optional()
    .describe("Server to connect to if mIRC is not on that network yet, e.g. irc.rizon.net."),
  port: z.int().min(1).max(65535).optional(),
  password: z.string().optional().describe("Server password, if required. Not logged."),
});
const joinSchema = z.object({
  session: sessionArg,
  network: networkArg,
  channel: z.string(),
  key: z.string().optional(),
});
const ensureJoinedSchema = z.object({
  session: sessionArg,
  network: networkArg,
  channel: z.string(),
});
/**
 * The agent's word that the user asked for this. Leaving or changing anything
 * the agent did not open or join itself needs it. The daemon cannot verify who
 * asked, so this stops the agent doing it on its own initiative; it is not
 * proof of consent.
 */
const confirmArg = z
  .boolean()
  .optional()
  .describe(
    "Set true ONLY when the user explicitly asked for this. Needed for anything the agent did " +
      "not open or join itself, i.e. the user's own channels and connections.",
  );
const partSchema = z.object({
  session: sessionArg,
  network: networkArg,
  channel: z.string(),
  confirm: confirmArg,
});
const disconnectSchema = z.object({
  session: sessionArg,
  network: z.string().describe("The network to disconnect from. Required: never inferred."),
  message: z
    .string()
    .optional()
    .describe("Quit message. Omit to use mIRC's own default, as a person quitting would."),
  confirm: confirmArg,
});
const nickSchema = z.object({
  session: sessionArg,
  network: networkArg,
  nick: z.string().min(1),
  confirm: confirmArg,
});
const sendSchema = z.object({
  session: sessionArg,
  network: networkArg,
  target: z.string(),
  text: z.string().min(1),
});
const notifySchema = z.object({ session: sessionArg, text: z.string().min(1) });
const waitSchema = z.object({
  session: sessionArg,
  network: networkArg,
  kind: z.enum(EVENT_KINDS).optional().describe("Event kind: text, notice, dcc, selfnick, ..."),
  buffer: z.string().optional(),
  nick: z.string().optional().describe("Who the message must be from."),
  direct: z
    .boolean()
    .optional()
    .describe("Only messages addressed to us (query, notice, CTCP), not channel traffic."),
  pattern: z.string().optional().describe("Case-insensitive substring of the text."),
  since: z.int().nonnegative().optional(),
  timeoutMs: z.int().min(100).max(600_000).optional(),
});
const dccStatusSchema = z.object({ session: sessionArg });
const dccWatchSchema = z.object({
  session: sessionArg,
  timeoutMs: z.int().min(100).max(3_600_000).optional(),
});
const xdccListSchema = z.object({
  session: sessionArg,
  network: networkArg,
  bot: z.string(),
  timeoutMs: z.int().min(500).max(120_000).optional(),
  quietMs: z
    .int()
    .min(100)
    .max(30_000)
    .optional()
    .describe("The list is complete once the bot is silent this long (default 3000)."),
});
const xdccFetchSchema = z.object({
  session: sessionArg,
  network: networkArg,
  channel: z.string(),
  bot: z.string(),
  pack: z.string().describe('Pack number or id, as the bot expects it (e.g. "42").'),
  timeoutMs: z.int().min(500).max(600_000).optional(),
  notifyOnFailure: z.boolean().optional().describe("Echo the failure into mIRC. Default true."),
});
const rawSchema = z.object({
  session: sessionArg,
  network: networkArg,
  line: z.string().min(1),
  confirm: z.literal(true).describe("Must be true, to make this a deliberate choice."),
});

type EmptyArgs = z.infer<typeof emptySchema>;
type GetStateArgs = z.infer<typeof getStateSchema>;
type ReadArgs = z.infer<typeof readSchema>;
type MembersArgs = z.infer<typeof membersSchema>;
type IsonArgs = z.infer<typeof isonSchema>;
type ConnectArgs = z.infer<typeof connectSchema>;
type EnsureConnectedArgs = z.infer<typeof ensureConnectedSchema>;
type JoinArgs = z.infer<typeof joinSchema>;
type EnsureJoinedArgs = z.infer<typeof ensureJoinedSchema>;
type PartArgs = z.infer<typeof partSchema>;
type DisconnectArgs = z.infer<typeof disconnectSchema>;
type NickArgs = z.infer<typeof nickSchema>;
type SendArgs = z.infer<typeof sendSchema>;
type NotifyArgs = z.infer<typeof notifySchema>;
type WaitArgs = z.infer<typeof waitSchema>;
type DccStatusArgs = z.infer<typeof dccStatusSchema>;
type DccWatchArgs = z.infer<typeof dccWatchSchema>;
type XdccListArgs = z.infer<typeof xdccListSchema>;
type XdccFetchArgs = z.infer<typeof xdccFetchSchema>;
type RawArgs = z.infer<typeof rawSchema>;

export function registerTools(server: McpServer, options: ToolOptions): void {
  const { registry, stateFreshnessMs, allowRaw } = options;

  /**
   * Register one tool, logging every invocation.
   *
   * The log lives here rather than in each handler so a new tool cannot forget it:
   * name, arguments, duration and outcome land in one place, with arguments
   * passing through the logger's redaction (so `password` never reaches disk).
   *
   * The cast is deliberate. The SDK's `registerTool` generics do not infer through
   * its union-typed parameters (see the file header), so the wrapper owns the
   * types and the boundary gets one narrow cast instead of twenty untyped args.
   */
  function tool<Args>(name: string, config: ToolConfig, handler: ToolHandler<Args>): void {
    const register = server.registerTool.bind(server) as unknown as (
      name: string,
      config: ToolConfig,
      cb: (args: Args, extra: unknown) => Promise<ToolResult>,
    ) => unknown;

    register(name, config, async (args: Args) => {
      const startedTs = Date.now();
      try {
        const result = await handler(args);
        const code = codeFrom(result);
        const record = {
          tool: name,
          args,
          ms: Date.now() - startedTs,
          ok: code === undefined,
          ...(code ? { code } : {}),
        };
        if (code) options.log.warn("tool.call", record);
        else options.log.debug("tool.call", record);
        return result;
      } catch (err) {
        // A handler that throws instead of returning a failure is still recorded,
        // so an unexpected fault cannot look like a call that never happened.
        options.log.error("tool.call", {
          tool: name,
          args,
          ms: Date.now() - startedTs,
          ok: false,
          error: (err as Error).message,
        });
        throw err;
      }
    });
  }

  // --- diagnostics -------------------------------------------------------

  tool(
    "daemon_status",
    {
      description:
        "Daemon health: uptime, whether mIRC is attached, session id and active DCC jobs.",
      inputSchema: emptySchema.shape,
    },
    (_args: EmptyArgs) =>
      guarded(() => {
        const sessions = registry.list();
        const sole = registry.resolve();
        const status: DaemonStatus = {
          uptimeSecs: Math.round((Date.now() - options.startedTs) / 1000),
          sessions: sessions.length,
          mircAttached: sessions.length > 0,
          sessionId: sole?.id,
          nick: sole?.nick,
          agentsAttached: 0,
          lastStateRefreshTs: sole?.state.lastRefreshTs,
          dccJobs: sessions.reduce((total, s) => total + s.dcc.active().length, 0),
        };
        return json(status);
      }),
  );

  tool(
    "irc_list_sessions",
    {
      description: "List attached mIRC clients with a summary of the networks each is on.",
      inputSchema: emptySchema.shape,
    },
    (_args: EmptyArgs) =>
      guarded(() =>
        json(
          registry.list().map((s) => ({
            ...s.info(),
            networks: s.state.networks().map((n) => ({
              name: n.name,
              status: n.status,
              nick: n.nick,
              channels: n.channels,
            })),
          })),
        )
      ),
  );

  tool(
    "irc_get_state",
    {
      description:
        "What mIRC is doing now: networks, connection status, our nick, joined channels and " +
        "member counts. Call this before acting to avoid reconnecting or rejoining needlessly. " +
        "`openedByAgent` and `joinedByAgent` mark what the agent may leave on its own; " +
        "everything else is the user's. `renamed` shows a nick change, e.g. by NickServ.",
      inputSchema: getStateSchema.shape,
    },
    ({ session, network }: GetStateArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        await freshen(s, stateFreshnessMs);
        const picked = network ? [s.state.resolve(network)] : s.state.networks();
        const networks = picked.map((n) => ({
          ...n,
          openedByAgent: s.owned.ownsConnection(n.cid),
          joinedByAgent: n.channels.filter((c) => s.owned.ownsChannel(n.cid, c)),
        }));
        return json({ networks, lastRefreshTs: s.state.lastRefreshTs });
      }),
  );

  // --- reading -----------------------------------------------------------

  tool(
    "irc_read",
    {
      description:
        "Read retained IRC activity, oldest first. Returns a cursor to pass to a later call " +
        "so you only get what is new.",
      inputSchema: readSchema.shape,
    },
    ({ session, network, buffer, since, limit, kinds }: ReadArgs) =>
      guarded(() => {
        const s = sessionOf(registry, session);
        const max = limit ?? 50;
        const query = { net: network, buf: buffer, kinds };
        if (since === undefined) {
          const events = s.log.since(0, { ...query, limit: max });
          return json({ cursor: s.log.cursor, events, more: false });
        }
        // Paging: keep the oldest so nothing between two polls is skipped, and hand
        // back a cursor at the last event returned rather than at the head.
        const page = s.log.since(since, { ...query, limit: max + 1, keep: "oldest" });
        const more = page.length > max;
        const events = page.slice(0, max);
        const cursor = more ? events[events.length - 1].seq : s.log.cursor;
        return json({ cursor, events, more });
      }),
  );

  tool(
    "irc_members",
    {
      description:
        "Who is in a channel. Large channels return a truncated name list with the full count.",
      inputSchema: membersSchema.shape,
    },
    ({ session, network, channel }: MembersArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs);
        const outcome = await s.commands.send("members", { cid: net.cid, channel });
        if (!outcome.ok) return failure(outcome.error);
        const names = Array.isArray(outcome.data?.names) ? (outcome.data!.names as string[]) : [];
        return json({
          channel,
          count: typeof outcome.data?.count === "number" ? outcome.data.count : names.length,
          names: names.slice(0, 200),
          // mIRC stops listing before a frame would overflow the line limit.
          truncated: names.length > 200 || outcome.data?.truncated === true,
        });
      }),
  );

  tool(
    "irc_ison",
    {
      description: "Check which of the given nicks are online on a network.",
      inputSchema: isonSchema.shape,
    },
    ({ session, network, nicks }: IsonArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs);
        // A space-separated string, not an array: mSL found arrays by bracket
        // position, and nicks like [XDCC]Bot contain brackets.
        const outcome = await s.commands.send("ison", { cid: net.cid, list: nicks.join(" ") });
        if (!outcome.ok) return failure(outcome.error);
        const present = Array.isArray(outcome.data?.present)
          ? (outcome.data!.present as string[])
          : [];
        return json({
          present,
          absent: nicks.filter(
            (n: string) => !present.some((p: string) => p.toLowerCase() === n.toLowerCase()),
          ),
        });
      }),
  );

  // --- connecting and joining -------------------------------------------

  /**
   * Connect and wait for registration, in an existing quit window for that
   * network if there is one, otherwise in a new one.
   *
   * mIRC keeps a connection's window after it quits, so opening a new window
   * (`/server -m`) on every trip piled up disconnected windows for the same
   * network. A quit window for the network is reconnected in place instead:
   * the agent's own first, then the user's. Reconnecting the user's window
   * earns no receipt, so it stays theirs and the agent cannot disconnect it
   * without confirmation. The one visible difference from a new window: mIRC
   * may rejoin channels that were still open in it when the user quit.
   * Nothing still connected is ever a candidate, and bridge.mrc refuses to
   * reconnect a window that is not disconnected, whatever it is asked.
   */
  async function openConnection(
    s: Session,
    server: string,
    port: number | undefined,
    password: string | undefined,
    network?: string,
  ): Promise<ToolResult> {
    const quitWindows = s.state.networks().filter((n) =>
      n.status === "disconnected" &&
      ((network !== undefined && sameNetwork(n.name, network)) ||
        (n.server !== undefined && n.server.toLowerCase() === server.toLowerCase()))
    );
    const reusable = quitWindows.find((n) => s.owned.ownsConnection(n.cid)) ?? quitWindows[0];
    const usersWindow = reusable !== undefined && !s.owned.ownsConnection(reusable.cid);
    const outcome = await s.commands.send(
      "connect",
      { cid: reusable?.cid, server, port, password },
      // EFNet took 32.6 s to register in the live test: ident and DNS checks.
      { context: "connect", timeoutMs: 60_000 },
    );
    if (!outcome.ok) return failure(outcome.error);
    const error = await s.refreshState();
    if (error) return failure(error);
    const cid = typeof outcome.data?.cid === "number" ? outcome.data.cid : undefined;
    // A receipt makes the connection the agent's to close again, but a window
    // the user owned stays the user's after the agent brings it back.
    if (cid !== undefined && !usersWindow) s.owned.openedConnection(cid);
    const net = cid === undefined ? undefined : s.state.byCid(cid);
    return json({
      skipped: false,
      reusedWindow: reusable === undefined ? false : usersWindow ? "user's" : "agent's",
      network: net,
    });
  }

  /** A connection already serving `server` or `network`, if mIRC has one up. */
  function existingConnection(s: Session, server?: string, network?: string) {
    const byNetwork = network ? s.state.find(network) : undefined;
    if (byNetwork?.status === "connected") return byNetwork;
    const byServer = server ? s.state.findByServer(server) : undefined;
    if (byServer?.status === "connected") return byServer;
    return undefined;
  }

  tool(
    "irc_connect",
    {
      description:
        "Connect mIRC to an IRC server as an ADDITIONAL connection; existing connections are " +
        "never touched. If mIRC is already connected to that server, it is reused instead. " +
        "Prefer irc_ensure_connected, which also reuses a connection to the same network " +
        "through a different server.",
      inputSchema: connectSchema.shape,
    },
    ({ session, server, port, password }: ConnectArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        await freshen(s, stateFreshnessMs);
        const existing = existingConnection(s, server);
        if (existing) {
          return json({ skipped: true, reason: "already connected", network: existing });
        }
        return await openConnection(s, server, port, password);
      }),
  );

  tool(
    "irc_ensure_connected",
    {
      description:
        "Make sure mIRC is on a network. If any connection to that network (or that server) is " +
        "up, including one the user opened, it is reused. Otherwise a quit window for that " +
        "network is reconnected (the user's stays the user's), or a new connection is opened " +
        "alongside the existing ones. A live connection is never disconnected or replaced.",
      inputSchema: ensureConnectedSchema.shape,
    },
    ({ session, network, server, port, password }: EnsureConnectedArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        await freshen(s, stateFreshnessMs);
        const existing = existingConnection(s, server, network);
        if (existing) {
          return json({ skipped: true, reason: "already connected", network: existing });
        }
        if (!server) {
          return failure(
            bridgeError(
              "unknown_network",
              `mIRC is not on "${network}" and no server was given. Pass server (and port) ` +
                "to connect, or check the network name.",
            ),
          );
        }
        return await openConnection(s, server, port, password, network);
      }),
  );

  tool(
    "irc_join",
    {
      description:
        "Join a channel. A channel with almost nobody in it comes back with a warning, since " +
        "an empty channel often means the name is wrong.",
      inputSchema: joinSchema.shape,
    },
    ({ session, network, channel, key }: JoinArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs);
        const outcome = await s.commands.send("join", { cid: net.cid, channel, key }, {
          context: "join",
        });
        if (!outcome.ok) return failure(explainJoinRefusal(outcome.error, net));
        // Only a real join earns a receipt: "already" means it was in there before.
        if (outcome.data?.already !== true) s.owned.joinedChannel(net.cid, channel);

        const members = typeof outcome.data?.members === "number"
          ? outcome.data.members
          : s.state.memberCount(net, channel);
        const warning = emptyChannelWarning(channel, members);
        return fromOutcome(outcome, warning ? [warning] : []);
      }),
  );

  tool(
    "irc_ensure_joined",
    {
      description:
        "Make sure mIRC is in a channel, joining only if it is not already. This is the step " +
        "to use before messaging a bot.",
      inputSchema: ensureJoinedSchema.shape,
    },
    ({ session, network, channel }: EnsureJoinedArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs);
        if (s.state.isJoined(net, channel)) {
          return json({
            skipped: true,
            reason: "already joined",
            channel,
            members: s.state.memberCount(net, channel),
          });
        }
        const outcome = await s.commands.send("join", { cid: net.cid, channel }, {
          context: "join",
        });
        if (!outcome.ok) return failure(explainJoinRefusal(outcome.error, net));
        if (outcome.data?.already !== true) s.owned.joinedChannel(net.cid, channel);
        const members = typeof outcome.data?.members === "number"
          ? outcome.data.members
          : s.state.memberCount(net, channel);
        const warning = emptyChannelWarning(channel, members);
        return json({
          skipped: false,
          channel,
          data: outcome.data ?? {},
          warnings: warning ? [warning] : [],
        });
      }),
  );

  tool(
    "irc_part",
    {
      description:
        "Leave a channel, only when the user asked or the task they gave includes leaving. " +
        "Never tidy up on your own initiative. Channels the agent joined itself need no " +
        "confirmation; the user's own channels need confirm: true.",
      inputSchema: partSchema.shape,
    },
    ({ session, network, channel, confirm }: PartArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs);
        if (!s.owned.ownsChannel(net.cid, channel) && confirm !== true) {
          return usersOwn(channel, net);
        }
        return fromOutcome(await s.commands.send("part", { cid: net.cid, channel }));
      }),
  );

  tool(
    "irc_disconnect",
    {
      description:
        "Disconnect from a network, only when the user asked or the task they gave includes it " +
        "(e.g. 'get pack 5, then disconnect'). A finished transfer is NOT a reason to disconnect " +
        "by itself. Connections the agent opened need no confirmation; the user's own need " +
        "confirm: true. Quits with mIRC's own default message unless one is given.",
      inputSchema: disconnectSchema.shape,
    },
    ({ session, network, message, confirm }: DisconnectArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs);
        if (!s.owned.ownsConnection(net.cid) && confirm !== true) {
          return usersOwn("This connection", net);
        }
        if (net.status === "disconnected") {
          return json({ skipped: true, reason: "already disconnected", network: net });
        }
        const outcome = await s.commands.send("disconnect", { cid: net.cid, message }, {
          timeoutMs: 15_000,
        });
        if (!outcome.ok) return failure(outcome.error);
        const error = await s.refreshState();
        if (error) return failure(error);
        return json({ ok: true, network: s.state.byCid(net.cid) ?? null });
      }),
  );

  tool(
    "irc_nick",
    {
      description:
        "Change our nick on one network, e.g. after NickServ renamed us to a Guest nick. Free on " +
        "connections the agent opened; on the user's own connections it needs confirm: true, " +
        "only when the user asked. Waits for the server to accept or refuse it.",
      inputSchema: nickSchema.shape,
    },
    ({ session, network, nick, confirm }: NickArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs);
        if (!s.owned.ownsConnection(net.cid) && confirm !== true) {
          return usersOwn("The nick", net);
        }
        // Exact comparison: a change of case only is still a change the user can ask for.
        if (net.nick === nick) {
          return json({ skipped: true, reason: "already using that nick", nick });
        }
        const outcome = await s.commands.send("nick", { cid: net.cid, nick });
        if (!outcome.ok) return failure(outcome.error);
        const confirmed = typeof outcome.data?.nick === "string" ? outcome.data.nick : nick;
        return json({ ok: true, network: net.name, nick: confirmed });
      }),
  );

  // --- speaking ----------------------------------------------------------

  tool(
    "irc_send",
    {
      description:
        "Send a PRIVMSG. `target` may be a channel (#name) or a nick, so this covers both " +
        "talking in a channel and messaging a bot. Success means mIRC sent it; IRC does not " +
        "acknowledge delivery, so a refusal (e.g. 401 no such nick) arrives later as a raw event.",
      inputSchema: sendSchema.shape,
    },
    ({ session, network, target, text }: SendArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs);
        return fromOutcome(
          await s.commands.send("msg", { cid: net.cid, target, text }, { context: "message" }),
        );
      }),
  );

  tool(
    "irc_notice",
    {
      description: "Send a NOTICE. Many IRC bots accept commands this way rather than by PRIVMSG.",
      inputSchema: sendSchema.shape,
    },
    ({ session, network, target, text }: SendArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs);
        return fromOutcome(
          await s.commands.send("notice", { cid: net.cid, target, text }, { context: "message" }),
        );
      }),
  );

  tool(
    "irc_notify",
    {
      description: "Echo a line into mIRC so the human sees it even while unattended.",
      inputSchema: notifySchema.shape,
    },
    ({ session, text }: NotifyArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        return fromOutcome(await s.commands.send("echo", { text }));
      }),
  );

  // --- waiting -----------------------------------------------------------

  tool(
    "irc_wait_for",
    {
      description:
        "Block until a matching message arrives, then return it. Prefer this to polling " +
        "irc_read. Pass `since` (a cursor from irc_read) to also match messages that already " +
        "arrived, which avoids missing a reply that landed just before the call.",
      inputSchema: waitSchema.shape,
    },
    ({ session, network, kind, buffer, nick, pattern, direct, since, timeoutMs }: WaitArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const matcher: WaitMatcher = { kind, net: network, buf: buffer, nick, pattern, direct };
        const cursor = since ?? s.log.cursor;
        const waitMs = timeoutMs ?? 30_000;
        const event = await waitForEvent({
          log: s.log,
          bus: s.bus,
          matcher,
          since: cursor,
          timeoutMs: waitMs,
        });
        if (!event) return json({ matched: false, waitedMs: waitMs, cursor: s.log.cursor });
        return json({ matched: true, event, cursor: s.log.cursor });
      }),
  );

  // --- DCC ---------------------------------------------------------------

  tool(
    "irc_dcc_status",
    {
      description:
        "DCC transfers known to the daemon: in-flight, recently completed and recently failed.",
      inputSchema: dccStatusSchema.shape,
    },
    ({ session }: DccStatusArgs) =>
      guarded(() => {
        const s = sessionOf(registry, session);
        return json({ jobs: s.dcc.list(), active: s.dcc.active().length });
      }),
  );

  tool(
    "irc_dcc_watch",
    {
      description: "Block until a DCC transfer finishes or fails, then report the outcome.",
      inputSchema: dccWatchSchema.shape,
    },
    ({ session, timeoutMs }: DccWatchArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const cursor = s.log.cursor;
        const event = await waitForEvent({
          log: s.log,
          bus: s.bus,
          matcher: { kind: "dcc" },
          since: cursor,
          timeoutMs: timeoutMs ?? 600_000,
        });
        return json({ event: event ?? null, jobs: s.dcc.list() });
      }),
  );

  // --- XDCC composites ---------------------------------------------------

  tool(
    "xdcc_list",
    {
      description:
        "Ask an XDCC bot for its pack list. Returns the notices it sent back, which may arrive " +
        "as several messages and may be truncated by the bot.",
      inputSchema: xdccListSchema.shape,
    },
    ({ session, network, bot, timeoutMs, quietMs }: XdccListArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs);
        const cursor = s.log.cursor;
        const deadline = Date.now() + (timeoutMs ?? 20_000);
        const sent = await s.commands.send(
          "msg",
          { cid: net.cid, target: bot, text: "xdcc list" },
          { context: "message" },
        );
        if (!sent.ok) return failure(sent.error);

        // Only this connection: the same nick can belong to someone else elsewhere.
        const matcher: WaitMatcher = { cid: net.cid, nick: bot, direct: true };
        const first = await waitForEvent({
          log: s.log,
          bus: s.bus,
          matcher,
          since: cursor,
          timeoutMs: Math.max(0, deadline - Date.now()),
        });
        if (!first) {
          return failure(
            bridgeError(
              "bot_no_response",
              `${bot} did not reply with a pack list. It may be offline, idle, or not an ` +
                "XDCC bot — check the name with irc_members.",
            ),
          );
        }
        // Pack lists arrive as a burst spread over seconds (bots throttle themselves),
        // so keep collecting until the bot goes quiet rather than stopping at line one.
        const replies: BridgeEvent[] = [first];
        let complete = true;
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            complete = false;
            break;
          }
          const next = await waitForEvent({
            log: s.log,
            bus: s.bus,
            matcher,
            since: replies[replies.length - 1].seq,
            timeoutMs: Math.min(quietMs ?? 3000, remaining),
          });
          if (!next) break;
          replies.push(next);
        }
        return json({ bot, replies, complete, cursor: s.log.cursor });
      }),
  );

  tool(
    "xdcc_fetch",
    {
      description:
        "Request a pack from an XDCC bot: ensures mIRC is on the network and in the channel, " +
        "confirms the bot is present, sends the request, then waits for its reply. Reports " +
        "whether a transfer started.",
      inputSchema: xdccFetchSchema.shape,
    },
    ({ session, network, channel, bot, pack, timeoutMs, notifyOnFailure }: XdccFetchArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const steps: string[] = [];
        const waitMs = timeoutMs ?? 60_000;

        const fail = async (error: BridgeError): Promise<ToolResult> => {
          if (notifyOnFailure !== false) {
            await s.commands.send("echo", { text: `mirc-daemon: ${error.code} — ${error.hint}` });
          }
          return failure(error);
        };

        // 1. connected?
        const net = await targetOf(s, network, stateFreshnessMs);
        if (net.status !== "connected") {
          return await fail(
            bridgeError(
              "connect_failed",
              `mIRC is not connected to "${net.name}". Connect it first, or use ` +
                "irc_ensure_connected.",
            ),
          );
        }
        steps.push("connected");

        // 2. joined?
        if (!s.state.isJoined(net, channel)) {
          const joined = await s.commands.send("join", { cid: net.cid, channel }, {
            context: "join",
          });
          if (!joined.ok) return await fail(explainJoinRefusal(joined.error, net));
          if (joined.data?.already !== true) s.owned.joinedChannel(net.cid, channel);
          steps.push("joined");
        } else {
          steps.push("already joined");
        }

        // 3. is the bot actually here? Failing now beats waiting for a timeout.
        // Ask about the one nick rather than fetching the list: XDCC channels run to
        // thousands of users, far past what one frame can carry.
        const members = await s.commands.send("members", { cid: net.cid, channel, nick: bot });
        if (members.ok && typeof members.data?.present === "boolean") {
          if (!members.data.present) {
            return await fail(
              bridgeError(
                "bot_not_in_channel",
                `${bot} is not in ${channel}. Check the bot name, or it may be offline.`,
              ),
            );
          }
          steps.push("bot present");
        }

        // 4. capture the cursor *before* sending, so an instant reply is not missed.
        const cursor = s.log.cursor;
        s.dcc.start({ net: net.name, bot, pack });

        const sent = await s.commands.send(
          "msg",
          { cid: net.cid, target: bot, text: `xdcc send #${pack.replace(/^#/, "")}` },
          { context: "message" },
        );
        if (!sent.ok) return await fail(sent.error);
        steps.push("requested");

        // 5. wait for the bot to say something back, on this connection only.
        const reply = await waitForEvent({
          log: s.log,
          bus: s.bus,
          matcher: { cid: net.cid, nick: bot, direct: true },
          since: cursor,
          timeoutMs: waitMs,
        });

        if (!reply) {
          return await fail(
            bridgeError(
              "bot_no_response",
              `no reply from ${bot} within ${Math.round(waitMs / 1000)}s. It may be offline, ` +
                "over its transfer limit, or not an XDCC bot.",
            ),
          );
        }

        return json({
          bot,
          pack,
          steps,
          reply,
          dcc: s.dcc.latest(),
          note: "A DCC offer may now be pending in mIRC. Accept it there, or use irc_dcc_watch.",
        });
      }),
  );

  // --- gated -------------------------------------------------------------

  tool(
    "irc_raw",
    {
      description:
        "Send a raw IRC line. Denied unless the daemon was started with --allow-raw, because " +
        "it can do anything the IRC protocol can.",
      inputSchema: rawSchema.shape,
    },
    ({ session, network, line }: RawArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        if (!allowRaw) {
          options.log.warn("guard.deny", { door: "mcp", tool: "irc_raw" });
          return failure(
            bridgeError(
              "guard_denied",
              "raw lines are denied by default. Restart the daemon with --allow-raw to permit " +
                "them, and be aware it can do anything the IRC protocol can.",
            ),
          );
        }
        const net = await targetOf(s, network, stateFreshnessMs);
        return fromOutcome(await s.commands.send("raw", { cid: net.cid, line }));
      }),
  );
}
