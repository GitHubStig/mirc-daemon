/**
 * MBP framing: newline-delimited JSON.
 *
 * Two constraints shape this module:
 *
 *  1. mIRC's `sockread` is CRLF-delimited, so *every* line we send must end in a
 *     newline or the client will sit on a partial buffer. Newline framing is
 *     therefore exact, not a convenience.
 *  2. mIRC caps a line at just under 4150 bytes and errors when `/sockwrite`'s
 *     16384-byte buffer is overrun, so an oversized frame is a bug we refuse to
 *     send rather than one we discover in the client.
 *
 * The decoder deliberately splits on LF alone — not "universal newlines" — because
 * U+2028/U+2029 are legal inside JSON strings and a naive reader would corrupt them.
 */

import { MAX_FRAME_BYTES } from "./types.ts";

const LF = 0x0a;
const CR = 0x0d;

export class FrameTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number, limit: number) {
    super(`frame is ${bytes} bytes, over the ${limit}-byte limit; paginate or truncate`);
    this.name = "FrameTooLargeError";
    this.bytes = bytes;
  }
}

export class FrameDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameDecodeError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Serialize a frame to bytes, terminated with CRLF. Throws if it would not fit.
 *
 * CRLF, not LF: mIRC's `sockread` reads up to `$crlf`, so an LF-only line leaves
 * the client with nothing to read — it sits on a buffer that never terminates and
 * never fires its handler. Our own decoder accepts either, which is why a lenient
 * test double missed this and a real mIRC did not.
 */
export function encodeFrame(frame: unknown, limit = MAX_FRAME_BYTES): Uint8Array {
  const json = JSON.stringify(frame);
  const body = encoder.encode(json);
  if (body.length > limit) throw new FrameTooLargeError(body.length, limit);
  const out = new Uint8Array(body.length + 2);
  out.set(body, 0);
  out[body.length] = CR;
  out[body.length + 1] = LF;
  return out;
}

/** True when the frame fits within the line limit. */
export function fitsFrame(frame: unknown, limit = MAX_FRAME_BYTES): boolean {
  return encoder.encode(JSON.stringify(frame)).length <= limit;
}

export interface DecodeResult {
  /** Complete frames, in arrival order. */
  lines: string[];
  /** Lines discarded for exceeding the limit. */
  dropped: number;
}

/**
 * Incremental LF-splitting line decoder. Feed it whatever the socket delivers;
 * it hands back only whole lines and keeps the remainder buffered.
 */
export class LineDecoder {
  #buf: Uint8Array = new Uint8Array(0);
  #limit: number;
  /** True while we are skipping the tail of an overlong line. */
  #skipping = false;

  constructor(limit = MAX_FRAME_BYTES) {
    this.#limit = limit;
  }

  get buffered(): number {
    return this.#buf.length;
  }

  push(chunk: Uint8Array): DecodeResult {
    const lines: string[] = [];
    let dropped = 0;

    if (this.#buf.length === 0) {
      this.#buf = chunk;
    } else {
      const merged = new Uint8Array(this.#buf.length + chunk.length);
      merged.set(this.#buf, 0);
      merged.set(chunk, this.#buf.length);
      this.#buf = merged;
    }

    let start = 0;
    for (;;) {
      const nl = this.#buf.indexOf(LF, start);
      if (nl === -1) break;

      let end = nl;
      if (end > start && this.#buf[end - 1] === CR) end -= 1;
      const length = end - start;

      if (this.#skipping) {
        // tail of an overlong line: discard without decoding
        this.#skipping = false;
        dropped += 1;
      } else if (length > this.#limit) {
        dropped += 1;
      } else if (length > 0) {
        lines.push(decoder.decode(this.#buf.subarray(start, end)));
      }
      start = nl + 1;
    }

    this.#buf = start === 0 ? this.#buf : this.#buf.subarray(start);
    if (this.#buf.length > this.#limit) {
      // No newline yet and already past the limit: drop what we have and keep
      // discarding until the next LF, so the overlong line costs one frame.
      this.#buf = new Uint8Array(0);
      this.#skipping = true;
    }

    return { lines, dropped };
  }

  /** Discard any partial line left in the buffer (used on disconnect). */
  reset(): void {
    this.#buf = new Uint8Array(0);
    this.#skipping = false;
  }
}

/**
 * Escape raw C0 control characters other than tab, LF and CR.
 *
 * IRC formatting is made of them (\x02 bold, \x03 colour, \x0f reset, \x1f
 * underline), JSON forbids them unescaped inside strings, and a bridge.mrc that
 * forgets to escape them makes every coloured line unparseable — which is how
 * XDCC bot replies went missing. They are never legal outside a string either,
 * so escaping them everywhere cannot change a valid frame's meaning.
 */
export function escapeControlChars(line: string): string {
  return line.replace(
    RAW_CONTROL_RE,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

// deno-lint-ignore no-control-regex -- matching control characters is the point
const RAW_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/** Parse and type-check a single inbound frame. Throws FrameDecodeError on garbage. */
export function parseInbound(line: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(escapeControlChars(line));
  } catch (err) {
    throw new FrameDecodeError(`invalid JSON: ${(err as Error).message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FrameDecodeError("frame is not a JSON object");
  }
  const t = (value as Record<string, unknown>).t;
  if (typeof t !== "string" || t.length === 0) {
    throw new FrameDecodeError("frame has no `t` discriminator");
  }
  return value;
}
