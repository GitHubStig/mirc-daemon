/**
 * DCC outcome tracking.
 *
 * Progress is deliberately absent: the mIRC client already shows it, so relaying
 * percentages would cost a timer and a file watcher for nothing. What an agent
 * needs is the exception — did the transfer finish, or did it fail or stop
 * abnormally — and mIRC reports both through `on FILERCVD` and `on GETFAIL`.
 *
 * Jobs are also opened by the tool layer before it asks a bot for a pack, so a
 * "no transfer ever started" case is visible rather than silent.
 */

import type { BridgeEvent, DccJob, DccState } from "./types.ts";

export interface DccRequest {
  net: string;
  bot: string;
  pack?: string;
}

const MAX_REMEMBERED = 100;

export class DccTracker {
  #jobs: DccJob[] = [];
  #seq = 0;

  /** Open a job for a transfer we have just requested. */
  start(request: DccRequest): DccJob {
    this.#seq += 1;
    const job: DccJob = {
      id: `dcc${this.#seq}`,
      net: request.net,
      state: "in_flight",
      startedTs: Date.now(),
      requestedBy: { bot: request.bot, pack: request.pack },
    };
    this.#remember(job);
    return job;
  }

  /**
   * Fold a `dcc` event into the job list. The event carries a filename but not
   * the request that caused it, so it attaches to the oldest in-flight job on
   * that network — mIRC runs one transfer at a time in practice. An event with
   * nothing waiting for it still becomes a job, so an out-of-band transfer is
   * visible rather than ignored.
   */
  applyEvent(event: BridgeEvent): DccJob | undefined {
    if (event.kind !== "dcc") return undefined;
    const state = stateFromEvent(event);
    if (!state) return undefined;

    const job = this.#jobs.find((j) => j.net === event.net && j.state === "in_flight") ??
      this.#openFromEvent(event);

    job.state = state;
    job.endedTs = Date.now();

    const file = event.extra?.file;
    if (typeof file === "string" && file.length > 0) job.file = file;
    const size = event.extra?.size;
    if (typeof size === "number") job.size = size;
    const reason = event.extra?.reason;
    if (typeof reason === "string" && reason.length > 0) job.detail = reason;

    // mIRC knows the real duration; only fall back to wall-clock if it did not say.
    const secs = event.extra?.secs;
    job.secs = typeof secs === "number"
      ? secs
      : Math.max(0, Math.round((job.endedTs - job.startedTs) / 1000));

    this.#remember(job);
    return job;
  }

  #openFromEvent(event: BridgeEvent): DccJob {
    this.#seq += 1;
    return {
      id: `dcc${this.#seq}`,
      net: event.net,
      file: typeof event.extra?.file === "string" ? event.extra.file : "(unknown)",
      state: "in_flight",
      startedTs: event.ts,
    };
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

  active(): DccJob[] {
    return this.#jobs.filter((j) => j.state === "in_flight");
  }

  recentFailures(): DccJob[] {
    return this.#jobs.filter((j) => j.state === "failed");
  }

  /** The most recently opened job, which is what a caller usually wants to hear about. */
  latest(): DccJob | undefined {
    return this.#jobs.at(-1);
  }
}

function stateFromEvent(event: BridgeEvent): DccState | undefined {
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
