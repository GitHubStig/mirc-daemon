/**
 * XDCC jobs, followed from the request to the end of the transfer.
 *
 * A job is opened when the agent asks a bot for a pack, and then moves on the
 * strength of what happens next, whether or not a tool call is waiting:
 *
 *   requested → (queued) → offered → downloading ⇄ stalled → complete
 *                                  ↘ refused / failed
 *
 *  - The bot's reply, a notice or private message, is read for its meaning
 *    (xdcc.ts): queued with a position, denied, no such pack, already pending,
 *    busy.
 *  - The bot's `DCC SEND` offer (a CTCP) means the transfer is starting, and
 *    says the file name and size. A `DCC ACCEPT` after it means mIRC is
 *    resuming a file it already has, and says from where.
 *  - mIRC's open downloads, polled with `gets` while a transfer runs, move it
 *    to downloading and carry the byte count. No growth for a minute is
 *    "stalled": mIRC raises no event for a transfer that hangs without the
 *    connection breaking, so this is the only way an agent hears of one.
 *  - mIRC's `on FILERCVD` / `on GETFAIL` end it.
 *
 * This runs in the background because bots can be slow. In the live test,
 * AxA-MP1 answered after almost four minutes, far past what any tool call can
 * wait: MCP clients give up after about 60 s. The tools wait briefly and then
 * report the job; later replies still land on it.
 */

import {
  ACTIVE_DCC_STATES,
  type BridgeEvent,
  type DccGet,
  type DccJob,
  type DccState,
  sameNetwork,
  TRANSFER_DCC_STATES,
} from "./types.ts";
import { classifyBotReply, parseDccAccept, parseDccOffer } from "./xdcc.ts";
import { isChannelBuffer } from "./waits.ts";

export interface DccRequest {
  cid?: number;
  net: string;
  bot: string;
  pack?: string;
}

const MAX_REMEMBERED = 100;

/** No new bytes for this long and an open download counts as stalled. */
export const STALL_AFTER_MS = 60_000;

/**
 * How long after a failure a fresh offer of the same file from the same bot
 * continues that job. Seen live: after mIRC's connect to the bot timed out, the
 * bot offered the file again by itself, and that became a job nobody asked for.
 */
const REOFFER_WINDOW_MS = 120_000;

export class DccTracker {
  #jobs: DccJob[] = [];
  #seq = 0;
  #listeners = new Set<(job: DccJob) => void>();
  #stallAfterMs: number;

  constructor(options: { stallAfterMs?: number } = {}) {
    this.#stallAfterMs = options.stallAfterMs ?? STALL_AFTER_MS;
  }

