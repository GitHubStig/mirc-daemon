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
  ACTIVE_DCC_STATES,
  type BridgeError,
  bridgeError,
  type BridgeEvent,
  BridgeFailure,
  type DaemonStatus,
  type DccJob,
  EVENT_KINDS,
  type NetworkState,
  sameNetwork,
  TRANSFER_DCC_STATES,
} from "../core/types.ts";
import {
  type SearchSaid,
  type Session,
  type SessionRegistry,
  silenceHint,
} from "../core/sessions.ts";
import { classifyNumeric, emptyChannelWarning } from "../core/outcomes.ts";
import { markDays } from "../core/history.ts";
import { isChannelBuffer, waitForEvent, type WaitMatcher } from "../core/waits.ts";
import {
  channelsIn,
  classifyBotReply,
  parseSearchResult,
  plainText,
  quotedQuery,
  searchTotal,
  searchTrigger,
  triggersIn,
} from "../core/xdcc.ts";
import {
  CHANNEL_CHANGE_REFUSALS,
  isAbout,
  modesFrom324,
  numericOf,
  parseWhois,
  rawWords,
  WHOIS_NUMERICS,
} from "../core/numerics.ts";
import { alreadyHad, describeDownload, describeProgress } from "../core/dcc.ts";
import type { LogSink } from "../core/log.ts";

