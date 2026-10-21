import { assertEquals } from "@std/assert";
import { readIniValue } from "../src/core/ini.ts";

const SAMPLE = [
  "; a comment",
  "# another comment",
  "",
  "[bridge]",
  "host = 127.0.0.1",
  "port=8686",
  "token=abc123",
  "",
  "[other]",
  "token=nope",
].join("\n");

Deno.test("readIniValue finds a value in the named section", () => {
  assertEquals(readIniValue(SAMPLE, "bridge", "token"), "abc123");
  assertEquals(readIniValue(SAMPLE, "bridge", "host"), "127.0.0.1");
  assertEquals(readIniValue(SAMPLE, "bridge", "port"), "8686");
});

Deno.test("readIniValue does not read the same key from another section", () => {
  assertEquals(readIniValue(SAMPLE, "other", "token"), "nope");
  assertEquals(readIniValue(SAMPLE, "missing", "token"), undefined);
});

Deno.test("readIniValue tolerates surrounding whitespace on key and value", () => {
  assertEquals(readIniValue("[s]\n  key  =  spaced value  \n", "s", "key"), "spaced value");
});

Deno.test("readIniValue handles CRLF, which is what a Windows editor writes", () => {
  assertEquals(readIniValue("[bridge]\r\ntoken=abc123\r\n", "bridge", "token"), "abc123");
});

Deno.test("readIniValue ignores comments and blank lines without losing the section", () => {
  const text = "[bridge]\n\n; still in bridge\n\nhost=x\n";
  assertEquals(readIniValue(text, "bridge", "host"), "x");
});

Deno.test("readIniValue returns undefined for an absent key or empty input", () => {
  assertEquals(readIniValue(SAMPLE, "bridge", "nope"), undefined);
  assertEquals(readIniValue("", "bridge", "token"), undefined);
});

Deno.test("readIniValue does not treat a bare line outside a section as a value", () => {
  assertEquals(readIniValue("token=stray\n[bridge]\n", "bridge", "token"), undefined);
});