  /**
   * Hear about every job change, whether an event or a progress poll caused
   * it. Polls arrive outside the event stream, so waiting on events alone
   * would miss a job going to downloading or stalled.
   */
  onChange(listener: (job: DccJob) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(job: DccJob | undefined): DccJob | undefined {
    if (job) { for (const listener of [...this.#listeners]) listener(job); }
    return job;
  }

  /** Open a job for a pack we are about to request. */
  start(request: DccRequest): DccJob {
    this.#seq += 1;
    const now = Date.now();
    const job: DccJob = {
      id: `dcc${this.#seq}`,
      cid: request.cid,
      net: request.net,
      state: "requested",
      startedTs: now,
      updatedTs: now,
      requestedBy: { bot: request.bot, pack: request.pack },
    };
    this.#remember(job);
    return job;
  }

  /**
   * Fold an event into the jobs. Returns the job it changed, if any, so a
   * caller waiting on a job can tell its event apart from the noise.
   */
  applyEvent(event: BridgeEvent): DccJob | undefined {
    switch (event.kind) {
      case "ctcp":
        return this.#changed(this.#onOffer(event) ?? this.#onAccept(event));
      case "notice":
      case "text":
        return this.#changed(this.#onReply(event));
      case "dcc":
        return this.#changed(this.#onOutcome(event));
      default:
        return undefined;
    }
  }

  /** A `DCC SEND` from a bot we asked: the transfer is starting. */
  #onOffer(event: BridgeEvent): DccJob | undefined {
    const offer = parseDccOffer(
      typeof event.extra?.ctcp === "string" ? event.extra.ctcp : undefined,
      typeof event.extra?.text === "string" ? event.extra.text : undefined,
    );
    if (!offer) return undefined;
    // An offer nobody asked for still becomes a job, so it is visible.
    const job = this.#activeFrom(event.cid, event.nick) ??
      this.#recentlyFailed(event.cid, event.nick, offer.file) ??
      this.#open(event, offer.file);
    if (!isActive(job)) {
      // The bot trying again after a failed connect: the same request, going on.
      delete job.endedTs;
      delete job.secs;
      delete job.detail;
    }
    job.file = offer.file;
    if (offer.size !== undefined) job.size = offer.size;
    delete job.resumedFrom;
    delete job.rcvd;
    delete job.cps;
    delete job.progressTs;
    this.#move(job, "offered");
    return job;
  }

  /** The bot agreeing to mIRC's `DCC RESUME`: this transfer continues a file. */
  #onAccept(event: BridgeEvent): DccJob | undefined {
    const accept = parseDccAccept(
      typeof event.extra?.ctcp === "string" ? event.extra.ctcp : undefined,
      typeof event.extra?.text === "string" ? event.extra.text : undefined,
    );
    if (!accept) return undefined;
    const job = this.#activeFrom(event.cid, event.nick);
    if (!job || job.state !== "offered") return undefined;
    job.resumedFrom = accept.position;
    job.updatedTs = Date.now();
    return job;
  }

  /**
   * What the bot said back, addressed to us. Channel chatter is ignored.
   *
   * Every reply is kept, word for word, with whether it was understood. Bots
   * answer in whatever language their operator chose, and no pattern list
   * covers them all; the agent reading the words can. So a reply moves the job
   * only when it is recognised, and is otherwise passed on for the agent to
   * read, rather than guessed at.
   */
  #onReply(event: BridgeEvent): DccJob | undefined {
    if (isChannelBuffer(event.buf) || !event.text) return undefined;
    const job = this.#activeFrom(event.cid, event.nick);
    if (!job) return undefined;

    const reply = classifyBotReply(event.text);
    job.lastReply = reply.text;
    job.lastReplyKind = reply.kind;
    job.lastReplyTs = Date.now();
    // Once the transfer is under way, the protocol says how it is going: the
    // bot's words are kept for the agent, but no longer move the job.
    if (TRANSFER_DCC_STATES.has(job.state)) return job;

    switch (reply.kind) {
      case "queued":
        job.position = reply.position;
        this.#move(job, "queued");
        break;
      case "sending":
        // The offer itself follows as a CTCP; the name is useful already.
        if (reply.file) job.file = reply.file;
        job.updatedTs = Date.now();
        break;
      case "denied":
      case "invalid_pack":
      case "pending":
      case "busy":
        job.detail = reply.text;
        this.#move(job, "refused");
        job.endedTs = Date.now();
        break;
      case "unknown":
        job.updatedTs = Date.now();
        break;
    }
    return job;
  }

  /**
   * mIRC's verdict on a transfer. Matched to the job by who sent it, rather
   * than to whichever job is oldest, because the agent may have several bots
   * going at once. A transfer nobody requested still becomes a job.
   */
  #onOutcome(event: BridgeEvent): DccJob | undefined {
    const state = outcomeState(event);
    if (!state) return undefined;
    const from = typeof event.extra?.from === "string" ? event.extra.from : undefined;
    // mIRC's $filename here is the full saved path (seen live:
    // D:\Downloads\<nick>\dcc-test.txt). The name is what identifies the file.
    const savedAs = typeof event.extra?.file === "string" && event.extra.file.length > 0
      ? event.extra.file
      : undefined;
    const file = savedAs === undefined ? undefined : baseName(savedAs);

    // Closing the download window to cancel makes mIRC report a failure; that
    // belongs to the job just cancelled, not to a new one.
    const cancelled = this.#recentlyCancelled(from, file);
    if (cancelled) {
      if (savedAs) cancelled.savedAs = savedAs;
      return cancelled;
    }

    const job = this.#activeFrom(event.cid, from) ??
      this.#activeFrom(undefined, from) ??
      (file ? this.#jobs.find((j) => isActive(j) && j.file === file) : undefined) ??
      this.#jobs.find((j) => isActive(j) && sameNetwork(j.net, event.net)) ??
      this.#open(event, file ?? "(unknown)");

    this.#move(job, state);
    job.endedTs = Date.now();
    if (file) job.file = file;
    if (savedAs) job.savedAs = savedAs;
    const size = event.extra?.size;
    if (typeof size === "number") job.size = size;
    // The last poll is up to 15 s old; a finished file is all there.
    if (state === "complete" && job.rcvd !== undefined && job.size !== undefined) {
      job.rcvd = job.size;
    }
    const reason = event.extra?.reason;
    if (typeof reason === "string" && reason.length > 0) job.detail = reason;
    // mIRC knows the real duration; only fall back to wall-clock if it did not say.
    const secs = event.extra?.secs;
    job.secs = typeof secs === "number"
      ? secs
      : Math.max(0, Math.round((job.endedTs - job.startedTs) / 1000));
    return job;
  }

  /**
   * Mark a job cancelled. The caller has already told the bot and closed the
   * transfer; this records it, so the failure mIRC reports for the closed
   * window lands here rather than on another job.
   */
  cancel(job: DccJob, detail: string): void {
    this.#move(job, "cancelled");
    job.endedTs = Date.now();
    job.detail = detail;
    this.#changed(job);
  }

  /**
   * Fold in mIRC's open downloads (`gets`). A job whose download has gained
   * bytes is downloading; one that has gained none for the stall window is
   * stalled. Returns the jobs whose state changed.
   */
  applyProgress(gets: readonly DccGet[], now = Date.now()): DccJob[] {
    const changed: DccJob[] = [];
    for (const job of this.transferring()) {
      const get = this.#getFor(job, gets);
      if (!get) continue;
      if (get.size > 0 && job.size === undefined) job.size = get.size;
      job.cps = get.cps;
      const grew = job.rcvd === undefined ? get.rcvd > (job.resumedFrom ?? 0) : get.rcvd > job.rcvd;
      job.rcvd = get.rcvd;
      job.progressTs ??= now;
      const before = job.state;
      if (grew) {
        job.progressTs = now;
        if (job.state !== "downloading") this.#move(job, "downloading");
      } else if (now - job.progressTs >= this.#stallAfterMs && job.state !== "stalled") {
        this.#move(job, "stalled");
      }
      if (job.state !== before) changed.push(job);
    }
    for (const job of changed) this.#changed(job);
    return changed;
  }

  /**
   * The download mIRC has open for a job: same sender and file. mIRC keeps a
   * finished get's window, so a live one is preferred over a done one.
   */
  #getFor(job: DccJob, gets: readonly DccGet[]): DccGet | undefined {
    const sender = job.requestedBy?.bot ?? job.sender;
    if (!sender) return undefined;
    // bridge.mrc sends $nopath of the file; baseName again in case a path slips through.
    // An empty nick (an older script read $get().nick, which mIRC leaves empty)
    // falls back to the file name alone.
    const mine = gets.filter((g) =>
      (g.nick === "" || sameNick(sender, g.nick)) &&
      (job.file === undefined ? g.nick !== "" : baseName(g.file) === job.file)
    );
    return mine.findLast((g) => !g.done) ?? mine.at(-1);
  }