export interface ToolOptions {
  registry: SessionRegistry;
  log: LogSink;
  startedTs: number;
  /** Age at which the state model is re-queried before a compound operation. */
  stateFreshnessMs: number;
  /** ADR-0006: raw server lines are denied unless explicitly allowed. */
  allowRaw: boolean;
  /** How long a connect is waited for; tests shorten it. */
  connectWaitMs?: number;
  /** The pause between joining and searching; tests shorten it. */
  searchSettleMs?: number;
  /** How long xdcc_fetch waits for an offer after an unread reply; tests shorten it. */
  offerGraceMs?: number;
  /** How long xdcc_fetch waits for a resume's ACCEPT after the offer; tests shorten it. */
  resumeGraceMs?: number;
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
  const ids = all.map((s) => s.id).join(", ");
  // A session that does not exist is a different mistake from leaving it out.
  // Seen with a real agent: it passed a connection's cid ("1") as the session,
  // was told to "pass session", and went round in circles.
  if (id !== undefined) {
    throw new BridgeFailure(
      bridgeError(
        "server_error",
        `there is no mIRC client "${id}". ` +
          (all.length === 1
            ? `Only one is attached (${ids}), so leave session out.`
            : `Attached: ${ids}; pass one of those, or ask the user which.`) +
          " A session is a whole mIRC client, not a connection: for a connection use cid.",
      ),
    );
  }
  throw new BridgeFailure(
    bridgeError(
      "server_error",
      `${all.length} mIRC clients are attached (${ids}); pass session to say which one.`,
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
  cid?: number,
  /** The channel the call is about, if any: only for a refusal's hint. */
  channel?: string,
): Promise<NetworkState> {
  await freshen(session, thresholdMs);
  if (cid === undefined) return session.state.resolve(network, channel);
  // An explicit connection id wins: it is how two connections to one network
  // (say the user's and the agent's, both on EFnet) are told apart.
  const net = session.state.byCid(cid);
  if (!net) {
    throw new BridgeFailure(
      bridgeError("unknown_network", `mIRC has no connection with cid ${cid}; see irc_get_state.`),
    );
  }
  if (network !== undefined && !sameNetwork(net.name, network)) {
    throw new BridgeFailure(
      bridgeError(
        "unknown_network",
        `cid ${cid} is on "${net.name}", not "${network}". Pass one or the other.`,
      ),
    );
  }
  return net;
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

/**
 * The longest any tool waits. MCP clients give up on a call after about 60 s
 * (the SDK's default request timeout), so a longer wait does not wait longer:
 * it turns into a client-side error, and the result is lost. Anything slower
 * than this is tracked in the background and checked on again.
 */
const MAX_WAIT_MS = 55_000;

/**
 * How long xdcc_fetch keeps waiting for the offer once the bot has said
 * something it could not classify. The offer followed within 300 ms live.
 */
const OFFER_GRACE_MS = 5_000;

/** How long a connect is waited for before reporting that mIRC is still trying. */
const CONNECT_WAIT_MS = 50_000;

/**
 * How long xdcc_search waits after joining a channel before it searches. Seen
 * live (Rizon, 2026-10-23): searching 40 ms after the join got no answer, and a
 * greeting the channel's bot sends on join was taken for one. Some bots also
 * ignore commands from someone who has only just joined. Taken out of the
 * search's own wait, so the call still ends inside the client's ~60 s.
 */
const SEARCH_SETTLE_MS = 10_000;

/** Slack after NickServ's announced rename deadline before giving up on the rename. */
const RENAME_MARGIN_MS = 5_000;

/** Network services: their notices (a rename warning, logon news) are never a search's answer. */
const SERVICES = new Set([
  "nickserv",
  "chanserv",
  "memoserv",
  "operserv",
  "hostserv",
  "botserv",
  "global",
]);

/** How long xdcc_fetch waits after the offer for a resume's ACCEPT (and its end). */
const RESUME_GRACE_MS = 2_500;

/**
 * Wait until `settled(job)` holds or `timeoutMs` passes. Jobs are moved by
 * events and by progress polls, and the tracker reports both, so checking on
 * every change is enough. Resolves true if it settled.
 */
function waitForJob(
  session: Session,
  job: DccJob,
  settled: (job: DccJob) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  if (settled(job)) return Promise.resolve(true);
  if (session.closed.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onDrop = () => stop(false);
    const stop = (result: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      session.closed.removeEventListener("abort", onDrop);
      resolve(result);
    };
    const timer = setTimeout(() => stop(false), timeoutMs);
    const unsubscribe = session.dcc.onChange(() => {
      if (settled(job)) stop(true);
    });
    session.closed.addEventListener("abort", onDrop, { once: true });
  });
}

/**
 * `irc_dcc_status` with `wait`: wait for a job (the newest active one when
 * none is named) to change, then report it.
 */
async function watchJob(s: Session, job?: string, timeoutMs?: number): Promise<ToolResult> {
  const target = job !== undefined ? s.dcc.get(job) : s.dcc.active().at(-1);
  if (!target) {
    return job !== undefined
      ? failure(bridgeError("dcc_failed", `no DCC job named "${job}".`))
      : json({ changed: false, note: "no active DCC job to watch", jobs: s.dcc.list() });
  }
  const from = target.state;
  const heard = target.lastReplyTs;
  // A new reply wakes the watch even when it moves nothing: a refusal in a
  // language the daemon cannot read must still reach the agent, which can.
  const changed = await waitForJob(
    s,
    target,
    (j) => j.state !== from || j.lastReplyTs !== heard,
    timeoutMs ?? 50_000,
  );
  if (!changed && s.closed.aborted) return linkDropped();
  const next = jobAdvice(target);
  const newReply = target.lastReplyTs !== heard;
  return json({
    changed,
    from,
    ...(newReply ? { why: target.state !== from ? "state and reply" : "bot replied" } : {}),
    job: target,
    downloading: describeDownload(target) ?? null,
    progress: describeProgress(target) ?? null,
    ...(newReply ? botSaid(target) : {}),
    ...(next ? { next } : {}),
    ...(changed ? {} : { note: "no change yet; call again to keep waiting" }),
  });
}

/**
 * The answer when a wait's mIRC link dropped under it. Events after a
 * reconnect go to a new session, so the wait could only have missed them;
 * the agent should ask again, which reaches the new session.
 */
function linkDropped(): ToolResult {
  return failure(
    bridgeError(
      "connect_failed",
      "mIRC's link to the daemon dropped during the wait, so anything that arrived since " +
        "was not seen here. Ask again; once mIRC has reconnected, the call reaches it.",
    ),
  );
}

/**
 * What a job means for the agent to do next, by state. A stalled transfer is
 * the one that most needs saying: mIRC raises no event for it, and asking again
 * resumes from what is on disk.
 */
function jobAdvice(job: DccJob): string | undefined {
  switch (job.state) {
    case "downloading":
      return "Transferring. Follow it with irc_dcc_status {wait: true}; it ends complete or failed.";
    case "stalled":
      return "No data has arrived for a while, though mIRC still has the download open. Tell " +
        `the user. To retry, stop it with xdcc_cancel {job: "${job.id}"} and request the same ` +
        "pack again: mIRC resumes from what it already has.";
    case "failed":
      return job.requestedBy
        ? "Requesting the same pack again resumes from what mIRC already saved."
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The bot's last words, and whether the daemon understood them. Unrecognised
 * replies are the agent's to read: bots answer in their operator's language,
 * and an LLM reads Italian or Portuguese where a pattern list does not.
 */
function botSaid(job: DccJob): Record<string, unknown> {
  if (job.lastReply === undefined) return {};
  const understood = job.lastReplyKind !== undefined && job.lastReplyKind !== "unknown";
  return {
    botSaid: { text: job.lastReply, understood, ...(understood ? { as: job.lastReplyKind } : {}) },
    ...(understood ? {} : {
      readIt: "The daemon did not recognise the bot's reply, so the job has not moved on it. " +
        "Read it yourself (it may be in another language) and tell the user what it means. If " +
        `it is a refusal, close the job with xdcc_cancel {job: "${job.id}", tellBot: false}. ` +
        "If it says the transfer is coming, follow it with irc_dcc_status {wait: true}.",
    }),
  };
}

/**
 * When a read of `buffer` finds nothing, whether that is because no channel or
 * query by that name exists. Seen live: an agent asked for "#home" when the
 * channel is "#home!", got an empty answer, and took it for a quiet channel.
 */
function unknownBuffer(s: Session, buffer: string, network?: string): string | undefined {
  const nets = s.state.networks().filter((n) =>
    network === undefined || sameNetwork(n.name, network)
  );
  const names = new Set<string>(nets.flatMap((n) => n.channels));
  for (const e of s.log.since(0, { net: network, limit: 2000, keep: "newest" })) {
    if (e.buf) names.add(e.buf);
  }
  const want = buffer.toLowerCase();
  if ([...names].some((n) => n.toLowerCase() === want)) return undefined;
  const close = [...names].filter((n) =>
    n.toLowerCase().startsWith(want) || want.startsWith(n.toLowerCase()) ||
    n.toLowerCase().includes(want.replace(/^[#&]/, ""))
  );
  return `There is no channel or query named ${buffer}` +
    (network ? ` on ${network}` : "") + ", so nothing was found, not a quiet channel." +
    (close.length > 0 ? ` Did you mean ${close.slice(0, 3).join(" or ")}?` : "") +
    (nets.some((n) => n.channels.length > 0)
      ? ` mIRC is in: ${nets.flatMap((n) => n.channels).slice(0, 10).join(", ")}.`
      : "");
}

/** What mIRC will do with an offer, from its DCC send-request setting ($sreq). */
function acceptance(session: Session): string {
  switch (session.sreq) {
    case "auto":
      return "mIRC accepts DCC sends automatically, so the transfer starts by itself.";
    case "ask":
      return "mIRC is set to ASK before accepting: tell the user to accept the file in mIRC, " +
        "or it will not start.";
    case "ignore":
      return "mIRC is set to IGNORE DCC sends, so this transfer cannot start.";
    default:
      return "mIRC's DCC accept setting is unknown.";
  }
}

// Shared argument pieces.
const sessionArg = z
  .string()
  .optional()
  .describe(
    "Leave this out. Only needed when several mIRC clients are attached, which is rare; then " +
      'it is a client id like "s1" from daemon_status. Not a connection: that is cid.',
  );
const networkArg = z
  .string()
  .optional()
  // Was "omit when only one is connected". Seen with a small local model: it
  // took that as "usually omit", lost count of its connections, and left it out
  // of four calls with three networks up.
  .describe(
    'The network, e.g. "Rizon". Always pass the one the user named, or the one the ' +
      "channel is on. Leave it out only when mIRC is on a single network.",
  );
const cidArg = z
  .int()
  .optional()
  .describe(
    "A specific connection, from irc_get_state. Only needed when two connections share a " +
      "network and the network name alone is ambiguous.",
  );

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
  cid: cidArg,
  channel: z.string(),
});
const isonSchema = z.object({
  session: sessionArg,
  network: networkArg,
  cid: cidArg,
  nicks: z.array(z.string()).min(1),
});
const connectSchema = z.object({
  session: sessionArg,
  network: z
    .string()
    .optional()
    .describe(
      "Network name, e.g. EFnet or Rizon, matched case-insensitively. Pass it whenever you " +
        "know it: it is what lets a connection the user already has be reused. A network in " +
        "mIRC's server list needs no server: mIRC picks one.",
    ),
  server: z
    .string()
    .optional()
    .describe("Server to connect to if mIRC is not on that network yet, e.g. irc.rizon.net."),
  port: z.int().min(1).max(65535).optional(),
  tls: z
    .boolean()
    .optional()
    .describe("Connect over TLS (mIRC's +port). The port defaults to 6697 when this is set."),
  password: z.string().optional().describe("Server password, if required. Not logged."),
  second: z
    .boolean()
    .optional()
    .describe(
      "Open another connection even though mIRC is already on that network. Only when the " +
        "user asked for one: several connections from one host can get the user banned.",
    ),
});
const joinSchema = z.object({
  session: sessionArg,
  network: networkArg,
  cid: cidArg,
  channel: z.string(),
  key: z.string().optional(),
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
  cid: cidArg,
  channel: z.string(),
  message: z
    .string()
    .optional()
    .describe("Part message, as /part #chan <message>. Omit to leave without one."),
  confirm: confirmArg,
});
const cleanupSchema = z.object({ session: sessionArg });
const modeSchema = z.object({
  session: sessionArg,
  network: networkArg,
  cid: cidArg,
  channel: z.string(),
  modes: z
    .string()
    .min(1)
    .describe('Mode changes as IRC writes them, e.g. "+i", "-i+k secret", "+o nick".'),
  confirm: confirmArg,
});
const historySchema = z.object({
  session: sessionArg,
  network: networkArg,
  cid: cidArg,
  window: z.string().describe("A channel (#name) or a query (the other person's nick)."),
  lines: z.int().min(1).max(200).optional().describe("How many of the newest lines (default 50)."),
  before: z
    .int()
    .positive()
    .optional()
    .describe("Page back: only lines before this line number (`from` of a previous answer)."),
});
type HistoryArgs = z.infer<typeof historySchema>;
const whoisSchema = z.object({
  session: sessionArg,
  network: networkArg,
  cid: cidArg,
  nick: z.string(),
});
const topicSchema = z.object({
  session: sessionArg,
  network: networkArg,
  cid: cidArg,
  channel: z.string(),
  text: z.string().min(1).optional().describe("Set the topic to this. Omit to read it."),
  confirm: confirmArg,
});
const disconnectSchema = z.object({
  session: sessionArg,
  network: z
    .string()
    .optional()
    .describe("The network to disconnect from. Never inferred: name it, or pass cid."),
  cid: cidArg,
  message: z
    .string()
    .optional()
    .describe("Quit message. Omit to use mIRC's own default, as a person quitting would."),
  confirm: confirmArg,
});
const nickSchema = z.object({
  session: sessionArg,
  network: networkArg,
  cid: cidArg,
  nick: z.string().min(1),
  confirm: confirmArg,
});
const sendSchema = z.object({
  session: sessionArg,
  network: networkArg,
  cid: cidArg,
  target: z.string(),
  text: z.string().min(1),
  notice: z
    .boolean()
    .optional()
    .describe("Send it as a NOTICE instead. Some bots take commands only that way."),
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
  timeoutMs: z.int().min(100).max(MAX_WAIT_MS).optional(),
});
const jobArg = z
  .string()
  .optional()
  .describe("A job id from xdcc_fetch, e.g. dcc3. Omit for the most recent active one.");
const dccStatusSchema = z.object({
  session: sessionArg,
  job: jobArg,
  wait: z
    .boolean()
    .optional()
    .describe("Wait for the job to change before answering, instead of answering now."),
  timeoutMs: z.int().min(100).max(MAX_WAIT_MS).optional().describe("With wait: how long."),
});
const xdccCancelSchema = z.object({
  session: sessionArg,
  job: jobArg,
  confirm: confirmArg,
  tellBot: z
    .boolean()
    .optional()
    .describe(
      "Send the bot XDCC CANCEL / XDCC REMOVE (default true). Pass false to just close the " +
        "job, e.g. when the bot already refused in words the daemon did not recognise.",
    ),
});
const xdccListSchema = z.object({
  session: sessionArg,
  network: networkArg,
  bot: z.string(),
  timeoutMs: z.int().min(500).max(MAX_WAIT_MS).optional(),
  quietMs: z
    .int()
    .min(100)
    .max(30_000)
    .optional()
    .describe("The list is complete once the bot is silent this long (default 3000)."),
});
const xdccSearchSchema = z.object({
  session: sessionArg,
  network: networkArg,
  cid: cidArg,
  channel: z
    .string()
    .describe(
      "Where to search: usually the chat channel that a bot channel's topic names, e.g. " +
        "#FILES-CHAT for #FILES, whose own topic lists the triggers.",
    ),
  query: z.string().min(1),
  trigger: z
    .string()
    .optional()
    .describe('The search command, e.g. "!search" or "@find". Omit to take it from the topic.'),
  timeoutMs: z.int().min(500).max(MAX_WAIT_MS).optional(),
  quietMs: z
    .int()
    .min(100)
    .max(30_000)
    .optional()
    .describe("The results are complete once nothing has come for this long (default 3000)."),
});
type XdccSearchArgs = z.infer<typeof xdccSearchSchema>;
const xdccSearchResultsSchema = z.object({
  session: sessionArg,
  network: networkArg,
  cid: cidArg,
  channel: z.string().describe("The channel the search was said in."),
  cursor: z.int().nonnegative().describe("The cursor xdcc_search returned."),
  query: z
    .string()
    .optional()
    .describe("The words that search was for, as xdcc_search's answer gives them."),
  timeoutMs: z.int().min(500).max(MAX_WAIT_MS).optional(),
  quietMs: z.int().min(100).max(30_000).optional(),
});
type XdccSearchResultsArgs = z.infer<typeof xdccSearchResultsSchema>;
const xdccFetchSchema = z.object({
  session: sessionArg,
  network: networkArg,
  channel: z.string(),
  bot: z.string(),
  pack: z.string().describe('Pack number or id, as the bot expects it (e.g. "42").'),
  timeoutMs: z
    .int()
    .min(500)
    .max(MAX_WAIT_MS)
    .optional()
    .describe("How long to wait for the bot's first answer (default 50000). The job goes on."),
  notifyOnFailure: z.boolean().optional().describe("Echo the failure into mIRC. Default true."),
  topicRead: z
    .boolean()
    .optional()
    .describe(
      "Leave this out unless xdcc_fetch answered join_required for this channel. Then, having " +
        "read the topic it quoted, you judged that joining the channels it names is NOT " +
        "required. Ignored before that. Never set this to skip a requirement: joining is " +
        "cheap, a ban is not.",
    ),
});
const rawSchema = z.object({
  session: sessionArg,
  network: networkArg,
  cid: cidArg,
  line: z.string().min(1),
  confirm: z.literal(true).describe("Must be true, to make this a deliberate choice."),
});

type EmptyArgs = z.infer<typeof emptySchema>;
type GetStateArgs = z.infer<typeof getStateSchema>;
type ReadArgs = z.infer<typeof readSchema>;
type MembersArgs = z.infer<typeof membersSchema>;
type IsonArgs = z.infer<typeof isonSchema>;
type ConnectArgs = z.infer<typeof connectSchema>;
type JoinArgs = z.infer<typeof joinSchema>;
type PartArgs = z.infer<typeof partSchema>;
type DisconnectArgs = z.infer<typeof disconnectSchema>;
type CleanupArgs = z.infer<typeof cleanupSchema>;
type ModeArgs = z.infer<typeof modeSchema>;
type WhoisArgs = z.infer<typeof whoisSchema>;
type TopicArgs = z.infer<typeof topicSchema>;
type NickArgs = z.infer<typeof nickSchema>;
type SendArgs = z.infer<typeof sendSchema>;
type NotifyArgs = z.infer<typeof notifySchema>;
type WaitArgs = z.infer<typeof waitSchema>;
type DccStatusArgs = z.infer<typeof dccStatusSchema>;
type XdccListArgs = z.infer<typeof xdccListSchema>;
type XdccFetchArgs = z.infer<typeof xdccFetchSchema>;
type XdccCancelArgs = z.infer<typeof xdccCancelSchema>;
type RawArgs = z.infer<typeof rawSchema>;

export function registerTools(server: McpServer, options: ToolOptions): void {
  const { registry, stateFreshnessMs, allowRaw } = options;
  const connectWaitMs = options.connectWaitMs ?? CONNECT_WAIT_MS;
  const searchSettleMs = options.searchSettleMs ?? SEARCH_SETTLE_MS;
  const offerGraceMs = options.offerGraceMs ?? OFFER_GRACE_MS;
  const resumeGraceMs = options.resumeGraceMs ?? RESUME_GRACE_MS;

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
        "Daemon health: uptime, whether mIRC is attached and answering, session id (every " +
        "attached mIRC client, when there are several) and active " +
        "DCC jobs.",
      inputSchema: emptySchema.shape,
    },
    (_args: EmptyArgs) =>
      guarded(() => {
        const sessions = registry.list();
        const sole = registry.resolve();
        const silentMs = sole?.silentForMs();
        const status: DaemonStatus = {
          ...(silentMs !== undefined
            ? { mircSilentForSecs: Math.round(silentMs / 1000), hint: silenceHint(silentMs) }
            : {}),
          uptimeSecs: Math.round((Date.now() - options.startedTs) / 1000),
          sessions: sessions.length,
          mircAttached: sessions.length > 0,
          sessionId: sole?.id,
          nick: sole?.nick,
          agentsAttached: 0,
          lastStateRefreshTs: sole?.state.lastRefreshTs,
          dccJobs: sessions.reduce((total, s) => total + s.dcc.active().length, 0),
          ...(sessions.length > 1
            ? {
              clients: sessions.map((s) => ({
                ...s.info(),
                networks: s.state.networks().map((n) => n.name),
              })),
            }
            : {}),
        };
        return json(status);
      }),
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
        "Read IRC activity the daemon has seen, oldest first: only since it last connected to " +
        "mIRC (see seenSince). For anything older, irc_history reads mIRC's own window. " +
        "Returns a cursor to pass to a later call so you only get what is new.",
      inputSchema: readSchema.shape,
    },
    ({ session, network, buffer, since, limit, kinds }: ReadArgs) =>
      guarded(() => {
        const s = sessionOf(registry, session);
        const max = limit ?? 50;
        const query = { net: network, buf: buffer, kinds };
        // How far back this can see, so "nothing" reads as "nothing since then"
        // rather than as lost history. A real agent could not tell the two apart.
        const oldest = s.log.since(0, { limit: 1, keep: "oldest" })[0];
        const seenSince = new Date(
          oldest !== undefined && oldest.seq > 1 ? oldest.ts : s.connectedTs,
        ).toISOString();
        let events: BridgeEvent[];
        let cursor: number;
        let more = false;
        if (since === undefined) {
          events = s.log.since(0, { ...query, limit: max });
          cursor = s.log.cursor;
        } else {
          // Paging: keep the oldest so nothing between two polls is skipped, and
          // hand back a cursor at the last event returned rather than at the head.
          const page = s.log.since(since, { ...query, limit: max + 1, keep: "oldest" });
          more = page.length > max;
          events = page.slice(0, max);
          cursor = more ? events[events.length - 1].seq : s.log.cursor;
        }
        const unknown = events.length === 0 && buffer !== undefined
          ? unknownBuffer(s, buffer, network)
          : undefined;
        return json({ cursor, events, more, seenSince, ...(unknown ? { note: unknown } : {}) });
      }),
  );

  tool(
    "irc_history",
    {
      description:
        "Read the last lines of one of mIRC's windows (a channel or a query), as mIRC shows " +
        "them, timestamps included: its own scrollback, however long ago, where irc_read only " +
        "has what the daemon saw since it last connected. Page back with `before`.",
      inputSchema: historySchema.shape,
    },
    ({ session, network, cid, window, lines, before }: HistoryArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(
          s,
          network,
          stateFreshnessMs,
          cid,
          isChannelBuffer(window) ? window : undefined,
        );
        const outcome = await s.commands.send("history", {
          cid: net.cid,
          window,
          lines: lines ?? 50,
          before: before ?? 0,
        });
        if (!outcome.ok) {
          if (outcome.error.detail === "no-such-window") {
            return failure(
              bridgeError(
                "not_on_channel",
                `mIRC has no window called ${window} on ${net.name}` +
                  (net.channels.length > 0 ? `; it is in ${net.channels.join(", ")}.` : ".") +
                  " A window closes when its channel is left, and its scrollback goes with it.",
              ),
            );
          }
          return failure(outcome.error);
        }
        const got = Array.isArray(outcome.data?.lines) ? (outcome.data.lines as string[]) : [];
        const from = typeof outcome.data?.from === "number" ? outcome.data.from : undefined;
        const asked = lines ?? 50;
        // mIRC caps a reply to fit one frame, so fewer may come back than asked.
        // Seen with a real agent: it asked for 200, got about 40, and told the
        // user it had read "the last 200 lines".
        const capped = got.length < asked && from !== undefined && from > 1;
        const marked = markDays(got.map((l) => plainText(l)));
        return json({
          window,
          network: net.name,
          returned: got.length,
          lines: marked.lines,
          ...(marked.days > 0
            ? {
              days: 'mIRC\'s timestamps carry no date. Each "--- new day" line marks where the ' +
                "clock goes back, so the lines above it are from an earlier day than the lines " +
                "below; say so rather than treating them as one day. A day where the clock still " +
                "moved forward is not marked, so there may be more.",
            }
            : {}),
          ...(from !== undefined ? { from } : {}),
          total: outcome.data?.total ?? null,
          ...(capped
            ? {
              capped: `Only ${got.length} of the ${asked} lines asked for fit in one reply. ` +
                `Pass before: ${from} for the lines before these.`,
            }
            : from !== undefined && from > 1
            ? { older: `Earlier lines exist: pass before: ${from} for the page before these.` }
            : {}),
        });
      }),
  );

  tool(
    "irc_members",
    {
      description:
        "Who is in a channel. Large channels return a truncated name list with the full count.",
      inputSchema: membersSchema.shape,
    },
    ({ session, network, cid, channel }: MembersArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs, cid, channel);
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
    ({ session, network, cid, nicks }: IsonArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs, cid);
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
    target: {
      server: string;
      port?: number;
      tls?: boolean;
      password?: string;
      network?: string;
      /** The user asked for another connection to a network mIRC is already on. */
      second?: boolean;
    },
  ): Promise<ToolResult> {
    const { server, port, tls, password, network, second } = target;
    const quitWindows = s.state.networks().filter((n) =>
      n.status === "disconnected" &&
      ((network !== undefined && sameNetwork(n.name, network)) ||
        (n.server !== undefined && n.server.toLowerCase() === server.toLowerCase()))
    );
    const reusable = quitWindows.find((n) => s.owned.ownsConnection(n.cid)) ?? quitWindows[0];
    const usersWindow = reusable !== undefined && !s.owned.ownsConnection(reusable.cid);
    const before = new Set(s.state.networks().map((n) => n.cid));

    const outcome = await s.commands.send(
      "connect",
      // tls goes as a number: bridge.mrc reads flags with jnum, and only strings are base64.
      { cid: reusable?.cid, server, port, tls: tls ? 1 : undefined, password },
      // Under MAX_WAIT_MS, or the MCP client gives up first and the answer is
      // lost. A connect often takes longer: mIRC rotates through a network's
      // servers (every one of irc.efnet.org's ten timed out from here, 21 s
      // each) and keeps going after this, so running out is reported as
      // "still trying", not as failure.
      { context: "connect", timeoutMs: connectWaitMs },
    );

    // Receipts first, success or not. A connection that never registered still
    // left a window behind, retrying on its own (seen live: "Connect retry #4"),
    // and it is the agent's to stop. Taking the receipt only on success left
    // that window looking like the user's.
    const refreshError = await s.refreshState();
    const opened = usersWindow
      ? []
      : s.state.networks().filter((n) => !before.has(n.cid) || n.cid === reusable?.cid);
    for (const n of opened) s.owned.openedConnection(n.cid);

    if (!outcome.ok && outcome.error.code === "timeout") {
      const trying = opened.find((n) => n.status !== "disconnected") ??
        (reusable ? s.state.byCid(reusable.cid) : undefined);
      const stop = trying === undefined
        ? ""
        : s.owned.ownsConnection(trying.cid)
        ? ` To give up, irc_disconnect {cid: ${trying.cid}}; that window is the agent's.`
        : ` To give up, irc_disconnect {cid: ${trying.cid}, confirm: true}, but that window is ` +
          "the user's, so only if they agree.";
      s.note(`still connecting to ${server}; mIRC keeps trying on its own`);
      return failure(
        bridgeError(
          "connect_timeout",
          `mIRC has not finished connecting to ${server} after ${
            Math.round(connectWaitMs / 1000)
          } s, and ` +
            "is still trying by itself. That is often normal: mIRC works through a network's " +
            "servers until one lets it in, which on EFnet can take over a minute. Check " +
            `irc_get_state in a little while, or wait for it with irc_wait_for {kind: "conn"}.` +
            stop,
        ),
      );
    }
    if (!outcome.ok) {
      const left = opened.find((n) => n.status !== "disconnected");
      return failure(
        left
          ? {
            ...outcome.error,
            hint: `${outcome.error.hint} mIRC may keep retrying in the window it opened ` +
              `(cid ${left.cid}); that window is the agent's, so irc_disconnect it to stop.`,
          }
          : outcome.error,
      );
    }
    if (refreshError) return failure(refreshError);
    const cid = typeof outcome.data?.cid === "number" ? outcome.data.cid : undefined;
    const net = cid === undefined ? undefined : s.state.byCid(cid);

    // Only now is the network's name known (the server announces it). A server
    // name the agent picked can belong to a network the user is already on
    // through another server, e.g. irc.efnet.org while they are on
    // efnet.deic.eu. Several connections from one host can get the user banned,
    // so the duplicate is closed again at once and the existing one used.
    const twin = net && second !== true
      ? s.state.networks().find((n) =>
        n.cid !== net.cid && n.status === "connected" && sameNetwork(n.name, net.name)
      )
      : undefined;
    if (net && twin) {
      await s.commands.send("disconnect", { cid: net.cid }, { timeoutMs: 15_000 });
      s.note(
        `connected to ${server}, but that is ${net.name}, which mIRC was already on ` +
          `(cid ${twin.cid}); closed the new connection again`,
      );
      await s.refreshState();
      return json({
        skipped: true,
        reason: `${server} is on ${net.name}, which mIRC is already connected to (cid ` +
          `${twin.cid}); the new connection was closed again and the existing one is the one ` +
          "to use. Pass network next time to skip the round trip.",
        network: s.state.byCid(twin.cid) ?? twin,
      });
    }

    s.note(`connected to ${server}${net ? ` (${net.name}, cid ${net.cid})` : ""}`);
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
        "Make sure mIRC is on a network. A live connection to that network (or that server), " +
        "the user's included, is reused, never replaced. Otherwise a quit window for it is " +
        "reconnected, or a new connection is opened alongside the others. Pass network " +
        "whenever you know it. A new connection that turns out to duplicate a network mIRC is " +
        "already on is closed again at once, since several connections from one host can get " +
        "the user banned; pass second: true only if the user asked for another.",
      inputSchema: connectSchema.shape,
    },
    ({ session, network, server, port, tls, password, second }: ConnectArgs) =>
      guarded(async () => {
        // A network name has no dots; a host does. Seen with a small local
        // model: told "on irc.williamgattone.it", it passed that as network.
        if (server === undefined && network?.includes(".")) {
          server = network;
          network = undefined;
        }
        const s = sessionOf(registry, session);
        await freshen(s, stateFreshnessMs);
        if (second !== true) {
          const existing = existingConnection(s, server, network);
          if (existing) {
            return json({ skipped: true, reason: "already connected", network: existing });
          }
        }
        if (!server && network) {
          // mIRC's /server takes a network name from its own server list and
          // picks a server itself, but retries a name it does not know as a
          // hostname, forever and silently. So ask first. An older bridge.mrc
          // without the query answers with a failure: then nothing changes.
          const known = await s.commands.send("netknown", { network });
          if (known.ok && known.data?.known === true) server = network;
          else if (known.ok) {
            return failure(
              bridgeError(
                "unknown_network",
                `mIRC is not on "${network}", and its server list has no network by that ` +
                  "name. Pass server (the address, e.g. irc.example.net, and tls if it needs " +
                  "it), or check the network name.",
              ),
            );
          }
        }
        if (!server) {
          return failure(
            bridgeError(
              "unknown_network",
              network
                ? `mIRC is not on "${network}" and no server was given. Pass server (and ` +
                  "port, and tls if it needs it) to connect, or check the network name."
                : "pass network, server, or both.",
            ),
          );
        }
        return await openConnection(s, { server, port, tls, password, network, second });
      }),
  );

