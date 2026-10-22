import { assertEquals, assertThrows } from "@std/assert";
import {
  encodeFrame,
  fitsFrame,
  FrameTooLargeError,
  LineDecoder,
  parseInbound,
} from "../src/core/wire.ts";
import { MAX_FRAME_BYTES } from "../src/core/types.ts";

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("encodeFrame terminates with CRLF, which is what sockread waits for", () => {
  const bytes = encodeFrame({ t: "ping" });
  assertEquals(bytes[bytes.length - 2], 0x0d);
  assertEquals(bytes[bytes.length - 1], 0x0a);
  assertEquals(new TextDecoder().decode(bytes), '{"t":"ping"}\r\n');
});

Deno.test("encodeFrame refuses a frame that would exceed mIRC's line limit", () => {
  const huge = { t: "ev", text: "x".repeat(MAX_FRAME_BYTES + 1) };
  assertThrows(() => encodeFrame(huge), FrameTooLargeError);
  assertEquals(fitsFrame(huge), false);
  assertEquals(fitsFrame({ t: "ping" }), true);
});

Deno.test("LineDecoder splits several frames delivered in one chunk", () => {
  const decoder = new LineDecoder();
  const { lines, dropped } = decoder.push(enc('{"t":"a"}\n{"t":"b"}\n{"t":"c"}\n'));
  assertEquals(lines, ['{"t":"a"}', '{"t":"b"}', '{"t":"c"}']);
  assertEquals(dropped, 0);
  assertEquals(decoder.buffered, 0);
});

Deno.test("LineDecoder holds a partial frame until the rest arrives", () => {
  const decoder = new LineDecoder();
  assertEquals(decoder.push(enc('{"t":"hel')).lines, []);
  assertEquals(decoder.push(enc('lo"}')).lines, []);
  // The LF completes the first frame; the trailing frame is still incomplete.
  assertEquals(decoder.push(enc('\n{"t":"pong"}\n{"t":"par')).lines, [
    '{"t":"hello"}',
    '{"t":"pong"}',
  ]);
  assertEquals(decoder.push(enc('tial"}\n')).lines, ['{"t":"partial"}']);
});

Deno.test("LineDecoder accepts CRLF and ignores blank lines", () => {
  const decoder = new LineDecoder();
  const { lines } = decoder.push(enc('{"t":"a"}\r\n\r\n{"t":"b"}\r\n'));
  assertEquals(lines, ['{"t":"a"}', '{"t":"b"}']);
});

Deno.test("LineDecoder does not split on U+2028 or U+2029 inside JSON strings", () => {
  // A reader that treats these as newlines would corrupt the frame.
  const frame = { t: "ev", text: "before\u2028middle\u2029after" };
  const decoder = new LineDecoder();
  const { lines } = decoder.push(encodeFrame(frame));
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), frame);
});

Deno.test("LineDecoder drops an overlong line and recovers on the next one", () => {
  const decoder = new LineDecoder(64);
  const { lines, dropped } = decoder.push(enc(`${"a".repeat(200)}\n{"t":"ok"}\n`));
  assertEquals(dropped, 1);
  assertEquals(lines, ['{"t":"ok"}']);
});

Deno.test("LineDecoder drops a line that only exceeds the limit across chunks", () => {
  const decoder = new LineDecoder(32);
  assertEquals(decoder.push(enc("x".repeat(40))).lines, []);
  // No LF yet and already past the limit: the tail is skipped, then the next
  // frame still arrives intact.
  const result = decoder.push(enc(`tail\n{"t":"ok"}\n`));
  assertEquals(result.lines, ['{"t":"ok"}']);
  assertEquals(result.dropped, 1);
});

Deno.test("LineDecoder reset discards an unterminated frame", () => {
  const decoder = new LineDecoder();
  decoder.push(enc('{"t":"partial"'));
  assertEquals(decoder.buffered, '{"t":"partial"'.length);
  decoder.reset();
  assertEquals(decoder.buffered, 0);
  assertEquals(decoder.push(enc('{"t":"ok"}\n')).lines, ['{"t":"ok"}']);
});

Deno.test("parseInbound rejects anything that is not a tagged object", () => {
  assertEquals(parseInbound('{"t":"pong"}'), { t: "pong" });
  assertThrows(() => parseInbound("not json"));
  assertThrows(() => parseInbound("[1,2,3]"));
  assertThrows(() => parseInbound('"a string"'));
  assertThrows(() => parseInbound('{"nope":1}'));
});
