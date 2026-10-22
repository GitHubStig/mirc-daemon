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
  BridgeFailure,
  type DaemonStatus,
  type EventKind,
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
  since: z.int().nonnegative().optional().describe("Cursor from a previous read."),
  limit: z.int().positive().max(500).optional().describe("Newest N matches (default 50)."),
  kinds: z.array(z.string()).optional().describe('Event kinds, e.g. ["text","notice"].'),
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
  network: z.string().describe("Network name to report against."),
  server: z.string().optional().describe("Only needed when the daemon has no such network yet."),
  port: z.int().min(1).max(65535).optional(),
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
const partSchema = z.object({ session: sessionArg, network: networkArg, channel: z.string() });
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
  kind: z.string().optional().describe("Event kind: text, notice, dcc, selfnick, ..."),
  buffer: z.string().optional(),
  nick: z.string().optional().describe("Who the message must be from."),
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
        "member counts. Call this before acting to avoid reconnecting or rejoining needlessly.",
      inputSchema: getStateSchema.shape,
    },
    ({ session, network }: GetStateArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        await freshen(s, stateFreshnessMs);
        const networks = network ? [s.state.resolve(network)] : s.state.networks();
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
        const events = s.log.since(since ?? 0, {
          net: network,
          buf: buffer,
          limit: limit ?? 50,
          kinds: kinds as EventKind[] | undefined,
        });
        return json({ cursor: s.log.cursor, events });
      }),
  );

  tool(
    "irc_members",
    {
      description: "Who is in a channel. Use it to confirm a bot is present before messaging it.",
      inputSchema: membersSchema.shape,
    },
    ({ session, network, channel }: MembersArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        s.state.resolve(network);
        const outcome = await s.commands.send("members", { channel });
        if (!outcome.ok) return failure(outcome.error);
        const names = Array.isArray(outcome.data?.names) ? (outcome.data!.names as string[]) : [];
        return json({
          channel,
          count: typeof outcome.data?.count === "number" ? outcome.data.count : names.length,
          names: names.slice(0, 200),
          truncated: names.length > 200,
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
        s.state.resolve(network);
        const outcome = await s.commands.send("ison", { nicks });
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

  tool(
    "irc_connect",
    {
      description:
        "Connect mIRC to an IRC server. Prefer irc_ensure_connected, which skips the step " +
        "when mIRC is already there.",
      inputSchema: connectSchema.shape,
    },
    ({ session, server, port, password }: ConnectArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const outcome = await s.commands.send(
          "connect",
          { server, port, password },
          { context: "connect", timeoutMs: 60_000 },
        );
        return fromOutcome(outcome);
      }),
  );

  tool(
    "irc_ensure_connected",
    {
      description:
        "Make sure mIRC is on a network, connecting only if it is not already. Safe to call " +
        "when it is already connected.",
      inputSchema: ensureConnectedSchema.shape,
    },
    ({ session, network, server, port }: EnsureConnectedArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        await freshen(s, stateFreshnessMs);
        const existing = s.state.find(network);
        if (existing?.status === "connected") {
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
        const outcome = await s.commands.send(
          "connect",
          { server, port, network },
          { context: "connect", timeoutMs: 60_000 },
        );
        if (!outcome.ok) return failure(outcome.error);
        await s.refreshState();
        return json({ skipped: false, data: outcome.data ?? {}, network: s.state.find(network) });
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
        await freshen(s, stateFreshnessMs);
        const net = s.state.resolve(network);
        const outcome = await s.commands.send("join", { channel, key }, { context: "join" });
        if (!outcome.ok) return failure(outcome.error);

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
        await freshen(s, stateFreshnessMs);
        const net = s.state.resolve(network);
        if (s.state.isJoined(net, channel)) {
          return json({
            skipped: true,
            reason: "already joined",
            channel,
            members: s.state.memberCount(net, channel),
          });
        }
        const outcome = await s.commands.send("join", { channel }, { context: "join" });
        if (!outcome.ok) return failure(outcome.error);
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
      description: "Leave a channel.",
      inputSchema: partSchema.shape,
    },
    ({ session, network, channel }: PartArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        s.state.resolve(network);
        return fromOutcome(await s.commands.send("part", { channel }));
      }),
  );

  // --- speaking ----------------------------------------------------------

  tool(
    "irc_send",
    {
      description:
        "Send a PRIVMSG. `target` may be a channel (#name) or a nick, so this covers both " +
        "talking in a channel and messaging a bot.",
      inputSchema: sendSchema.shape,
    },
    ({ session, network, target, text }: SendArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        s.state.resolve(network);
        return fromOutcome(await s.commands.send("msg", { target, text }, { context: "message" }));
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
        s.state.resolve(network);
        return fromOutcome(
          await s.commands.send("notice", { target, text }, { context: "message" }),
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
    ({ session, network, kind, buffer, nick, pattern, since, timeoutMs }: WaitArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const matcher: WaitMatcher = {
          kind: kind as EventKind | undefined,
          net: network,
          buf: buffer,
          nick,
          pattern,
        };
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
    ({ session, network, bot, timeoutMs }: XdccListArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        s.state.resolve(network);
        const cursor = s.log.cursor;
        const sent = await s.commands.send("msg", { target: bot, text: "xdcc list" }, {
          context: "message",
        });
        if (!sent.ok) return failure(sent.error);

        const first = await waitForEvent({
          log: s.log,
          bus: s.bus,
          matcher: { nick: bot },
          since: cursor,
          timeoutMs: timeoutMs ?? 20_000,
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
        // Pack lists arrive as a burst, so take everything the bot sent after the ask.
        const replies = s.log
          .since(cursor)
          .filter((e) => (e.nick ?? "").toLowerCase() === bot.toLowerCase());
        return json({ bot, replies, cursor: s.log.cursor });
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
        await freshen(s, stateFreshnessMs);
        const net = s.state.resolve(network);
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
          const joined = await s.commands.send("join", { channel }, { context: "join" });
          if (!joined.ok) return await fail(joined.error);
          steps.push("joined");
        } else {
          steps.push("already joined");
        }

        // 3. is the bot actually here? Failing now beats waiting for a timeout.
        const members = await s.commands.send("members", { channel });
        if (members.ok && Array.isArray(members.data?.names)) {
          const names = members.data!.names as string[];
          if (!names.some((n) => n.toLowerCase() === bot.toLowerCase())) {
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
          { target: bot, text: `xdcc send #${pack.replace(/^#/, "")}` },
          { context: "message" },
        );
        if (!sent.ok) return await fail(sent.error);
        steps.push("requested");

        // 5. wait for the bot to say something back.
        const reply = await waitForEvent({
          log: s.log,
          bus: s.bus,
          matcher: { nick: bot },
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
    ({ session, line }: RawArgs) =>
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
        return fromOutcome(await s.commands.send("raw", { line }));
      }),
  );
}
