/**
 * Sending commands to mIRC and waiting for an answer.
 *
 * Two mSL constraints shape this:
 *
 *  1. `/sockwrite` has a 16384-byte send buffer and errors once it is overrun, and
 *     mSL is single-threaded, so we never fire commands blindly. A small pool of
 *     *credits* — one credit is permission to send one frame — is granted by
 *     mIRC's `welcome` and returned with each `res`. With the default of one
 *     credit this is strict lock-step, which is how mSL actually executes.
 *  2. Nothing is fire-and-forget. Every command awaits its outcome within a
 *     timeout and comes back as a structured result, so a silent hang can never
 *     be mistaken for success.
 */

import {
  type ActionName,
  type BridgeError,
  bridgeError,
  type CmdFrame,
  type ResFrame,
} from "./types.ts";
import { type CommandOutcome, normalizeRes, type OutcomeContext } from "./outcomes.ts";
import type { LogSink } from "./log.ts";
import { FrameTooLargeError } from "./wire.ts";

export const DEFAULT_MAX_IN_FLIGHT = 1;
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Permit pool. Releasing hands the permit straight to the next waiter rather than
 * incrementing a counter and waking someone, so the in-flight count can never
 * briefly exceed the limit.
 */
class Gate {
  #available: number;
  #waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) throw new RangeError("permits must be at least 1");
    this.#available = permits;
  }

  get available(): number {
    return this.#available;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#available += 1;
  }

  /**
   * Wake every waiter without granting real permits. Used when the connection
   * drops: the waiters re-check the closed flag and fail, rather than waiting
   * forever for a credit that will never come.
   */
  drain(): void {
    const waiters = this.#waiters.splice(0, this.#waiters.length);
    for (const waiter of waiters) waiter();
  }
}

interface Pending {
  action: ActionName;
  context: OutcomeContext;
  startedTs: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (outcome: CommandOutcome) => void;
}

export interface CommandDispatcherOptions {
  write: (frame: CmdFrame) => void;
  maxInFlight?: number;
  defaultTimeoutMs?: number;
  log?: LogSink;
}

export class CommandDispatcher {
  #write: (frame: CmdFrame) => void;
  #gate: Gate;
  #pending = new Map<string, Pending>();
  #seq = 0;
  #defaultTimeoutMs: number;
  #log?: LogSink;
  #closed = false;
  #closeReason?: string;

  constructor(options: CommandDispatcherOptions) {
    this.#write = options.write;
    this.#gate = new Gate(options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#log = options.log;
  }

  /** Commands sent and not yet answered. */
  get outstanding(): number {
    return this.#pending.size;
  }

  /** Commands waiting for a credit. */
  get queueDepth(): number {
    return this.#gate.waiting;
  }

  async send(
    action: ActionName,
    params?: Record<string, unknown>,
    options: { timeoutMs?: number; context?: OutcomeContext } = {},
  ): Promise<CommandOutcome> {
    if (this.#closed) return { ok: false, error: this.#disconnected() };

    await this.#gate.acquire();

    // The socket can drop while this call was queued.
    if (this.#closed) {
      this.#gate.release();
      return { ok: false, error: this.#disconnected() };
    }

    this.#seq += 1;
    const id = `c${this.#seq}`;
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const context = options.context ?? "generic";

    return await new Promise<CommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#gate.release();
        this.#log?.warn("action.outcome", { id, action, code: "timeout", waitedMs: timeoutMs });
        resolve({
          ok: false,
          error: bridgeError(
            "timeout",
            `mIRC did not answer the "${action}" command within ${Math.round(timeoutMs / 1000)}s.`,
          ),
        });
      }, timeoutMs);

      this.#pending.set(id, { action, context, startedTs: Date.now(), timer, resolve });

      try {
        this.#write({ t: "cmd", id, action, params });
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        this.#gate.release();
        // An oversized frame is the caller's input, not a broken link, and an
        // agent can fix it by shortening the text; say that rather than
        // claiming mIRC is unreachable.
        const error = err instanceof FrameTooLargeError
          ? bridgeError(
            "too_long",
            `that "${action}" is too long to send to mIRC in one command (${err.bytes} bytes ` +
              "once encoded). Shorten it or split it into several calls.",
          )
          : bridgeError("connect_failed", `could not send to mIRC: ${(err as Error).message}`);
        resolve({ ok: false, error });
      }
    });
  }

  /** Called for every `res` frame. Unknown ids are late answers and are ignored. */
  handleRes(frame: ResFrame): void {
    const entry = this.#pending.get(frame.id);
    if (!entry) {
      this.#log?.debug("mbp.late-res", { id: frame.id, action: "unknown" });
      return;
    }
    clearTimeout(entry.timer);
    this.#pending.delete(frame.id);
    this.#gate.release();

    const outcome = normalizeRes(frame, entry.context);
    this.#log?.debug("action.outcome", {
      id: frame.id,
      action: entry.action,
      ok: outcome.ok,
      ms: Date.now() - entry.startedTs,
      ...(outcome.ok ? {} : { code: outcome.error.code }),
    });
    entry.resolve(outcome);
  }

  /** Fail everything in flight; used when the mIRC socket drops. */
  close(reason: string): void {
    this.#closed = true;
    this.#closeReason = reason;
    for (const [id, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.resolve({
        ok: false,
        error: bridgeError(
          "connect_failed",
          `mIRC disconnected before answering "${entry.action}".`,
          { detail: reason },
        ),
      });
      this.#pending.delete(id);
    }
    // Commands still queued for a credit have no timer of their own, so they must
    // be woken explicitly or they would hang until the process exits.
    this.#gate.drain();
  }

  #disconnected(): BridgeError {
    return bridgeError(
      "connect_failed",
      "mIRC is not connected to the daemon right now.",
      { detail: this.#closeReason },
    );
  }
}
