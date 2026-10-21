import type { BridgeEvent } from "./types.ts";

export type EventHandler = (event: BridgeEvent) => void;

/**
 * Fan-out for normalized IRC events. Pending `irc_wait_for` calls subscribe here,
 * and tests use it to observe the pipeline.
 *
 * Handlers are copied before dispatch, because a handler routinely unsubscribes
 * itself (a wait that just resolved) and mutating the set mid-iteration would
 * otherwise skip whoever is next.
 */
export class EventBus {
  #handlers = new Set<EventHandler>();
  #onError?: (err: unknown, event: BridgeEvent) => void;

  constructor(onError?: (err: unknown, event: BridgeEvent) => void) {
    this.#onError = onError;
  }

  /** Subscribe; returns an unsubscribe function. */
  on(handler: EventHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  get subscriberCount(): number {
    return this.#handlers.size;
  }

  emit(event: BridgeEvent): void {
    for (const handler of [...this.#handlers]) {
      try {
        handler(event);
      } catch (err) {
        // One bad subscriber must not stop the rest of the pipeline; surface it
        // rather than swallowing it, since this is a debugging-heavy phase.
        this.#onError?.(err, event);
      }
    }
  }
}