  tool(
    "irc_join",
    {
      description:
        "Make sure mIRC is in a channel, joining only if it is not already there. Joining a " +
        "name nobody is in creates that channel, and on most networks makes you its operator, " +
        "so this is also how to make a new channel. Returns the " +
        "channel's topic: read it, since channels state their rules there. Not needed before " +
        "xdcc_fetch or xdcc_search, which join by themselves. A channel with almost nobody " +
        "in it comes back with a warning, since that often means the name is wrong.",
      inputSchema: joinSchema.shape,
    },
    ({ session, network, cid, channel, key }: JoinArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs, cid, channel);
        // Asked of mIRC even when already joined: it answers that from its own
        // records at once, with the topic, and sends nothing to the server.
        const outcome = await s.commands.send("join", { cid: net.cid, channel, key }, {
          context: "join",
        });
        if (!outcome.ok) {
          s.note(`could not join ${channel} on ${net.name}: ${outcome.error.hint}`);
          return failure(explainJoinRefusal(outcome.error, net));
        }
        const already = outcome.data?.already === true;
        // Only a real join earns a receipt: "already" means it was in there before.
        if (!already) {
          s.owned.joinedChannel(net.cid, channel);
          s.note(`joined ${channel} on ${net.name}`);
        }
        const spelled = typeof outcome.data?.joined === "string" ? outcome.data.joined : channel;
        const members = typeof outcome.data?.members === "number"
          ? outcome.data.members
          : s.state.memberCount(net, channel);
        const topic = typeof outcome.data?.topic === "string" && outcome.data.topic !== ""
          ? outcome.data.topic
          : null;
        const warning = emptyChannelWarning(channel, members);
        // Said in words, both ways. Seen with a small local model: handed back
        // only `skipped: true`, it called the same join again and again.
        const done = (already
          ? `mIRC was already in ${spelled} on ${net.name}; nothing was sent. Do not join it ` +
            "again: carry on with the task."
          : `Joined ${spelled} on ${net.name}.`) +
          (topic ? " Read the topic for the channel's rules." : "");
        return json({
          ok: true,
          done,
          already,
          channel: spelled,
          network: net.name,
          members,
          topic,
          warnings: warning ? [warning] : [],
        });
      }),
  );

  /** Wait for a raw reply on one connection, since a cursor. */
  function waitRaw(
    s: Session,
    cid: number,
    test: (event: BridgeEvent) => boolean,
    since: number,
    timeoutMs: number,
  ): Promise<BridgeEvent | undefined> {
    return waitForEvent({
      log: s.log,
      bus: s.bus,
      signal: s.closed,
      matcher: { kind: "raw", cid, test },
      since,
      timeoutMs,
    });
  }

  /** A refusal of a MODE or TOPIC change on `channel`. */
  function refusalOf(event: BridgeEvent, channel: string): boolean {
    const n = numericOf(event);
    if (n === undefined || !CHANNEL_CHANGE_REFUSALS.has(n)) return false;
    // 472 and 501 name the mode letter, not the channel.
    return n === 472 || n === 501 || isAbout(event, channel);
  }

  function refused(event: BridgeEvent): ToolResult {
    return failure(
      classifyNumeric(numericOf(event) ?? 0, "generic", rawWords(event).slice(3).join(" ")),
    );
  }

  tool(
    "irc_mode",
    {
      description:
        'Change a channel\'s modes, e.g. "+i" (invite only), "-i+k secret", "+o nick". Needs ' +
        "channel operator status. Channels the agent joined itself need no confirmation; the " +
        "user's need confirm: true. Reports the modes the server then shows, or its refusal.",
      inputSchema: modeSchema.shape,
    },
    ({ session, network, cid, channel, modes, confirm }: ModeArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs, cid, channel);
        if (!s.owned.ownsChannel(net.cid, channel) && confirm !== true) {
          return usersOwn(channel, net);
        }
        const since = s.log.cursor;
        const changed = await s.commands.send("mode", { cid: net.cid, target: channel, modes });
        if (!changed.ok) return failure(changed.error);
        // IRC acknowledges a mode change only by echoing it, and a refusal
        // only by a numeric. So ask for the modes straight after: the server
        // answers in order, and whichever of refusal or 324 comes first is the
        // outcome. No fixed wait.
        const asked = await s.commands.send("mode", { cid: net.cid, target: channel });
        if (!asked.ok) return failure(asked.error);
        const reply = await waitRaw(
          s,
          net.cid,
          (e) => refusalOf(e, channel) || (numericOf(e) === 324 && isAbout(e, channel)),
          since,
          8000,
        );
        if (!reply && s.closed.aborted) return linkDropped();
        if (!reply) {
          return failure(
            bridgeError("timeout", `the server did not report ${channel}'s modes within 8 s.`),
          );
        }
        if (numericOf(reply) !== 324) return refused(reply);
        s.note(`set ${modes} on ${channel} (now ${modesFrom324(reply)})`);
        return json({ ok: true, channel, modes: modesFrom324(reply) });
      }),
  );

  tool(
    "irc_whois",
    {
      description:
        "Who a nick is: user and host, real name, server, channels, idle time, the services " +
        "account it is logged in as, and away message, as the server reports them.",
      inputSchema: whoisSchema.shape,
    },
    ({ session, network, cid, nick }: WhoisArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs, cid);
        const since = s.log.cursor;
        const sent = await s.commands.send("whois", { cid: net.cid, nick });
        if (!sent.ok) return failure(sent.error);
        // 318 ends a WHOIS; 401 means there was no such nick.
        const end = await waitRaw(
          s,
          net.cid,
          (e) => (numericOf(e) === 318 || numericOf(e) === 401) && isAbout(e, nick),
          since,
          10_000,
        );
        if (!end && s.closed.aborted) return linkDropped();
        if (!end) {
          return failure(bridgeError("timeout", `the server did not finish a WHOIS of ${nick}.`));
        }
        if (numericOf(end) === 401) return failure(classifyNumeric(401));
        const replies = s.log
          .since(since, { kinds: ["raw"], limit: 200, keep: "oldest" })
          .filter((e) =>
            e.cid === net.cid && WHOIS_NUMERICS.has(numericOf(e) ?? 0) && isAbout(e, nick)
          );
        return json(parseWhois(nick, replies));
      }),
  );

  tool(
    "irc_topic",
    {
      description:
        "Read a channel's topic (mIRC must be in the channel), or set it with `text`. Setting " +
        "it on a channel the agent joined itself needs no confirmation; the user's need " +
        "confirm: true. Channels state their rules in the topic, so read it when joining.",
      inputSchema: topicSchema.shape,
    },
    ({ session, network, cid, channel, text, confirm }: TopicArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs, cid, channel);
        if (text === undefined) {
          const read = await s.commands.send("topic", { cid: net.cid, channel });
          if (!read.ok) return failure(read.error);
          return json({ channel, topic: read.data?.topic ?? "" });
        }
        if (!s.owned.ownsChannel(net.cid, channel) && confirm !== true) {
          return usersOwn(channel, net);
        }
        const since = s.log.cursor;
        const sent = await s.commands.send("topic", { cid: net.cid, channel, text });
        if (!sent.ok) return failure(sent.error);
        // Accepted, the server echoes the TOPIC to everyone in the channel, us
        // included; refused, it sends a numeric.
        const reply = await waitForEvent({
          log: s.log,
          bus: s.bus,
          signal: s.closed,
          matcher: {
            cid: net.cid,
            test: (e) =>
              (e.kind === "topic" && (e.buf ?? "").toLowerCase() === channel.toLowerCase()) ||
              (e.kind === "raw" && refusalOf(e, channel)),
          },
          since,
          timeoutMs: 8000,
        });
        if (!reply && s.closed.aborted) return linkDropped();
        if (!reply) {
          return failure(bridgeError("timeout", `the server did not confirm ${channel}'s topic.`));
        }
        if (reply.kind === "raw") return refused(reply);
        s.note(`set ${channel}'s topic: ${reply.text ?? text}`);
        return json({ ok: true, channel, topic: reply.text ?? text });
      }),
  );

  tool(
    "irc_part",
    {
      description:
        "Leave a channel, only when the user asked or the task they gave includes leaving. " +
        "Never tidy up on your own initiative. Channels the agent joined itself need no " +
        "confirmation; the user's own channels need confirm: true. Takes an optional part " +
        "message, if the user gave one.",
      inputSchema: partSchema.shape,
    },
    ({ session, network, cid, channel, message, confirm }: PartArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs, cid, channel);
        if (!s.owned.ownsChannel(net.cid, channel) && confirm !== true) {
          return usersOwn(channel, net);
        }
        const outcome = await s.commands.send("part", { cid: net.cid, channel, message });
        if (outcome.ok) s.note(`left ${channel} on ${net.name}`);
        return fromOutcome(outcome);
      }),
  );

  /**
   * Close the agent's disconnected windows, after a disconnect. mIRC's
   * `/close -it` closes every disconnected window at once, with what is open
   * inside it, and nothing closes just one (docs/findings.md), so this only acts when
   * every one of them is the agent's and none holds a running transfer.
   * Otherwise it leaves them all and says why. There was once a tool that
   * closed the user's too, with confirm; agents stumbled over the extra step,
   * and the user can close their own windows in mIRC.
   */
  async function closeAgentWindows(
    s: Session,
  ): Promise<{ closed: string[]; leftOpen?: string } | BridgeError> {
    // Fresh, not cached: this decides whose windows are about to go.
    const refreshed = await s.refreshState();
    if (refreshed) return refreshed;
    const idle = s.state.networks().filter((n) => n.status === "disconnected");
    if (!idle.some((n) => s.owned.ownsConnection(n.cid))) return { closed: [] };
    const users = idle.filter((n) => !s.owned.ownsConnection(n.cid));
    if (users.length > 0) {
      return {
        closed: [],
        leftOpen: "The agent's disconnected window stays open: mIRC can only close every " +
          "disconnected window at once, and some are the user's (" +
          users.map((n) => `${n.name}, cid ${n.cid}`).join("; ") + "). Nothing to do about it.",
      };
    }
    const busy = idle.filter((n) => s.dcc.active().some((j) => j.cid === n.cid));
    if (busy.length > 0) {
      return {
        closed: [],
        leftOpen: "The disconnected windows stay open: closing them would also end the transfer " +
          "still running in " + busy.map((n) => `${n.name} (cid ${n.cid})`).join(", ") + ".",
      };
    }
    const outcome = await s.commands.send("closewin");
    if (!outcome.ok) return outcome.error;
    // The refresh also drops the closed windows' receipts.
    const after = await s.refreshState();
    if (after) return after;
    const remaining = new Set(s.state.networks().map((n) => n.cid));
    const closed = idle.filter((n) => !remaining.has(n.cid)).map((n) => `${n.name} (cid ${n.cid})`);
    if (closed.length > 0) s.note(`closed the agent's windows: ${closed.join(", ")}`);
    return { closed };
  }

  tool(
    "irc_disconnect",
    {
      description:
        "Disconnect from a network, only when the user asked or the task they gave includes it " +
        "(e.g. 'get pack 5, then disconnect'). A finished transfer is NOT a reason to disconnect " +
        "by itself. Connections the agent opened need no confirmation, and their window is " +
        "closed too; the user's own need confirm: true, and keep their window. Quits with " +
        "mIRC's own default message unless one is given. To undo everything the agent opened, " +
        "irc_cleanup does it in one call.",
      inputSchema: disconnectSchema.shape,
    },
    ({ session, network, cid, message, confirm }: DisconnectArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        // Never inferred: disconnecting the wrong network is not undoable.
        if (network === undefined && cid === undefined) {
          return failure(
            bridgeError("unknown_network", "name the network to disconnect, or pass its cid."),
          );
        }
        const net = await targetOf(s, network, stateFreshnessMs, cid);
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
        s.note(`disconnected from ${net.name} (cid ${net.cid})`);
        // Seen with real agents: told to clean up, they disconnected and left
        // the windows behind, or went round in circles over a separate step to
        // close them. So the agent's own window goes with its connection.
        if (s.owned.ownsConnection(net.cid)) {
          const windows = await closeAgentWindows(s);
          if ("code" in windows) return failure(windows);
          return json({
            ok: true,
            done: windows.closed.length > 0
              ? `Disconnected from ${net.name} and closed its window.`
              : `Disconnected from ${net.name}.`,
            ...(windows.leftOpen ? { window: windows.leftOpen } : {}),
          });
        }
        const error = await s.refreshState();
        if (error) return failure(error);
        return json({
          ok: true,
          done: `Disconnected from ${net.name}. Its window stays open: it is the user's.`,
          network: s.state.byCid(net.cid) ?? null,
        });
      }),
  );

  tool(
    "irc_cleanup",
    {
      description:
        "Undo what the agent opened, in one call, when the user asks to clean up: leaves the " +
        "channels it joined on the user's connections, disconnects the connections it opened, " +
        "and closes their windows. Never touches the user's own channels, connections or " +
        "windows, and needs no other tool before or after it. A connection with a transfer " +
        "still running is left alone, and the answer says so.",
      inputSchema: cleanupSchema.shape,
    },
    ({ session }: CleanupArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        // Fresh, not cached: this decides what is about to go.
        const refreshed = await s.refreshState();
        if (refreshed) return failure(refreshed);

        const left: string[] = [];
        const disconnected: string[] = [];
        const kept: string[] = [];
        const problems: string[] = [];
        for (const net of s.state.networks()) {
          if (!s.owned.ownsConnection(net.cid)) {
            // The user's connection: only the channels the agent joined go.
            for (const channel of net.channels.filter((c) => s.owned.ownsChannel(net.cid, c))) {
              const outcome = await s.commands.send("part", { cid: net.cid, channel });
              if (outcome.ok) {
                s.note(`left ${channel} on ${net.name}`);
                left.push(`${channel} on ${net.name}`);
              } else {
                problems.push(`could not leave ${channel} on ${net.name}: ${outcome.error.hint}`);
              }
            }
            continue;
          }
          // Closing a connection's window takes what is open inside it, so a
          // running download would go with it.
          const running = s.dcc.active().filter((j) => j.cid === net.cid);
          if (running.length > 0) {
            kept.push(
              `${net.name} (cid ${net.cid}): ${running.map((j) => j.id).join(", ")} still ` +
                "running; tell the user, and stop it with xdcc_cancel only if they ask",
            );
            continue;
          }
          if (net.status === "disconnected") continue;
          const outcome = await s.commands.send("disconnect", { cid: net.cid }, {
            timeoutMs: 15_000,
          });
          if (outcome.ok) {
            s.note(`disconnected from ${net.name} (cid ${net.cid})`);
            disconnected.push(`${net.name} (cid ${net.cid})`);
          } else {
            problems.push(`could not disconnect ${net.name}: ${outcome.error.hint}`);
          }
        }

        const windows = await closeAgentWindows(s);
        if ("code" in windows) return failure(windows);
        const closed = windows.closed;
        if (windows.leftOpen) problems.push(windows.leftOpen);

        const nothing = left.length + disconnected.length + closed.length === 0;
        return json({
          ok: problems.length === 0,
          done: nothing && kept.length === 0 && problems.length === 0
            ? "Nothing to clean up: the agent has no channels, connections or windows of its own."
            : "Cleaned up. The user's own channels and connections were not touched. Tell the " +
              "user what was done; nothing else needs calling.",
          left,
          disconnected,
          closed,
          kept,
          problems,
        });
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
    ({ session, network, cid, nick, confirm }: NickArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs, cid);
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
        s.note(`changed nick to ${confirmed} on ${net.name}`);
        return json({ ok: true, network: net.name, nick: confirmed });
      }),
  );

  // --- speaking ----------------------------------------------------------

  tool(
    "irc_send",
    {
      description:
        "Send a message (PRIVMSG), or a NOTICE with notice: true. `target` may be a channel " +
        "(#name) or a nick, so this covers both talking in a channel and messaging a bot. " +
        "Success means mIRC sent it; IRC does not acknowledge delivery, so a refusal (e.g. " +
        "401 no such nick) arrives later as a raw event.",
      inputSchema: sendSchema.shape,
    },
    ({ session, network, cid, target, text, notice }: SendArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(
          s,
          network,
          stateFreshnessMs,
          cid,
          isChannelBuffer(target) ? target : undefined,
        );
        if (isChannelBuffer(target)) {
          // Refused before sending, not warned about after: seen with two
          // models, a hand-typed search was never followed up, and a warning
          // on success did not stop them. xdcc_search collects the results.
          const search = /^([!@](?:search|find))\b/i.exec(text);
          if (search) {
            return failure(
              bridgeError(
                "guard_denied",
                `that is a search, and nothing was sent. Use xdcc_search {channel: "${target}", ` +
                  `network: "${net.name}", query, trigger: "${search[1]}"}: it joins the ` +
                  "channel, says the search, and collects the results, which come privately.",
              ),
            );
          }
          // Seen live: sent to a channel mIRC had not joined, it was refused by
          // the server (404) only after the tool had reported success.
          if (!s.state.isJoined(net, target)) {
            return failure(
              bridgeError(
                "not_on_channel",
                `mIRC is not in ${target} on ${net.name}, so nothing was sent: the server ` +
                  "would refuse it. Join it first with irc_join.",
              ),
            );
          }
        }
        const action = notice === true ? "notice" : "msg";
        const outcome = await s.commands.send(action, { cid: net.cid, target, text }, {
          context: "message",
        });
        if (outcome.ok) {
          s.note(
            notice === true
              ? `sent a notice to ${target} on ${net.name}: ${text}`
              : `said to ${target} on ${net.name}: ${text}`,
          );
        }
        // A bot command typed into a channel. Seen with a real agent: it sent
        // "!search debian" this way, then waited in the channel, while the
        // results came privately, as notices from the search bot.
        const botCommand = outcome.ok && isChannelBuffer(target) && /^[!@][a-z]/i.test(text);
        return fromOutcome(
          outcome,
          botCommand
            ? [
              bridgeError(
                "weak_match",
                "that looks like a bot command. Bots usually answer privately (a notice from " +
                  "the bot, under the bot's nick), not in the channel: wait with irc_wait_for " +
                  "{direct: true}. For a search, xdcc_search sends it and collects the results.",
              ),
            ]
            : [],
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
        "arrived, which avoids missing a reply that landed just before the call. A bot's reply " +
        "to a command usually comes privately, under the bot's nick, not in the channel: use " +
        "`direct: true` (and `nick`), not the channel as `buffer`.",
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
          signal: s.closed,
          matcher,
          since: cursor,
          timeoutMs: waitMs,
        });
        if (!event && s.closed.aborted) return linkDropped();
        if (!event) return json({ matched: false, waitedMs: waitMs, cursor: s.log.cursor });
        return json({ matched: true, event, cursor: s.log.cursor });
      }),
  );

  // --- DCC ---------------------------------------------------------------

  tool(
    "irc_dcc_status",
    {
      description:
        "XDCC/DCC jobs: requested, queued (with position), offered, downloading (with bytes " +
        "and rate), stalled, complete, refused or failed, with the bot's last reply. Pass " +
        "`job` for one. Jobs keep updating in the background, so this is how to check on a " +
        "slow bot or a long transfer. With wait: true it waits (at most 55 s) until the job " +
        "changes or the bot says something, then reports it; call again to keep waiting, " +
        "since transfers and busy bots can take far longer than one call may wait.",
      inputSchema: dccStatusSchema.shape,
    },
    ({ session, job, wait, timeoutMs }: DccStatusArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        if (wait === true) return await watchJob(s, job, timeoutMs);
        // Fresh numbers rather than up to one poll interval old.
        await s.pollTransfers();
        if (job !== undefined) {
          const found = s.dcc.get(job);
          if (!found) return failure(bridgeError("dcc_failed", `no DCC job named "${job}".`));
          const next = jobAdvice(found);
          return json({
            job: found,
            downloading: describeDownload(found) ?? null,
            progress: describeProgress(found) ?? null,
            ...(found.state === "requested" || found.state === "queued" ? botSaid(found) : {}),
            ...(next ? { next } : {}),
            mircAccepts: s.sreq ?? null,
          });
        }
        return json({
          jobs: s.dcc.list(),
          active: s.dcc.active().length,
          mircAccepts: s.sreq ?? null,
        });
      }),
  );

  tool(
    "xdcc_cancel",
    {
      description:
        "Stop an XDCC request or transfer, e.g. when the file is not what the user wanted. " +
        "Queued or waiting: asks the bot to drop it (XDCC REMOVE / XDCC CANCEL, as a person " +
        "would type). Transferring: also closes mIRC's download. Jobs the agent started need no " +
        "confirmation; a transfer the user started themselves needs confirm: true. Only when " +
        "the user asked, or the file is clearly not what they asked for.",
      inputSchema: xdccCancelSchema.shape,
    },
    ({ session, job, confirm, tellBot }: XdccCancelArgs) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const target = job !== undefined ? s.dcc.get(job) : s.dcc.active().at(-1);
        if (!target) {
          return failure(
            bridgeError(
              "dcc_failed",
              job !== undefined ? `no DCC job named "${job}".` : "there is no active DCC job.",
            ),
          );
        }
        if (!ACTIVE_DCC_STATES.has(target.state)) {
          return json({ skipped: true, reason: `already ${target.state}`, job: target });
        }
        const bot = target.requestedBy?.bot;
        if (!bot && confirm !== true) {
          return failure(
            bridgeError(
              "guard_denied",
              "that transfer was not started by the agent; it belongs to the user. Only stop " +
                "it if the user explicitly asked; then repeat the call with confirm: true.",
            ),
          );
        }
        const steps: string[] = [];
        const cid = target.cid;
        const wasState = target.state;
        // Record the cancel BEFORE acting, in the same synchronous step as the
        // state check above. Closing mIRC's download makes it report GETFAIL,
        // and live it did so 135 ms later, before even acknowledging the close;
        // marked first, that failure is recognised as this cancel. Nothing can
        // finish the job between the check and this line.
        s.dcc.cancel(target, "cancelled on request");
        if (bot && cid !== undefined && tellBot !== false) {
          // What a person types: REMOVE leaves the queue, CANCEL stops a send.
          const words = wasState === "queued" ? "XDCC REMOVE" : "XDCC CANCEL";
          const told = await s.commands.send("msg", { cid, target: bot, text: words }, {
            context: "message",
          });
          steps.push(told.ok ? `told ${bot}: ${words}` : `could not tell ${bot}`);
        }
        if (TRANSFER_DCC_STATES.has(wasState)) {
          // The transfer may already be running in mIRC; close its download.
          const nick = bot ?? target.sender;
          if (nick) {
            const closed = await s.commands.send("dccstop", { cid, nick });
            steps.push(closed.ok ? "closed mIRC's download" : "could not close mIRC's download");
          }
        }
        return json({ cancelled: true, steps, job: target });
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
        // The server says at once when there is no such nick (401); waiting for
        // the bot instead cost a real agent 20 s and a misleading "may be busy".
        const first = await waitForEvent({
          log: s.log,
          bus: s.bus,
          signal: s.closed,
          matcher: {
            cid: net.cid,
            test: (e) =>
              (e.kind === "raw" && numericOf(e) === 401 && isAbout(e, bot)) ||
              (e.kind !== "raw" && (e.nick ?? "").toLowerCase() === bot.toLowerCase() &&
                !isChannelBuffer(e.buf)),
          },
          since: cursor,
          timeoutMs: Math.max(0, deadline - Date.now()),
        });
        if (!first && s.closed.aborted) return linkDropped();
        if (first?.kind === "raw") {
          return failure(
            bridgeError(
              "nick_not_found",
              `there is no ${bot} on ${net.name}: the server says no such nick. Check the bot's ` +
                "name (bots often have prefixes like [XDCC] or a number), or it may be offline.",
            ),
          );
        }
        if (!first) {
          return failure(
            bridgeError(
              "bot_no_response",
              `${bot} has not replied yet. Busy bots can take minutes (one took nearly four in ` +
                "testing); a late reply still lands in irc_read and irc_wait_for with this " +
                `cursor: ${cursor}. It may also be offline or not an XDCC bot.`,
            ),
          );
        }
        // Many big bots refuse to list and point at a website instead.
        const verdict = classifyBotReply(first.text ?? "");
        if (verdict.kind === "denied") {
          return failure(
            bridgeError(
              "bot_refused",
              `${bot} does not give out its pack list (it said: "${verdict.text}"). Bots like ` +
                "this usually publish their packs on a website or announce them in the channel.",
              { detail: verdict.text },
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
            signal: s.closed,
            matcher,
            since: replies[replies.length - 1].seq,
            timeoutMs: Math.min(quietMs ?? 3000, remaining),
          });
          if (!next && s.closed.aborted) return linkDropped();
          if (!next) break;
          replies.push(next);
        }
        return json({ bot, replies, complete, cursor: s.log.cursor });
      }),
  );

  /**
   * The search said in `channel` that `cursor` belongs to: the last one said at
   * or before it, and for `query` when given. Two searches said with no event
   * between them share a cursor, and only the query tells them apart.
   */
  function searchAt(
    s: Session,
    cid: number,
    channel: string,
    cursor: number,
    query?: string,
  ): SearchSaid | undefined {
    return s.searches.findLast((x) =>
      x.cid === cid && x.channel.toLowerCase() === channel.toLowerCase() && x.cursor <= cursor &&
      (query === undefined || x.query.toLowerCase() === query.toLowerCase())
    ) ?? (query === undefined ? undefined : searchAt(s, cid, channel, cursor));
  }

  /**
   * Collect a search's replies, from `cursor` on: wait up to `waitMs` for the
   * first, then until nothing has come for `quietMs`. Replies that arrived
   * before the call are in the log already and are picked up first, which is
   * how xdcc_search_results finds results that came in between calls.
   *
   * Replies to another search said in the channel are set aside as
   * `elsewhere`: they neither count as this search's answer nor end the wait.
   * Seen live (Rizon, 2026-10-24): a slow search's answer, "Search for
   * NoSuchBot" then "No results were found.", landed while the next search
   * was collecting, and was reported as that search finding nothing. A line
   * that quotes a query goes with that search, and a bot's other lines go with
   * the last one it quoted, since a bot sends one search's answer as a block.
   * Until a bot has quoted one, its lines are this search's. With `query`
   * unknown (a daemon restart forgot the searches), nothing is set aside.
   */
  async function collectSearch(
    s: Session,
    cid: number,
    channel: string,
    query: string | undefined,
    cursor: number,
    waitMs: number,
    quietMs: number,
  ): Promise<{ replies: BridgeEvent[]; elsewhere: BridgeEvent[]; complete: boolean } | undefined> {
    const others = query === undefined ? [] : [
      ...new Set(
        s.searches
          .filter((x) =>
            x.cid === cid && x.channel.toLowerCase() === channel.toLowerCase() &&
            x.query.toLowerCase() !== query.toLowerCase()
          )
          .map((x) => x.query),
      ),
    ];
    // Search bots answer by private notice (seen live); a few answer in the
    // channel, so a channel line counts only when it is a result.
    const matcher: WaitMatcher = {
      cid,
      test: (e) =>
        (e.kind === "notice" || e.kind === "text") &&
        !SERVICES.has((e.nick ?? "").toLowerCase()) &&
        (!isChannelBuffer(e.buf) ||
          ((e.buf ?? "").toLowerCase() === channel.toLowerCase() &&
            parseSearchResult(e.text ?? "") !== undefined)),
    };
    const deadline = Date.now() + waitMs;
    const queries = query === undefined ? [] : [query, ...others];
    /** Per bot: whether the last query it quoted was another search's. */
    const answeringAnother = new Map<string, boolean>();
    const replies: BridgeEvent[] = [];
    const elsewhere: BridgeEvent[] = [];
    let since = cursor;
    let complete = true;
    while (replies.length + elsewhere.length < 300) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (replies.length > 0) complete = false;
        break;
      }
      const next = await waitForEvent({
        log: s.log,
        bus: s.bus,
        signal: s.closed,
        matcher,
        since,
        timeoutMs: replies.length === 0 ? remaining : Math.min(quietMs, remaining),
      });
      if (!next && s.closed.aborted) return undefined;
      if (!next) break;
      since = next.seq;
      const bot = (next.nick ?? "").toLowerCase();
      // Only headers and hints decide: a result's file name can contain any
      // word ("Linux.Mint" in a search for "mint" beside one for "linux").
      const quoted = parseSearchResult(next.text ?? "") === undefined
        ? quotedQuery(next.text ?? "", queries)
        : undefined;
      if (quoted !== undefined) {
        answeringAnother.set(bot, quoted.toLowerCase() !== query?.toLowerCase());
      }
      if (answeringAnother.get(bot) === true) elsewhere.push(next);
      else replies.push(next);
    }
    return { replies, elsewhere, complete };
  }

  // A bot tool joins the channel it is told to, and the join can land in the
  // wrong place. Seen with a small local model: asked to search a channel "on
  // Rizon", it named no network, the daemon used the only one connected, and the
  // join created an empty channel of that name there, where the search was then
  // said under the user's nick. A wrong channel is not always empty, though (the
  // user has joined ones with a few people in), so the real test is whether what
  // the tool came for is there: the bot, or a search trigger in the topic. When
  // it is not, a channel this call joined is left again, and the answer says
  // where it looked.

  /** Leave `channel` if this call's join put mIRC there; says so in @bridge. */
  async function leaveIfNew(
    s: Session,
    net: NetworkState,
    channel: string,
    joined: Record<string, unknown> | undefined,
    why: string,
  ): Promise<boolean> {
    if (joined?.already === true) return false;
    const left = await s.commands.send("part", { cid: net.cid, channel });
    if (left.ok) s.note(`left ${channel} on ${net.name} again: ${why}`);
    return left.ok;
  }

  /** Where the tool looked, and the way out when that was the wrong network. */
  function lookedOn(s: Session, net: NetworkState, channel: string, left: boolean): string {
    const all = s.state.networks().filter((n) => n.status === "connected").map((n) => n.name);
    return ` This was ${channel} on ${net.name}` + (left ? ", which was left again" : "") +
      `. mIRC is on ${all.join(", ")}. If the user named another network, irc_connect ` +
      "{network} to it first, then call again with that network; otherwise check the channel " +
      "name.";
  }

  /**
   * Wait out a services rename that is still to come on this connection, so a
   * bot command goes out under the nick its answer will be sent to. Seen live
   * (Rizon, 2026-10-23): connected under a registered nick, the agent searched
   * 15 s in, NickServ renamed the connection to a Guest nick 5 s later, and the
   * search bot, which answers minutes later and to the nick that asked, was
   * never heard from. A rename is pending when NickServ's last word on this
   * connection was "change within N seconds", with no rename since and no
   * "identified". Waits until N seconds after that warning, plus a margin.
   * Returns the rename, if one happened while waiting.
   */
  async function awaitRename(
    s: Session,
    cid: number,
  ): Promise<{ from: string; to: string } | undefined> {
    let due: number | undefined;
    for (const e of s.log.snapshot()) {
      if (e.cid !== cid) continue;
      if (e.kind === "selfnick") due = undefined;
      else if (e.kind === "notice" && (e.nick ?? "").toLowerCase() === "nickserv") {
        const text = plainText(e.text ?? "");
        const within = /within (\d+) seconds?/i.exec(text);
        if (within) due = e.ts + Number(within[1]) * 1000;
        else if (/identified|password accepted/i.test(text)) due = undefined;
      }
    }
    if (due === undefined) return undefined;
    const waitMs = due + RENAME_MARGIN_MS - Date.now();
    if (waitMs <= 0) return undefined;
    const event = await waitForEvent({
      log: s.log,
      bus: s.bus,
      signal: s.closed,
      matcher: { kind: "selfnick", cid },
      since: s.log.cursor,
      timeoutMs: waitMs,
    });
    if (!event) return undefined;
    const from = String(event.extra?.old ?? "");
    const to = String(event.extra?.new ?? "");
    s.note(`waited for services to rename ${from} to ${to} before asking a bot`);
    return { from, to };
  }

  /** What the agent should tell the user about a rename it waited for. */
  function renameNote(r: { from: string; to: string }): string {
    return `Services renamed this connection from ${r.from} to ${r.to} (the nick is ` +
      "registered and was not identified), so the request waited for that and went out as " +
      `${r.to}, the nick replies will come to. Tell the user.`;
  }

  /** Refuse a channel mIRC is alone in: nobody there can answer a bot command. */
  async function refuseEmpty(
    s: Session,
    net: NetworkState,
    channel: string,
    joined: Record<string, unknown> | undefined,
  ): Promise<BridgeError | undefined> {
    const members = typeof joined?.members === "number"
      ? joined.members
      : s.state.memberCount(net, channel);
    if (members === undefined || members > 1) return undefined;
    const left = await leaveIfNew(s, net, channel, joined, "nobody else was in it");
    return bridgeError(
      "empty_channel",
      `nobody else is in ${channel}` +
        (left ? ": it did not exist until the join created it" : "") + ", and nothing was sent." +
        lookedOn(s, net, channel, left),
    );
  }

  /** What a search turned up, for the agent: results, the total, and every other line. */
  function searchReport(
    channel: string,
    query: string | undefined,
    cursor: number,
    collected: { replies: BridgeEvent[]; elsewhere: BridgeEvent[]; complete: boolean },
    about: Record<string, unknown> = {},
  ): ToolResult {
    const { replies, elsewhere, complete } = collected;
    const other = elsewhere.length === 0 ? {} : {
      fromAnotherSearch: elsewhere.slice(0, 20).map((e) => e.nick + ": " + plainText(e.text ?? "")),
      aboutThat: "fromAnotherSearch answers a different search said in this channel, not this " +
        "one. If that search still matters to the user, tell them what it says.",
    };
    if (replies.length === 0) {
      return json({
        ...about,
        channel,
        pending: true,
        cursor,
        results: [],
        ...other,
        // Seen with a small local model: told to call back "in a minute or so",
        // it ended its turn promising to check, and never did. The bot answered
        // 4.6 minutes after the search, into a cursor nobody collected.
        next: "No answer yet; search bots queue searches, and one took almost 5 minutes. Call " +
          "xdcc_search_results {cursor: " + cursor + ", channel: " + JSON.stringify(channel) +
          (query === undefined ? "" : ", query: " + JSON.stringify(query)) +
          "} now: it waits up to ~50 s by itself. Each time it comes back pending, call it " +
          "again with the same cursor, for up to about 8 minutes, before telling the user " +
          "nothing came back. Do not end your turn to check later: nothing is collected until " +
          "you call. Do NOT search again, which only queues another search.",
      });
    }
    const results = replies
      .map((e) => parseSearchResult(e.text ?? ""))
      .filter((r) => r !== undefined);
    const total = replies.map((e) => searchTotal(e.text ?? "")).find((t) => t !== undefined);
    // Everything that is not a result, word for word: the "Search for ..."
    // header, "no results", hints like "!request", in whatever language.
    const said = replies
      .filter((e) => parseSearchResult(e.text ?? "") === undefined)
      .map((e) => (e.nick + ": " + plainText(e.text ?? "")))
      .slice(0, 20);
    return json({
      ...about,
      channel,
      results,
      shown: results.length,
      ...(total !== undefined ? { total } : {}),
      said,
      ...other,
      complete,
      // From here on: replies from a later search, or the rest of this one.
      cursor: Math.max(replies[replies.length - 1].seq, ...elsewhere.map((e) => e.seq)),
      next: results.length > 0
        ? "Pick the result that matches what the user wants (check the name and size), tell " +
          "the user which it is, then xdcc_fetch {bot, pack} in the channel where that bot is, " +
          "usually the bot channel whose topic named this one. xdcc_fetch says if the bot is " +
          "not there." +
          (total !== undefined && total > results.length
            ? " Only " + results.length + " of " + total + " are shown: add words to narrow it."
            : "")
        : "No result lines were recognised. Read `said`: it may say there are no results (and " +
          "how to request the file), or use a format the daemon does not know.",
    });
  }

  tool(
    "xdcc_search",
    {
      description:
        "Search a channel for files, with its search command (!search, @find, ...): use this, " +
        "not irc_send, for any search in a channel, since the results come back privately " +
        "and this collects them. For example when a pack number from a website turns out to be " +
        "the wrong file. It says the search " +
        "in the channel, visibly and under the user's nick, so use it only when the user wants " +
        "something found. Joins the channel if needed and takes the trigger from its topic " +
        "unless given. Search bots can take minutes to answer; if nothing has come back in " +
        "time, it returns a cursor for xdcc_search_results instead. Results are bot, pack, " +
        "name and size; pick the one that matches and xdcc_fetch it in the bot's channel.",
      inputSchema: xdccSearchSchema.shape,
    },
    ({ session, network, cid, channel, query, trigger, timeoutMs, quietMs }: XdccSearchArgs) =>
      guarded(async () => {
        const started = Date.now();
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs, cid, channel);
        // Joined or not, the reply carries the topic, which lists the triggers.
        const joined = await s.commands.send("join", { cid: net.cid, channel }, {
          context: "join",
        });
        if (!joined.ok) return failure(explainJoinRefusal(joined.error, net));
        if (joined.data?.already !== true) {
          s.owned.joinedChannel(net.cid, channel);
          s.note("joined " + channel + " on " + net.name + " to search it");
        }
        const empty = await refuseEmpty(s, net, channel, joined.data);
        if (empty) return failure(empty);
        const topic = typeof joined.data?.topic === "string" ? joined.data.topic : "";

        const triggers = triggersIn(topic);
        const command = trigger ?? searchTrigger(triggers);
        if (!command) {
          // A topic that lists triggers is the right channel with an unfamiliar
          // one; a topic with none may well be the wrong channel or network.
          if (triggers.length > 0) {
            return failure(
              bridgeError(
                "unknown_trigger",
                "could not tell " + channel + "'s search command from its topic (it lists " +
                  triggers.join(", ") + '). Topic: "' + plainText(topic) + '". Pass trigger, ' +
                  'e.g. "!search" or "@find", or ask the user which one the channel uses.',
              ),
            );
          }
          const left = await leaveIfNew(s, net, channel, joined.data, "its topic names no search");
          return failure(
            bridgeError(
              "unknown_trigger",
              channel + "'s topic names no search command, and nothing was sent. Topic: \"" +
                plainText(topic) + '".' + lookedOn(s, net, channel, left) + " Only if this " +
                'is the right channel, pass trigger (e.g. "!search"), or ask the user which one ' +
                "it uses.",
            ),
          );
        }

        // Just joined: let the channel settle first. What arrives meanwhile
        // (greetings sent on join) falls before the cursor, so it is not
        // mistaken for the answer.
        const settle = joined.data?.already === true ? 0 : searchSettleMs;
        if (settle > 0) {
          await new Promise((resolve) => setTimeout(resolve, settle));
          if (s.closed.aborted) return linkDropped();
        }
        const renamed = await awaitRename(s, net.cid);
        if (s.closed.aborted) return linkDropped();

        const cursor = s.log.cursor;
        const said = command + " " + query;
        const sent = await s.commands.send(
          "msg",
          { cid: net.cid, target: channel, text: said },
          { context: "message" },
        );
        if (!sent.ok) return failure(sent.error);
        s.note("searched in " + channel + ": " + said);
        s.searches.push({ cid: net.cid, channel, query, cursor });
        if (s.searches.length > 50) s.searches.shift();

        // The pause and any rename wait come out of the call's own budget.
        const collected = await collectSearch(
          s,
          net.cid,
          channel,
          query,
          cursor,
          Math.max(1000, (timeoutMs ?? 50_000) - (Date.now() - started)),
          quietMs ?? 3000,
        );
        if (!collected) return linkDropped();
        return searchReport(channel, query, cursor, collected, {
          query,
          trigger: command,
          ...(renamed ? { renamed: renameNote(renamed) } : {}),
        });
      }),
  );

  tool(
    "xdcc_search_results",
    {
      description:
        "Collect the results of an earlier xdcc_search, from the cursor it returned. Sends " +
        "nothing: use this rather than searching again when a search bot is slow. Waits up to " +
        "~50 s for replies that have not come yet; call it again while it says pending. " +
        "Replies are kept, so nothing is lost by a late call.",
      inputSchema: xdccSearchResultsSchema.shape,
    },
    (
      { session, network, cid, channel, cursor, query, timeoutMs, quietMs }: XdccSearchResultsArgs,
    ) =>
      guarded(async () => {
        const s = sessionOf(registry, session);
        const net = await targetOf(s, network, stateFreshnessMs, cid, channel);
        const searched = searchAt(s, net.cid, channel, cursor, query)?.query;
        const collected = await collectSearch(
          s,
          net.cid,
          channel,
          searched,
          cursor,
          timeoutMs ?? 50_000,
          quietMs ?? 3000,
        );
        if (!collected) return linkDropped();
        return searchReport(channel, searched, cursor, collected);
      }),
  );

  tool(
    "xdcc_fetch",
    {
      description:
        "Request a pack from an XDCC bot. mIRC must be on the network (irc_connect); that is " +
        "the only step needed first, since this joins the channel itself. It checks the " +
        "channel's topic (if it names other channels mIRC is not in, nothing is requested " +
        "until they are joined: join_required), confirms the bot is present, sends the " +
        "request, then waits (up to ~50 s) for the bot to answer. Returns a job: queued (with position), offered (transfer starting), " +
        "refused (with the bot's reason), or still waiting. The job keeps updating afterwards; " +
        "follow it with irc_dcc_status {wait: true}.",
      inputSchema: xdccFetchSchema.shape,
    },
    (
      { session, network, channel, bot, pack, timeoutMs, notifyOnFailure, topicRead }:
        XdccFetchArgs,
    ) =>
      guarded(async () => {
        const started = Date.now();
        const s = sessionOf(registry, session);
        const steps: string[] = [];
        const waitMs = timeoutMs ?? 50_000;

        const fail = async (error: BridgeError): Promise<ToolResult> => {
          if (notifyOnFailure !== false) {
            await s.commands.send("echo", { text: `mirc-daemon: ${error.code} — ${error.hint}` });
          }
          return failure(error);
        };

        // 1. connected?
        const net = await targetOf(s, network, stateFreshnessMs, undefined, channel);
        if (net.status !== "connected") {
          return await fail(
            bridgeError(
              "connect_failed",
              `mIRC is not connected to "${net.name}". Connect it first, or use ` +
                "irc_connect.",
            ),
          );
        }
        steps.push("connected");

        // mIRC set to ignore DCC sends means no transfer can ever start: say so
        // now rather than after a request the bot will dutifully queue.
        if (s.sreq === "ignore") {
          return await fail(bridgeError("dcc_failed", acceptance(s)));
        }

        // Already asked and still going: a second request only gets "already
        // requested" back, and its job would wait forever. An ended job is
        // different: asking again is how a broken transfer is resumed.
        const existing = s.dcc.activeRequest(net.cid, bot, pack);
        if (existing) {
          const downloading = describeDownload(existing);
          return json({
            skipped: true,
            reason: `pack ${pack} was already requested from ${bot}; this is that job`,
            job: existing,
            ...(downloading ? { downloading } : {}),
            progress: describeProgress(existing) ?? null,
            next: jobAdvice(existing) ??
              "Nothing was sent to the bot. Follow the existing job with irc_dcc_status {wait: true}.",
          });
        }

        // 2. joined? Asked of mIRC even when the state says so: in a channel
        //    already, it answers at once from its own records (no server
        //    traffic), and either way the answer carries the topic.
        const joined = await s.commands.send("join", { cid: net.cid, channel }, {
          context: "join",
        });
        if (!joined.ok) return await fail(explainJoinRefusal(joined.error, net));
        if (joined.data?.already !== true) {
          s.owned.joinedChannel(net.cid, channel);
          s.note(`joined ${channel} on ${net.name} to ask ${bot} for a pack`);
          steps.push("joined");
        } else {
          steps.push("already joined");
        }
        const empty = await refuseEmpty(s, net, channel, joined.data);
        if (empty) return await fail(empty);

        // The topic's conditions come before the request. Many XDCC channels ban
        // anyone who downloads without also joining the channels their topic
        // names, and a ban lands on the user, so the request waits until those
        // channels are joined, or the agent has read the topic and judged a
        // mention irrelevant.
        const topic = typeof joined.data?.topic === "string" ? joined.data.topic : "";
        const missing = channelsIn(topic).filter((c) =>
          c.toLowerCase() !== channel.toLowerCase() && !s.state.isJoined(net, c)
        );
        // topicRead counts only once this tool has shown the agent the topic.
        // Seen with a small local model: it set every optional flag on its first
        // call, topicRead: true included, and skipped a channel it was never
        // told about.
        const topicKey = `${net.cid} ${channel.toLowerCase()}`;
        if (missing.length > 0 && (topicRead !== true || !s.topicsShown.has(topicKey))) {
          s.topicsShown.add(topicKey);
          return failure(
            bridgeError(
              "join_required",
              `nothing was requested yet. ${channel}'s topic names ` +
                `${missing.join(", ")}, which mIRC is not in. Many XDCC channels ban anyone ` +
                "who downloads without joining the channels their topic names. Read the topic: " +
                `"${plainText(topic)}". If it asks for that, join each with irc_join ` +
                "(no need to ask the user, but tell them which channels you joined and why), " +
                "then call xdcc_fetch again. If a channel is only mentioned (a help channel, an " +
                "announcement), call again with topicRead: true.",
            ),
          );
        }
        if (missing.length > 0) steps.push(`topic read; not joining ${missing.join(", ")}`);

        // 3. is the bot actually here? Failing now beats waiting for a timeout.
        // Ask about the one nick rather than fetching the list: XDCC channels run to
        // thousands of users, far past what one frame can carry.
        const members = await s.commands.send("members", { cid: net.cid, channel, nick: bot });
        if (members.ok && typeof members.data?.present === "boolean") {
          if (!members.data.present) {
            const left = await leaveIfNew(s, net, channel, joined.data, `${bot} is not in it`);
            return await fail(
              bridgeError(
                "bot_not_in_channel",
                `${bot} is not in ${channel}, and nothing was sent to it. Check the bot name, ` +
                  "or it may be offline." + lookedOn(s, net, channel, left),
              ),
            );
          }
          steps.push("bot present");
        }

        // 4. open the job *before* sending, so an instant reply already has a job
        //    to land on. From here the job follows the bot on its own.
        // A bot answers, and offers the file, to the nick that asked: wait out a
        // services rename first, or both go to a nick that no longer exists.
        const renamed = await awaitRename(s, net.cid);
        if (s.closed.aborted) return linkDropped();
        if (renamed) steps.push(`waited for services to rename ${renamed.from} to ${renamed.to}`);

        const job = s.dcc.start({ cid: net.cid, net: net.name, bot, pack });

        const sent = await s.commands.send(
          "msg",
          { cid: net.cid, target: bot, text: `xdcc send #${pack.replace(/^#/, "")}` },
          { context: "message" },
        );
        if (!sent.ok) return await fail(sent.error);
        s.note(`asked ${bot} on ${net.name} for pack #${pack.replace(/^#/, "")}`);
        steps.push("requested");

        // 5. wait, briefly, for the bot to answer or the offer to arrive. Any
        //    rename wait came out of the same budget, to stay inside the client's.
        const deadline = Math.max(started + waitMs, Date.now() + 1000);
        await waitForJob(
          s,
          job,
          (j) => j.state !== "requested" || j.lastReply !== undefined,
          deadline - Date.now(),
        );
        if (s.closed.aborted) return linkDropped();
        // Bots announce before they offer, and the offer is what names the file.
        // Seen live: an Italian "sending you" line the classifier could not read
        // ended the wait 300 ms before the offer, every time.
        if (job.state === "requested") {
          await waitForJob(
            s,
            job,
            (j) => j.state !== "requested",
            Math.min(offerGraceMs, Math.max(0, deadline - Date.now())),
          );
          if (s.closed.aborted) return linkDropped();
        }
        // When mIRC already has the file it asks to resume, and the bot's ACCEPT
        // follows the offer by about a second (0.6–1 s live). Waiting that long
        // lets the answer say "resume", or "you already have it" when the
        // re-check finishes at once, instead of "starting".
        if (job.state === "offered") {
          await waitForJob(
            s,
            job,
            (j) => j.resumedFrom !== undefined || j.state !== "offered",
            Math.min(resumeGraceMs, Math.max(0, deadline - Date.now())),
          );
          // A re-check of a complete file ends within about a second; wait for it.
          if (alreadyHad(job) && job.state === "offered") {
            await waitForJob(s, job, (j) => j.state !== "offered", resumeGraceMs);
          }
          if (s.closed.aborted) return linkDropped();
        }

        if (job.state === "refused") {
          const verdict = classifyBotReply(job.detail ?? "");
          const why = verdict.kind === "invalid_pack"
            ? "there is no such pack: check the number against the bot's announcements."
            : verdict.kind === "pending"
            ? "a transfer or queue slot from this bot is already pending: let it finish, or " +
              "check irc_dcc_status."
            : verdict.kind === "busy"
            ? "the bot is at its limit right now; try again later."
            : "the bot declined.";
          return await fail(
            bridgeError("bot_refused", `${bot} refused pack ${pack}: ${why}`, {
              detail: job.detail,
            }),
          );
        }

        const next = alreadyHad(job)
          ? "mIRC already had this whole file, so it only re-checked the end; nothing new is " +
            "being downloaded. Tell the user they already have it."
          : job.state === "offered"
          ? `The transfer is starting${
            job.resumedFrom !== undefined ? " as a resume of the file mIRC already has" : ""
          }: ${acceptance(s)} Follow it with irc_dcc_status {wait: true}.`
          : job.state === "complete"
          ? "The transfer has already finished."
          : job.state === "failed"
          ? "The transfer failed at once; see detail. Asking again resumes from what is saved."
          : job.state === "queued"
          ? `Queued${job.position ? ` at position ${job.position}` : ""}: the bot will send ` +
            "when your turn comes, which can take a long time. Follow it with irc_dcc_status {wait: true}."
          : job.lastReply
          ? "The bot answered but has not offered the file yet; see botSaid. The job keeps " +
            "listening."
          : `No answer from ${bot} yet. Busy bots can take minutes; the job keeps listening, ` +
            "so check back with irc_dcc_status {wait: true} rather than asking again.";
        const downloading = describeDownload(job);
        return json({
          ...(downloading
            ? {
              downloading,
              tellTheUser: `Tell the user ${downloading} is what ${bot} is sending, so they can ` +
                "confirm it is what they wanted. Pack numbers from websites go stale; if this is " +
                `the wrong file, stop it with xdcc_cancel {job: "${job.id}"}.`,
            }
            : {}),
          job,
          steps,
          // Only while the bot's words are all there is to go on.
          ...(job.state === "requested" || job.state === "queued" ? botSaid(job) : {}),
          mircAccepts: s.sreq ?? null,
          next,
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
    ({ session, network, cid, line }: RawArgs) =>
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
        const net = await targetOf(s, network, stateFreshnessMs, cid);
        const outcome = await s.commands.send("raw", { cid: net.cid, line });
        if (outcome.ok) s.note(`sent a raw line on ${net.name}: ${line}`);
        return fromOutcome(outcome);
      }),
  );
}