  /** Jobs whose transfer mIRC has, or should have, open. */
  transferring(): DccJob[] {
    return this.#jobs.filter((j) => TRANSFER_DCC_STATES.has(j.state));
  }

  /**
   * An active job for this bot and pack on this connection. Asking a bot again
   * for a pack it is already handling is nearly always a mistake: the bot
   * answers "already requested" (in its own language), and the second job
   * would sit waiting forever and catch the first one's outcome.
   */
  activeRequest(cid: number | undefined, bot: string, pack: string): DccJob | undefined {
    const wanted = normalisePack(pack);
    return this.#jobs.find((j) =>
      isActive(j) &&
      (cid === undefined || j.cid === undefined || j.cid === cid) &&
      sameNick(j.requestedBy?.bot, bot) &&
      j.requestedBy?.pack !== undefined && normalisePack(j.requestedBy.pack) === wanted
    );
  }

  /** A job from `nick` for `file` that failed moments ago, for a bot's re-offer. */
  #recentlyFailed(
    cid: number | undefined,
    nick: string | undefined,
    file: string,
  ): DccJob | undefined {
    if (!nick) return undefined;
    const cutoff = Date.now() - REOFFER_WINDOW_MS;
    for (let i = this.#jobs.length - 1; i >= 0; i--) {
      const job = this.#jobs[i];
      if (job.state !== "failed" || (job.endedTs ?? 0) < cutoff) continue;
      if (cid !== undefined && job.cid !== undefined && job.cid !== cid) continue;
      if (sameNick(job.requestedBy?.bot ?? job.sender, nick) && job.file === file) return job;
    }
    return undefined;
  }

  /** A job cancelled in the last minute whose late outcome this could be. */
  #recentlyCancelled(from: string | undefined, file: string | undefined): DccJob | undefined {
    const cutoff = Date.now() - 60_000;
    for (let i = this.#jobs.length - 1; i >= 0; i--) {
      const job = this.#jobs[i];
      if (job.state !== "cancelled" || (job.endedTs ?? 0) < cutoff) continue;
      const sameSender = from !== undefined && sameNick(job.requestedBy?.bot, from);
      const sameFile = file !== undefined && job.file === file;
      if (sameSender || sameFile) return job;
    }
    return undefined;
  }

  /** The newest active job requested from `nick`, on `cid` when given. */
  #activeFrom(cid: number | undefined, nick: string | undefined): DccJob | undefined {
    if (!nick) return undefined;
    for (let i = this.#jobs.length - 1; i >= 0; i--) {
      const job = this.#jobs[i];
      if (!isActive(job)) continue;
      if (cid !== undefined && job.cid !== undefined && job.cid !== cid) continue;
      if (sameNick(job.requestedBy?.bot, nick)) return job;
    }
    return undefined;
  }

  #open(event: BridgeEvent, file: string): DccJob {
    this.#seq += 1;
    const job: DccJob = {
      id: `dcc${this.#seq}`,
      cid: event.cid,
      net: event.net,
      file,
      state: "requested",
      startedTs: event.ts,
      updatedTs: event.ts,
    };
    const sender = event.nick ??
      (typeof event.extra?.from === "string" ? event.extra.from : undefined);
    if (sender) job.sender = sender;
    this.#remember(job);
    return job;
  }

  #move(job: DccJob, state: DccState): void {
    job.state = state;
    job.updatedTs = Date.now();
    if (state !== "queued") delete job.position;
  }

  #remember(job: DccJob): void {
    if (!this.#jobs.includes(job)) this.#jobs.push(job);
    if (this.#jobs.length > MAX_REMEMBERED) {
      this.#jobs.splice(0, this.#jobs.length - MAX_REMEMBERED);
    }
  }

  list(): DccJob[] {
    return [...this.#jobs];
  }

  get(id: string): DccJob | undefined {
    return this.#jobs.find((j) => j.id === id);
  }

  active(): DccJob[] {
    return this.#jobs.filter(isActive);
  }

  recentFailures(): DccJob[] {
    return this.#jobs.filter((j) => j.state === "failed" || j.state === "refused");
  }

  /** The most recently opened job, which is what a caller usually wants to hear about. */
  latest(): DccJob | undefined {
    return this.#jobs.at(-1);
  }
}

