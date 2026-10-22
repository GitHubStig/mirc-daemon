/**
 * XDCC jobs, followed from the request to the end of the transfer.
 *
 * A job is opened when the agent asks a bot for a pack, and then moves on the
 * strength of what happens next, whether or not a tool call is waiting:
 *
 *   requested → (queued) → offered → complete
 *                                  ↘ refused / failed
 *
 *  - The bot's reply, a notice or private message, is read for its meaning
 *    (xdcc.ts): queued with a position, denied, no such pack, already pending,
 *    busy.
 *  - The bot's `DCC SEND` offer (a CTCP) means the transfer is starting, and
 *    says the file name and size.
 *  - mIRC's `on FILERCVD` / `on GETFAIL` end it.
 *
 * This runs in the background because bots can be slow. In the live test,
 * AxA-MP1 answered after almost four minutes, far past what any tool call can
 * wait: MCP clients give up after about 60 s. The tools wait briefly and then
 * report the job; later replies still land on it.
 *
 * Progress is deliberately absent: mIRC already shows it, and relaying
 * percentages would cost a timer and a file watcher for nothing.
 */

import {
  ACTIVE_DCC_STATES,
  type BridgeEvent,
  type DccJob,
  type DccState,
  sameNetwork,
} from "./types.ts";
import { classifyBotReply, parseDccOffer } from "./xdcc.ts";
import { isChannelBuffer } from "./waits.ts";

export interface DccRequest {
  cid?: number;
  net: string;
  bot: string;
  pack?: string;
}

const MAX_REMEMBERED = 100;

export class DccTracker {
  #jobs: DccJob[] = [];
  #seq = 0;

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
        return this.#onOffer(event);
      case "notice":
      case "text":
        return this.#onReply(event);
      case "dcc":
        return this.#onOutcome(event);
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
    const job = this.#activeFrom(event.cid, event.nick) ?? this.#open(event, offer.file);
    job.file = offer.file;
    if (offer.size !== undefined) job.size = offer.size;
    this.#move(job, "offered");
    return job;
  }

  /** What the bot said back, addressed to us. Channel chatter is ignored. */
  #onReply(event: BridgeEvent): DccJob | undefined {
    if (isChannelBuffer(event.buf) || !event.text) return undefined;
    const job = this.#activeFrom(event.cid, event.nick);
    // Only a job still waiting on the bot can be moved by what the bot says.
    if (!job || job.state === "offered") return undefined;

    const reply = classifyBotReply(event.text);
    job.lastReply = reply.text;
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
