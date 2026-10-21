/**
 * Bounded, ordered history of everything the daemon has seen.
 *
 * This exists so an agent can (1) read history it did not witness, (2) have a
 * wait match a reply that arrived just *before* the tool call — otherwise a bot
 * answering 200 ms early turns into a timeout — and (3) poll with a cursor and
 * receive only what is new.
 *
 * One ring holds every event rather than one ring per IRC buffer. That trades a
 * little memory for a single monotonic cursor, which keeps `since` and the wait
 * matchers trivially correct; filtering by network or buffer is a scan over a
 * few thousand entries. The plan left the shape of this open, and this is the
 * simpler end of that choice.
 */

import type { BridgeEvent, EventKind } from "./types.ts";

export interface LogQuery {
  net?: string;
  buf?: string;
  kinds?: readonly EventKind[];
  /** Return at most this many of the *newest* matches. Omit for all of them. */
  limit?: number;
}

export type NewEvent = Omit<BridgeEvent, "seq" | "ts"> & { ts?: number };

export const DEFAULT_CAPACITY = 2000;

export class EventLog {
  #events: BridgeEvent[] = [];
  #seq = 0;
  #capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    if (capacity < 1) throw new RangeError("capacity must be at least 1");
    this.#capacity = capacity;
  }

  /** The cursor to pass to a later `since` call: everything after this is new. */
  get cursor(): number {
    return this.#seq;
  }

  get size(): number {
    return this.#events.length;
  }

  append(input: NewEvent): BridgeEvent {
    this.#seq += 1;
    const event: BridgeEvent = { ...input, seq: this.#seq, ts: input.ts ?? Date.now() };
    this.#events.push(event);
    if (this.#events.length > this.#capacity) {
      this.#events.splice(0, this.#events.length - this.#capacity);
    }
    return event;
  }

  /** Events after `cursor`, oldest first, optionally filtered. */
  since(cursor: number, query: LogQuery = {}): BridgeEvent[] {
    const found = this.#events.filter((e) => e.seq > cursor && matchesQuery(e, query));
    if (query.limit !== undefined && found.length > query.limit) {
      return found.slice(found.length - query.limit);
    }
    return found;
  }

  /** First event after `cursor` satisfying `predicate`, or undefined. */
  findFirst(cursor: number, predicate: (event: BridgeEvent) => boolean): BridgeEvent | undefined {
    for (const event of this.#events) {
      if (event.seq > cursor && predicate(event)) return event;
    }
    return undefined;
  }

  /** Oldest-first snapshot, for diagnostics. */
  snapshot(): readonly BridgeEvent[] {
    return this.#events;
  }

  clear(): void {
    this.#events = [];
  }
}

function matchesQuery(event: BridgeEvent, query: LogQuery): boolean {
  if (query.net !== undefined && event.net !== query.net) return false;
  if (query.buf !== undefined && event.buf !== query.buf) return false;
  if (query.kinds && !query.kinds.includes(event.kind)) return false;
  return true;
}