/** The last path component, for either separator. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** "1.2 GB", for telling a person what is being downloaded. */
export function humanSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * One line naming what a job is downloading, for the agent to show the user.
 * The pack number came from somewhere (often a website) that may be out of
 * date, so the file the bot actually offers is what the user should confirm.
 */
export function describeDownload(job: DccJob): string | undefined {
  if (!job.file) return undefined;
  const size = humanSize(job.size);
  const pack = job.requestedBy?.pack ? `pack #${job.requestedBy.pack.replace(/^#/, "")} is ` : "";
  return `${pack}"${job.file}"${size ? ` (${size})` : ""}`;
}

/**
 * How far along a transfer is, for the agent to relay: bytes, percentage and
 * rate, and whether it is a resume. Undefined until there is something to say.
 */
export function describeProgress(job: DccJob): string | undefined {
  const parts: string[] = [];
  if (job.rcvd !== undefined) {
    const of = job.size ? ` of ${humanSize(job.size)}` : "";
    const pct = job.size ? ` (${Math.floor((job.rcvd / job.size) * 100)}%)` : "";
    parts.push(`${humanSize(job.rcvd)}${of}${pct}`);
    if (job.cps !== undefined && job.state === "downloading") parts.push(`${humanSize(job.cps)}/s`);
  }
  if (job.resumedFrom !== undefined) {
    parts.push(
      alreadyHad(job)
        ? "mIRC already had the whole file and only re-checked its end"
        : `resumed from ${humanSize(job.resumedFrom)}`,
    );
  }
  if (job.state === "stalled" && job.progressTs !== undefined) {
    const secs = Math.round((Date.now() - job.progressTs) / 1000);
    parts.push(`no data for ${secs} s`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * A resume from the last few KB: mIRC had the file already, so asking again
 * cost a re-check, not a download. mIRC backs off 8 KB when resuming.
 */
export function alreadyHad(job: DccJob): boolean {
  return job.resumedFrom !== undefined && job.size !== undefined &&
    job.size - job.resumedFrom <= 64 * 1024;
}

/** "#39" and "39" are the same pack. */
function normalisePack(pack: string): string {
  return pack.trim().replace(/^#/, "");
}

function isActive(job: DccJob): boolean {
  return ACTIVE_DCC_STATES.has(job.state);
}

function sameNick(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

function outcomeState(event: BridgeEvent): DccState | undefined {
  switch (event.extra?.event) {
    case "complete":
      return "complete";
    case "getfail":
    case "sendfail":
      return "failed";
    default:
      return undefined;
  }
}
